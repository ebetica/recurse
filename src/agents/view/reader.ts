// Bounded inode-pinned async history reads never block the event loop.
// Caller supplies owner-filtered attachments/config; projection/reply policy
// stay injected. Preserve serialization budgets and reject unsafe byte offsets.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  AsyncJsonlRangeReader,
  HEADER_BYTES,
  VIEW_RAW_LINE_BYTES,
  assistantText,
  boundaryKind,
  entryIdentity,
  groupPiTurns,
  joinText,
  splitPiUserText,
  viewEntry,
  type ExpectedIdentity,
  type JsonObject,
  type PiTurnGroup,
} from "./session_entries";
import {
  LIVE_TOOL_OUTPUT_MAX,
  TurnStats,
  truncateToolDetail,
  type ToolStat,
} from "../../tool_projection/__init__";
import { containsSecret } from "../../tool_projection/redaction";

export type { JsonObject } from "./session_entries";

const VIEW_READ_BYTES = 4 << 20;
const VIEW_WINDOW_MAX = 100;
const VIEW_RESULT_MAX = LIVE_TOOL_OUTPUT_MAX;
const COMPLETED_REPLY_BATCH_MAX = 20;
const COMPLETED_REPLY_RESPONSE_MAX_BYTES = 1 << 20;
const COMPLETED_REPLY_SCAN_MAX_BYTES = 4 << 20;
const COMPLETED_REPLY_SCAN_MAX_LINES = 4000;
const COMPLETED_REPLY_WAIT_MAX_SECONDS = 30;
const COMPLETED_REPLY_ENVELOPE_RESERVE = 4096;
const PI_REPLY_CURSOR_VERSION = 1;
const SSE_RETRY_MS = 3000;
export const SSE_PAGE_LIMIT = 100;

export interface ViewInputs {
  readonly cid: string;
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly sessionCwd: string;
  readonly live: string;
  readonly envelope: string;
  readonly files: string;
  readonly maxSessionBytes: number;
  readonly unbound?: boolean;
}

export interface ViewFeed {
  readonly sessionKey: string;
  readonly position: number;
  readonly oldest: number | null;
  readonly tip: string | null;
  readonly parent: string | null;
}

export interface ViewBatch {
  readonly feed: ViewFeed;
  readonly entries: string;
  readonly reset: boolean;
  readonly caughtUp: boolean;
  readonly older: boolean;
}

export interface ConversationBlock {
  readonly id: string;
  readonly kind: string;
  readonly role: string;
  readonly text: string;
  readonly thinking?: string | null;
  readonly has_thinking?: true;
  readonly thinking_title?: string | null;
  readonly thinking_start_ms?: number;
  readonly live_thinking?: true;
  readonly origin: string;
  readonly name: string | null;
  readonly args: string;
  readonly result: string | null;
  readonly live: boolean;
  readonly usage: JsonObject | null;
  readonly meta: JsonObject | null;
  readonly calls?: readonly JsonObject[];
  readonly safety_usage: JsonObject | null;
  readonly timing?: {
    total_ms?: number;
    safety_ms?: number;
    command_ms?: number;
  };
  readonly model_time_ms?: number;
  readonly model_response?: JsonObject;
  readonly error: string | null;
  readonly error_detail: string | null;
  readonly stop_reason: string | null;
  readonly running: boolean;
  readonly input: string | null;
  readonly stat: ToolStat | null;
  readonly call_id: string | null;
  readonly artifact_id?: string;
  readonly order: number;
  readonly offset: number;
}

export interface ConversationSnapshot {
  readonly instance_id: string;
  readonly revision: number;
  readonly blocks: readonly ConversationBlock[];
  readonly older: boolean;
  readonly newer: boolean;
  readonly removed: readonly string[];
  readonly reset: boolean;
}

export interface ConversationProjection {
  readonly cid: string;
  readonly instance_id: string;
  readonly revision: number;
  readonly last_access: number;
  readonly attachments: Record<string, JsonObject[]>;
  touch(): void;
  idleFor(now?: number): number;
  reset(sessionKey: string): void;
  hasBlock(id: string): boolean;
  unresolvedAttachments(): string[];
  attachFiles(attachments: Record<string, JsonObject[]>): void;
  ingest(entries: readonly unknown[], live?: boolean): number;
  prepend(entries: readonly unknown[]): void;
  syncLive(entries: readonly JsonObject[], caughtUp: boolean): void;
  changes(since: number, limit: number): ConversationSnapshot;
  window(options: {
    after?: string | null;
    before?: string | null;
    limit?: number;
  }): ConversationSnapshot;
}

