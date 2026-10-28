// Pure collapsed/expanded turn models preserve steered replies/attachments and
// restore segments in chronological order. Tool wording uses closed labels and
// redacted details, except the owning conversation's bounded whole commands.
import type {
  AgentAttachment,
  MessageEntry,
  ToolEntry,
  ToolStat,
  TreeNode,
  Turn,
  TurnEntry,
  TurnSegment,
  TurnSummary,
} from "../types.js";
import { summaryLine } from "./turn-summary.js";
import { namedToolSummary } from "./tool_activity.js";

export function isAgentMessage(entry: MessageEntry): boolean {
  return typeof entry.from === "string" && entry.from.trim().length > 0;
}

// Platform traffic is presentation metadata, never inferred from authored
// prose. Missing provenance therefore fails open as operator input.
export function isPlatformInterruption(entry: MessageEntry): boolean {
  if (entry.kind !== "user" || entry.role !== "user") return false;
  const provenance = [entry.origin, entry.source].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return provenance?.trim() === "platform";
}

export function isAgentActivityMessage(entry: MessageEntry): boolean {
  if (isAgentMessage(entry) || isPlatformInterruption(entry)) return true;
  // Invariant: A backend reminder or lifecycle line batched behind the row's
  // parsed origin tag loses its structured provenance but keeps its wording:
  // fold such rows even though they look operator-shaped.
  if (isInternalNoticeOnly(entry)) return true;
  const origin = typeof entry.origin === "string" ? entry.origin.trim() : "";
  const source = typeof entry.source === "string" ? entry.source.trim() : "";
  // Invariant: Immutable pre-cron-removal rows still carry scheduled/cron
  // provenance. A present stamp decides alone: only an unstamped row falls
  // through to its content header, so a leaked agent tag can never fold a
  // stamped operator row and hide operator prose.
  if (origin !== "" || source !== "")
    return (
      origin === "agent" ||
      origin === "scheduled" ||
      origin === "platform" ||
      origin === "service" ||
      source === "cron"
    );
  // Invariant: Structured provenance stays authoritative. Only unstamped rows
  // fall back to origin tags; untagged input fails open as operator prose.
  if (typeof entry.content !== "string") return false;
  const contentOrigin = parsedContentOrigin(entry.content);
  return contentOrigin !== null && contentOrigin !== "operator";
}

// Folds backend delivery fragments; strips only whole marker lines.
const BG_REMINDER_HEAD = /^Background shells still running \(\d+\):\s*$/;
const BG_REMINDER_ITEM = /^-\s+\S+\s+\((?:running|stopping),[^()\n]*\)/;
const BG_REMINDER_TAIL = /^… and \d+ more\s*$/;
// Unquoted origin tags mark backend chrome; operator tags preserve mixed rows.
const CONTENT_ORIGIN =
  /\[recurse-origin: (operator|agent|scheduled|platform|service)\]/;
export function parsedContentOrigin(content: unknown): string | null {
  if (typeof content !== "string" || !content.includes("[recurse-origin:"))
    return null;
  const scan = new RegExp(CONTENT_ORIGIN.source, "g");
  let found: string | null = null;
  for (const match of content.matchAll(scan)) {
    if (match[1] === "operator") return "operator";
    found ??= match[1] ?? null;
  }
  return found;
}
// Surviving tag-only envelopes are leaked backend chrome, never operator prose.
const ENVELOPE_LINE =
  /^\[recurse-origin(?:-quoted)?: (?:operator|agent|scheduled|platform|service)\]\s*$/;
// Surviving sender-only lines are leaked attribution stripped by the backend.
const SENDER_LINE = /^\[recurse-from(?:-name)?(?:-quoted)?: [^\n\]]*\]\s*$/;
// Quoted inner envelopes mark twice-forwarded fragments, not authored prose.
const QUOTED_ENVELOPE =
  /\[recurse-origin-quoted: (?:operator|agent|scheduled|platform|service)\]/;
