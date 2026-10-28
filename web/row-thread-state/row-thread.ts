// Folds immutable /view windows into renderer turns without a second parser.
// New instances rebuild; same-lineage rows upsert by id, live rows replace.
// Compaction stays in-session; held rows are uncapped, served pages bounded.
import type {
  MessageEntry,
  ToolStat,
  Turn,
  TurnSegment,
  TurnSummary,
  TurnUsage,
  TurnUsageTotal,
} from "../types.js";
import {
  hasArgsPrefix,
  streamingDetailText,
  streamingRowText,
} from "../partial-tool-args.js";
import type { ViewBlock, ViewPage } from "./view-blocks.js";
import {
  summarizeListedTools,
  visibleAssistant,
} from "../thread-render/turn-view.js";

export interface RowThread {
  instanceId: string;
  revision: number;
  rows: ViewBlock[];
  // Session identity rotates on Clear, not on same-session view rebuilds.
  sessionKey?: string;
  retryNotice?: string | null;
}

export interface RowFold {
  state: RowThread | null;
  changed: boolean;
  reset: boolean;
}

export interface ClearedMarker {
  instanceId: string;
  revision: number;
  sessionKey?: string;
}

// Only a changed session resolves Clear, never a rebuilt instance/revision.
// Missing session identity fails closed; instance comparison is legacy-only
// when both sides lack session keys. Caller removes resolved markers.
export function clearedPageStale(
  marker: ClearedMarker | undefined,
  page: ViewPage | null,
): boolean {
  if (!marker || !page || page.status !== "ready") return false;
  if (marker.sessionKey !== undefined && page.session !== undefined)
    return page.session === marker.sessionKey;
  if (marker.sessionKey !== undefined || page.session !== undefined)
    return true;
  return page.instance_id === marker.instanceId;
}

// Applies only on exact read serial identity; missing entries never match.
// Drops/recreated entries get never-reused serials to prevent eviction ABA.
export function readSerialApplies(
  captured: number | undefined,
  current: number | undefined,
): boolean {
  return captured === current;
}

// Union-bounds all row-cache maps, including thread-less serial entries. Evicts
// oldest insertion first while protecting the just-touched writer.
export function pruneCaches(
  caches: Map<string, unknown>[],
  max: number,
  except?: string,
): void {
  const keys = new Set<string>();
  for (const cache of caches) for (const key of cache.keys()) keys.add(key);
  if (except !== undefined) keys.delete(except);
  while (keys.size > max) {
    const oldest = keys.values().next().value;
    if (oldest === undefined) return;
    keys.delete(oldest);
    for (const cache of caches) cache.delete(oldest);
  }
}

function isRow(value: unknown): value is ViewBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ViewBlock).id === "string" &&
    typeof (value as ViewBlock).kind === "string" &&
    typeof (value as ViewBlock).text === "string"
  );
}

function rowEqual(a: ViewBlock, b: ViewBlock): boolean {
  return (
    a.id === b.id &&
    a.order === b.order &&
    a.offset === b.offset &&
    a.kind === b.kind &&
    a.role === b.role &&
    a.text === b.text &&
    a.thinking_title === b.thinking_title &&
    a.has_thinking === b.has_thinking &&
    a.origin === b.origin &&
    a.name === b.name &&
    a.args === b.args &&
    a.result === b.result &&
    a.result_truncated === b.result_truncated &&
    a.tool_output_tail === b.tool_output_tail &&
    JSON.stringify(a.calls ?? null) === JSON.stringify(b.calls ?? null) &&
    a.live === b.live &&
    a.error === b.error &&
    a.error_detail === b.error_detail &&
    a.stop_reason === b.stop_reason &&
    a.running === b.running &&
    a.input === b.input &&
    a.sender === b.sender &&
    a.sender_name === b.sender_name &&
    JSON.stringify(a.attachment ?? null) ===
      JSON.stringify(b.attachment ?? null) &&
    JSON.stringify(a.files ?? []) === JSON.stringify(b.files ?? []) &&
    JSON.stringify(a.pr_links ?? []) === JSON.stringify(b.pr_links ?? []) &&
    JSON.stringify(a.stat ?? null) === JSON.stringify(b.stat ?? null) &&
    JSON.stringify(a.usage ?? null) === JSON.stringify(b.usage ?? null) &&
    JSON.stringify(a.meta ?? null) === JSON.stringify(b.meta ?? null) &&
    JSON.stringify(a.safety_usage ?? null) ===
      JSON.stringify(b.safety_usage ?? null) &&
    JSON.stringify(a.timing ?? null) === JSON.stringify(b.timing ?? null) &&
    a.model_time_ms === b.model_time_ms &&
    JSON.stringify(a.model_response) === JSON.stringify(b.model_response)
  );
}

