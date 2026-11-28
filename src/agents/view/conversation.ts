// Stable entry identities reconcile bounded history with live row projections.
// No I/O or state writes; durable history remains the source of truth.
// Offsets beyond Number.MAX_SAFE_INTEGER are unsupported.

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  codemodeCalls,
  hookArguments,
  displayToolArgs,
  displayResult,
  entryRows,
  LOST_STOP_REASON,
  object,
  pythonTruthy,
  resultTiming,
  type Block,
  type ToolTiming,
} from "./entry_rows";
import { RowFeed } from "./row_feed";
import { retriedNotice, retryReason } from "./failure_sentences";
import { entryIdentity, type JsonObject } from "./session_entries";
import {
  readLines,
  summarizeSafetyResults,
} from "../../tool_projection/__init__";

type Pending = {
  callId: string;
  artifactId?: string;
  offset: number;
  text: string;
  safety: JsonObject | null;
  timing: ToolTiming | null;
  readLines: number;
  calls: JsonObject[] | null;
  ranArgs: JsonObject | null;
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
  last_access = performance.now() / 1000;
  private feed: RowFeed;
  private pending = new Map<string, Pending>();
  private entryIds = new Set<string>();
  private persistedIds = new Set<string>();
  private entryParents = new Map<string, string | null>();
  private entryRoles = new Map<string, string>();
  private callRows = new Map<string, string>();
  private settledResults = new Set<string>();
  // Preserve durable thinking under ephemeral overlays; no other live swaps.
  private liveThinking = new Map<string, string | undefined>();
  private compactionCuts = new Map<string, string>();
  // Completion links to its seated summary, or folds into it when adjacent.
  private notices = new Map<
    string,
    { rowId: string; body: string; folded?: Block }
  >();
  /** Published files per tool call, oldest first. */
  attachments: Record<string, JsonObject[]> = Object.create(null);

  constructor(
    cid: string,
    sessionKey: string,
    instanceId = randomUUID().slice(0, 16),
  ) {
    this.cid = cid;
    this.session_key = sessionKey;
    this.feed = new RowFeed(instanceId);
  }

  get instance_id(): string {
    return this.feed.instance_id;
  }

  get revision(): number {
    return this.feed.revision;
  }

  private get blocks(): readonly Block[] {
    return this.feed.rows;
  }

  reset(sessionKey: string): void {
    this.session_key = sessionKey;
    this.feed = new RowFeed(randomUUID().slice(0, 16));
    this.pending.clear();
    this.entryIds.clear();
    this.persistedIds.clear();
    this.entryParents.clear();
    this.entryRoles.clear();
    this.callRows.clear();
    this.settledResults.clear();
    this.liveThinking.clear();
    this.compactionCuts.clear();
    this.notices.clear();
    this.attachments = Object.create(null);
    this.touch();
  }

  hasBlock(id: string): boolean {
    return this.feed.has(id);
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
      if (Object.hasOwn(additions, row.call_id || row.id))
        this.feed.changed(row.id);
    }
  }

  changes(since: number, limit: number, textDeltas = false) {
    const page = this.feed.changes(since, limit, textDeltas);
    if (page.reset) this.touch();
    return page;
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
    this.feed.orderLiveTail();
    this.demoteRetriedErrors();
    this.touch();
    return applied;
  }

  /** Add older file entries without moving any already displayed rows. */
  prepend(entries: readonly unknown[]): void {
    this.feed.backfill(
      () => {
        const latestCalls = new Map(this.callRows);
        for (const entry of entries) this.ingestOne(entry, false);
        for (const [callId, rowId] of latestCalls)
          this.callRows.set(callId, rowId);
      },
      () => {
        this.resolvePending();
        this.resolveCompactionTargets();
        this.seatCompactionCuts();
        this.demoteRetriedErrors();
      },
    );
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
      const current = this.feed.get(row.id);
      if (current !== undefined && !isDeepStrictEqual(current, updated))
        this.feed.replace(updated);
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
          ranArgs: pending.ranArgs,
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
    if (live && (!this.feed.has(rowId) || this.settledResults.has(rowId)))
      return 0;
    if (!live && !this.feed.has(rowId)) {
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
        ranArgs: hookArguments(messageValue.details),
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
        ranArgs: hookArguments(messageValue.details),
      }),
    );
  }

  private ingestOne(value: unknown, live: boolean): number {
    if (!object(value)) return 0;
    const identity = entryIdentity(value);
    if (identity === null) return 0;
    const messageValue = value.message;
    if (object(messageValue) && typeof messageValue.role === "string")
      this.entryRoles.set(identity[0], messageValue.role);
    if (this.persistedIds.has(identity[0])) {
      const hasThinking =
        typeof value.thinkingTitle === "string" ||
        value.hasThinking === true ||
        this.liveThinking.has(identity[0]);
      if (!live || !hasThinking) return 0;
    }
    this.entryParents.set(identity[0], identity[1]);
    if (!this.acceptLive(identity, messageValue, live)) return 0;
    this.entryIds.add(identity[0]);
    if (!live) this.persistedIds.add(identity[0]);
    if (
      value.type === "message" &&
      object(messageValue) &&
      messageValue.role === "toolResult"
    ) {
      return this.ingestToolResult(value, messageValue, identity, live);
    }
    const projected = entryRows(identity[0], value);
    const firstKept = projected.firstKept;
    const notice = firstKept ? this.notices.get(firstKept) : undefined;
    if (value.type === "custom_message") this.placeNotice(projected.rows[0]);
    for (const [callId, rowId] of projected.callRows ?? [])
      this.callRows.set(callId, rowId);

    const offset = value._offset;
    let merged = 0;
    for (const row of projected.rows) {
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
    if (firstKept) this.compactionCuts.set(firstKept, identity[0]);
    return merged;
  }

  // Pi may retain non-rendered metadata just before a message. Resolve that
  // cut to its following projected entry, without creating a second divider.
  private resolveCompactionTargets(): void {
    const cuts = [...this.compactionCuts].filter(
      ([cut, id]) =>
        !this.feed.has(cut) && !this.feed.get(id)?.meta?.jumpEntryId,
    );
    if (!cuts.length) return;
    const children = new Map(
      [...this.entryParents].map(([id, parent]) => [parent, id]),
    );
    for (const [cut, id] of cuts) {
      let target = cut;
      const seen = new Set<string>();
      while (
        !this.feed.has(target) &&
        children.has(target) &&
        !seen.has(target)
      ) {
        seen.add(target);
        target = children.get(target)!;
      }
      const row = this.feed.get(id);
      if (target === cut || !this.feed.has(target) || row === undefined)
        continue;
      if (row.meta?.jumpEntryId === target) continue;
      this.feed.replace(
        Object.freeze({ ...row, meta: { ...row.meta, jumpEntryId: target } }),
      );
    }
  }

  private seatCompactionCuts(): number {
    let moved = 0;
    // Invariant: Reverse paging inserts cuts in a different order. Always seat
    // them in persisted history order, not Map insertion order.
    const cuts = [...this.compactionCuts].sort(([, left], [, right]) => {
      const a = this.feed.get(left);
      const b = this.feed.get(right);
      return (a?.offset ?? -1) - (b?.offset ?? -1) || left.localeCompare(right);
    });
    for (const [firstKept, durableId] of cuts) {
      const durablePosition = this.feed.position(durableId);
      const anchorId =
        this.blocks[durablePosition ?? -1]?.meta?.jumpEntryId ?? firstKept;
      const anchorPosition = this.feed.position(String(anchorId));
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
      if (this.feed.move(durablePosition, target, order)) moved += 1;
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
      ranArgs?: JsonObject | null;
    } = {},
  ): boolean {
    const current = this.feed.get(rowId);
    if (current === undefined) return false;
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
      ...(options.ranArgs
        ? { ran_args: displayToolArgs(current.name, options.ranArgs) }
        : {}),
      ...(options.artifactId ? { artifact_id: options.artifactId } : {}),
    });
    if (isDeepStrictEqual(current, updated)) return false;
    this.feed.replace(updated);
    return true;
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
    if (caughtUp) {
      for (const [entryId, durable] of this.liveThinking) {
        if (liveIds.has(entryId)) continue;
        const current = this.feed.get(entryId);
        if (current !== undefined) {
          const restored = { ...current };
          if (durable === undefined) delete restored.thinking;
          else restored.thinking = durable;
          delete restored.live_thinking;
          if (!isDeepStrictEqual(restored, current))
            this.feed.replace(Object.freeze(restored));
        }
        this.liveThinking.delete(entryId);
      }
      this.feed.removeWhere((row) => row.live && !liveIds.has(row.id));
    }
    this.ingest(entries, true);
    if (caughtUp) {
      const active = liveRunningCallIds(entries);
      for (const row of this.blocks) {
        if (row.running && !active.has(row.id))
          this.feed.replace(Object.freeze({ ...row, running: false }));
      }
    }
  }

  private merge(row: Block, live: boolean): boolean {
    const current = this.feed.get(row.id);
    if (current !== undefined) {
      if (!current.live) {
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
        this.feed.replace(Object.freeze(updated));
        return true;
      }
      const timing = row.timing !== undefined ? row.timing : current.timing;
      const modelTime =
        row.model_time_ms !== undefined
          ? row.model_time_ms
          : current.model_time_ms;
      const updated: Block = Object.freeze({
        ...row,
        live,
        order: live ? current.order : this.feed.takeOrder(),
        running: current.running,
        result: row.result !== null ? row.result : current.result,
        usage: row.usage !== null ? row.usage : current.usage,
        safety_usage:
          row.safety_usage !== null ? row.safety_usage : current.safety_usage,
        ...(timing === undefined ? {} : { timing }),
        ...(modelTime === undefined ? {} : { model_time_ms: modelTime }),
        ...(current.calls && !row.calls ? { calls: current.calls } : {}),
        ...(current.ran_args ? { ran_args: current.ran_args } : {}),
      });
      if (isDeepStrictEqual(updated, current)) return false;
      this.feed.replace(updated);
      return true;
    }
    this.feed.append(row, live);
    return true;
  }

  /** Link completion to its seated summary. Keep both unless adjacent. */
  private placeNotice(row: Block | undefined): void {
    const point = row?.meta?.firstKeptEntryId;
    if (row?.role !== "compaction-notice" || typeof point !== "string") return;
    this.notices.set(point, { rowId: row.id, body: row.text });
  }

  // Adjacent completion folds into the summary; separated completion links to
  // it.
  private showNoticeOnCompaction(pointId: string): boolean {
    const durableId = this.compactionCuts.get(pointId);
    const notice = this.notices.get(pointId);
    if (durableId === undefined || notice === undefined) return false;
    const position = this.feed.position(durableId);
    if (position === undefined) return false;
    const current = this.blocks[position]!;
    const noticePosition = this.feed.position(notice.rowId);
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
      this.feed.insert(target, folded);
      return this.showNoticeOnCompaction(pointId);
    }
    const seated = this.feed.has(String(current.meta?.jumpEntryId ?? pointId));
    const adjacent =
      seated &&
      this.blocks
        .slice(
          Math.min(position, noticePosition) + 1,
          Math.max(position, noticePosition),
        )
        .every((row) => row.role === "usage");
    const meta = { ...(current.meta ?? {}) };
    if (adjacent) meta.body = notice.body;
    else delete meta.body;
    if (!isDeepStrictEqual(current.meta, meta))
      this.feed.replace(Object.freeze({ ...current, meta }));
    if (adjacent) {
      notice.folded = this.blocks[noticePosition];
      this.feed.remove(notice.rowId);
    } else if (noticePosition !== undefined) {
      const row = this.blocks[noticePosition]!;
      if (row.meta?.summaryEntryId !== durableId)
        this.feed.replace(
          Object.freeze({
            ...row,
            meta: { ...row.meta, summaryEntryId: durableId },
          }),
        );
    }
    return true;
  }

  window(options?: Parameters<RowFeed["window"]>[0]) {
    this.touch();
    return this.feed.window(options);
  }
}
