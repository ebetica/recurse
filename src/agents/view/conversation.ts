// Pure immutable row projection reconciles history by stable entry identity.
// No I/O, Pi launch or state writes; durable history remains source of truth.
// Live drafts replace the tail and persisted entries promote rows in place.
// Offsets beyond Number.MAX_SAFE_INTEGER are unsupported.

import { randomUUID } from "node:crypto";
import { modelResponse } from "./model_response";
import { performance } from "node:perf_hooks";
import {
  describeTurnFailure,
  isRefusal,
  retriedNotice,
  retryReason,
} from "./failure_sentences";
import {
  entry as sessionEntry,
  entryIdentity,
  LINE_BYTES,
  type JsonObject,
} from "./session_entries";
import {
  oneLine,
  providerUsage,
  readLines,
  summarizeSafetyResults,
  toolCallDetails,
  toolStat,
  truncateToolDetail,
  validCostScope,
  validUsageCost,
  validUsageCount,
  USAGE_KEYS,
  TOOL_COMMAND_MAX,
} from "../../tool_projection/__init__";

export type { JsonObject } from "./session_entries";

export interface Block {
  readonly id: string;
  readonly kind: string;
  readonly role: string;
  readonly text: string;
  /** Bounded latest bold heading; full thinking is lazy-loaded by offset. */
  readonly thinking?: string | null;
  readonly has_thinking?: true;
  readonly thinking_start_ms?: number;
  /** Set while a live thinking title overlays this persisted row. */
  readonly live_thinking?: true;
  readonly origin: string;
  readonly name: string | null;
  readonly args: string;
  readonly result: string | null;
  readonly live: boolean;
  readonly usage: JsonObject | null;
  readonly stat: Record<string, number | string> | null;
  readonly call_id: string | null;
  readonly artifact_id?: string;
  readonly order: number;
  readonly offset: number;
  readonly safety_usage: JsonObject | null;
  /** Bounded extension timings copied from the recorded tool result. */
  readonly timing?: ToolTiming;
  /** Model request-to-response duration, retained only on assistant rows. */
  readonly model_time_ms?: number;
  readonly model_response?: JsonObject;
  readonly error: string | null;
  readonly error_detail: string | null;
  readonly stop_reason: string | null;
  readonly running: boolean;
  readonly input: string | null;
  readonly meta: JsonObject | null;
  /** Codemode nested calls from the result's details.calls, bounded. */
  readonly calls?: readonly JsonObject[];
}

export interface Snapshot {
  readonly instance_id: string;
  readonly revision: number;
  readonly blocks: readonly Block[];
  readonly older: boolean;
  readonly newer: boolean;
  readonly removed: readonly string[];
  readonly reset: boolean;
}

export interface ToolTiming {
  total_ms?: number;
  safety_ms?: number;
  command_ms?: number;
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
type StreamMarker = [event: string, details: JsonObject];

// Node/Bun abort wording fallback for entries without structured error fields.
const ABORT_ERROR_TEXTS = new Set([
  "This operation was aborted",
  "The operation was aborted.",
  "Operation aborted",
]);

function isAbortMessage(message: JsonObject, rawError: string | null): boolean {
  const stopReason = message.stopReason;
  const errorName = message.errorName ?? message.error_name;
  return (
    stopReason === "aborted" ||
    stopReason === "abort" ||
    errorName === "AbortError" ||
    (rawError !== null && ABORT_ERROR_TEXTS.has(rawError))
  );
}
const BG_SHELL_CUSTOM_TYPE = "bg-shell";
const AUTO_RETRY_CUSTOM_TYPE = "recurse.auto-retry";
const THINKING_HEADING_MAX_CHARS = 200;
const REDACTED_THINKING =
  /^(?:\[?(?:redacted|encrypted)(?:[ _-](?:thinking|reasoning))?\]?|<encrypted>)+$/iu;

export interface ThinkingInfo {
  title: string | null;
  hasThinking: boolean;
}

/** Extract only a bounded title and presence flag; prose stays session-only. */
export function thinkingInfo(content: unknown): ThinkingInfo {
  if (!Array.isArray(content)) return { title: null, hasThinking: false };
  let title: string | null = null;
  let hasThinking = false;
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    if ((block as JsonObject).type !== "thinking") continue;
    const thinking = (block as JsonObject).thinking;
    if (typeof thinking !== "string") continue;
    const text = thinking.trim();
    if (!text || REDACTED_THINKING.test(text)) continue;
    hasThinking = true;
    for (const match of thinking.matchAll(/\*\*(.+?)\*\*/gu)) {
      const heading = match[1]?.trim();
      if (heading)
        title = [...heading].slice(0, THINKING_HEADING_MAX_CHARS).join("");
    }
  }
  return { title, hasThinking };
}