// Thread-level instance/revision fold. Stale, unavailable, or malformed
// pages keep what is held and never blank the thread. `direction` chooses
// where genuinely new rows land: tail polls append, scroll-up pages prepend.
export function foldRowThread(
  prev: RowThread | null | undefined,
  page: ViewPage,
  direction: "newer" | "older" = "newer",
): RowFold {
  if (
    !page ||
    page.status !== "ready" ||
    typeof page.instance_id !== "string" ||
    typeof page.revision !== "number" ||
    !Array.isArray(page.blocks)
  )
    return { state: prev ?? null, changed: false, reset: false };
  const fresh = (page.blocks as unknown[])
    .filter(isRow)
    .map((row) =>
      Number.isFinite(row.tool_elapsed_ms)
        ? { ...row, tool_received_at_ms: performance.now() }
        : row,
    );
  if (!prev || prev.instanceId !== page.instance_id || page.reset)
    return {
      state: {
        instanceId: page.instance_id,
        revision: page.revision,
        rows: fresh,
        sessionKey: page.session,
        retryNotice: page.retry_notice,
      },
      changed: true,
      reset: true,
    };
  if (
    prev.revision === page.revision &&
    direction === "newer" &&
    (page.retry_notice === undefined || page.retry_notice === prev.retryNotice)
  )
    return { state: prev, changed: false, reset: false };
  // Invariant: An older window can carry rows never held even when nothing
  // mutated server-side, so same-revision still merges here; only genuinely new
  // or changed rows report a change.
  const removed = new Set(page.removed ?? []);
  const byId = new Map(fresh.map((block) => [block.id, block]));
  const replacement = (held: ViewBlock): ViewBlock =>
    page.revision < prev.revision ? held : (byId.get(held.id) ?? held);
  const merged: ViewBlock[] =
    direction === "newer"
      ? prev.rows.flatMap((held) => {
          if (removed.has(held.id) && page.revision >= prev.revision) return [];
          return [replacement(held)];
        })
      : prev.rows.map(replacement);
  const heldIds = new Set(merged.map((block) => block.id));
  const novel = fresh.filter((block) => !heldIds.has(block.id));
  if (direction === "older") {
    const rows = [...novel, ...merged].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    let changed =
      novel.length > 0 ||
      (page.retry_notice !== undefined &&
        page.retry_notice !== prev.retryNotice);
    if (!changed)
      changed = merged.some(
        (block, index) => !rowEqual(block, prev.rows[index]!),
      );
    return {
      state: changed
        ? {
            instanceId: prev.instanceId,
            revision: prev.revision,
            rows,
            sessionKey: page.session ?? prev.sessionKey,
            retryNotice:
              page.retry_notice !== undefined
                ? page.retry_notice
                : prev.retryNotice,
          }
        : prev,
      changed,
      reset: false,
    };
  }
  const rows = [...merged, ...novel].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  return {
    state: {
      instanceId: prev.instanceId,
      revision: Math.max(prev.revision, page.revision),
      rows,
      sessionKey: page.session ?? prev.sessionKey,
      retryNotice:
        page.retry_notice !== undefined ? page.retry_notice : prev.retryNotice,
    },
    changed: true,
    reset: false,
  };
}

export function threadHasLive(rows: readonly ViewBlock[]): boolean {
  return rows.some((row) => row.live);
}

export function rowThreadHasActiveTurn(
  status: string,
  rows: readonly ViewBlock[],
): boolean {
  // Invariant: Admission flips the agent status before Pi publishes the new
  // turn's live rows. Status alone would reopen the settled tail from the
  // previous turn.
  return (
    (status === "running" || status === "interrupting") &&
    rows.some((row) => row.live || row.running || row.live_thinking)
  );
}

// Files sources name their message (`pi:<entry id>`); text-row ids ARE
// entry ids, so a deep link resolves to its row without byte offsets.
export function rowIdFromMessageId(
  messageId: string | null | undefined,
): string | null {
  if (typeof messageId !== "string" || !messageId) return null;
  const rowId = messageId.startsWith("pi:") ? messageId.slice(3) : messageId;
  return rowId ? rowId : null;
}