const QUOTED_ENVELOPE_GLOBAL = new RegExp(QUOTED_ENVELOPE.source, "g");
// Bracketed notices beside envelope chrome are backend text, not prose.
const BRACKETED_LINE = /^\[.*\]$/;
const REAP_NOTICE = /\[Subagent "[^"\n]*" \(id [^)\n]*\) was deleted/;
// Restart reminder matchers are single-line: commands are JSON-quoted.
const RESTART_LOST_LINE =
  /^Background command ".*" did not finish before Recurse restarted and is no longer running\.$/;
const RESTART_DONE_LINE =
  /^Background command ".*" finished while Recurse was restarting; its completion details are in this session\.$/;
// Strips hidden frame headings only beside envelopes, never bare ## Message.
const FRAME_LINE = /^## Message\s*$/;
// Standalone/trailing receipts are leaked chrome; ids match backend display.
const TRAILER_LINE = /^\[recurse-delivery:[A-Za-z0-9_.:-]{1,128}\]\s*$/;
const TRAILING_TRAILER = /\n?\[recurse-delivery:[A-Za-z0-9_.:-]{1,128}\]\s*$/;
// Unwraps canonical, legacy and quoted guidance; outside prose is untouched.
const REMINDER_BLOCK =
  /<system[_-]reminder(?:-quoted)?>([\s\S]*?)<\/(?:system[_-]reminder(?:-quoted)?)>/g;

// Strips only turn-report framing: a known trigger with optional "; …" notes.
const TURN_TRIGGER =
  /\(turn started by (?:your message|an agent message|an operator message|a system message)(?:; [^()\n]+)?\)/u;
const TURN_REPORT = new RegExp(
  `^(.* ended) ${TURN_TRIGGER.source} (with no final message\\.)`,
  "u",
);
export function stripTurnDeliveryChrome(content: string): string {
  const leading = content.match(new RegExp(`^${TURN_TRIGGER.source}\\n?`, "u"));
  const withoutLeading = leading ? content.slice(leading[0].length) : content;
  return withoutLeading.replace(TURN_REPORT, "$1 $2");
}

function isInternalNoticeLine(line: string): boolean {
  const text = line.trim();
  return (
    BG_REMINDER_HEAD.test(text) ||
    BG_REMINDER_ITEM.test(text) ||
    BG_REMINDER_TAIL.test(text) ||
    ENVELOPE_LINE.test(text) ||
    SENDER_LINE.test(text) ||
    TRAILER_LINE.test(text) ||
    REAP_NOTICE.test(text) ||
    RESTART_LOST_LINE.test(text) ||
    RESTART_DONE_LINE.test(text)
  );
}

// Envelope/receipt/quoted-envelope chrome identifies backend delivery rows.
// Backend stripping and authored-tag escaping keep operator prose distinct.
function hasDeliveryChrome(content: string): boolean {
  if (QUOTED_ENVELOPE.test(content)) return true;
  return content
    .split("\n")
    .map((line) => line.trim())
    .some(
      (text) =>
        ENVELOPE_LINE.test(text) ||
        SENDER_LINE.test(text) ||
        TRAILER_LINE.test(text),
    );
}

function mayHoldInternalNotice(content: string): boolean {
  return (
    content.includes("Background shells still running (") ||
    content.includes("[recurse-origin") ||
    content.includes("[recurse-from") ||
    content.includes('[Subagent "') ||
    content.includes("## Message") ||
    content.includes("[recurse-delivery:") ||
    content.includes("[Recurse restarted]") ||
    content.includes("[Platform notice:") ||
    content.includes("## Runtime context") ||
    content.includes("## Digest:") ||
    content.includes("<system_reminder>") ||
    content.includes("<system-reminder>") ||
    content.includes("<system_reminder-quoted>") ||
    content.includes("<system-reminder-quoted>") ||
    content.includes("</system_reminder>") ||
    content.includes("</system-reminder>") ||
    content.includes("</system_reminder-quoted>") ||
    content.includes("</system-reminder-quoted>")
  );
}