const BG_SHELL_INTERNAL_ERROR = "[pi-bg-shell] internal error:";
const BG_SHELL_NOTICE_BODY_MAX = 8000;
const BG_SHELL_COMMAND_MAX = 80;
const BG_SHELL_LABEL_MAX = 160;
const BG_SHELL_SINGLE_RE =
  /^Shell `([^`]+)` \((.*)\) (exited (\S+)|killed by (\S+)) after (\S+)/u;
const BG_SHELL_FAILED_RE = /^Shell `([^`]+)` failed to start:(.*)$/su;
const BG_SHELL_BATCH_RE = /^(\d+) background commands completed/u;
const COMPACTION_NOTICE_CUSTOM_TYPE = "recurse.compaction-notice";
// Lost tasks never become retried notices, even with a later same-turn reply.
export const LOST_STOP_REASON = "lost";
const COMPACTION_NOTICE_MAX = 1200;
const COMPACTION_FAILED_TYPE = "recurse.compaction-failed";
const COMPACTION_FAILED_REASON_MAX = 200;
const COMPACT_PENDING_TYPE = "recurse.compact-pending";
const SHELL_ID_MAX = 128;
const SHELL_COMMAND_MAX = 300;
const SHELL_PATH_MAX = 512;

const PYTHON_WHITESPACE =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYTHON_TRIM_RE = new RegExp(
  `^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`,
  "gu",
);
const PYTHON_LINES_GLOBAL_RE = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/gu;

// Native publish rows and historical publication calls look up owned files.
export function publishesFiles(row: {
  name: string | null;
  args: string;
  input: string | null;
}): boolean {
  if (row.name === "publish" || row.name === "publish_attachment") return true;
  return (
    row.name === "bash" &&
    `${row.args}\n${row.input ?? ""}`.includes("tools/publish.ts")
  );
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness for JSON values, including empty collections. */
function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (object(value)) return Object.keys(value).length > 0;
  return true;
}

function pythonStrip(value: string): string {
  return value.replace(PYTHON_TRIM_RE, "");
}

function timingMs(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

// Copy only the extension-owned, bounded timing from a real Pi tool result.
// Malformed components discard the whole
// timing object, while missing optional components remain absent.
function resultTiming(message: JsonObject): ToolTiming | null {
  const details = message.details;
  const raw = object(details) ? details.recurseToolTiming : null;
  if (!object(raw) || raw.version !== 1) return null;
  const total = timingMs(raw.totalMs);
  if (total === null) return null;
  const timing: ToolTiming = { total_ms: total };
  for (const [source, target] of [
    ["safetyWaitMs", "safety_ms"],
    ["commandMs", "command_ms"],
  ] as const) {
    if (!(source in raw)) continue;
    const elapsed = timingMs(raw[source]);
    if (elapsed === null || elapsed > total) return null;
    timing[target] = elapsed;
  }
  return timing;
}

function pythonSplitlines(value: string): string[] {
  return value.split(PYTHON_LINES_GLOBAL_RE);
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function codePointSlice(value: string, end: number): string {
  return codePoints(value).slice(0, end).join("");
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (object(left) || object(right)) {
    if (!object(left) || !object(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && deepEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function block(
  id: string,
  kind: string,
  role: string,
  text = "",
  origin = "user",
  extra: Partial<Block> = {},
): Block {
  return Object.freeze({
    id,
    kind,
    role,
    text,
    origin,
    name: null,
    args: "",
    result: null,
    live: false,
    usage: null,
    stat: null,
    call_id: null,
    order: 0,
    offset: -1,
    safety_usage: null,
    error: null,
    error_detail: null,
    stop_reason: null,
    running: false,
    input: null,
    meta: null,
    ...extra,
  });
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

/** Parse complete JSONL lines and retain the final partial line. */
export function splitComplete(buffer: Uint8Array): [JsonObject[], Uint8Array] {
  const entries: JsonObject[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 10) continue;
    const raw = buffer.subarray(start, index);
    start = index + 1;
    let hasContent = false;
    for (const byte of raw) {
      if (![9, 10, 11, 12, 13, 28, 29, 30, 31, 32].includes(byte)) {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) continue;
    try {
      const parsed = sessionEntry(raw);
      if (parsed !== null) {
        entries.push(parsed);
      } else if (raw.length > LINE_BYTES) {
        // Invariant: split_complete historically did not cap a line. Keep that
        // behavior for a valid oversized Pi record while normal rows share the
        // bounded session-entry decoder.
        const oversized: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
        if (object(oversized)) entries.push(oversized);
      }
    } catch {
      // Invariant: A malformed complete line is ignored; only a trailing
      // partial is held.
    }
  }
  return [entries, buffer.slice(start)];
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let joined = "";
  for (const item of content) {
    if (object(item) && item.type === "text" && typeof item.text === "string")
      joined += item.text;
  }
  return joined;
}

function originOf(value: string, role: string): string {
  if (role === "assistant") return "assistant";
  for (let line of pythonSplitlines(value)) {
    line = pythonStrip(line);
    if (!line.startsWith("[recurse-origin:") || !line.endsWith("]")) continue;
    const claimed = pythonStrip(line.slice("[recurse-origin:".length, -1));
    if (claimed === "operator" || claimed === "agent") return claimed;
    if (["service", "scheduled", "platform"].includes(claimed)) return claimed;
  }
  return "user";
}

function pythonJsonStringify(value: unknown): string | null {
  try {
    const encoded = JSON.stringify(value, (_key, item: unknown) =>
      item === undefined ||
      typeof item === "bigint" ||
      typeof item === "function" ||
      typeof item === "symbol"
        ? String(item)
        : item,
    );
    if (encoded === undefined) return null;
    // Invariant: Python json.dumps defaults to ensure_ascii=True.
    // JSON.stringify leaves non-ASCII characters literal, so escape each UTF-16
    // unit (including both halves of a supplementary code point) using
    // lowercase hex.
    return encoded.replace(
      /[\u007f-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  } catch {
    return null;
  }
}

function displayArgs(argumentsValue: unknown): string {
  if (argumentsValue === null || argumentsValue === undefined) return "";
  const raw =
    typeof argumentsValue === "string"
      ? argumentsValue
      : pythonJsonStringify(argumentsValue);
  return raw === null ? "" : oneLine(raw);
}

function completeArgs(argumentsValue: unknown): boolean {
  if (object(argumentsValue)) return true;
  if (typeof argumentsValue !== "string") return false;
  try {
    return object(JSON.parse(argumentsValue) as unknown);
  } catch {
    return false;
  }
}

function displayToolArgs(name: unknown, argumentsValue: unknown): string {
  if (name === "bash" && object(argumentsValue))
    return displayArgs(
      Object.hasOwn(argumentsValue, "command")
        ? argumentsValue.command
        : argumentsValue,
    );
  let value = displayArgs(argumentsValue);
  if (
    typeof argumentsValue === "string" &&
    value &&
    !completeArgs(argumentsValue)
  ) {
    value = truncateToolDetail(value, TOOL_COMMAND_MAX);
  }
  return value;
}

const CODEMODE_CALLS_MAX = 100;
const CODEMODE_TEXT_MAX = 300;
const CODEMODE_STATUSES = new Set(["running", "ok", "error", "cancelled"]);

/** Bound a codemode result's details.calls to plain one-line display fields. */
export function codemodeCalls(details: unknown): JsonObject[] | null {
  if (!object(details) || !Array.isArray(details.calls)) return null;
  const text = (value: unknown): string =>
    typeof value === "string"
      ? truncateToolDetail(oneLine(value), CODEMODE_TEXT_MAX)
      : "";
  const calls: JsonObject[] = [];
  for (const call of details.calls.slice(0, CODEMODE_CALLS_MAX)) {
    if (!object(call)) continue;
    const status = CODEMODE_STATUSES.has(call.status as string)
      ? (call.status as string)
      : "running";
    const entry: JsonObject = {
      name: text(call.name) || "tool",
      args: text(call.args),
      status,
      stat: toolStat(
        typeof call.name === "string" ? call.name : null,
        call.args,
        null,
      ),
    };
    if (typeof call.durationMs === "number" && call.durationMs >= 0)
      entry.durationMs = Math.round(call.durationMs);
    const error = text(call.error).replace(
      /^Tool call blocked: (?=\[pi-safety\])/,
      "",
    );
    if (error) entry.error = error;
    calls.push(entry);
  }
  // Invariant: Display rows are capped; their tail retains only grouped stats.
  const alreadyOmitted =
    typeof details.omitted_calls === "number" && details.omitted_calls > 0
      ? Math.floor(details.omitted_calls)
      : 0;
  const omitted =
    Math.max(0, details.calls.length - CODEMODE_CALLS_MAX) + alreadyOmitted;
  if (omitted > 0) {
    const summary = new Map<string, JsonObject>();
    for (const call of details.calls.slice(CODEMODE_CALLS_MAX)) {
      if (!object(call)) continue;
      const stat = toolStat(text(call.name), call.args, null);
      const name = [
        "chdir",
        "clear",
        "compact",
        "wait",
        "publish_attachment",
      ].includes(text(call.name))
        ? text(call.name)
        : "tool";
      const key = JSON.stringify([name, stat.kind, stat.action]);
      const counted = summary.get(key) ?? {
        name,
        stat: { kind: stat.kind, action: stat.action },
        count: 0,
      };
      counted.count = Number(counted.count) + 1;
      const totals = counted.stat as JsonObject;
      for (const field of ["added", "removed"])
        if (typeof stat[field] === "number")
          totals[field] = Number(totals[field] ?? 0) + Number(stat[field]);
      summary.set(key, counted);
    }
    if (alreadyOmitted)
      summary.set("omitted", {
        name: "tool",
        stat: { kind: "other" },
        count: alreadyOmitted,
      });
    calls.push({
      name: "",
      args: "",
      status: "omitted",
      omitted,
      summary: [...summary.values()],
    });
  }
  return calls;
}

function displayResult(content: unknown): string {
  const rendered = text(content);
  if (rendered || !pythonTruthy(content)) return rendered;
  const raw = pythonJsonStringify(content);
  return raw === null ? "" : oneLine(raw);
}

function usageTokenCounts(data: JsonObject): JsonObject | null {
  const tokens = data.tokens;
  if (
    !object(tokens) ||
    !USAGE_KEYS.every((key) => validUsageCount(tokens[key]))
  )
    return null;
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, tokens[key]]));
}

function usageScopeTriple(
  scope: unknown,
  source: unknown,
  scopePartial: unknown,
  scopeBase: unknown,
): JsonObject | null {
  if (!validCostScope(scope)) return null;
  if (source !== "authoritative" && source !== "unknown") return null;
  if (scopePartial === null || scopePartial === undefined) scopePartial = false;
  else if (typeof scopePartial !== "boolean") return null;
  if (
    scopeBase !== null &&
    scopeBase !== undefined &&
    (typeof scopeBase !== "number" ||
      !Number.isFinite(scopeBase) ||
      scopeBase < 0)
  ) {
    return null;
  }
  const scoped: JsonObject = {
    costScope: scope,
    costSource: source,
    costScopePartial: scopePartial,
  };
  if (scopeBase !== null && scopeBase !== undefined)
    scoped.costScopeBase = scopeBase;
  return scoped;
}

function usageAt(at: unknown): number {
  return typeof at === "number" && at >= 0 && Number.isFinite(at) ? at : 0;
}

function usageRow(data: unknown): JsonObject | null {
  if (!object(data)) return null;
  const counts = usageTokenCounts(data);
  if (counts === null) return null;
  const cost = data.cost;
  const total = object(cost) ? cost.total : undefined;
  if (!validUsageCost(total)) return null;
  const scope = data.costScope;
  const source = data.costSource;
  const scopePartial = data.costScopePartial;
  const scopeBase = data.costScopeBase;
  let scoped: JsonObject = {};
  if (
    (scope !== null && scope !== undefined) ||
    (source !== null && source !== undefined) ||
    (scopePartial !== null && scopePartial !== undefined) ||
    (scopeBase !== null && scopeBase !== undefined)
  ) {
    const triple = usageScopeTriple(scope, source, scopePartial, scopeBase);
    if (triple === null) return null;
    scoped = triple;
  }
  return {
    tokens: counts,
    cost: { total },
    ...(typeof data.model === "string" && data.model
      ? { model: codePointSlice(data.model, 128) }
      : {}),
    ...scoped,
    partial: typeof data.partial === "boolean" ? data.partial : true,
    stopReason:
      typeof data.stopReason === "string" && data.stopReason
        ? codePointSlice(data.stopReason, 64)
        : "unknown",
    at: usageAt(data.at),
  };
}

function oneLineBounded(value: string, limit: number): string {
  const flat = oneLine(value);
  const chars = codePoints(flat);
  return chars.length <= limit
    ? flat
    : `${chars.slice(0, Math.max(limit - 1, 0)).join("")}…`;
}

function bgShellNotice(entry: JsonObject): [string, string] | null {
  if (entry.customType !== BG_SHELL_CUSTOM_TYPE || entry.display === false)
    return null;
  const details = entry.details;
  if (object(details) && Object.hasOwn(details, "bgShellStream")) return null;
  const content = entry.content;
  const raw = typeof content === "string" ? content : text(content);
  if (!pythonStrip(raw)) return null;
  const body =
    codePoints(raw).length <= BG_SHELL_NOTICE_BODY_MAX
      ? raw
      : `${codePointSlice(raw, BG_SHELL_NOTICE_BODY_MAX)}\n… truncated`;
  const batch = BG_SHELL_BATCH_RE.exec(body);
  if (batch !== null)
    return [`Background shells finished · ${batch[1]} completed`, body];
  const single = BG_SHELL_SINGLE_RE.exec(body);
  if (single !== null) {
    const command = oneLineBounded(single[2]!, BG_SHELL_COMMAND_MAX);
    const outcome =
      single[4] !== undefined ? `exit ${single[4]}` : `killed by ${single[5]}`;
    return [
      "Background shell finished · `" +
        command +
        "` · " +
        outcome +
        " · " +
        single[6],
      body,
    ];
  }
  const failed = BG_SHELL_FAILED_RE.exec(body);
  if (failed !== null)
    return ["Background shell failed to start · `" + failed[1] + "`", body];
  if (body.startsWith(BG_SHELL_INTERNAL_ERROR))
    return [oneLineBounded(body, BG_SHELL_LABEL_MAX), body];
  if (object(details) && Object.hasOwn(details, "completionBatchId")) {
    const first = pythonSplitlines(pythonStrip(body))[0] ?? "";
    return [oneLineBounded(first, BG_SHELL_LABEL_MAX), body];
  }
  return null;
}

function compactAppliedBlock(entryId: string, entry: JsonObject): Block[] {
  const data = entry.data;
  if (!object(data) || data.version !== 1) return [];
  const summary = data.summary;
  const pointId = data.pointId;
  const appliedAt = data.appliedAt;
  if (
    typeof summary !== "string" ||
    !summary ||
    typeof pointId !== "string" ||
    !pointId ||
    typeof appliedAt !== "number" ||
    !Number.isFinite(appliedAt)
  ) {
    return [];
  }
  return [
    block(
      entryId,
      "marker",
      "compaction",
      summary,
      originOf(summary, "custom"),
      {
        meta: { compact_provisional: { pointId, appliedAt } },
      },
    ),
  ];
}

function entryEpoch(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function messageEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return value > 1e11 ? value : value * 1000;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function modelDurationMs(
  start: number | null,
  end: number | null,
): number | null {
  if (start === null || end === null || end < start) return null;
  const elapsed = Math.round(end - start);
  return Number.isSafeInteger(elapsed) && elapsed > 0 ? elapsed : null;
}

function durableKeys(entry: JsonObject): [string | null, number | null] {
  const firstKept =
    typeof entry.firstKeptEntryId === "string" && entry.firstKeptEntryId
      ? entry.firstKeptEntryId
      : null;
  const at = entryEpoch(entry.timestamp);
  return [firstKept, at === null ? null : at * 1000];
}

function durableSupersedes(
  durable: [string | null, number | null],
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

function entryMs(entry: JsonObject): number | null {
  const at = entryEpoch(entry.timestamp);
  return at === null ? null : at * 1000;
}

function closeInTime(first: number | null, second: number | null): boolean {
  return (
    first !== null &&
    second !== null &&
    Math.abs(first - second) <= LEGACY_NOTICE_LINK_MS
  );
}

function compactionFailedBlock(entryId: string, entry: JsonObject): Block[] {
  const data = entry.data;
  const reason = object(data) ? data.reason : undefined;
  if (typeof reason !== "string" || !pythonStrip(reason)) return [];
  const shown = `Compaction failed: ${oneLineBounded(pythonStrip(reason), COMPACTION_FAILED_REASON_MAX)}. Retry with /compact`;
  return [
    block(entryId, "marker", "custom", shown, originOf(shown, "custom"), {
      meta: { compact_marker: true },
    }),
  ];
}

function compactPendingBlock(entryId: string, ready = false): Block[] {
  const shown = ready
    ? "Summary ready, applying at the next step"
    : "Compacting…";
  return [
    block(entryId, "marker", "custom", shown, originOf(shown, "custom"), {
      meta: { compact_marker: true },
    }),
  ];
}

function customBlock(entryId: string, entry: JsonObject): Block[] | null {
  if (entry.customType === "recurse.usage") {
    const row = usageRow(entry.data);
    return row === null
      ? []
      : [block(entryId, "marker", "usage", "", "user", { usage: row })];
  }
  if (entry.customType === COMPACTION_FAILED_TYPE)
    return compactionFailedBlock(entryId, entry);
  if (entry.customType === COMPACT_PENDING_TYPE)
    return compactPendingBlock(entryId);
  if (entry.customType === "recurse.compact-ready")
    return compactPendingBlock(entryId, true);
  if (entry.customType === "recurse.compact-applied")
    return compactAppliedBlock(entryId, entry);
  return null;
}

function customMessageBlock(entryId: string, entry: JsonObject): Block[] {
  if (entry.customType === COMPACTION_NOTICE_CUSTOM_TYPE) {
    if (entry.display === false) return [];
    const content = entry.content;
    const raw = typeof content === "string" ? content : text(content);
    if (!pythonStrip(raw)) return [];
    const body =
      codePoints(raw).length <= COMPACTION_NOTICE_MAX
        ? raw
        : `${codePointSlice(raw, COMPACTION_NOTICE_MAX)}\n… truncated`;
    return [
      block(entryId, "marker", "compaction-notice", body, "system", {
        meta: { body },
      }),
    ];
  }
  if (entry.customType === AUTO_RETRY_CUSTOM_TYPE) {
    const shown = text(entry.content);
    const rowId = typeof entry.retryOf === "string" ? entry.retryOf : entryId;
    return [
      block(rowId, "marker", "shell-notice", shown, "system", {
        meta: { retry: true },
      }),
    ];
  }
  const notice = bgShellNotice(entry);
  if (notice !== null) {
    const [label, body] = notice;
    return [
      block(entryId, "marker", "shell-notice", label, "system", {
        meta: { body },
      }),
    ];
  }
  const shown = text(entry.content);
  return [block(entryId, "marker", "custom", shown, originOf(shown, "custom"))];
}

function streamMarker(entry: unknown): StreamMarker | null {
  if (!object(entry) || entry.type !== "message" || !object(entry.message))
    return null;
  const message = entry.message;
  if (message.role !== "custom" || message.customType !== BG_SHELL_CUSTOM_TYPE)
    return null;
  const details = message.details;
  if (!object(details)) return null;
  const event = details.bgShellStream;
  return event === "shell-background-running" ||
    event === "shell-background-end"
    ? [event, details]
    : null;
}

function shellPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function shellState(details: JsonObject): JsonObject | null {
  const shellId = details.shellId;
  const command = details.command;
  const logPath = details.logPath;
  const started = details.startedAt;
  if (
    typeof shellId !== "string" ||
    !shellId ||
    codePoints(shellId).length > SHELL_ID_MAX ||
    typeof command !== "string" ||
    !command
  ) {
    return null;
  }
  return {
    shellId,
    command: codePointSlice(command, SHELL_COMMAND_MAX),
    pid: shellPid(details.pid),
    pgid: shellPid(details.pgid),
    logPath:
      typeof logPath === "string" && logPath
        ? codePointSlice(logPath, SHELL_PATH_MAX)
        : "",
    startedAt:
      typeof started === "number" && started >= 0 && Number.isFinite(started)
        ? started
        : 0,
  };
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
  private durableCompactions: Array<[string | null, number | null]> = [];
  private compactionCuts = new Map<string, string>();
  // Completion links to its seated summary, or folds into it when adjacent.
  private notices = new Map<
    string,
    { rowId: string; body: string; folded?: Block }
  >();
  // Legacy notices get pointId from adjacent compact-applied, in either order.
  private legacyNotices = new Map<string, number | null>();
  private appliedParents = new Map<string, [string, number | null]>();
  private changesLog: Array<[number, string]> = [];
  /** Published files per tool call, oldest first. */
  attachments: Record<string, JsonObject[]> = {};

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
    this.attachments = {};
    this.touch();
  }

  hasBlock(id: string): boolean {
    return this.index.has(id);
  }

  unresolvedAttachments(): string[] {
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const row of this.blocks) {
      if (
        publishesFiles(row) &&
        row.result !== null &&
        row.call_id !== null &&
        !Object.hasOwn(this.attachments, row.call_id) &&
        !seen.has(row.call_id)
      ) {
        seen.add(row.call_id);
        unresolved.push(row.call_id);
      }
    }
    return unresolved;
  }

  attachFiles(attachments: Record<string, JsonObject[]>): void {
    const additions: Record<string, JsonObject[]> = {};
    for (const [key, value] of Object.entries(attachments)) {
      if (
        !Object.hasOwn(this.attachments, key) ||
        !deepEqual(this.attachments[key], value)
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
    this.revision += 1;
    this.changesLog.push([this.revision, identity]);
    if (this.changesLog.length > 512) this.changesLog.shift();
  }

  changes(since: number, limit: number): Snapshot {
    if (
      since > this.revision ||
      since < 0 ||
      (this.changesLog.length > 0 && since < this.changesLog[0]![0] - 1)
    ) {
      return Object.freeze({ ...this.window({ limit }), reset: true });
    }
    const changed = new Set(
      this.changesLog
        .filter(([revision]) => revision > since)
        .map(([, identity]) => identity),
    );
    if (changed.size > limit)
      return Object.freeze({ ...this.window({ limit }), reset: true });
    const rows = this.blocks.filter((row) => changed.has(row.id));
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
    const latestCalls = new Map(this.callRows);
    for (const entry of entries) this.ingestOne(entry, false, true);
    for (const [callId, rowId] of latestCalls) this.callRows.set(callId, rowId);
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
        !deepEqual(this.blocks[position], updated)
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
    const offset = value._offset;
    let merged = 0;
    for (const row of this.normalize(identity[0], value)) {
      if (
        this.merge(
          {
            ...row,
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
    if (value.type === "compaction") {
      if (typeof value.firstKeptEntryId === "string" && value.firstKeptEntryId)
        this.compactionCuts.set(value.firstKeptEntryId, identity[0]);
      merged += this.supersedeProvisionalCompactions(value);
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

  private supersedeProvisionalCompactions(entry: JsonObject): number {
    const firstKept =
      typeof entry.firstKeptEntryId === "string" && entry.firstKeptEntryId
        ? entry.firstKeptEntryId
        : null;
    const timestamp = entryEpoch(entry.timestamp);
    if (firstKept === null && timestamp === null) return 0;
    const durableMs = timestamp === null ? null : timestamp * 1000;
    let removed = 0;
    for (const row of [...this.blocks]) {
      const provisional = object(row.meta)
        ? row.meta.compact_provisional
        : null;
      if (!object(provisional)) continue;
      let superseded = firstKept !== null && provisional.pointId === firstKept;
      if (!superseded && durableMs !== null) {
        const appliedAt = provisional.appliedAt;
        superseded =
          typeof appliedAt === "number" &&
          Number.isFinite(appliedAt) &&
          durableMs >= appliedAt;
      }
      if (superseded && this.removeBlock(row.id)) removed += 1;
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

  private normalize(entryId: string, entry: JsonObject): Block[] {
    if (entry.type === "compaction") {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      this.durableCompactions.push(durableKeys(entry));
      const notice =
        typeof entry.firstKeptEntryId === "string"
          ? this.notices.get(entry.firstKeptEntryId)
          : undefined;
      return [
        block(
          entryId,
          "marker",
          "compaction",
          summary,
          originOf(summary, "custom"),
          typeof entry.firstKeptEntryId === "string"
            ? {
                meta: {
                  firstKeptEntryId: entry.firstKeptEntryId,
                  ...(notice === undefined ? {} : { body: notice.body }),
                },
              }
            : {},
        ),
      ];
    }
    if (entry.type === "custom_message")
      return this.placeNotice(
        entryId,
        entry,
        customMessageBlock(entryId, entry),
      );
    if (entry.type === "custom") {
      if (entry.customType === "recurse.compact-applied")
        this.linkLegacyNotice(entry);
      const known = customBlock(entryId, entry);
      if (known !== null) return this.dropSupersededProvisional(entry, known);
    }
    const messageValue = entry.message;
    if (!object(messageValue)) return [];
    const role = messageValue.role;
    if (role !== "user" && role !== "assistant" && role !== "custom") return [];
    const content = messageValue.content;
    const shown = text(content);
    const info = role === "assistant" ? thinkingInfo(content) : null;
    const thinking =
      role === "assistant" &&
      typeof entry.thinkingTitle === "string" &&
      entry.thinkingTitle.trim()
        ? entry.thinkingTitle
        : (info?.title ?? null);
    const usage = role === "assistant" ? providerUsage(messageValue) : null;
    // Invariant: Pi records the request start as assistant message.timestamp
    // (ms) and the response end as the surrounding session entry timestamp. The
    // persisted gap survives reload and excludes shell/safety work; usage is
    // attached to the same assistant message.
    const modelTime =
      role === "assistant"
        ? modelDurationMs(
            messageEpochMs(messageValue.timestamp),
            messageEpochMs(entry.timestamp),
          )
        : null;
    const rawValue = messageValue.errorMessage;
    const rawError =
      typeof rawValue === "string" && pythonStrip(rawValue) ? rawValue : null;
    let stopReason =
      typeof messageValue.stopReason === "string"
        ? messageValue.stopReason
        : null;
    let error: string | null;
    let errorDetail: string | null;
    if (role === "assistant" && isAbortMessage(messageValue, rawError)) {
      stopReason = "aborted";
      error = rawError;
      errorDetail = null;
    } else {
      const provider =
        typeof messageValue.provider === "string" &&
        pythonStrip(messageValue.provider)
          ? messageValue.provider
          : undefined;
      const model =
        typeof messageValue.model === "string" &&
        pythonStrip(messageValue.model)
          ? messageValue.model
          : undefined;
      error =
        rawError === null
          ? null
          : describeTurnFailure(rawError, { provider, model });
      errorDetail = rawError === null ? null : codePointSlice(rawError, 500);
      // Invariant: Durable leaves a refused run out of later requests
      // (durable/refusals.ts); the view marks it so the thread can say so.
      if (role === "assistant" && isRefusal(messageValue))
        stopReason = "refused";
    }
    const rows = [
      block(entryId, "text", role, shown, originOf(shown, role), {
        usage,
        ...(role === "assistant"
          ? { model_response: modelResponse(messageValue) }
          : {}),
        ...(modelTime === null ? {} : { model_time_ms: modelTime }),
        ...(thinking === null ? {} : { thinking }),
        ...(info?.hasThinking || entry.hasThinking === true
          ? { has_thinking: true }
          : {}),
        ...(typeof entry.thinkingStartMs === "number"
          ? { thinking_start_ms: entry.thinkingStartMs }
          : {}),
        error,
        error_detail: errorDetail,
        stop_reason: stopReason,
      }),
    ];
    if (role === "assistant" && Array.isArray(content)) {
      const calls = content.filter(
        (part): part is JsonObject => object(part) && part.type === "toolCall",
      );
      calls.forEach((call, index) => {
        const rawId = call.id;
        const callId =
          typeof rawId === "string" && rawId ? rawId : `${entryId}#${index}`;
        const rowId = `${entryId}#${callId}`;
        this.callRows.set(callId, rowId);
        const name = call.name;
        const args = call.arguments;
        const nameText = typeof name === "string" ? name : null;
        const shapedArgs =
          typeof args === "string" || object(args) ? args : null;
        const [summary, detail] = toolCallDetails(shapedArgs, nameText);
        rows.push(
          block(rowId, "tool_call", "tool", "", "user", {
            name: typeof name === "string" && name ? name : "tool",
            args: displayToolArgs(name, args),
            call_id: callId,
            input:
              typeof name === "string" &&
              ["bash", "shell"].includes(name.toLowerCase())
                ? summary
                : detail || summary,
            stat: toolStat(nameText, shapedArgs, null),
          }),
        );
      });
    }
    return rows;
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
    if (deepEqual(current, updated)) return false;
    this.blocks[position] = updated;
    this.changed(rowId);
    return true;
  }

  private restoreRetryShadow(entryId: string): void {
    const shadow = this.retryShadows.get(entryId);
    this.retryShadows.delete(entryId);
    const position = this.index.get(entryId);
    if (shadow === undefined || position === undefined) return;
    if (!deepEqual(this.blocks[position], shadow)) {
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
          if (!deepEqual(restored, current)) {
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
        if (deepEqual(updated, current)) return false;
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
      if (deepEqual(updated, current)) return false;
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
    rows: Block[],
  ): Block[] {
    const row = rows[0];
    if (row?.role !== "compaction-notice") return rows;
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
    if (pointId === null) return rows;
    this.notices.set(pointId, { rowId: entryId, body });
    return rows;
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
    if (!deepEqual(current.meta, meta)) {
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

  private dropSupersededProvisional(entry: JsonObject, rows: Block[]): Block[] {
    if (entry.customType !== "recurse.compact-applied") return rows;
    return this.provisionalSuperseded(entry) ? [] : rows;
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