// Strips backend delivery chrome from raw user rows before display.
const ORIGIN_TAG_HEAD =
  /^\[recurse-origin: (?:operator|agent|scheduled|platform|service)\][ \t]*\r?\n/;
const ORIGIN_TAG_LINE =
  /^\[recurse-origin: (?:operator|agent|scheduled|platform|service)\]\s*$/;
const SENDER_LINE = /^\[recurse-from: [A-Za-z0-9][A-Za-z0-9_-]{0,127}\]\s*$/;
const SENDER_NAME_LINE = /^\[recurse-from-name: .+\]\s*$/;
const DELIVERY_TRAILER = /\n?\[recurse-delivery:[A-Za-z0-9_.:-]{1,128}\]\s*$/;

function stripSenderLines(lines: string[]): string[] {
  let rest = lines;
  if (rest.length && SENDER_LINE.test(rest[0]!.trim())) rest = rest.slice(1);
  if (rest.length && SENDER_NAME_LINE.test(rest[0]!.trim()))
    rest = rest.slice(1);
  return rest;
}

export function stripRowEnvelope(text: string): string {
  const bare = text.replace(DELIVERY_TRAILER, "");
  const head = bare.match(ORIGIN_TAG_HEAD);
  if (head?.[0])
    return stripSenderLines(bare.slice(head[0].length).split("\n")).join("\n");
  const lines = bare.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (ORIGIN_TAG_LINE.test(lines[index]!.trim()))
      return stripSenderLines(lines.slice(index + 1)).join("\n");
  }
  return bare;
}

// Maps structured non-operator provenance to folded system input. Untagged rows
// fail open like the turns path; stamps remain authoritative.
function userOrigin(origin: string): string | undefined {
  if (origin === "operator") return "operator";
  if (origin === "agent") return "agent";
  if (["service", "scheduled", "platform"].includes(origin)) return origin;
  if (origin === "system") return "service";
  return undefined;
}

interface UsageAcc {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costOk: boolean;
  costReported: boolean;
  partial: boolean;
  scopes: Map<string, { cost?: number; partial: boolean }>;
  calls: number;
  replies: number;
}

function emptyAcc(): UsageAcc {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costOk: true,
    costReported: false,
    partial: false,
    scopes: new Map(),
    calls: 0,
    replies: 0,
  };
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function addRowUsage(acc: UsageAcc, usage: ViewBlock["usage"]): void {
  acc.replies += 1;
  if (!usage || typeof usage !== "object") return;
  const { input, output, cacheRead, cacheWrite } = usage as TurnUsage;
  if (
    !validCount(input) ||
    !validCount(output) ||
    !validCount(cacheRead) ||
    !validCount(cacheWrite)
  )
    return;
  acc.input += input;
  acc.output += output;
  acc.cacheRead += cacheRead;
  acc.cacheWrite += cacheWrite;
  acc.calls += 1;
  const report = usage as TurnUsage;
  const cost = report.cost;
  const validCost =
    typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
  if (report.costScope) {
    const scope = acc.scopes.get(report.costScope) ?? { partial: false };
    scope.partial ||= report.costScopePartial === true;
    if (report.costSource === "authoritative") {
      if (validCost) scope.cost = cost;
      else scope.partial = true;
    }
    acc.scopes.set(report.costScope, scope);
  } else if (validCost && report.costSource !== "unknown") {
    acc.cost += cost;
    acc.costReported = true;
    acc.costOk &&= report.costPartial !== true;
  } else acc.costOk = false;
}

function summedUsage(acc: UsageAcc, partial: boolean): TurnUsageTotal | null {
  if (acc.calls < 1) return null;
  let cost = acc.cost;
  let costReported = acc.costReported;
  let costPartial = !acc.costOk;
  for (const scope of acc.scopes.values()) {
    if (scope.cost !== undefined) {
      cost += scope.cost;
      costReported = true;
    }
    costPartial ||= scope.partial || scope.cost === undefined;
  }
  return {
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    calls: acc.calls,
    replies: acc.replies,
    partial: partial || acc.partial || acc.calls < acc.replies,
    ...(costReported ? { cost } : null),
    costPartial,
  };
}

