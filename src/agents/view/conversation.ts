// Stable entry identities reconcile bounded history with live row projections.
// No I/O or state writes; durable history remains the source of truth.
// Backfill is not a live change; edits to held rows remain observable.
// Offsets beyond Number.MAX_SAFE_INTEGER are unsupported.

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  AUTO_RETRY_CUSTOM_TYPE,
  block,
  codemodeCalls,
  displayResult,
  entryMs,
  entryRows,
  LOST_STOP_REASON,
  object,
  pythonTruthy,
  resultTiming,
  shellState,
  streamMarker,
  type Block,
  type CompactionKeys,
  type StreamMarker,
  type ToolTiming,
} from "./entry_rows";
import { textHash } from "./text_hash";
import { retriedNotice, retryReason } from "./failure_sentences";
import { entryIdentity, type JsonObject } from "./session_entries";
import {
  readLines,
  summarizeSafetyResults,
} from "../../tool_projection/__init__";

interface TextMark {
  readonly length: number;
  readonly hash: number;
}

/** Streaming assistant text grows by appends; other rows are sent whole. */
function appendable(row: Block | undefined): row is Block {
  return row?.kind === "text" && row.role === "assistant";
}

/** The row with only its text after `held`, or whole if that is no prefix. */
function textDelta(row: Block, held: TextMark | null | undefined): Block {
  if (!held?.length || !appendable(row) || row.text.length < held.length)
    return row;
  if (textHash(row.text.slice(0, held.length)) !== held.hash) return row;
  return {
    ...row,
    text: row.text.slice(held.length),
    text_from: held.length,
    text_hash: held.hash,
  };
}

interface Snapshot {
  readonly instance_id: string;
  readonly revision: number;
  readonly blocks: readonly Block[];
  readonly older: boolean;
  readonly newer: boolean;
  readonly removed: readonly string[];
  readonly reset: boolean;
}

type Pending = {
  callId: string;
  artifactId?: string;
  offset: number;
  text: string;
  safety: JsonObject | null;
  timing: ToolTiming | null;
  readLines: number;
  calls: JsonObject[] | null;
};

// Native, nested and historical publication calls look up owned files.
function publishesFiles(row: {
  name: string | null;
  args: string;
  input: string | null;
  calls?: readonly JsonObject[] | null;
}): boolean {
  if (row.name === "publish" || row.name === "publish_attachment") return true;
  if (row.name === "codemode")
    return !!row.calls?.some(
      (call) => call.name === "publish" || call.status === "omitted",
    );
  return (
    row.name === "bash" &&
    `${row.args}\n${row.input ?? ""}`.includes("tools/publish.ts")
  );
}

type SeatTarget = {
  target: number;
  predecessor: Block | null;
  successor: Block | null;
};

/**
 * Pi's persisted pending marker, where its summary is seated. A live
 * Compacting row (Durable) is not a seat: it goes when the summary lands.
 */
function isCompactPending(row: Block): boolean {
  return (
    !row.live &&
    row.kind === "marker" &&
    row.text === "Compacting…" &&
    object(row.meta) &&
    row.meta.compact_marker === true
  );
}

function compactionSeatTarget(
  rows: Block[],
  anchorId: string,
): SeatTarget | null {
  const anchorPosition = rows.findIndex((row) => row.id === anchorId);
  if (anchorPosition < 0) return null;
  let pendingPosition = -1;
  for (let index = anchorPosition; index < rows.length; index += 1) {
    if (isCompactPending(rows[index]!)) {
      pendingPosition = index;
      break;
    }
  }
  let target =
    rows[anchorPosition]!.role === "user"
      ? anchorPosition
      : pendingPosition < 0
        ? anchorPosition + 1
        : pendingPosition + 1;
  if (pendingPosition >= 0) {
    while (
      target < rows.length &&
      rows[target]!.kind === "tool_call" &&
      rows[target]!.id.startsWith(`${anchorId}#`)
    ) {
      target += 1;
    }
  }
  return {
    target,
    predecessor: target > 0 ? rows[target - 1]! : null,
    successor: target < rows.length ? rows[target]! : null,
  };
}

function compactionSeatOrder(
  predecessor: Block | null,
  successor: Block | null,
): number {
  if (predecessor === null) return successor === null ? 0 : successor.order - 1;
  if (successor === null) return predecessor.order + 1;
  return (predecessor.order + successor.order) / 2;
}

function durableSupersedes(
  durable: CompactionKeys,
  pointId: string,
  appliedAt: number,
): boolean {
  const [firstKept, durableMs] = durable;
  return (
    (firstKept !== null && pointId === firstKept) ||
    (durableMs !== null && durableMs >= appliedAt)
  );
}

// A legacy notice and its compact-applied entry are written together.
const LEGACY_NOTICE_LINK_MS = 5000;

function closeInTime(first: number | null, second: number | null): boolean {
  return (
    first !== null &&
    second !== null &&
    Math.abs(first - second) <= LEGACY_NOTICE_LINK_MS
  );
}