// Hidden-context headings gate frame stripping; bare ## Message stays visible.
const HIDDEN_CONTEXT_HEAD = /^(## Runtime context|## Digest:)\s*$/;

export function splitHiddenFrame(content: string): string {
  const lines = content.split("\n");
  const frame = lines.findIndex((line) => FRAME_LINE.test(line.trim()));
  if (frame < 0) return content;
  const headed = lines
    .slice(0, frame)
    .some((line) => HIDDEN_CONTEXT_HEAD.test(line.trim()));
  return headed ? lines.slice(frame + 1).join("\n") : content;
}

// Unwraps reminder content before line matching; outside prose is untouched.
// Uses newline spelling shared with the backend unwrappers.
function unwrapReminderBlocks(content: string): string {
  return content.replace(REMINDER_BLOCK, (_match, body: string) =>
    body.replace(/^\n+|\n+$/g, ""),
  );
}

// The row's prose with turn-internal delivery lines removed. Pure, so mixed
// rows keep their operator text while notice-only rows collapse to blank.
export function stripInternalNoticeLines(content: unknown): string {
  if (typeof content !== "string" || !mayHoldInternalNotice(content)) {
    return typeof content === "string" ? content : "";
  }
  // Invariant: Hidden context never reaches bubbles; reminders unwrap next.
  // Twice-formatted envelopes identify delivery fragments: strip markers and
  // bracketed notice lines, independent of notice wording.
  const quoted = QUOTED_ENVELOPE.test(content);
  const lines = unwrapReminderBlocks(splitHiddenFrame(content)).split("\n");
  const framed = lines.some((line) => ENVELOPE_LINE.test(line.trim()));
  const kept = lines.filter((line) => {
    let text = line.trim();
    if (quoted) {
      text = text.replace(QUOTED_ENVELOPE_GLOBAL, "").trim();
      if (!text) return false;
      if (BRACKETED_LINE.test(text)) return false;
    }
    if (isInternalNoticeLine(text)) return false;
    return framed ? !FRAME_LINE.test(text) : true;
  });
  return kept.join("\n").replace(TRAILING_TRAILER, "").trim();
}

export function isInternalNoticeOnly(entry: MessageEntry): boolean {
  const content = typeof entry.content === "string" ? entry.content : "";
  if (!content.trim() || !mayHoldInternalNotice(content)) return false;
  const stripped = stripInternalNoticeLines(content);
  if (stripped === "") return true;
  // Invariant: A framed backend notice keeps its body once the chrome is gone
  // (restart recovery, reconciler platform notices); the chrome proves it is a
  // delivery row, so fold the whole row instead of bubbling the notice text.
  return (
    hasDeliveryChrome(content) &&
    BRACKETED_LINE.test(stripped.split("\n")[0].trim())
  );
}

// Strips delivery chrome; empty fragments render no bubble or placeholder.
export function activityBodyText(entry: MessageEntry): string {
  return stripTurnDeliveryChrome(
    stripInternalNoticeLines(entry.content),
  ).trim();
}

export function isAgentOnlyTurn(turn: Turn): boolean {
  // Invariant: A byte-bounded partial view may omit the operator input that
  // makes a turn mixed. Preserve its final reply rather than hiding it on
  // incomplete evidence.
  if (turn.partial) return false;
  let agentMessages = 0;
  let humanMessages = 0;
  for (const segment of turn.segments || []) {
    for (const entry of segment.user || []) {
      if (isAgentActivityMessage(entry)) agentMessages += 1;
      else humanMessages += 1;
    }
  }
  return agentMessages > 0 && humanMessages === 0;
}

export interface AgentMessageHeaderView {
  senderId: string;
  senderName: string;
  relationship: string;
  available: boolean;
}

// Keep the delivered sender id/name even if its conversation is later reaped;
// only a live tree row becomes a navigation target.
export function agentMessageHeader(
  entry: MessageEntry,
  current: { id: string; parent?: string | null },
  nodes: Readonly<Record<string, TreeNode>>,
): AgentMessageHeaderView | null {
  if (!isAgentMessage(entry)) return null;
  const senderId = entry.from!.trim();
  const node = nodes[senderId];
  const remoteLabel = senderId.match(/@([A-Za-z0-9._-]{1,32})$/)?.[1];
  let relationship = "agent";
  if (remoteLabel) relationship = `remote agent · ${remoteLabel}`;
  else if (!node) relationship = "removed agent";
  else if (senderId === current.parent) relationship = "parent agent";
  else if (node.parent === current.id) relationship = "child agent";
  else if (current.parent && node.parent === current.parent)
    relationship = "sibling agent";
  return {
    senderId,
    senderName:
      node?.title || entry.from_name || `Agent ${senderId.slice(0, 8)}`,
    relationship,
    available: Boolean(node),
  };
}

export interface ToolHeaderView {
  label: string;
  detail: string;
  // Front-truncated read details keep filename ends; tooltips keep full text.
  detailTitle?: string;
  note: string;
  stale: boolean;
  truncated: boolean;
}

const KIND_LABEL: Record<string, string> = {
  read: "Read",
  edit: "Update",
  write: "Write",
  shell: "Bash",
  search: "Search",
  web: "Fetch",
};

const SHELL_ACTION: Record<string, string> = {
  subagent_create: "Created an agent",
  subagent_send: "Messaged an agent",
  subagent_rm: "Reaped an agent",
  backgrounded: "Backgrounded — still running",
  worktree_enter: "Entered a worktree",
  cron_create: "Scheduled a task",
  pr_create: "Opened a pull request",
  pr_merge: "Merged a pull request",
};

const STALE_NOTE = "stopped before finishing";
const TRUNCATED_NOTE =
  "The rest of this turn's calls were not recorded individually";

export function turnOutcomeLabel(status: Turn["status"]): string {
  if (status === "error") return "Failed";
  // Invariant: An operator-requested stop (Stop button / qq) settles the turn
  // as interrupted — the server records stop/abort, not an error — so it reads
  // Stopped, never Failed.
  if (status === "interrupted") return "Stopped";
  return "";
}

const upperFirst = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);
const lineCount = (n: number): string => `${n} line${n === 1 ? "" : "s"}`;