function rowUsageModel(usage: ViewBlock["usage"]): TurnUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const { input, output, cacheRead, cacheWrite } = usage as TurnUsage;
  if (
    !validCount(input) ||
    !validCount(output) ||
    !validCount(cacheRead) ||
    !validCount(cacheWrite)
  )
    return null;
  return { ...(usage as TurnUsage), input, output, cacheRead, cacheWrite };
}

interface RunTotal {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  model?: string;
  partial: boolean;
  // Scoped totals replace; costScopeBase marks additive steered-segment deltas.
  costScope?: string;
  costSource?: "authoritative" | "unknown";
  costScopePartial?: boolean;
  costScopeBase?: number;
}

// Authoritative run total from a marker/usage row: the nested recurse.usage
// shape only, never flat per-call usage. Malformed rows drop and the turn
// keeps its summed estimates.
function parseRunTotal(usage: ViewBlock["usage"]): RunTotal | null {
  if (!usage || typeof usage !== "object") return null;
  const tokens = (usage as { tokens?: unknown }).tokens;
  const cost = (usage as { cost?: unknown }).cost;
  if (!tokens || typeof tokens !== "object") return null;
  const { input, output, cacheRead, cacheWrite } = tokens as Record<
    string,
    unknown
  >;
  if (
    !validCount(input) ||
    !validCount(output) ||
    !validCount(cacheRead) ||
    !validCount(cacheWrite)
  )
    return null;
  const total = (cost as { total?: unknown } | null | undefined)?.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0)
    return null;
  const record = usage as unknown as Record<string, unknown>;
  const model = record["model"];
  const partial = record["partial"];
  const costScope = record["costScope"];
  const costSource = record["costSource"];
  const costScopePartial = record["costScopePartial"];
  const costScopeBase = record["costScopeBase"];
  // Invariant: The backend already bounds scope ids (128 ASCII); recheck
  // lightly so a malformed triple drops the row instead of misattributing
  // spend.
  const scope =
    typeof costScope === "string" &&
    costScope.length > 0 &&
    costScope.length <= 128
      ? costScope
      : undefined;
  const source =
    costSource === "authoritative" || costSource === "unknown"
      ? costSource
      : undefined;
  const base =
    typeof costScopeBase === "number" &&
    Number.isFinite(costScopeBase) &&
    costScopeBase >= 0
      ? costScopeBase
      : undefined;
  if (costScopeBase !== undefined && base === undefined) return null;
  if (
    scope === undefined &&
    (source !== undefined || costScopePartial === true || base !== undefined)
  )
    return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    model: typeof model === "string" && model ? model : undefined,
    partial: partial === true,
    ...(scope !== undefined
      ? {
          costScope: scope,
          costSource: source ?? "unknown",
          costScopePartial: costScopePartial === true,
          ...(base !== undefined ? { costScopeBase: base } : null),
        }
      : null),
  };
}

// Merge settled marker totals with still-unmarked estimates for display.
// Either side may be empty; scope collisions (same id on both, unreachable
// with fresh-scope-per-run providers) keep the settled entry and lower.
function mergeAcc(finalized: UsageAcc, pending: UsageAcc): UsageAcc {
  const scopes = new Map(finalized.scopes);
  let partial = finalized.partial;
  for (const [id, entry] of pending.scopes) {
    if (scopes.has(id)) partial = true;
    else scopes.set(id, entry);
  }
  return {
    input: finalized.input + pending.input,
    output: finalized.output + pending.output,
    cacheRead: finalized.cacheRead + pending.cacheRead,
    cacheWrite: finalized.cacheWrite + pending.cacheWrite,
    cost: finalized.cost + pending.cost,
    costOk: finalized.costOk && pending.costOk,
    costReported: finalized.costReported || pending.costReported,
    partial:
      partial ||
      finalized.calls < finalized.replies ||
      pending.calls < pending.replies,
    scopes,
    calls: finalized.calls + pending.calls,
    replies: finalized.replies + pending.replies,
  };
}