function liveRunningCallIds(entries: readonly JsonObject[]): Set<string> {
  const active = new Set<string>();
  for (const entry of entries) {
    if (!pythonTruthy(entry.toolRunning)) continue;
    if (!object(entry.message)) continue;
    active.add(
      `${String(entry.callEntryId)}#${String(entry.message.toolCallId)}`,
    );
  }
  return active;
}

export class ConversationView {
  readonly cid: string;
  session_key: string;
  instance_id: string;
  revision = 0;
  last_access = performance.now() / 1000;
  private blocks: Block[] = [];
  private index = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private entryIds = new Set<string>();
  private persistedIds = new Set<string>();
  private entryParents = new Map<string, string | null>();
  private entryRoles = new Map<string, string>();
  private retryShadows = new Map<string, Block>();
  private callRows = new Map<string, string>();
  private nextOrder = 0;
  private firstOrder = 0;
  private settledResults = new Set<string>();
  // Preserve durable thinking under ephemeral overlays; no other live swaps.
  private liveThinking = new Map<string, string | undefined>();
  private durableCompactions: CompactionKeys[] = [];
  private compactionCuts = new Map<string, string>();
  // Completion links to its seated summary, or folds into it when adjacent.
  private notices = new Map<
    string,
    { rowId: string; body: string; folded?: Block }
  >();
  // Legacy notices get pointId from adjacent compact-applied, in either order.
  private legacyNotices = new Map<string, number | null>();
  private appliedParents = new Map<string, [string, number | null]>();
  /** Each change, with the row's text mark from before it. */
  private changesLog: Array<[number, string, TextMark | null]> = [];
  private backfillExisting: ReadonlySet<string> | null = null;
  /** Each assistant row's text mark as of its latest change. */
  private textMarks = new Map<string, TextMark>();
  /** Published files per tool call, oldest first. */
  attachments: Record<string, JsonObject[]> = Object.create(null);

  constructor(
    cid: string,
    sessionKey: string,
    instanceId = randomUUID().slice(0, 16),
  ) {
    this.cid = cid;
    this.session_key = sessionKey;
    this.instance_id = instanceId;
  }

  reset(sessionKey: string): void {
    this.session_key = sessionKey;
    this.instance_id = randomUUID().slice(0, 16);
    this.revision = 0;
    this.blocks = [];
    this.index.clear();
    this.pending.clear();
    this.entryIds.clear();
    this.persistedIds.clear();
    this.entryParents.clear();
    this.entryRoles.clear();
    this.retryShadows.clear();
    this.callRows.clear();
    this.nextOrder = 0;
    this.firstOrder = 0;
    this.settledResults.clear();
    this.liveThinking.clear();
    this.durableCompactions = [];
    this.compactionCuts.clear();
    this.notices.clear();
    this.legacyNotices.clear();
    this.appliedParents.clear();
    this.changesLog = [];
    this.textMarks.clear();
    this.attachments = Object.create(null);
    this.touch();
  }

  hasBlock(id: string): boolean {
    return this.index.has(id);
  }