export interface ReplyReasonPolicy {
  readonly success: ReadonlySet<unknown>;
  readonly interrupted: ReadonlySet<unknown>;
  readonly tool: ReadonlySet<unknown>;
}

class AsyncMutex {
  private held = false;
  private readonly waiters: Array<(release: () => void) => void> = [];

  get locked(): boolean {
    return this.held;
  }

  acquire(): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.makeRelease());
      else this.held = false;
    };
  }
}

/** Projection lifetime, feed cursor and lock retire as one cache entry. */
export class ViewEntry {
  feed: ViewFeed = {
    sessionKey: "",
    position: 0,
    oldest: null,
    tip: null,
    parent: null,
  };
  readonly lock = new AsyncMutex();
  evictPending = false;
  readers = 0;

  constructor(readonly projection: ConversationProjection) {}

  get cid(): string {
    return this.projection.cid;
  }
  get instanceId(): string {
    return this.projection.instance_id;
  }
  get revision(): number {
    return this.projection.revision;
  }
  get lastAccess(): number {
    return this.projection.last_access;
  }
  get attachments(): Record<string, JsonObject[]> {
    return this.projection.attachments;
  }
  touch(): void {
    this.projection.touch();
  }
  idleFor(now?: number): number {
    return this.projection.idleFor(now);
  }
  reset(sessionKey: string): void {
    this.projection.reset(sessionKey);
  }
  hasBlock(id: string): boolean {
    return this.projection.hasBlock(id);
  }
  unresolvedAttachments(): string[] {
    return this.projection.unresolvedAttachments();
  }
  attachFiles(attachments: Record<string, JsonObject[]>): void {
    this.projection.attachFiles(attachments);
  }
  ingest(entries: JsonObject[]): number {
    return this.projection.ingest(entries);
  }
  prepend(entries: JsonObject[]): void {
    this.projection.prepend(entries);
  }
  syncLive(entries: JsonObject[], options: { caughtUp: boolean }): void {
    this.projection.syncLive(entries, options.caughtUp);
  }
  changes(since: number, limit: number): ConversationSnapshot {
    return this.projection.changes(since, limit);
  }
  window(options: {
    after?: string | null;
    before?: string | null;
    limit?: number;
  }): ConversationSnapshot {
    return this.projection.window(options);
  }
}

/** Bounded resident projections. Callers inject the conversation port. */
export class ViewCache {
  private readonly views = new Map<string, ViewEntry>();
  readonly maxViews: number;
  readonly idleTtl: number;

  constructor(
    private readonly createProjection: (cid: string) => ConversationProjection,
    options: { maxViews?: number; idleTtl?: number } = {},
  ) {
    this.maxViews = options.maxViews ?? 200;
    this.idleTtl = options.idleTtl ?? 600;
  }

  private retire(cid: string): boolean {
    const view = this.views.get(cid);
    if (view === undefined) return false;
    if (view.readers || view.lock.locked) {
      view.evictPending = true;
      return false;
    }
    this.views.delete(cid);
    return true;
  }

  drop(cid: string): boolean {
    return this.retire(cid);
  }

  evictIdle(now = performance.now() / 1000): string[] {
    const removed: string[] = [];
    for (const [cid, view] of this.views) {
      if (view.idleFor(now) > this.idleTtl && this.retire(cid))
        removed.push(cid);
    }
    return removed;
  }

  async *acquire(cid: string): AsyncGenerator<ViewEntry | null> {
    this.evictIdle();
    let view = this.views.get(cid);
    if (view === undefined) {
      const oldest = [...this.views.values()].sort(
        (left, right) => left.lastAccess - right.lastAccess,
      );
      for (const candidate of oldest) {
        if (this.views.size < this.maxViews) break;
        this.retire(candidate.cid);
      }
      if (this.views.size >= this.maxViews) {
        yield null;
        return;
      }
      view = new ViewEntry(this.createProjection(cid));
      this.views.set(cid, view);
    }
    // Invariant: Count lock waiters before yielding: eviction cannot replace an
    // identity while a queued reader is about to acquire the same projection.
    view.readers += 1;
    let release: (() => void) | null = null;
    try {
      release = await view.lock.acquire();
      view.touch();
      yield view;
    } finally {
      release?.();
      view.readers -= 1;
      if (view.evictPending && !view.readers) this.retire(cid);
    }
  }
}