// Spec: Estimates precede exactly one final marker per run, in order.
// Finalization transfers counts and supersedes spend, clearing pending state.
// Scope totals replace, run token counts add, scopeless legacy spend adds.
function applyRunTotal(build: TurnBuild, total: RunTotal): void {
  const fin = build.finalized;
  const pend = build.usage;
  fin.calls += pend.calls;
  fin.replies += pend.replies;
  // Invariant: A marker-only run still made at least one provider call, which
  // also keeps the meter rendering for estimate-free turns.
  if (pend.calls === 0) fin.calls += 1;
  Object.assign(pend, emptyAcc());
  fin.input += total.input;
  fin.output += total.output;
  fin.cacheRead += total.cacheRead;
  fin.cacheWrite += total.cacheWrite;
  fin.partial ||= total.partial;
  if (total.costScope === undefined) {
    fin.cost += total.total;
    fin.costReported = true;
    fin.costOk &&= !total.partial;
    return;
  }
  // Invariant: Authoritative scope totals replace; unknown ones lower
  // confidence. With costScopeBase, disjoint segment deltas add rather than
  // replace.
  const scope = fin.scopes.get(total.costScope) ?? { partial: false };
  scope.partial ||= total.costScopePartial === true;
  if (total.costScopeBase !== undefined) {
    scope.cost = (scope.cost ?? 0) + total.total;
  } else if (total.costSource === "authoritative") scope.cost = total.total;
  else scope.partial = true;
  fin.scopes.set(total.costScope, scope);
}

const emptySegment = (): TurnSegment => ({
  user: [],
  tools: [],
  assistant: null,
  summary: null,
});

import { activityUsage } from "../thread-render/activity-usage.js";

interface TurnBuild {
  turn: Turn;
  current: TurnSegment;
  replySettled?: boolean;
  // Pending per-request estimates not yet covered by a marker.
  usage: UsageAcc;
  // Settled authoritative marker totals for this section.
  finalized: UsageAcc;
  seq: number;
  prLinks: NonNullable<TurnSummary["pr_links"]>;
  safetyTurns: Turn[];
  requestModelTimeMs?: number;
  requestThinking?: string | null;
  requestThinkingEntryId?: string;
  requestHasThinking?: boolean;
  requestLiveThinking?: boolean;
  requestThinkingElapsedMs?: number;
}

function openTurn(id: string, cursor: number): TurnBuild {
  const current = emptySegment();
  const turn: Turn = {
    turn_id: `row:${id}`,
    cursor,
    started_at: null,
    ended_at: null,
    open: false,
    status: "idle",
    summary: null,
    segments: [current],
    partial: false,
  };
  return {
    turn,
    current,
    usage: emptyAcc(),
    finalized: emptyAcc(),
    seq: 0,
    prLinks: [],
    safetyTurns: [],
  };
}

function summarizeBuild(build: TurnBuild): void {
  build.turn.summary = {
    ...summarizeListedTools(
      build.turn.segments.flatMap((segment) => segment.tools),
    ).summary,
    usage: summedUsage(
      mergeAcc(build.finalized, build.usage),
      build.turn.partial,
    ),
    safety_usage:
      activityUsage(build.safetyTurns).safetyTotal ??
      (build.safetyTurns.length
        ? {
            calls: build.safetyTurns.reduce(
              (sum, turn) => sum + (turn.summary?.safety_usage?.calls ?? 0),
              0,
            ),
            partial: true,
            groups: [],
          }
        : undefined),
    prs: build.prLinks.map((link) => link.number),
    pr_links: build.prLinks,
  };
}

function finishTurn(build: TurnBuild, out: Turn[]): void {
  summarizeBuild(build);
  out.push(build.turn);
}

const STAT_KINDS = new Set([
  "read",
  "edit",
  "write",
  "shell",
  "search",
  "web",
  "other",
]);

// Closed tool labels/counts ride the served block (same backend classifier
// the turns path uses); anything else renders with the bare tool wording.
function rowStat(stat: ViewBlock["stat"]): ToolStat {
  if (
    stat &&
    typeof stat === "object" &&
    STAT_KINDS.has((stat as ToolStat).kind)
  )
    return stat as ToolStat;
  return { kind: "other" };
}

// Full notice text behind a shell-notice row's compact label, if served.
function noticeBody(row: ViewBlock): string | undefined {
  const meta = row.meta as { body?: unknown } | null;
  return typeof meta?.body === "string" && meta.body ? meta.body : undefined;
}