function statNote(stat: ToolStat): string {
  if (stat.kind === "read") return stat.lines ? lineCount(stat.lines) : "";
  if (stat.kind === "edit") {
    const parts: string[] = [];
    if (stat.added) parts.push(`+${stat.added}`);
    if (stat.removed) parts.push(`-${stat.removed}`);
    const count = (stat.added || 0) + (stat.removed || 0);
    return parts.length
      ? `${parts.join(" ")} line${count === 1 ? "" : "s"}`
      : "";
  }
  if (stat.kind === "write")
    return stat.added ? `Added ${lineCount(stat.added)}` : "";
  if (stat.kind === "shell")
    return (stat.action && SHELL_ACTION[stat.action]) || "";
  return "";
}

// Uses durable call ids to merge reread windows, preserving distinct repeats.
// Legacy rows use stable offset plus ordinal identity.
export function toolRowKey(entry: ToolEntry): string {
  return entry.call_id
    ? `call:${entry.call_id}`
    : `row:${entry.offset}:${entry.seq}`;
}

export interface ServedToolData {
  args: string;
  result: string | null;
  result_truncated: boolean;
  calls?: CodemodeCall[] | null;
}

export interface ToolExpansion {
  args: string | null;
  output: string | null;
  outputTruncated: boolean;
  calls?: CodemodeCall[] | null;
}

export interface CodemodeCall {
  stat?: ToolEntry["stat"];
  summary?: { name: string; stat: ToolEntry["stat"]; count: number }[];
  name: string;
  args: string;
  status: string;
  durationMs?: number;
  error?: string;
  omitted?: number;
}

// Server names may themselves contain "__"; the first split is a display
// guess only (pi-safety resolves the exact server from the tool namespace).
export function codemodeCallName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  return match ? `${match[1]}/${match[2]}` : name;
}

/** The codemode script: the `code` argument, else the raw arguments. */
export function codemodeScript(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === "object" && "code" in parsed) {
      const code = (parsed as { code: unknown }).code;
      if (typeof code === "string") return code;
    }
  } catch {}
  return args;
}

/** Script row label counts all nested calls, including those past the cap. */
export function codemodeHeaderLabel(calls: readonly CodemodeCall[]): string {
  const count = calls.reduce((n, call) => n + (call.omitted ?? 1), 0);
  return count === 0 ? "Ran a script" : `Ran a script · ${count} tools`;
}