export function unavailable(status = "unavailable"): JsonObject {
  return {
    status,
    instance_id: null,
    revision: 0,
    blocks: [],
    older: false,
    newer: false,
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Python json.dumps formatting and ensure_ascii, for persisted byte budgets.
function pythonJson(value: unknown, compact = false): string {
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new TypeError("value is not JSON serializable");
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const char = raw[index]!;
    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
      } else if (char === "\\") {
        output += char;
        escaped = true;
      } else if (char === '"') {
        output += char;
        inString = false;
      } else if (code > 0x7f) {
        const point = raw.codePointAt(index)!;
        if (point > 0xffff) {
          const adjusted = point - 0x10000;
          const high = 0xd800 + (adjusted >> 10);
          const low = 0xdc00 + (adjusted & 0x3ff);
          output += `\\u${high.toString(16)}\\u${low.toString(16)}`;
          index += 1;
        } else output += `\\u${code.toString(16).padStart(4, "0")}`;
      } else output += char;
    } else {
      output += char;
      if (char === '"') inString = true;
      else if (!compact && (char === "," || char === ":")) output += " ";
    }
  }
  return output;
}

function pythonJsonBytes(value: unknown, compact = false): number {
  return Buffer.byteLength(pythonJson(value, compact), "utf8");
}

function mergeCompactionMarkers(
  entries: JsonObject[],
  markers: JsonObject[],
  dangling: string | null,
): JsonObject[] {
  const chained = new Set(entries.map((entry) => entry.id));
  const fringe = new Set(chained);
  if (dangling !== null) fringe.add(dangling);
  for (const marker of markers) {
    if (!chained.has(marker.id) && fringe.has(marker.parentId))
      entries.push(marker);
  }
  entries.sort((left, right) => {
    const a = left._offset;
    const b = right._offset;
    return (typeof a === "number" ? a : -1) - (typeof b === "number" ? b : -1);
  });
  return entries;
}

async function olderViewEntries(
  reader: AsyncJsonlRangeReader,
  end: number,
  parent: string | null = null,
): Promise<[JsonObject[], number, number, string | null, string | null]> {
  let budget = VIEW_READ_BYTES;
  let rows: Array<[number, number, Uint8Array]> = [];
  let capped = false;
  let parsed: Array<[number, number, JsonObject]> = [];
  for (;;) {
    [rows, capped] = await reader.backwardLines(end, 0, budget, {
      stripImages: true,
    });
    parsed = [];
    let charged = 0;
    for (const [start, stop, raw] of rows) {
      const entry = viewEntry(raw);
      if (entry === null) continue;
      charged += pythonJsonBytes(entry);
      if (charged > VIEW_READ_BYTES && parsed.length > 0) {
        capped = true;
        break;
      }
      parsed.push([start, stop, entry]);
    }
    if (
      charged >= VIEW_READ_BYTES ||
      !capped ||
      budget >= VIEW_READ_BYTES + VIEW_RAW_LINE_BYTES
    )
      break;
    budget = Math.min(budget * 2, VIEW_READ_BYTES + VIEW_RAW_LINE_BYTES);
  }
  const entries: JsonObject[] = [];
  const markers: JsonObject[] = [];
  let oldest = parsed.length
    ? Math.min(...parsed.map(([start]) => start))
    : capped
      ? Math.max(0, end - Math.max(1, Math.floor(budget / 2)))
      : 0;
  const position = parsed.length
    ? Math.max(...parsed.map(([, stop]) => stop))
    : end;
  let tip = parent;
  for (const [start, , entry] of parsed) {
    const identity = entryIdentity(entry);
    if (identity === null) continue;
    if (tip === null) {
      if (entry.type === "compaction") {
        markers.push({ ...entry, _offset: start });
        continue;
      }
      tip = identity[0];
      parent = identity[0];
    }
    if (identity[0] !== parent) {
      if (entry.type === "compaction")
        markers.push({ ...entry, _offset: start });
      continue;
    }
    entries.push({ ...entry, _offset: start });
    parent = identity[1];
    if (parent === null) {
      // Invariant: Reaching the beginning ends the chain, but earlier
      // compaction leaves remain eligible for subsequent page walks.
      oldest = 0;
      break;
    }
  }
  if (markers.length)
    return [
      mergeCompactionMarkers(entries, markers, parent),
      oldest,
      position,
      parent,
      tip,
    ];
  entries.reverse();
  return [entries, oldest, position, parent, tip];
}

