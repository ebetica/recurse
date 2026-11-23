// Pure display projection of one Pi-shaped entry, shared by legacy and Durable history.
// Legacy notices retain text but never acquire live state or navigation.

import { modelResponse } from "./model_response";
import { describeTurnFailure, isRefusal } from "./failure_sentences";
import type { JsonObject } from "./session_entries";
import {
  oneLine,
  providerUsage,
  toolCallDetails,
  toolStat,
  truncateToolDetail,
  validCostScope,
  validUsageCost,
  validUsageCount,
  USAGE_KEYS,
  TOOL_COMMAND_MAX,
  type ToolStat,
} from "../../tool_projection";

export interface Block {
  readonly id: string;
  readonly kind: string;
  readonly role: string;
  readonly text: string;
  /** Bounded latest bold heading; full thinking is lazy-loaded by offset. */
  readonly thinking?: string | null;
  readonly thinking_key?: string;
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
  readonly stat: ToolStat | null;
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
  /** On a text-delta change page: text follows this many held characters. */
  readonly text_from?: number;
  /** With `text_from`: `textHash` of the held text it follows. */
  readonly text_hash?: number;
}

export interface ToolTiming {
  total_ms?: number;
  safety_ms?: number;
  command_ms?: number;
}

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
const THINKING_HEADING_MAX_CHARS = 200;
const REDACTED_THINKING =
  /^(?:\[?(?:redacted|encrypted)(?:[ _-](?:thinking|reasoning))?\]?|<encrypted>)+$/iu;

interface ThinkingInfo {
  title: string | null;
  hasThinking: boolean;
}