// Read from the error text pi-safety writes. A server's own error that starts
// with "[pi-safety]" would also read as blocked; that only mislabels a call
// that failed anyway.
export function codemodeCallBlockReason(call: CodemodeCall): string | null {
  const error = call.error ?? "";
  if (!error.startsWith("[pi-safety]")) return null;
  const text = error.slice("[pi-safety]".length).trim();
  const because = /blocked because (.+?\.)(?:\.|\s|$)/u.exec(text);
  if (because) return because[1]!;
  const sentence = /^.+?\.(?=\s|$)/u.exec(text);
  return sentence ? sentence[0] : text;
}

/** One nested call's status line: status, then duration when finished. */
export function codemodeCallStatus(call: CodemodeCall): string {
  if (codemodeCallBlockReason(call) !== null) return "blocked by safety review";
  return call.durationMs === undefined
    ? call.status
    : `${call.status} · ${call.durationMs} ms`;
}

// Payloads own expansion; otherwise open served args/output or stored command.
// Heads with nothing more to show have no control or empty pane.
export function toolExpansion(
  entry: ToolEntry,
  block: ServedToolData | null,
): ToolExpansion {
  const full = entry.input_full || block?.args || "";
  if (entry.name === "codemode" && block)
    return {
      args: block.args ? codemodeScript(block.args) : null,
      output: block.result || null,
      outputTruncated: block.result_truncated,
      calls: block.calls?.length ? block.calls : null,
    };
  return {
    args:
      !entry.artifact_id && full && full !== (entry.input || "") ? full : null,
    output: block?.result || null,
    outputTruncated: block?.result_truncated ?? false,
  };
}

// Long read details retain the filename end; short details stay unchanged.
const MAX_READ_DETAIL_CHARS = 120;

export function clipReadDetail(
  value: string,
  limit: number = MAX_READ_DETAIL_CHARS,
): string {
  const chars = [...value];
  if (chars.length <= limit) return value;
  if (limit <= 1) return "…";
  const tail = chars.slice(-(limit - 1)).join("");
  const boundary = tail.indexOf("/");
  return `…${boundary > 0 ? tail.slice(boundary) : tail}`;
}

export function toolHeader(entry: ToolEntry): ToolHeaderView {
  if (entry.status === "truncated") {
    return {
      label: "",
      detail: "",
      note: TRUNCATED_NOTE,
      stale: false,
      truncated: true,
    };
  }
  const stat = entry.stat;
  const name = (entry.name || "").trim();
  const label = KIND_LABEL[stat.kind] || (name ? upperFirst(name) : "Tool");
  const full = entry.input_full || entry.input || "";
  const stale = entry.status === "stale";
  let note = statNote(stat);
  if (stale) note = note ? `${note} · ${STALE_NOTE}` : upperFirst(STALE_NOTE);
  if (stat.kind === "read") {
    const detail = clipReadDetail(full);
    return {
      label,
      detail,
      detailTitle: detail === full ? undefined : full,
      note,
      stale,
      truncated: false,
    };
  }
  return { label, detail: full, note, stale, truncated: false };
}

export interface ToolSeriesDisclosure {
  open: boolean;
  visibleLabel: string;
  ariaLabel: string;
}

// Completed calls use the same default-closed disclosure while a turn streams
// and after it settles. The separate live row owns only calls still running.
export function toolSeriesDisclosure(
  summary: string,
  expanded: boolean,
): ToolSeriesDisclosure {
  return {
    open: expanded,
    visibleLabel: summary,
    ariaLabel: `${expanded ? "Hide" : "Show"} activity: ${summary}`,
  };
}

export interface SegmentView {
  user: MessageEntry[];
  assistant: MessageEntry | null;
}

export interface HiddenAssistantOutput {
  messages: number;
  characters: number;
}

export interface HiddenAssistantOutputPlacement {
  segmentIndex: number;
  output: HiddenAssistantOutput;
}

export type CollapsedVisibleAssistants = ReadonlySet<MessageEntry>;

// A steer is a durable user row in the middle of a turn. Its predecessor is
// the previous logical message in that turn; tool and other structure rows do
// not participate in the order. Showing that predecessor keeps a collapsed
// turn anchored to the input the operator was responding to.
export function collapsedVisibleAssistants(
  turn: Turn,
): CollapsedVisibleAssistants {
  const visible = new Set<MessageEntry>();
  let previous: MessageEntry | null = null;
  for (const segment of turn.segments || []) {
    for (const user of segment.user || []) {
      if (
        user.steer === true &&
        previous?.kind === "assistant" &&
        visibleAssistant(previous)
      ) {
        visible.add(previous);
      }
      previous = user;
    }
    if (segment.assistant) previous = segment.assistant;
  }
  return visible;
}