/** Bounded file pass over supervisor-supplied immutable values. */
export async function readBatch(
  inputs: ViewInputs,
  feed: ViewFeed,
  options: { older?: boolean } = {},
): Promise<ViewBatch> {
  const path = inputs.sessionFile;
  if (path === null) throw new Error("session unavailable");
  const unpinned = new AsyncJsonlRangeReader(path);
  const info = await unpinned.sessionInfo();
  if (info.size > inputs.maxSessionBytes)
    throw new Error("unsafe session file");
  const rawKey = `${inputs.sessionId}\0${path}\0${info.identity[0]}\0${info.identity[1]}`;
  const key = createHash("sha256")
    .update(rawKey, "utf8")
    .digest("hex")
    .slice(0, 24);
  const reset = feed.sessionKey !== key || feed.position > info.size;
  const source = new AsyncJsonlRangeReader(path, info.identity);
  if (options.older && !reset && feed.oldest) {
    const [entries, oldest, , parent] = await olderViewEntries(
      source,
      feed.oldest,
      feed.parent,
    );
    return {
      feed: {
        sessionKey: key,
        position: feed.position,
        oldest,
        tip: feed.tip,
        parent,
      },
      entries: pythonJson(entries),
      reset: false,
      caughtUp: false,
      older: true,
    };
  }
  let activeFeed = feed;
  let entries: JsonObject[] = [];
  if (reset || feed.oldest === null) {
    const [initial, oldest, position, parent, tip] = await olderViewEntries(
      source,
      info.size,
    );
    entries = initial;
    activeFeed = { sessionKey: key, position, oldest, tip, parent };
  }
  const [rows, position, caughtUp] = await source.forwardPage(
    activeFeed.position,
    {
      maxBytes: VIEW_READ_BYTES,
      maxLines: 10_000,
      stripImages: true,
    },
  );
  const forward: JsonObject[] = rows.map(([start, , entry]) => ({
    ...entry,
    _offset: start,
  }));
  let tip = activeFeed.tip;
  let branched = false;
  for (const entry of forward) {
    if (entry.type === "compaction") continue;
    const identity = entryIdentity(entry);
    if (identity !== null) {
      branched ||= tip !== null && identity[1] !== tip;
      tip = identity[0];
    }
  }
  if (branched) {
    const [rebuilt, oldest, newPosition, parent, newTip] =
      await olderViewEntries(source, info.size);
    entries = rebuilt;
    activeFeed = {
      sessionKey: key,
      position: newPosition,
      oldest,
      tip: newTip,
      parent,
    };
    return {
      feed: activeFeed,
      entries: pythonJson(entries),
      reset: true,
      caughtUp: false,
      older: false,
    };
  }
  entries.push(...forward);
  return {
    feed: {
      sessionKey: key,
      position,
      oldest: activeFeed.oldest,
      tip,
      parent: activeFeed.parent,
    },
    entries: pythonJson(entries),
    reset,
    caughtUp,
    older: false,
  };
}

export function applyBatch(
  view: ViewEntry,
  generation: string,
  batch: ViewBatch,
): boolean {
  if (view.evictPending || view.instanceId !== generation) return false;
  if (batch.reset) view.reset(batch.feed.sessionKey);
  const entries = JSON.parse(batch.entries) as JsonObject[];
  if (batch.older) view.prepend(entries);
  else view.ingest(entries);
  view.feed = batch.feed;
  return true;
}

export class CompletedReplyCursorError extends Error {
  constructor(message = "", options?: ErrorOptions) {
    super(message, options);
    this.name = "CompletedReplyCursorError";
  }
}
export class CompletedReplyCursorExpired extends Error {
  constructor(message = "", options?: ErrorOptions) {
    super(message, options);
    this.name = "CompletedReplyCursorExpired";
  }
}
export class CompletedReplyStorageUnavailable extends Error {
  constructor(message = "", options?: ErrorOptions) {
    super(message, options);
    this.name = "CompletedReplyStorageUnavailable";
  }
}

function completedReplySize(reply: JsonObject): number {
  return pythonJsonBytes(reply, true);
}

function boundedCompletedReply(reply: JsonObject): JsonObject {
  const limit =
    COMPLETED_REPLY_RESPONSE_MAX_BYTES - COMPLETED_REPLY_ENVELOPE_RESERVE;
  if (completedReplySize(reply) <= limit) return reply;
  const bounded: JsonObject = { ...reply, content: "", truncated: true };
  const content = reply.content;
  if (typeof content !== "string") return bounded;
  const points = Array.from(content);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    bounded.content = points.slice(0, middle).join("");
    if (completedReplySize(bounded) <= limit) low = middle;
    else high = middle - 1;
  }
  bounded.content = points.slice(0, low).join("");
  return bounded;
}