  unresolvedAttachments(force: ReadonlySet<string> = new Set()): string[] {
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const row of this.blocks) {
      if (
        row.result !== null &&
        row.call_id !== null &&
        (force.has(row.call_id) ||
          (!row.running &&
            publishesFiles(row) &&
            !Object.hasOwn(this.attachments, row.call_id))) &&
        !seen.has(row.call_id)
      ) {
        seen.add(row.call_id);
        unresolved.push(row.call_id);
      }
    }
    return unresolved;
  }

  attachFiles(attachments: Record<string, JsonObject[]>): void {
    const additions: Record<string, JsonObject[]> = Object.create(null);
    for (const [key, value] of Object.entries(attachments)) {
      if (
        !Object.hasOwn(this.attachments, key) ||
        !isDeepStrictEqual(this.attachments[key], value)
      )
        additions[key] = value;
    }
    if (Object.keys(additions).length === 0) return;
    Object.assign(this.attachments, additions);
    for (const row of this.blocks) {
      if (Object.hasOwn(additions, row.call_id || row.id)) this.changed(row.id);
    }
  }

  private changed(identity: string): void {
    const position = this.index.get(identity);
    const row = position === undefined ? undefined : this.blocks[position];
    if (this.backfillExisting === null || this.backfillExisting.has(identity)) {
      this.revision += 1;
      this.changesLog.push([
        this.revision,
        identity,
        this.textMarks.get(identity) ?? null,
      ]);
      if (this.changesLog.length > 512) this.changesLog.shift();
    }
    if (appendable(row) && row.id === identity)
      this.textMarks.set(identity, {
        length: row.text.length,
        hash: textHash(row.text),
      });
    else this.textMarks.delete(identity);
  }

  /**
   * Rows changed after `since`; with `textDeltas`, assistant rows still
   * extending their text at `since` carry only the rest and `text_from`.
   */
  changes(since: number, limit: number, textDeltas = false): Snapshot {
    if (
      since > this.revision ||
      since < 0 ||
      (this.changesLog.length > 0 && since < this.changesLog[0]![0] - 1)
    ) {
      return Object.freeze({ ...this.window({ limit }), reset: true });
    }
    const held = new Map<string, TextMark | null>();
    for (const [revision, identity, mark] of this.changesLog)
      if (revision > since && !held.has(identity)) held.set(identity, mark);
    const changed = new Set(held.keys());
    if (changed.size > limit)
      return Object.freeze({ ...this.window({ limit }), reset: true });
    const rows = this.blocks
      .filter((row) => changed.has(row.id))
      .map((row) => (textDeltas ? textDelta(row, held.get(row.id)) : row));
    const removed = [...changed]
      .filter((identity) => !this.index.has(identity))
      .sort();
    return Object.freeze({
      instance_id: this.instance_id,
      revision: this.revision,
      blocks: Object.freeze(rows),
      older: false,
      newer: false,
      removed: Object.freeze(removed),
      reset: false,
    });
  }

  touch(): void {
    this.last_access = performance.now() / 1000;
  }

  idleFor(now = performance.now() / 1000): number {
    return now - this.last_access;
  }

  // Merge entries by stable identity on one code path; return changed-row
  // count.
  ingest(entries: readonly unknown[], live = false): number {
    let applied = 0;
    for (const entry of entries) applied += this.ingestOne(entry, live);
    applied += this.resolvePending();
    this.resolveCompactionTargets();
    this.seatCompactionCuts();
    this.orderLiveTail();
    this.demoteRetriedErrors();
    this.touch();
    return applied;
  }

  /** Add older file entries without moving any already displayed rows. */
  prepend(entries: readonly unknown[]): void {
    // Invariant: Split old and new rows by id, not by count: an older entry may
    // remove a displayed row (a compaction hides its notice), shifting every
    // position.
    const existing = new Set(this.blocks.map((row) => row.id));
    this.backfillExisting = existing;
    try {
      const latestCalls = new Map(this.callRows);
      for (const entry of entries) this.ingestOne(entry, false, true);
      for (const [callId, rowId] of latestCalls)
        this.callRows.set(callId, rowId);
      const prefix = this.blocks.filter((row) => !existing.has(row.id));
      this.firstOrder -= prefix.length;
      const orderedPrefix = prefix.map((row, index) =>
        Object.freeze({ ...row, order: this.firstOrder + index }),
      );
      this.blocks = [
        ...orderedPrefix,
        ...this.blocks.filter((row) => existing.has(row.id)),
      ];
      this.rebuildIndex();
      this.resolvePending();
      this.resolveCompactionTargets();
      this.seatCompactionCuts();
      this.demoteRetriedErrors();
    } finally {
      this.backfillExisting = null;
    }
  }

  private sameTurn(first: string, second: string): boolean {
    const firstParent = this.entryParents.get(first);
    const secondParent = this.entryParents.get(second);
    if (
      firstParent !== null &&
      firstParent !== undefined &&
      firstParent === secondParent
    )
      return true;
    let current = secondParent;
    const seen = new Set<string>();
    while (current !== null && current !== undefined && !seen.has(current)) {
      if (current === first) return true;
      if (this.entryRoles.get(current) === "user") return false;
      seen.add(current);
      current = this.entryParents.get(current) ?? null;
    }
    return false;
  }

  private demoteRetriedErrors(): void {
    const assistants = this.blocks.filter(
      (row) => row.kind === "text" && row.role === "assistant",
    );
    for (let index = 0; index < assistants.length; index += 1) {
      const row = assistants[index]!;
      if (
        row.error === null ||
        row.stop_reason === LOST_STOP_REASON ||
        retryReason(row.error_detail ?? row.error) === null
      )
        continue;
      if (
        !assistants
          .slice(index + 1)
          .some(
            (later) =>
              later.order > row.order && this.sameTurn(row.id, later.id),
          )
      ) {
        continue;
      }
      const updated: Block = Object.freeze({
        ...row,
        kind: "marker",
        role: "shell-notice",
        text: retriedNotice(row.error_detail ?? row.error),
        origin: "system",
        error: null,
        error_detail: null,
        stop_reason: null,
        meta: null,
      });
      const position = this.index.get(row.id);
      if (
        position !== undefined &&
        !isDeepStrictEqual(this.blocks[position], updated)
      ) {
        this.blocks[position] = updated;
        this.changed(row.id);
      }
    }
  }

  private resolvePending(): number {
    let applied = 0;
    for (const [identity, pending] of [...this.pending]) {
      const candidates = this.blocks.filter(
        (row) =>
          row.kind === "tool_call" &&
          row.call_id === pending.callId &&
          (pending.offset < 0 ||
            (row.offset >= 0 && row.offset < pending.offset)),
      );
      if (
        candidates.length === 0 ||
        (pending.offset < 0 && candidates.length !== 1)
      )
        continue;
      const owner = candidates.reduce((best, row) =>
        row.offset > best.offset ? row : best,
      );
      this.settledResults.add(owner.id);
      if (
        this.attachResult(owner.id, pending.text, {
          safetyUsage: pending.safety,
          timing: pending.timing,
          readLines: pending.readLines,
          calls: pending.calls,
          artifactId: pending.artifactId,
        })
      ) {
        applied += 1;
      }
      this.pending.delete(identity);
    }
    return applied;
  }

  private acceptLive(
    identity: [string, string | null],
    messageValue: unknown,
    live: boolean,
  ): boolean {
    if (!live || this.entryIds.has(identity[0])) return true;
    if (object(messageValue) && messageValue.role === "toolResult") {
      return (
        typeof messageValue.toolCallId === "string" &&
        this.callRows.has(messageValue.toolCallId)
      );
    }
    return (
      (identity[1] !== null && this.entryIds.has(identity[1])) ||
      (identity[1] === null && this.entryIds.size === 0)
    );
  }

  private resultRowId(
    entry: JsonObject,
    identity: [string, string | null],
    callId: string,
    live: boolean,
  ): string {
    const owner = entry.callEntryId;
    let rowId =
      typeof owner === "string"
        ? `${owner}#${callId}`
        : (this.callRows.get(callId) ?? callId);
    const offset = entry._offset;
    if (
      !live &&
      (typeof offset === "boolean" ||
        (typeof offset === "number" && Number.isInteger(offset)))
    ) {
      const byteOffset = Number(offset);
      const preceding = this.blocks.filter(
        (row) =>
          row.kind === "tool_call" &&
          row.call_id === callId &&
          row.offset >= 0 &&
          row.offset < byteOffset,
      );
      if (preceding.length > 0) {
        rowId = preceding.reduce((best, row) =>
          row.offset > best.offset ? row : best,
        ).id;
      } else return `pending:${identity[0]}`;
    }
    return rowId;
  }

  private ingestToolResult(
    entry: JsonObject,
    messageValue: JsonObject,
    identity: [string, string | null],
    live: boolean,
  ): number {
    const callId = messageValue.toolCallId;
    if (typeof callId !== "string" || !callId) return 0;
    const rowId = this.resultRowId(entry, identity, callId, live);
    if (live && (!this.index.has(rowId) || this.settledResults.has(rowId)))
      return 0;
    if (!live && !this.index.has(rowId)) {
      const offset = entry._offset;
      this.pending.set(identity[0], {
        callId,
        ...(typeof entry.artifactId === "string"
          ? { artifactId: entry.artifactId }
          : {}),
        offset:
          typeof offset === "boolean" ||
          (typeof offset === "number" && Number.isInteger(offset))
            ? Number(offset)
            : -1,
        text: displayResult(messageValue.content),
        safety: summarizeSafetyResults([messageValue]),
        timing: resultTiming(messageValue),
        readLines: readLines(messageValue),
        calls: codemodeCalls(messageValue.details),
      });
      return 0;
    }
    if (!live) this.settledResults.add(rowId);
    return Number(
      this.attachResult(rowId, displayResult(messageValue.content), {
        running: live && entry.toolRunning === true,
        ...(typeof entry.artifactId === "string"
          ? { artifactId: entry.artifactId }
          : {}),
        readLines: readLines(messageValue),
        safetyUsage: summarizeSafetyResults([messageValue]),
        timing: resultTiming(messageValue),
        calls: codemodeCalls(messageValue.details),
      }),
    );
  }

  private ingestOne(value: unknown, live: boolean, backfill = false): number {
    if (!object(value)) return 0;
    const identity = entryIdentity(value);
    if (identity === null) return 0;
    const messageValue = value.message;
    if (object(messageValue) && typeof messageValue.role === "string")
      this.entryRoles.set(identity[0], messageValue.role);
    if (this.persistedIds.has(identity[0])) {
      const retryRow = this.retryShadows.has(identity[0]);
      const hasThinking =
        typeof value.thinkingTitle === "string" ||
        value.hasThinking === true ||
        this.liveThinking.has(identity[0]);
      if (!live || (!retryRow && !hasThinking)) return 0;
    }
    this.entryParents.set(identity[0], identity[1]);
    if (!this.acceptLive(identity, messageValue, live)) return 0;
    this.entryIds.add(identity[0]);
    if (!live) this.persistedIds.add(identity[0]);
    const marker = streamMarker(value);
    if (marker !== null) return Number(this.trackShell(marker, live, backfill));
    if (
      value.type === "message" &&
      object(messageValue) &&
      messageValue.role === "toolResult"
    ) {
      return this.ingestToolResult(value, messageValue, identity, live);
    }
    const applied =
      value.type === "custom" && value.customType === "recurse.compact-applied";
    if (applied) this.linkLegacyNotice(value);
    const projected = entryRows(identity[0], value);
    const compaction = projected.compaction;
    const firstKept = compaction?.[0];
    const notice = firstKept ? this.notices.get(firstKept) : undefined;
    if (compaction !== undefined) this.durableCompactions.push(compaction);
    if (value.type === "custom_message")
      this.placeNotice(identity[0], value, projected.rows[0]);
    for (const [callId, rowId] of projected.callRows ?? [])
      this.callRows.set(callId, rowId);

    const offset = value._offset;
    let merged = 0;
    const rows =
      applied && this.provisionalSuperseded(value) ? [] : projected.rows;
    for (const row of rows) {
      if (
        this.merge(
          {
            ...row,
            ...(notice === undefined
              ? {}
              : { meta: { ...row.meta, body: notice.body } }),
            offset:
              typeof offset === "boolean" ||
              (typeof offset === "number" && Number.isInteger(offset))
                ? Number(offset)
                : -1,
          },
          live,
        )
      )
        merged += 1;
    }
    if (compaction !== undefined) {
      if (firstKept) this.compactionCuts.set(firstKept, identity[0]);
      merged += this.supersedeProvisionalCompactions(compaction);
    } else if (
      value.customType === "recurse.compact-applied" &&
      object(value.data) &&
      typeof value.data.pointId === "string" &&
      this.index.has(identity[0])
    ) {
      this.compactionCuts.set(value.data.pointId, identity[0]);
    }
    return merged;
  }

  // Pi may retain non-rendered metadata just before a message. Resolve that
  // cut to its following projected entry, without creating a second divider.
  private resolveCompactionTargets(): void {
    const cuts = [...this.compactionCuts].filter(
      ([cut, id]) =>
        !this.index.has(cut) &&
        !this.blocks[this.index.get(id) ?? -1]?.meta?.jumpEntryId,
    );
    if (!cuts.length) return;
    const children = new Map(
      [...this.entryParents].map(([id, parent]) => [parent, id]),
    );
    for (const [cut, id] of cuts) {
      let target = cut;
      const seen = new Set<string>();
      while (
        !this.index.has(target) &&
        children.has(target) &&
        !seen.has(target)
      ) {
        seen.add(target);
        target = children.get(target)!;
      }
      const position = this.index.get(id);
      if (target === cut || !this.index.has(target) || position === undefined)
        continue;
      const row = this.blocks[position]!;
      if (row.meta?.jumpEntryId === target) continue;
      this.blocks[position] = Object.freeze({
        ...row,
        meta: { ...row.meta, jumpEntryId: target },
      });
      this.changed(id);
    }
  }

  private supersedeProvisionalCompactions(durable: CompactionKeys): number {
    if (durable.every((value) => value === null)) return 0;
    let removed = 0;
    for (const row of [...this.blocks]) {
      const provisional = row.meta?.compact_provisional;
      if (!object(provisional)) continue;
      const point =
        typeof provisional.pointId === "string" ? provisional.pointId : "";
      const at =
        typeof provisional.appliedAt === "number" &&
        Number.isFinite(provisional.appliedAt)
          ? provisional.appliedAt
          : Infinity;
      if (durableSupersedes(durable, point, at) && this.removeBlock(row.id))
        removed += 1;
    }
    return removed;
  }

  private seatCompactionCuts(): number {
    let moved = 0;
    // Invariant: Reverse paging inserts cuts in a different order. Always seat
    // them in persisted history order, not Map insertion order.
    const cuts = [...this.compactionCuts].sort(([, left], [, right]) => {
      const a = this.blocks[this.index.get(left) ?? -1];
      const b = this.blocks[this.index.get(right) ?? -1];
      return (a?.offset ?? -1) - (b?.offset ?? -1) || left.localeCompare(right);
    });
    for (const [firstKept, durableId] of cuts) {
      const durablePosition = this.index.get(durableId);
      const anchorId =
        this.blocks[durablePosition ?? -1]?.meta?.jumpEntryId ?? firstKept;
      const anchorPosition = this.index.get(String(anchorId));
      if (anchorPosition === undefined || durablePosition === undefined)
        continue;
      if (durablePosition < anchorPosition) continue;
      const remaining = this.blocks.filter((row) => row.id !== durableId);
      const targetInfo = compactionSeatTarget(remaining, String(anchorId));
      if (targetInfo === null) continue;
      const { target, predecessor, successor } = targetInfo;
      if (durablePosition === target) {
        const current = this.blocks[durablePosition]!;
        if (
          (predecessor === null || predecessor.order < current.order) &&
          (successor === null || current.order < successor.order)
        ) {
          continue;
        }
      }
      const order = compactionSeatOrder(predecessor, successor);
      const [row] = this.blocks.splice(durablePosition, 1);
      if (row === undefined) continue;
      this.blocks.splice(target, 0, Object.freeze({ ...row, order }));
      this.rebuildIndex();
      this.changed(durableId);
      moved += 1;
    }
    for (const pointId of this.notices.keys())
      this.showNoticeOnCompaction(pointId);
    return moved;
  }

  private attachResult(
    rowId: string,
    shown: string,
    options: {
      running?: boolean;
      safetyUsage?: JsonObject | null;
      timing?: ToolTiming | null;
      artifactId?: string;
      readLines?: number;
      calls?: JsonObject[] | null;
    } = {},
  ): boolean {
    const position = this.index.get(rowId);
    if (position === undefined) return false;
    const current = this.blocks[position]!;
    let stat = current.stat;
    if (stat?.kind === "read") {
      const from = typeof stat.from === "number" ? stat.from : 1;
      const count = options.readLines ?? 0;
      stat = { ...stat, lines: count, to: from + Math.max(count - 1, 0) };
    }
    const timing = options.timing ?? current.timing;
    const updated: Block = Object.freeze({
      ...current,
      result: shown,
      stat,
      running: options.running ?? false,
      safety_usage: options.safetyUsage ?? current.safety_usage,
      ...(timing === undefined ? {} : { timing }),
      ...(options.calls ? { calls: options.calls } : {}),
      ...(options.artifactId ? { artifact_id: options.artifactId } : {}),
    });
    if (isDeepStrictEqual(current, updated)) return false;
    this.blocks[position] = updated;
    this.changed(rowId);
    return true;
  }

  private restoreRetryShadow(entryId: string): void {
    const shadow = this.retryShadows.get(entryId);
    this.retryShadows.delete(entryId);
    const position = this.index.get(entryId);
    if (shadow === undefined || position === undefined) return;
    if (!isDeepStrictEqual(this.blocks[position], shadow)) {
      this.blocks[position] = shadow;
      this.changed(entryId);
    }
  }

  // Reconcile a Pi live-tail snapshot; clear drafts only after file catch-up.
  syncLive(entries: readonly JsonObject[], caughtUp: boolean): void {
    const liveIds = new Set<unknown>(entries.map((entry) => entry.id));
    for (const entry of entries) {
      const messageValue = entry.message;
      const content = object(messageValue) ? messageValue.content : null;
      if (Array.isArray(content)) {
        for (const call of content) {
          if (object(call) && call.type === "toolCall")
            liveIds.add(`${String(entry.id)}#${String(call.id)}`);
        }
      }
    }
    const activeRetryOfs = new Set(
      entries
        .filter(
          (entry) =>
            entry.customType === AUTO_RETRY_CUSTOM_TYPE &&
            typeof entry.retryOf === "string",
        )
        .map((entry) => entry.retryOf as string),
    );
    for (const entryId of [...this.retryShadows.keys()]) {
      if (!activeRetryOfs.has(entryId)) this.restoreRetryShadow(entryId);
    }
    if (caughtUp) {
      for (const [entryId, durable] of this.liveThinking) {
        if (liveIds.has(entryId)) continue;
        const position = this.index.get(entryId);
        if (position !== undefined) {
          const current = this.blocks[position]!;
          const restored = { ...current };
          if (durable === undefined) delete restored.thinking;
          else restored.thinking = durable;
          delete restored.live_thinking;
          if (!isDeepStrictEqual(restored, current)) {
            this.blocks[position] = Object.freeze(restored);
            this.changed(entryId);
          }
        }
        this.liveThinking.delete(entryId);
      }
      const removed = this.blocks
        .filter((row) => row.live && !liveIds.has(row.id))
        .map((row) => row.id);
      if (removed.length > 0) {
        this.blocks = this.blocks.filter(
          (row) => !row.live || liveIds.has(row.id),
        );
        this.rebuildIndex();
        for (const identity of removed) this.changed(identity);
      }
    }
    this.ingest(entries, true);
    if (caughtUp) {
      const active = liveRunningCallIds(entries);
      for (let index = 0; index < this.blocks.length; index += 1) {
        const row = this.blocks[index]!;
        if (row.running && !active.has(row.id)) {
          this.blocks[index] = Object.freeze({ ...row, running: false });
          this.changed(row.id);
        }
      }
    }
  }

  private orderLiveTail(): void {
    const persisted = this.blocks
      .filter((row) => !row.live)
      .sort((left, right) => left.order - right.order);
    const live = this.blocks.filter((row) => row.live);
    live.forEach((row, index) => {
      const order = this.nextOrder + index;
      if (row.order !== order) {
        live[index] = Object.freeze({ ...row, order });
        this.changed(row.id);
      }
    });
    this.blocks = [...persisted, ...live];
    this.rebuildIndex();
  }

  private merge(row: Block, live: boolean): boolean {
    const position = this.index.get(row.id);
    if (position !== undefined) {
      const current = this.blocks[position]!;
      const retryBlock = object(row.meta) && row.meta.retry === true;
      const retryCurrent = this.retryShadows.has(row.id);
      if (!current.live && !retryBlock && !retryCurrent) {
        // Invariant: Streaming may overlap a persisted partial entry.
        // Live thinking overlays must restore the durable value when cleared;
        // live rows never replace durable text, tools or status.
        if (!live) return false;
        const hasOverlay = this.liveThinking.has(row.id);
        const thinking = row.thinking;
        const hasThinking = row.has_thinking === true;
        if (typeof thinking !== "string" && !hasThinking && !hasOverlay)
          return false;
        const updated = { ...current };
        if (typeof thinking === "string" || hasThinking) {
          if (!hasOverlay)
            this.liveThinking.set(row.id, current.thinking ?? undefined);
          if (typeof thinking === "string") updated.thinking = thinking;
          updated.has_thinking = true;
          updated.live_thinking = true;
        } else {
          const durable = this.liveThinking.get(row.id);
          this.liveThinking.delete(row.id);
          if (durable === undefined) delete updated.thinking;
          else updated.thinking = durable;
          delete updated.live_thinking;
        }
        if (isDeepStrictEqual(updated, current)) return false;
        this.blocks[position] = Object.freeze(updated);
        this.changed(row.id);
        return true;
      }
      if (retryBlock && !retryCurrent) this.retryShadows.set(row.id, current);
      const shadow = this.retryShadows.get(row.id);
      let rowLive: boolean;
      let order: number;
      let markerMeta: JsonObject | null;
      if (retryBlock) {
        rowLive = current.live;
        order = current.order;
        markerMeta = null;
      } else if (retryCurrent && shadow !== undefined) {
        this.retryShadows.delete(row.id);
        if (live) {
          rowLive = shadow.live;
          order = shadow.order;
        } else {
          rowLive = false;
          order = this.nextOrder;
          this.nextOrder += 1;
        }
        markerMeta = row.meta;
      } else {
        rowLive = live;
        order = live ? current.order : this.nextOrder;
        if (!live) this.nextOrder += 1;
        markerMeta = row.meta;
      }
      const timing = row.timing !== undefined ? row.timing : current.timing;
      const modelTime =
        row.model_time_ms !== undefined
          ? row.model_time_ms
          : current.model_time_ms;
      const updated: Block = Object.freeze({
        ...row,
        live: rowLive,
        order,
        running: current.running,
        result: row.result !== null ? row.result : current.result,
        usage: row.usage !== null ? row.usage : current.usage,
        safety_usage:
          row.safety_usage !== null ? row.safety_usage : current.safety_usage,
        ...(timing === undefined ? {} : { timing }),
        ...(modelTime === undefined ? {} : { model_time_ms: modelTime }),
        meta: markerMeta,
        ...(current.calls && !row.calls ? { calls: current.calls } : {}),
      });
      if (isDeepStrictEqual(updated, current)) return false;
      this.blocks[position] = updated;
      this.changed(row.id);
      return true;
    }
    this.index.set(row.id, this.blocks.length);
    this.blocks.push(Object.freeze({ ...row, live, order: this.nextOrder }));
    this.nextOrder += 1;
    this.changed(row.id);
    return true;
  }

  /** Link completion to its seated summary. Keep both unless adjacent. */
  private placeNotice(
    entryId: string,
    entry: JsonObject,
    row: Block | undefined,
  ): void {
    if (row?.role !== "compaction-notice") return;
    const body = String(row.meta?.body ?? "");
    const details = entry.details;
    let pointId: string | null = null;
    if (object(details) && typeof details.pointId === "string")
      pointId = details.pointId || null;
    else if (body.startsWith("Context compacted")) {
      const at = entryMs(entry);
      const applied = this.appliedParents.get(entryId);
      if (applied !== undefined && closeInTime(applied[1], at)) {
        this.appliedParents.delete(entryId);
        pointId = applied[0];
      } else this.legacyNotices.set(entryId, at);
    }
    if (pointId === null) return;
    this.notices.set(pointId, { rowId: entryId, body });
  }

  private linkLegacyNotice(entry: JsonObject): void {
    const data = entry.data;
    const parent = entry.parentId;
    if (!object(data) || typeof data.pointId !== "string" || !data.pointId)
      return;
    if (typeof parent !== "string" || !parent) return;
    const at = entryMs(entry);
    if (!this.legacyNotices.has(parent)) {
      this.appliedParents.set(parent, [data.pointId, at]);
      return;
    }
    if (!closeInTime(this.legacyNotices.get(parent) ?? null, at)) return;
    this.legacyNotices.delete(parent);
    const position = this.index.get(parent);
    const body =
      position === undefined
        ? ""
        : String(this.blocks[position]!.meta?.body ?? "");
    this.notices.set(data.pointId, { rowId: parent, body });
    this.showNoticeOnCompaction(data.pointId);
  }

  // Adjacent completion folds into the summary; separated completion links to
  // it.
  private showNoticeOnCompaction(pointId: string): boolean {
    const durableId = this.compactionCuts.get(pointId);
    const notice = this.notices.get(pointId);
    if (durableId === undefined || notice === undefined) return false;
    const position = this.index.get(durableId);
    if (position === undefined) return false;
    const current = this.blocks[position]!;
    const noticePosition = this.index.get(notice.rowId);
    if (noticePosition === undefined) {
      const folded = notice.folded;
      if (folded === undefined) return true;
      // Invariant: Older pages can seat another summary between this pair. The
      // notice belongs at completion, so retain its row until adjacency is
      // final.
      const successor = this.blocks.findIndex(
        (row) => row.role !== "compaction" && row.order > folded.order,
      );
      const target = successor < 0 ? this.blocks.length : successor;
      const between = this.blocks.slice(
        target > position ? position + 1 : target,
        target > position ? target : position,
      );
      if (between.every((row) => row.role === "usage")) return true;
      this.blocks.splice(target, 0, folded);
      this.rebuildIndex();
      this.changed(folded.id);
      return this.showNoticeOnCompaction(pointId);
    }
    const seated = this.index.has(String(current.meta?.jumpEntryId ?? pointId));
    const adjacent =
      seated &&
      !current.meta?.compact_provisional &&
      this.blocks
        .slice(
          Math.min(position, noticePosition) + 1,
          Math.max(position, noticePosition),
        )
        .every((row) => row.role === "usage");
    const meta = { ...(current.meta ?? {}) };
    if (adjacent) meta.body = notice.body;
    else delete meta.body;
    if (!isDeepStrictEqual(current.meta, meta)) {
      this.blocks[position] = Object.freeze({ ...current, meta });
      this.changed(durableId);
    }
    if (adjacent) {
      notice.folded = this.blocks[noticePosition];
      this.removeBlock(notice.rowId);
    } else if (noticePosition !== undefined) {
      const row = this.blocks[noticePosition]!;
      if (row.meta?.summaryEntryId !== durableId) {
        this.blocks[noticePosition] = Object.freeze({
          ...row,
          meta: { ...row.meta, summaryEntryId: durableId },
        });
        this.changed(notice.rowId);
      }
    }
    return true;
  }

  private provisionalSuperseded(entry: JsonObject): boolean {
    const data = entry.data;
    if (!object(data)) return false;
    const pointId = data.pointId;
    const appliedAt = data.appliedAt;
    if (
      typeof pointId !== "string" ||
      !pointId ||
      typeof appliedAt !== "number" ||
      !Number.isFinite(appliedAt)
    ) {
      return false;
    }
    return this.durableCompactions.some((durable) =>
      durableSupersedes(durable, pointId, appliedAt),
    );
  }

  private removeBlock(rowId: string): boolean {
    const position = this.index.get(rowId);
    if (position === undefined) return false;
    this.blocks.splice(position, 1);
    this.rebuildIndex();
    this.changed(rowId);
    return true;
  }

  private trackShell(
    marker: StreamMarker,
    live: boolean,
    backfill: boolean,
  ): boolean {
    const [event, details] = marker;
    if (event === "shell-background-end") {
      const shellId = details.shellId;
      if (typeof shellId !== "string" || !shellId) return false;
      return this.removeBlock(`shell:${shellId}`);
    }
    if (backfill) return false;
    const state = shellState(details);
    if (state === null) return false;
    const shellId = state.shellId as string;
    const command = state.command as string;
    return this.merge(
      block(`shell:${shellId}`, "marker", "shell", command, "system", {
        meta: state,
      }),
      live,
    );
  }

  // Cursor window: latest rows, forward after a row, or backward before one.
  window(
    options: {
      after?: string | null;
      before?: string | null;
      limit?: number;
    } = {},
  ): Snapshot {
    this.touch();
    const after = options.after ?? null;
    const before = options.before ?? null;
    const limit = options.limit ?? 50;
    const total = this.blocks.length;
    const beforePosition = before === null ? undefined : this.index.get(before);
    if (beforePosition !== undefined)
      return this.snapshot(
        Math.max(0, beforePosition - limit),
        beforePosition,
        total,
      );
    const afterPosition = after === null ? undefined : this.index.get(after);
    const start =
      after === null
        ? Math.max(0, total - limit)
        : afterPosition !== undefined
          ? afterPosition + 1
          : total;
    return this.snapshot(start, Math.min(total, start + limit), total);
  }

  private snapshot(start: number, end: number, total: number): Snapshot {
    return Object.freeze({
      instance_id: this.instance_id,
      revision: this.revision,
      blocks: Object.freeze(this.blocks.slice(start, end)),
      older: start > 0,
      newer: end < total,
      removed: Object.freeze([]),
      reset: false,
    });
  }

  private rebuildIndex(): void {
    this.index = new Map(this.blocks.map((row, index) => [row.id, index]));
  }
}