function assistantIsVisible(
  assistant: MessageEntry,
  visible: MessageEntry | CollapsedVisibleAssistants | null,
): boolean {
  if (!visible) return false;
  return (
    visible === assistant ||
    ("has" in visible &&
      typeof visible.has === "function" &&
      visible.has(assistant))
  );
}

interface AssistantTextStat {
  message: boolean;
  characters: number;
}

// Committed message text is immutable, but each poll can deserialize it into a
// fresh object. Cache by its durable place in the loaded turn rather than by
// object identity so large intermediate replies are scanned once. The bounded
// FIFO means scrolling through old history cannot grow view state forever.
export class HiddenAssistantOutputCounter {
  private readonly textStats = new Map<string, AssistantTextStat>();

  constructor(private readonly limit = 4096) {}

  placements(
    turn: Turn,
    visible: MessageEntry | CollapsedVisibleAssistants | null,
    scope = turn.turn_id,
  ): HiddenAssistantOutputPlacement[] {
    const placements: HiddenAssistantOutputPlacement[] = [];
    let segmentIndex = -1;
    let messages = 0;
    let characters = 0;
    const flush = () => {
      if (messages)
        placements.push({
          segmentIndex,
          output: { messages, characters },
        });
      segmentIndex = -1;
      messages = 0;
      characters = 0;
    };
    (turn.segments || []).forEach((segment, index) => {
      // Invariant: User entries delimit hidden replies. Combine replies only
      // across segments that carry no user entry of their own.
      if ((segment.user || []).length && messages) flush();
      const assistant = segment.assistant;
      if (!assistant) return;
      if (assistantIsVisible(assistant, visible)) {
        flush();
        return;
      }
      const stat = this.textStat(assistant, scope, index);
      if (!stat.message) return;
      if (segmentIndex < 0) segmentIndex = index;
      messages += 1;
      characters += stat.characters;
    });
    flush();
    return placements;
  }

  count(
    turn: Turn,
    visible: MessageEntry | CollapsedVisibleAssistants | null,
    scope = turn.turn_id,
  ): HiddenAssistantOutput {
    return this.placements(turn, visible, scope).reduce(
      (total, placement) => ({
        messages: total.messages + placement.output.messages,
        characters: total.characters + placement.output.characters,
      }),
      { messages: 0, characters: 0 },
    );
  }

  private textStat(
    assistant: MessageEntry,
    scope: string,
    index: number,
  ): AssistantTextStat {
    const identity = assistant.id ?? assistant.offset ?? index;
    const key = `${scope}\0${index}\0${identity}`;
    let stat = this.textStats.get(key);
    if (!stat) {
      stat = assistantTextStat(assistant.content);
      while (this.textStats.size >= this.limit) {
        const oldest = this.textStats.keys().next().value;
        if (oldest === undefined) break;
        this.textStats.delete(oldest);
      }
      this.textStats.set(key, stat);
    }
    return stat;
  }
}

function assistantTextStat(content: unknown): AssistantTextStat {
  const text = typeof content === "string" ? content : "";
  if (!text.trim()) return { message: false, characters: 0 };
  // Invariant: "Characters" means Unicode code points in the exact stored text:
  // leading, trailing, and internal whitespace count, while an all-whitespace
  // record does not become a message. This avoids UTF-16 counting astral
  // characters twice.
  let characters = 0;
  for (const _character of text) characters += 1;
  return { message: true, characters };
}

export function hiddenAssistantOutputLabel(
  output: HiddenAssistantOutput,
): string {
  const messages = `${output.messages} message${output.messages === 1 ? "" : "s"}`;
  const characters = `${output.characters} character${output.characters === 1 ? "" : "s"}`;
  return `${messages} hidden (${characters})`;
}