function groupAssistants(
  group: PiTurnGroup,
): [Array<[string, string, unknown, unknown]>, unknown] {
  const assistants: Array<[string, string, unknown, unknown]> = [];
  for (const [, , entry] of group.rows) {
    const text = assistantText(entry);
    if (text === null) continue;
    const message = isRecord(entry.message) ? entry.message : null;
    assistants.push([
      entryIdentity(entry)?.[0] ?? "",
      text,
      message?.stopReason,
      entry.timestamp,
    ]);
  }
  return [assistants, assistants.at(-1)?.[2] ?? null];
}

function groupReply(
  group: PiTurnGroup,
  reasons: ReplyReasonPolicy,
): JsonObject | null {
  if (group.closed_by === null) return null;
  const [assistants, terminal] = groupAssistants(group);
  const last = assistants.at(-1);
  if (last === undefined || !last[0]) return null;
  if (reasons.interrupted.has(terminal) || reasons.tool.has(terminal))
    return null;
  const status = reasons.success.has(terminal) ? "idle" : "error";
  const content = joinText(
    assistants.map(([id, text]) => [id, text] as [string, string]),
  ).content;
  return boundedCompletedReply({
    id: `pi:${last[0]}`,
    content,
    status,
    completed_at: last[3],
  });
}

function encodeReplyCursor(
  cid: string,
  key: string,
  offset: number,
  entryId: string,
): string {
  const raw = pythonJson(
    [PI_REPLY_CURSOR_VERSION, cid, key, offset, entryId],
    true,
  );
  return Buffer.from(raw, "utf8").toString("base64url");
}

function decodeBase64Json(token: string): unknown {
  try {
    const bytes = Buffer.from(token, "base64url");
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(copy);
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CompletedReplyCursorError("invalid completed-reply cursor", {
      cause: error,
    });
  }
}

function decodeReplyCursor(
  cid: string,
  token: string | null,
  key: string,
  size: number,
): [number, string] {
  if (token === null || token === "") return [0, ""];
  const decoded = decodeBase64Json(token);
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 5 ||
    typeof decoded[0] !== "number" ||
    !Number.isSafeInteger(decoded[0]) ||
    decoded[0] !== PI_REPLY_CURSOR_VERSION
  )
    throw new CompletedReplyCursorExpired(
      "completed-reply cursor predates retained history",
    );
  if (decoded[1] !== cid || typeof decoded[4] !== "string")
    throw new CompletedReplyCursorError("invalid completed-reply cursor");
  if (decoded[2] !== key)
    throw new CompletedReplyCursorExpired(
      "completed-reply cursor predates retained history",
    );
  const offset = decoded[3];
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
    throw new CompletedReplyCursorError("invalid completed-reply cursor");
  if (offset > size)
    throw new CompletedReplyCursorExpired(
      "completed-reply cursor predates retained history",
    );
  return [offset, decoded[4]];
}