/** Extract a bounded heading or opening line without exposing full reasoning. */
export function thinkingInfo(message: JsonObject | undefined): ThinkingInfo {
  const content = message?.content;
  if (!Array.isArray(content)) return { title: null, hasThinking: false };
  let title: string | null = null;
  let hasThinking = false;
  for (const block of content) {
    if (!object(block) || block.type !== "thinking") continue;
    const thinking = block.thinking;
    if (typeof thinking !== "string") continue;
    hasThinking = true;
    const text = thinking.trim();
    if (!text || block.redacted === true || REDACTED_THINKING.test(text))
      continue;
    let heading = "";
    for (const match of text.matchAll(/\*\*(.+?)\*\*/gu))
      heading = match[1]?.trim() || heading;
    const line = heading || text.split("\n", 1)[0]!.trimEnd();
    title = codePointSlice(line, THINKING_HEADING_MAX_CHARS);
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

const PYTHON_WHITESPACE =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYTHON_TRIM_RE = new RegExp(
  `^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`,
  "gu",
);
const PYTHON_LINES_GLOBAL_RE = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/gu;

export function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness for JSON values, including empty collections. */
export function pythonTruthy(value: unknown): boolean {
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
export function resultTiming(message: JsonObject): ToolTiming | null {
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

function jsonCodeUnit(unit: string): string {
  return `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function displayJson(value: unknown, escape: RegExp): string | null {
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
    return encoded.replace(escape, (char) =>
      char.length === 1
        ? jsonCodeUnit(char)
        : char.replace(/./gs, jsonCodeUnit),
    );
  } catch {
    return null;
  }
}

function displayArgs(argumentsValue: unknown): string {
  if (argumentsValue === null || argumentsValue === undefined) return "";
  if (typeof argumentsValue === "string") return oneLine(argumentsValue);
  // Keep full JSON values intact without showing invisible controls or line breaks.
  return displayJson(argumentsValue, /[\p{C}\p{Zl}\p{Zp}]/gu) ?? "";
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
      const name = text(call.name) || "tool";
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

export function displayResult(content: unknown): string {
  const rendered = text(content);
  if (rendered || !pythonTruthy(content)) return rendered;
  const raw = displayJson(content, /[\u007f-\uffff]/g);
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

function isBgShellStream(entry: JsonObject): boolean {
  return (
    entry.customType === BG_SHELL_CUSTOM_TYPE &&
    object(entry.details) &&
    Object.hasOwn(entry.details, "bgShellStream")
  );
}

function bgShellNotice(entry: JsonObject): [string, string] | null {
  if (entry.customType !== BG_SHELL_CUSTOM_TYPE || entry.display === false)
    return null;
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
  const details = entry.details;
  if (object(details) && Object.hasOwn(details, "completionBatchId")) {
    const first = pythonSplitlines(pythonStrip(body))[0] ?? "";
    return [oneLineBounded(first, BG_SHELL_LABEL_MAX), body];
  }
  return null;
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

function legacyNotice(entryId: string, shown: string): Block {
  return block(entryId, "marker", "legacy-notice", shown, "system");
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
  if (entry.customType === COMPACTION_FAILED_TYPE) {
    const reason = object(entry.data) ? entry.data.reason : null;
    if (typeof reason !== "string" || !pythonStrip(reason)) return [];
    return [
      legacyNotice(
        entryId,
        `Compaction failed: ${oneLineBounded(pythonStrip(reason), COMPACTION_FAILED_REASON_MAX)}`,
      ),
    ];
  }
  if (entry.customType === COMPACT_PENDING_TYPE)
    return compactPendingBlock(entryId);
  if (entry.customType === "recurse.compact-ready")
    return compactPendingBlock(entryId, true);
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
    const firstKept = object(entry.details) ? entry.details.pointId : null;
    const hasPoint = typeof firstKept === "string" && !!firstKept;
    if (body.startsWith("Context compacted") && !hasPoint)
      return [legacyNotice(entryId, body)];
    return [
      block(entryId, "marker", "compaction-notice", body, "system", {
        meta: hasPoint ? { body, firstKeptEntryId: firstKept } : { body },
      }),
    ];
  }
  if (entry.customType === "recurse.auto-retry") {
    const shown = text(entry.content);
    return entry.display === false || !pythonStrip(shown)
      ? []
      : [legacyNotice(entryId, shown)];
  }
  if (isBgShellStream(entry)) return [];
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

interface EntryRows {
  rows: Block[];
  callRows?: [callId: string, rowId: string][];
  firstKept?: string;
}

export function entryRows(entryId: string, entry: JsonObject): EntryRows {
  if (entry.type === "compaction") {
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    const firstKept = entry.firstKeptEntryId;
    return {
      ...(typeof firstKept === "string" ? { firstKept } : {}),
      rows: [
        block(
          entryId,
          "marker",
          "compaction",
          summary,
          originOf(summary, "custom"),
          typeof firstKept === "string"
            ? { meta: { firstKeptEntryId: firstKept } }
            : {},
        ),
      ],
    };
  }
  if (entry.type === "custom_message")
    return { rows: customMessageBlock(entryId, entry) };
  if (entry.type === "custom") {
    const known = customBlock(entryId, entry);
    if (known !== null) return { rows: known };
  }
  const messageValue = entry.message;
  if (!object(messageValue)) return { rows: [] };
  const role = messageValue.role;
  if (role !== "user" && role !== "assistant" && role !== "custom")
    return { rows: [] };
  if (role === "custom" && isBgShellStream(messageValue)) return { rows: [] };
  const content = messageValue.content;
  const shown = text(content);
  const info = role === "assistant" ? thinkingInfo(messageValue) : null;
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
      typeof messageValue.model === "string" && pythonStrip(messageValue.model)
        ? messageValue.model
        : undefined;
    error =
      rawError === null
        ? null
        : describeTurnFailure(rawError, { provider, model });
    errorDetail = rawError === null ? null : codePointSlice(rawError, 500);
    // Invariant: Durable leaves a refused run out of later requests
    // (durable/refusals.ts); the view marks it so the thread can say so.
    if (role === "assistant" && isRefusal(messageValue)) stopReason = "refused";
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
        ? {
            has_thinking: true,
            thinking_key: String(entry.thinkingKey ?? "") || undefined,
          }
        : {}),
      ...(typeof entry.thinkingStartMs === "number"
        ? { thinking_start_ms: entry.thinkingStartMs }
        : {}),
      error,
      error_detail: errorDetail,
      stop_reason: stopReason,
    }),
  ];
  const callRows: [callId: string, rowId: string][] = [];
  if (role === "assistant" && Array.isArray(content)) {
    const calls = content.filter(
      (part): part is JsonObject => object(part) && part.type === "toolCall",
    );
    calls.forEach((call, index) => {
      const rawId = call.id;
      const callId =
        typeof rawId === "string" && rawId ? rawId : `${entryId}#${index}`;
      const rowId = `${entryId}#${callId}`;
      callRows.push([callId, rowId]);
      const name = call.name;
      const args = call.arguments;
      const nameText = typeof name === "string" ? name : null;
      const shapedArgs = typeof args === "string" || object(args) ? args : null;
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
  return { rows, callRows };
}