export function isNoticeOnlyAssistant(entry: MessageEntry | null): boolean {
  if (!entry?.notices?.length) return false;
  // Invariant: `tools` counts the segment's calls, which render in their own
  // row and say nothing about whether this entry is a reply. Reading it here
  // made every notice that followed a tool call outrank the real reply beside
  // it.
  return (
    !(entry.content || "").trim() &&
    !entry.attachments?.length &&
    !entry.stopped &&
    !entry.error
  );
}

export function visibleAssistant(
  entry: MessageEntry | null,
): MessageEntry | null {
  if (!entry) return null;
  return (entry.content || "").trim() ||
    entry.attachments?.length ||
    entry.stopped ||
    entry.error ||
    entry.notices?.length
    ? entry
    : null;
}

export function finalAssistant(turn: Turn): MessageEntry | null {
  for (let i = (turn.segments || []).length - 1; i >= 0; i--) {
    const assistant = visibleAssistant(turn.segments[i].assistant);
    if (assistant && !isNoticeOnlyAssistant(assistant)) return assistant;
  }
  return null;
}

export function collapsedTurn(turn: Turn): SegmentView[] {
  if (turn.system || !turn.segments?.length) return [];
  const agentOnly = isAgentOnlyTurn(turn);
  const final = agentOnly ? null : finalAssistant(turn);
  const visible = agentOnly
    ? new Set<MessageEntry>()
    : collapsedVisibleAssistants(turn);
  return turn.segments.map((segment) => {
    const assistant = segment.assistant;
    return {
      user: (segment.user || []).filter(
        (entry) => !isAgentActivityMessage(entry),
      ),
      assistant:
        assistant &&
        (isNoticeOnlyAssistant(assistant) ||
          assistant === final ||
          visible.has(assistant))
          ? assistant
          : null,
    };
  });
}

// Collapsing intermediate prose never hides published file outcomes.
export function turnAttachments(turn: Turn): AgentAttachment[] {
  return (turn.segments || []).flatMap(
    (segment) => segment.assistant?.attachments || [],
  );
}

export function expandedTurn(turn: Turn): TurnEntry[] {
  const entries: TurnEntry[] = [];
  for (const segment of turn.segments || []) {
    entries.push(...(segment.user || []), ...(segment.tools || []));
    if (segment.assistant) entries.push(segment.assistant);
  }
  return entries;
}

export interface ListedToolSummary {
  summary: TurnSummary;
  calls: number;
  partial: boolean;
}

const emptyListedSummary = (): TurnSummary => ({
  tools: 0,
  shell: 0,
  read_files: 0,
  edit_files: 0,
  added: 0,
  removed: 0,
  write_files: 0,
  agents: 0,
  agent_messages: 0,
  agent_reaps: 0,
  searches: 0,
  web: 0,
  prs: [],
  truncated: false,
});

/** Replace script wrappers with their server-classified nested calls. */
function summaryTools(tools: readonly ToolEntry[] | undefined): ToolEntry[] {
  return (tools || []).flatMap((entry) =>
    entry.name === "codemode" && entry.calls?.length
      ? entry.calls.flatMap((call) =>
          (call.summary ?? [{ ...call, count: call.omitted ?? 1 }]).map(
            (nested) => ({
              ...entry,
              name: nested.name,
              stat: nested.stat ?? { kind: "other" as const },
              count: nested.count,
              calls: null,
            }),
          ),
        )
      : [entry],
  );
}

// Classifies listed calls when a recorded summary is absent, matching backend
// stat dimensions and structural shell actions. Truncation markers are not
// calls.
export function summarizeListedTools(
  tools: readonly ToolEntry[] | undefined,
): ListedToolSummary {
  const summary = emptyListedSummary();
  let calls = 0;
  let partial = false;
  const add = (field: keyof TurnSummary, value: number): void => {
    if (!Number.isSafeInteger(value) || value < 0) {
      partial = true;
      return;
    }
    const next = ((summary[field] as number | undefined) || 0) + value;
    if (!Number.isSafeInteger(next)) {
      partial = true;
      return;
    }
    (summary as unknown as Record<string, number>)[field] = next;
  };
  for (const entry of summaryTools(tools)) {
    if (entry.status === "truncated") continue;
    const count = entry.count ?? 1;
    calls += count;
    switch (entry.stat?.kind) {
      case "read":
        add("read_files", count);
        break;
      case "edit":
        add("edit_files", count);
        add("added", entry.stat?.added || 0);
        add("removed", entry.stat?.removed || 0);
        break;
      case "write":
        add("write_files", count);
        add("added", entry.stat?.added || 0);
        break;
      case "shell":
        add("shell", count);
        if (entry.stat?.action === "subagent_create") add("agents", count);
        else if (entry.stat?.action === "subagent_send")
          add("agent_messages", count);
        else if (entry.stat?.action === "subagent_rm")
          add("agent_reaps", count);
        break;
      case "search":
        add("searches", count);
        break;
      case "web":
        add("web", count);
        break;
      default:
        break;
    }
  }
  if (calls > 0) add("tools", calls);
  return { summary, calls, partial };
}