function replyBindingKey(
  sessionId: string,
  sessionFile: string,
  identity: ExpectedIdentity,
): string {
  const value = `${sessionId}\0${sessionFile}\0${identity[0]}\0${identity[1]}`;
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** One bounded forward page of completed Pi turns, oldest first. */
export async function completedReplyPage(
  cid: string,
  sessionId: string,
  sessionFile: string,
  sessionCwd: string,
  token: string | null,
  options: {
    status: JsonObject;
    maxSessionBytes: number;
    reasons: ReplyReasonPolicy;
  },
  batchLimit: number = COMPLETED_REPLY_BATCH_MAX,
): Promise<JsonObject> {
  let info: Awaited<ReturnType<AsyncJsonlRangeReader["sessionInfo"]>>;
  try {
    info = await new AsyncJsonlRangeReader(sessionFile).sessionInfo();
  } catch (error) {
    if (isMissingFile(error))
      throw new CompletedReplyCursorExpired(
        "completed-reply cursor predates retained history",
        { cause: error },
      );
    throw new CompletedReplyStorageUnavailable();
  }
  if (info.size > options.maxSessionBytes)
    throw new CompletedReplyStorageUnavailable();
  const key = replyBindingKey(sessionId, sessionFile, info.identity);
  const [offset, expectedId] = decodeReplyCursor(cid, token, key, info.size);
  const source = new AsyncJsonlRangeReader(sessionFile, info.identity);
  let ranged: Array<[number, number, JsonObject]>;
  let end: number;
  let eof: boolean;
  try {
    if (offset < info.size && expectedId) {
      const probe = await source.entryAt(offset, HEADER_BYTES);
      const identity = probe === null ? null : entryIdentity(probe);
      if (identity === null || identity[0] !== expectedId)
        throw new CompletedReplyCursorExpired(
          "completed-reply cursor predates retained history",
        );
    }
    const header = await source.entryAt(0, HEADER_BYTES);
    if (
      header === null ||
      header.type !== "session" ||
      header.id !== sessionId ||
      header.cwd !== sessionCwd
    )
      throw new CompletedReplyCursorExpired(
        "completed-reply cursor predates retained history",
      );
    [ranged, end, eof] = await source.forwardPage(offset, {
      maxBytes: COMPLETED_REPLY_SCAN_MAX_BYTES,
      maxLines: COMPLETED_REPLY_SCAN_MAX_LINES,
    });
  } catch (error) {
    if (
      error instanceof CompletedReplyCursorError ||
      error instanceof CompletedReplyCursorExpired
    )
      throw error;
    throw new CompletedReplyStorageUnavailable();
  }
  let limit = COMPLETED_REPLY_BATCH_MAX;
  try {
    limit = Math.min(
      Math.max(pythonInt(batchLimit), 1),
      COMPLETED_REPLY_BATCH_MAX,
    );
  } catch {
    // Invariant: Python's caller normally supplies an integer; its public
    // helper clamps non-convertible page sizes back to the module default.
  }
  const budget =
    COMPLETED_REPLY_RESPONSE_MAX_BYTES - COMPLETED_REPLY_ENVELOPE_RESERVE;
  const replies: JsonObject[] = [];
  let replyBytes = 0;
  let resume: [number, string] | null = null;
  let unemittedClosed = false;
  const groups = groupPiTurns(ranged.map(([start, , entry]) => [start, entry]));
  for (const group of groups) {
    if (group.closed_by === null) {
      resume = [group.start_offset, group.start_entry_id];
      break;
    }
    const reply = groupReply(group, options.reasons);
    if (reply === null) continue;
    const encoded = completedReplySize(reply);
    if (
      replies.length &&
      (replies.length >= limit || replyBytes + encoded > budget)
    ) {
      resume = [group.start_offset, group.start_entry_id];
      unemittedClosed = true;
      break;
    }
    replies.push(reply);
    replyBytes += encoded;
  }
  if (resume === null) {
    if (end < info.size) {
      let identity: [string, string | null] | null = null;
      try {
        const probe = await source.entryAt(end, HEADER_BYTES);
        identity = probe === null ? null : entryIdentity(probe);
      } catch {
        // Invariant: Resume at the scan boundary with an empty expected id if
        // the next record is malformed or the page boundary raced a torn write.
      }
      resume = [end, identity?.[0] ?? ""];
    } else resume = [end, ""];
  }
  return {
    replies,
    next_cursor: encodeReplyCursor(cid, key, resume[0], resume[1]),
    has_more: unemittedClosed || !eof,
    status: options.status,
  };
}

function pythonFloat(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const text = stripPythonWhitespace(value);
    if (
      !text ||
      !/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/iu.test(
        text,
      )
    )
      throw new TypeError("invalid float");
    if (/^[+-]?inf(?:inity)?$/iu.test(text))
      return text.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/iu.test(text)) return Number.NaN;
    return Number(text);
  }
  throw new TypeError("invalid float");
}

function pythonInt(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid integer");
    return Math.trunc(value);
  }
  if (
    typeof value === "string" &&
    /^[\t\n\v\f\r \u001c-\u0020]*[+-]?\d+[\t\n\v\f\r \u001c-\u0020]*$/u.test(
      value,
    )
  ) {
    const parsed = Number(stripPythonWhitespace(value));
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new TypeError("invalid integer");
}

export function replyPollWindow(
  wait: unknown,
  batchLimit: unknown,
): [number, number] {
  let waitSeconds: number;
  try {
    waitSeconds = pythonFloat(wait);
  } catch {
    throw new RangeError("wait must be a finite number");
  }
  if (!Number.isFinite(waitSeconds))
    throw new RangeError("wait must be a finite number");
  let limit = COMPLETED_REPLY_BATCH_MAX;
  try {
    limit = Math.min(
      Math.max(pythonInt(batchLimit), 1),
      COMPLETED_REPLY_BATCH_MAX,
    );
  } catch {}
  return [
    Math.min(Math.max(waitSeconds, 0), COMPLETED_REPLY_WAIT_MAX_SECONDS),
    limit,
  ];
}