// Older sessions retain custom pending markers after completion or failure.
// Seat the outcome there, retaining its identity and summary; a later running
// request stays pending, and cannot replace an unrelated failed request.
function settledCompactionRows(rows: readonly ViewBlock[]): ViewBlock[] {
  const projected: ViewBlock[] = [];
  let pending = -1;
  for (const row of rows) {
    if (row.kind === "marker" && row.role === "compaction") {
      if (pending >= 0) {
        projected[pending] = row;
        pending = -1;
        continue;
      }
    } else if (
      row.kind === "marker" &&
      row.role === "custom" &&
      (row.meta as { compact_marker?: unknown } | null)?.compact_marker === true
    ) {
      if (pending >= 0 && row.text.startsWith("Compaction failed:")) {
        projected[pending] = row;
        pending = -1;
        continue;
      }
      pending = row.text === "Compacting…" ? projected.length : -1;
    }
    projected.push(row);
  }
  return projected;
}

// Operator inputs start turns; agent inputs during tool rounds are steering
// segments of the same turn. A completed reply separates later wake-ups.
export function rowsToTurns(
  rows: readonly ViewBlock[],
  hasOlder = false,
): Turn[] {
  rows = settledCompactionRows(rows);
  const turns: Turn[] = [];
  const attached = new Set<string>();
  let build: TurnBuild | null = null;
  // Invariant: Last turn closed by a shell-notice split: an authoritative run
  // total landing before the next row recreates a build still belongs to it.
  // User rows and compaction fences clear it, so a genuinely late total keeps
  // attributing forward to the newer turn instead.
  let lastClosed: TurnBuild | null = null;
  const ensure = (id: string, index: number): TurnBuild => {
    if (!build) {
      build = openTurn(id, index);
      build.turn.partial =
        hasOlder &&
        turns.length === 0 &&
        rows[index]?.role !== "user" &&
        rows[index]?.role !== "custom";
      return build;
    }
    return build;
  };
  rows.forEach((row, index) => {
    if (row.kind === "marker") {
      if (row.role === "usage") {
        // Invariant: The just-ended run's authoritative total overrides the
        // tail turn's summed estimates. A late row landing after the next user
        // message opened a new turn attributes to that turn instead — a rare,
        // self-healing race the stream refold corrects on resync.
        const total = parseRunTotal(row.usage);
        if (total) {
          if (build) {
            applyRunTotal(build, total);
            build.replySettled = true;
          } else if (lastClosed) {
            // Invariant: One marker per run: consume the split turn so a
            // duplicate or misordered second total drops instead of
            // double-billing.
            applyRunTotal(lastClosed, total);
            summarizeBuild(lastClosed);
            lastClosed = null;
          }
        }
        return;
      }
      if (row.role === "shell-notice") {
        // Invariant: Shell notices close the open turn at their stored
        // position. Later rows follow the marker; only operator input opens
        // response boundaries.
        const body = noticeBody(row);
        const system: MessageEntry = {
          kind: "system",
          offset: row.offset ?? -1,
          role: "marker",
          marker: "shell-notice",
          content: row.text,
          id: `row:${row.id}`,
          ...(body === undefined ? {} : { detail: body }),
        };
        if (
          build &&
          build.turn.segments.some(
            (segment) =>
              segment.user.length > 0 ||
              segment.tools.length > 0 ||
              segment.assistant !== null,
          )
        ) {
          finishTurn(build, turns);
          lastClosed = build;
          build = null;
        }
        turns.push({
          turn_id: `row:${row.id}`,
          cursor: index,
          started_at: null,
          ended_at: null,
          open: false,
          status: "marker",
          summary: null,
          segments: [],
          partial: false,
          system,
        });
        return;
      }
      if (row.role === "compaction-notice") {
        if (build) {
          finishTurn(build, turns);
          build = null;
        }
        lastClosed = null;
        const body = noticeBody(row);
        const system: MessageEntry = {
          kind: "system",
          offset: row.offset ?? -1,
          role: "marker",
          marker: "compaction-notice",
          content: row.text,
          id: `row:${row.id}`,
          ...(body === undefined ? {} : { detail: body }),
        };
        turns.push({
          turn_id: `row:${row.id}`,
          cursor: index,
          started_at: null,
          ended_at: null,
          open: false,
          status: "marker",
          summary: null,
          segments: [],
          partial: false,
          system,
        });
        return;
      }
      // Invariant: Only compaction markers render here: the backend tags its
      // pending/failure rows with meta.compact_marker, and anything else
      // (bg-shell prose, monitor output, other extensions) stays dropped. Usage
      // and shell notices are consumed above.
      const compactMarker =
        (row.meta as { compact_marker?: unknown } | null)?.compact_marker ===
        true;
      if (row.role !== "compaction" && !compactMarker) return;
      if (build) {
        finishTurn(build, turns);
        build = null;
      }
      lastClosed = null;
      const content = row.text;
      const body = row.role === "compaction" ? noticeBody(row) : undefined;
      const system: MessageEntry = {
        kind: "system",
        offset: row.offset ?? -1,
        role: "marker",
        marker: row.role === "compaction" ? "compact" : "custom",
        content,
        id: `row:${row.id}`,
        ...(body === undefined ? {} : { detail: body }),
      };
      turns.push({
        turn_id: `row:${row.id}`,
        cursor: index,
        started_at: null,
        ended_at: null,
        open: false,
        status: "marker",
        summary: null,
        segments: [],
        partial: false,
        system,
      });
      return;
    }
    if (row.kind === "tool_call") {
      const active = ensure(row.id, index);
      active.replySettled = false;
      if (row.safety_usage) {
        active.safetyTurns.push({
          ...openTurn(row.id, index).turn,
          summary: {
            ...summarizeListedTools([]).summary,
            safety_usage: row.safety_usage,
          },
        });
      }
      if (visibleAssistant(active.current.assistant)) {
        active.current = emptySegment();
        active.turn.segments.push(active.current);
      }
      active.seq += 1;
      for (const link of row.pr_links ?? []) {
        if (!active.prLinks.some((held) => held.url === link.url))
          active.prLinks.push(link);
      }
      for (const attachment of row.attachment
        ? [row.attachment]
        : (row.files ?? [])) {
        if (attachment.id && attached.has(attachment.id)) continue;
        if (attachment.id) attached.add(attachment.id);
        const assistant = (active.current.assistant ??= {
          kind: "assistant",
          role: "assistant",
          offset: row.offset ?? -1,
          id: `row:${row.id}`,
          content: "",
        });
        assistant.attachments = [...(assistant.attachments ?? []), attachment];
      }
      const callId = row.id;
      // Invariant: Partial args decode safely, never render raw JSON. Search
      // patterns use details, not summary; declined secret/early prefixes show
      // only the tool name until a complete safe value exists.
      const streaming = streamingRowText(row.name, row.args, row.input);
      const detailStreaming = streamingDetailText(
        row.name,
        row.args,
        row.input,
      );
      active.current.tools.push({
        kind: "tool",
        offset: row.offset ?? -1,
        seq: active.seq,
        name: row.name || "tool",
        input: row.input ?? streaming ?? undefined,
        input_full:
          row.name === "bash"
            ? (streaming ??
              (!row.input && hasArgsPrefix(row.args)
                ? undefined
                : row.args || undefined))
            : (detailStreaming ?? undefined),
        call_id: callId,
        timing: row.timing ?? undefined,
        model_time_ms: active.requestModelTimeMs,
        thinking: active.requestThinking,
        thinking_entry_id: active.requestThinkingEntryId,
        has_thinking: active.requestHasThinking,
        live_thinking: active.requestLiveThinking,
        thinking_elapsed_ms: active.requestThinkingElapsedMs,
        status: "ok",
        running: row.running === true,
        preparing:
          row.offset === -1 && row.live === true && row.running !== true,
        stat: rowStat(row.stat),
        calls: row.calls,
      });
      active.requestThinking = undefined;
      active.requestThinkingEntryId = undefined;
      active.requestHasThinking = undefined;
      active.requestLiveThinking = undefined;
      active.requestThinkingElapsedMs = undefined;
      return;
    }
    if (row.kind !== "text") return;
    if (row.role === "assistant") {
      const active = ensure(row.id, index);
      // Invariant: Empty generation handovers are not final replies; only
      // settled reply text/errors or an authoritative run total seal the run.
      active.replySettled ||=
        !row.live &&
        row.stop_reason !== "toolUse" &&
        Boolean(row.text.trim() || row.error);
      active.requestModelTimeMs = row.model_time_ms ?? undefined;
      active.requestThinking = row.thinking_title;
      active.requestThinkingEntryId = `row:${row.id}`;
      active.requestHasThinking = row.has_thinking === true;
      active.requestLiveThinking = row.live_thinking === true;
      active.requestThinkingElapsedMs =
        typeof row.thinking_elapsed_ms === "number"
          ? row.thinking_elapsed_ms
          : undefined;
      const usage = rowUsageModel(row.usage);
      addRowUsage(active.usage, row.usage);
      const interrupted =
        row.stop_reason === "aborted" || row.stop_reason === "abort";
      // Invariant: An operator stop settles the whole turn: once a row carries
      // the abort outcome, later rows (an error stirred up by the abort, or a
      // trailing idle row) must not regrade it to Failed or clear it.
      if (interrupted) active.turn.status = "interrupted";
      else if (active.turn.status !== "interrupted")
        active.turn.status = row.error ? "error" : "idle";
      const error =
        active.turn.status === "interrupted"
          ? undefined
          : (row.error ?? undefined);
      const errorDetail =
        active.turn.status === "interrupted"
          ? undefined
          : (row.error_detail ?? undefined);
      const refusedText =
        error && row.stop_reason === "refused"
          ? active.turn.segments
              .flatMap((segment) => segment.user)
              .filter((user) => user.origin !== "agent")
              .map((user) => user.content)
              .join("\n\n")
          : undefined;
      // Invariant: Consecutive tool-only requests share one series until reply
      // text or input separates them. Request timing and thinking ride their
      // tools, so merging the empty assistant rows cannot overwrite that
      // metadata.
      if (active.current.assistant?.content?.trim()) {
        active.current = emptySegment();
        active.turn.segments.push(active.current);
      }
      const held = active.current.assistant;
      if (!held) {
        const entry: MessageEntry = {
          kind: "assistant",
          offset: row.offset ?? -1,
          role: "assistant",
          id: `row:${row.id}`,
          content: row.text,
          thinking: row.thinking_title,
          has_thinking: row.has_thinking,
          live_thinking: row.live_thinking === true,
          thinking_elapsed_ms: row.thinking_elapsed_ms,
          error,
          error_detail: errorDetail,
          refused_text: refusedText,
          model_time_ms: row.model_time_ms ?? undefined,
          model_responses: row.model_response ? [row.model_response] : [],
        };
        if (usage) {
          entry.usage = usage;
          entry.latest_usage = usage;
        }
        active.current.assistant = entry;
      } else {
        held.content = held.content
          ? `${held.content}\n\n${row.text}`
          : row.text;
        held.id = `row:${row.id}`;
        held.thinking = row.thinking_title;
        held.has_thinking = row.has_thinking;
        held.live_thinking = row.live_thinking === true;
        held.thinking_elapsed_ms = row.thinking_elapsed_ms;
        if (row.model_response)
          (held.model_responses ??= []).push(row.model_response);
        if (error && held.error && !held.content)
          held.error_attempts = (held.error_attempts ?? 1) + 1;
        held.error = error;
        held.error_detail = errorDetail;
        held.refused_text = refusedText;
        if (row.model_time_ms !== null && row.model_time_ms !== undefined)
          held.model_time_ms = row.model_time_ms;
        if (usage) {
          const base = rowUsageModel(held.usage);
          held.usage = {
            input: (base?.input ?? 0) + usage.input,
            output: (base?.output ?? 0) + usage.output,
            cacheRead: (base?.cacheRead ?? 0) + usage.cacheRead,
            cacheWrite: (base?.cacheWrite ?? 0) + usage.cacheWrite,
          };
          held.latest_usage = usage;
        }
      }
      return;
    }
    if (row.role === "user" || row.role === "custom") {
      const origin = userOrigin(row.origin);
      const steered =
        build &&
        !build.replySettled &&
        (origin === "agent" || origin === "platform");
      if (
        !steered &&
        build &&
        build.turn.segments.some(
          (segment) =>
            segment.user.length > 0 ||
            segment.tools.length > 0 ||
            segment.assistant !== null,
        )
      ) {
        finishTurn(build, turns);
        build = null;
      }
      lastClosed = null;
      const active = ensure(row.id, index);
      if (
        active.current.user.length > 0 ||
        active.current.tools.length > 0 ||
        active.current.assistant !== null
      ) {
        const next = emptySegment();
        active.turn.segments.push(next);
        active.current = next;
      }
      const entry: MessageEntry = {
        kind: "user",
        offset: row.offset ?? -1,
        role: "user",
        id: `row:${row.id}`,
        content: stripRowEnvelope(row.text),
      };
      if (origin) entry.origin = origin;
      if (typeof row.sender === "string" && row.sender) entry.from = row.sender;
      if (typeof row.sender_name === "string" && row.sender_name)
        entry.from_name = row.sender_name;
      active.current.user.push(entry);
      return;
    }
  });
  if (build) finishTurn(build, turns);
  return turns;
}