const CLASSIFIED_BREAKDOWN_FIELDS = [
  "shell",
  "read_files",
  "edit_files",
  "added",
  "removed",
  "write_files",
  "agents",
  "agent_messages",
  "agent_reaps",
  "searches",
  "web",
] as const;

function classifiedToolCount(summary: TurnSummary | null): number {
  if (!summary) return 0;
  return [
    summary.shell,
    summary.read_files,
    summary.edit_files,
    summary.write_files,
    summary.searches,
    summary.web,
  ].reduce((total, value) => total + Math.max(0, value), 0);
}

export function toolSeriesSummary(segment: TurnSegment): string {
  const listedTools = summaryTools(segment.tools).filter(
    (entry) => entry.status !== "truncated",
  );
  const total = Math.max(
    listedTools.reduce((count, entry) => count + (entry.count ?? 1), 0),
    segment.summary?.tools || 0,
  );
  const listedSummary = segment.summary
    ? null
    : summarizeListedTools(segment.tools).summary;
  const classified = segment.summary ?? listedSummary;
  const running = listedTools.filter(
    (entry) =>
      entry.running && entry.stat.kind === "shell" && !entry.stat.action,
  ).length;
  const preparing = listedTools.filter(
    (entry) =>
      entry.preparing && entry.stat.kind === "shell" && !entry.stat.action,
  ).length;
  const line =
    summaryLine(segment.summary, 0, running, preparing) ||
    (listedSummary &&
    CLASSIFIED_BREAKDOWN_FIELDS.some((field) => (listedSummary[field] || 0) > 0)
      ? summaryLine(listedSummary, 0, running, preparing)
      : "");
  if (!total)
    return segment.tools?.some((entry) => entry.status === "truncated")
      ? "Tool activity"
      : "";

  const named = namedToolSummary(listedTools);
  const other = Math.max(
    0,
    total - classifiedToolCount(classified) - named.count,
  );
  const extras = [...named.parts];
  if (other) extras.push(`used ${other} other tool${other === 1 ? "" : "s"}`);

  // Invariant: A bare tool-use count is the old fallback for an unclassified
  // series. Use the same explicit fallback as the addendum so no call
  // disappears.
  if (!line || /^\d+ tool use/.test(line))
    return extras.length
      ? `${extras[0]![0].toUpperCase()}${extras[0]!.slice(1)}${extras
          .slice(1)
          .map((part) => `, ${part}`)
          .join("")}`
      : `${total} tool use${total === 1 ? "" : "s"}`;
  return [line, ...extras].join(", ");
}

export function turnExpandable(turn: Turn, extraTools = 0): boolean {
  if (
    (turn.segments || []).some((segment) =>
      (segment.user || []).some((entry) => isAgentActivityMessage(entry)),
    )
  )
    return true;
  if (extraTools > 0 || (turn.summary?.tools || 0) > 0) return true;
  if ((turn.segments || []).some((segment) => toolSeriesSummary(segment)))
    return true;
  return (turn.segments || [])
    .slice(0, -1)
    .some((segment) => visibleAssistant(segment.assistant));
}

export function turnSummaryLine(turn: Turn): string {
  const incoming = (turn.segments || []).reduce(
    (total, segment) =>
      total +
      (segment.user || []).filter((entry) => isAgentMessage(entry)).length,
    0,
  );
  return summaryLine(turn.summary, incoming);
}