export function unboundReplyPage(
  cursor: string | null,
  sessionNamed: boolean,
  status: JsonObject,
): JsonObject {
  if (cursor && sessionNamed) {
    decodeBase64Json(cursor);
    throw new CompletedReplyCursorExpired(
      "completed-reply cursor predates retained history",
    );
  }
  return { replies: [], next_cursor: cursor, has_more: false, status };
}

const PYTHON_WHITESPACE_EDGES =
  /^[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;

function stripPythonWhitespace(value: string): string {
  return value.replace(PYTHON_WHITESPACE_EDGES, "");
}

const THINKING_READ_MAX_BYTES = 1 << 20;
const THINKING_READ_MAX_CHARS = 8000;

/** Bounded full thinking text for one authorized assistant entry. */
export async function thinkingText(
  sessionFile: string,
  offset: number | boolean,
): Promise<JsonObject | null> {
  if (
    typeof offset !== "boolean" &&
    (!Number.isSafeInteger(offset) || offset < 0)
  )
    return null;
  try {
    const entry = await new AsyncJsonlRangeReader(sessionFile).entryAt(
      Number(offset),
      THINKING_READ_MAX_BYTES,
    );
    const message = entry?.message;
    if (!message || typeof message !== "object" || Array.isArray(message))
      return null;
    if ((message as JsonObject).role !== "assistant") return null;
    const content = (message as JsonObject).content;
    if (!Array.isArray(content)) return null;
    const parts = content
      .filter(
        (part): part is JsonObject =>
          typeof part === "object" &&
          part !== null &&
          !Array.isArray(part) &&
          part.type === "thinking" &&
          typeof part.thinking === "string",
      )
      .map((part) => part.thinking as string)
      .filter((part) => part.trim());
    if (!parts.length) return null;
    const text = parts.join("\n\n");
    const chars = [...text];
    return {
      text:
        chars.length > THINKING_READ_MAX_CHARS
          ? `${chars.slice(0, THINKING_READ_MAX_CHARS - 1).join("")}…`
          : text,
    };
  } catch {
    return null;
  }
}

/** Summary text for a compaction marker at its exact byte offset. */
export async function markerSummary(
  sessionFile: string,
  offset: number | boolean,
): Promise<JsonObject | null> {
  if (
    typeof offset !== "boolean" &&
    (!Number.isSafeInteger(offset) || offset < 0)
  )
    return null;
  try {
    const entry = await new AsyncJsonlRangeReader(sessionFile).entryAt(
      Number(offset),
      HEADER_BYTES,
    );
    if (entry === null || boundaryKind(entry) !== "compaction") return null;
    const summary = entry.summary;
    if (typeof summary !== "string" || !stripPythonWhitespace(summary))
      return null;
    return { summary, marker: "compact" };
  } catch {
    return null;
  }
}

function blockSender(text: string): [string | null, string | null] {
  const [, sender, senderName] = splitPiUserText(text);
  return [sender, senderName];
}

function servedBlock(
  block: ConversationBlock,
  files: readonly JsonObject[] = [],
): JsonObject {
  // Invariant: truncateToolDetail returns a result that fits unchanged, reading
  // only a bounded prefix of a long one.
  const result =
    block.result === null
      ? null
      : truncateToolDetail(block.result, VIEW_RESULT_MAX);
  const truncated = result !== block.result;
  let sender: string | null = null;
  let senderName: string | null = null;
  if (block.kind === "text" && block.role === "user")
    [sender, senderName] = blockSender(block.text);
  let prLinks: unknown[] = [];
  const stat = block.stat ?? {};
  if (stat.action === "pr_create" || stat.action === "pr_merge") {
    const summary = new TurnStats();
    summary.record(block.name, block.args, block.result, stat);
    const links = summary.summary().pr_links;
    prLinks = Array.isArray(links) ? links : [];
  }
  return {
    id: block.id,
    ...(block.artifact_id ? { artifact_id: block.artifact_id } : {}),
    order: block.order,
    offset: block.offset,
    kind: block.kind,
    role: block.role,
    text: block.text,
    ...(block.thinking ? { thinking_title: block.thinking } : {}),
    ...(block.has_thinking ? { has_thinking: true } : {}),
    ...(typeof block.thinking_start_ms === "number"
      ? {
          thinking_elapsed_ms: Math.max(
            0,
            Date.now() - block.thinking_start_ms,
          ),
        }
      : {}),
    ...(block.live_thinking ? { live_thinking: true } : {}),
    origin: block.origin,
    name: block.name,
    args: block.args,
    result,
    ...(block.running && block.result !== null
      ? {
          tool_output_tail: containsSecret(block.result)
            ? "Output withheld"
            : block.result.slice(-4000).split("\n").slice(-5).join("\n"),
        }
      : {}),
    result_truncated: truncated,
    live: block.live,
    usage: block.usage,
    meta: block.meta,
    safety_usage: block.safety_usage,
    ...(block.timing ? { timing: block.timing } : {}),
    ...(block.model_response ? { model_response: block.model_response } : {}),
    ...(block.model_time_ms !== undefined
      ? { model_time_ms: block.model_time_ms }
      : {}),
    error: block.error,
    error_detail: block.error_detail,
    stop_reason: block.stop_reason,
    running: block.running,
    input: block.input,
    sender,
    sender_name: senderName,
    stat: block.stat,
    // Invariant: The tool publishes one file per call; a bash call may publish
    // many.
    attachment:
      block.name === "bash" || block.name === "publish"
        ? null
        : (files[0] ?? null),
    pr_links: prLinks,
    ...(block.calls ? { calls: block.calls } : {}),
    ...((block.name === "bash" || block.name === "publish") && files.length
      ? { files }
      : {}),
  };
}

/** Served page projection; conversation mutation remains injected. */
export function window(
  view: ViewEntry,
  inputs: ViewInputs,
  options: {
    caughtUp: boolean;
    after?: string | null;
    before?: string | null;
    limit?: number;
    since?: number | null;
    instance?: string | null;
  } = { caughtUp: false },
): JsonObject {
  const live = JSON.parse(inputs.live) as JsonObject[];
  view.syncLive(live, { caughtUp: options.caughtUp });
  view.attachFiles(JSON.parse(inputs.files) as Record<string, JsonObject[]>);
  const envelope = JSON.parse(inputs.envelope) as JsonObject;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), VIEW_WINDOW_MAX);
  const page =
    options.since !== null &&
    options.since !== undefined &&
    options.instance === view.instanceId
      ? view.changes(options.since, limit)
      : view.window({ after: options.after, before: options.before, limit });
  return {
    status: "ready",
    instance_id: page.instance_id,
    revision: view.revision,
    session: inputs.sessionId,
    blocks: page.blocks.map((block) =>
      servedBlock(block, view.attachments[block.call_id || block.id]),
    ),
    older: page.older || Boolean(view.feed.oldest),
    newer: page.newer,
    removed: page.removed,
    reset: page.reset,
    ...envelope,
  };
}

export function needsOlder(
  view: ViewEntry,
  before: string | null,
  limit: number,
): boolean {
  return (
    Boolean(view.feed.oldest) &&
    (view.window({ limit: 1 }).blocks.length === 0 ||
      (before !== null &&
        view.hasBlock(before) &&
        !view.window({ before, limit }).older))
  );
}

function parsePythonInteger(value: string): number | null {
  if (
    !/^[\t\n\v\f\r\u001c-\u0020]*[+-]?\d+[\t\n\v\f\r\u001c-\u0020]*$/u.test(
      value,
    )
  )
    return null;
  const parsed = Number(stripPythonWhitespace(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseEventCursor(
  value: string | null,
): [string | null, number | null] {
  if (typeof value !== "string" || !value) return [null, null];
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return [null, null];
  const since = parsePythonInteger(value.slice(separator + 1));
  if (since === null || since < 0) return [null, null];
  return [value.slice(0, separator), since];
}

function pythonString(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** One compact SSE frame; live work reconnects sooner than idle pages. */
export function sseFrame(kind: string, page: JsonObject): Uint8Array {
  const retry =
    page.active_run ||
    (Array.isArray(page.blocks) &&
      page.blocks.some((block: JsonObject) => block?.live === true))
      ? 500
      : SSE_RETRY_MS;
  const payload = pythonJson(page, true);
  const cursor = `${pythonString(page.instance_id)}:${pythonString(page.revision)}`;
  const bytes = Buffer.from(
    `retry: ${retry}\nevent: ${kind}\nid: ${cursor}\ndata: ${payload}\n\n`,
    "utf8",
  );
  const output = new Uint8Array(new ArrayBuffer(bytes.length));
  output.set(bytes);
  return output;
}
