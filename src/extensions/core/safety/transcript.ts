import { createHash } from "node:crypto";

type MessageLike = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
};

type EntryLike = {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: MessageLike;
};

type RecurseOrigin =
  | "operator"
  | "agent"
  | "scheduled"
  | "platform"
  | "unknown";

type TranscriptItem = {
  entryIndex: number;
  segmentIndex: number;
  evidenceKey?: string;
  role: "user" | "assistant" | "tool";
  text: string;
  origin?: RecurseOrigin;
  toolName?: string;
  command?: string;
  toolOutput?: string;
};

type ToolCallLike = {
  entryIndex: number;
  segmentIndex: number;
  name: string;
  arguments: Record<string, unknown>;
};

const DEFAULT_MAX_CHARS = 80_000;
// Recent user/final-agent exchanges stabilize cached review evidence.
const RECENT_EXCHANGES = 3;
const MAX_TOOL_COMMAND_CHARS = 4_000;
const MAX_TOOL_OUTPUT_CHARS = 300;
const MAX_ACTION_CHARS = 60_000;
const MESSAGE_START =
  /(?:^|\n)## Message\r?\n(?=(?:\[[^\]\r\n]+ UTC\] )?\[recurse-origin: (?:operator|agent|scheduled|platform|service)\])/g;
const FRAME_HEADER =
  /(?:^|\n)(?:\[[^\]\r\n]+ UTC\] )?\[recurse-origin: (operator|agent|scheduled|platform|service)\](?: \[from agent [^\]\r\n]{1,512}\])?\r?\n/g;

type SplitEvidence = { text: string; origin: RecurseOrigin };

function splitUserEvidence(text: string, durableOnly = false): SplitEvidence[] {
  // Spec: Pi expands skills before arguments; locate the last message heading
  // with origin label, retaining standalone-label compatibility.
  let evidence = text;
  MESSAGE_START.lastIndex = 0;
  while (MESSAGE_START.exec(text) !== null) {
    evidence = text.slice(MESSAGE_START.lastIndex);
  }
  FRAME_HEADER.lastIndex = 0;
  let match = FRAME_HEADER.exec(evidence);
  if (!match || match.index !== 0) {
    return durableOnly ? [] : [{ text, origin: "unknown" }];
  }
  const result: SplitEvidence[] = [];
  while (match) {
    const bodyStart = FRAME_HEADER.lastIndex;
    const rawOrigin = match[1];
    const next = FRAME_HEADER.exec(evidence);
    const bodyEnd = next?.index ?? evidence.length;
    const body = evidence.slice(bodyStart, bodyEnd).trimEnd();
    const origin: RecurseOrigin =
      rawOrigin === "service" ? "unknown" : (rawOrigin as RecurseOrigin);
    if (body) result.push({ text: body, origin });
    match = next;
  }
  return result;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("\n");
}

export function truncateSerializedAction(
  text: string,
  maxChars: number,
): string {
  if (text.length <= maxChars) return text;
  const render = (kept: number) => {
    const prefix = Math.ceil(kept * 0.6);
    return JSON.stringify(
      {
        action_truncated: true,
        original_chars: text.length,
        serialized_prefix: text.slice(0, prefix),
        serialized_suffix: text.slice(text.length - (kept - prefix)),
      },
      null,
      2,
    );
  };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (render(mid).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  return render(low);
}

function boundedToolCommand(command: string): string {
  if (command.length <= MAX_TOOL_COMMAND_CHARS) return command;
  const half = Math.floor((MAX_TOOL_COMMAND_CHARS - 100) / 2);
  return `${command.slice(0, half)}\n… [command truncated; ${command.length} original chars] …\n${command.slice(-half)}`;
}

function boundedToolOutput(content: unknown): string {
  const text = textContent(content);
  return text.length <= MAX_TOOL_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}… [tool result truncated; ${text.length} original chars]`;
}

export { boundedToolOutput };

function serializeTranscriptItem(item: TranscriptItem): string {
  // Invariant: JSON-encode each evidence item so body text cannot forge
  // metadata or trusted records.
  return JSON.stringify(
    item.role === "tool"
      ? {
          evidence_role: "tool",
          trusted_recurse_origin: null,
          tool_name: item.toolName,
          command: item.command ?? null,
          tool_output: item.toolOutput,
        }
      : {
          evidence_role: item.role,
          trusted_recurse_origin:
            item.role === "user" ? (item.origin ?? "unknown") : null,
          body: item.text,
        },
  );
}

// Build evidence from human intent, completed explanations and completed tool
// calls with bounded output. Exclude thinking, write/edit contents and the
// current unfinished call.
export function buildReviewTranscript(
  entries: readonly EntryLike[],
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const userItems: TranscriptItem[] = [];
  const assistantItems: TranscriptItem[] = [];
  const toolItems: TranscriptItem[] = [];
  // Invariant: Duplicate immutable call ids are ambiguous; omit evidence rather
  // than pair a result with the wrong call.
  const toolCalls = new Map<string, ToolCallLike | null>();

  entries.forEach((entry, index) => {
    if (entry.type !== "message" || !entry.message) return;
    if (
      entry.message.role === "assistant" &&
      Array.isArray(entry.message.content)
    ) {
      entry.message.content.forEach((block, segmentIndex) => {
        if (!block || typeof block !== "object") return;
        const candidate = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (candidate.type !== "toolCall" || typeof candidate.id !== "string")
          return;
        // Invariant: Reserve ids before validation; even malformed duplicates
        // invalidate all pairings for that id.
        if (toolCalls.has(candidate.id)) {
          toolCalls.set(candidate.id, null);
          return;
        }
        if (
          typeof candidate.name !== "string" ||
          !candidate.arguments ||
          typeof candidate.arguments !== "object" ||
          Array.isArray(candidate.arguments)
        ) {
          toolCalls.set(candidate.id, null);
          return;
        }
        toolCalls.set(candidate.id, {
          entryIndex: index,
          segmentIndex,
          name: candidate.name,
          arguments: candidate.arguments as Record<string, unknown>,
        });
      });
    }

    if (entry.message.role === "user") {
      const text = textContent(entry.message.content).trim();
      if (text) {
        splitUserEvidence(text).forEach((segment, segmentIndex) => {
          userItems.push({
            entryIndex: index,
            segmentIndex,
            role: "user",
            text: segment.text,
            origin: segment.origin,
          });
        });
      }
    } else if (
      entry.message.role === "assistant" &&
      entry.message.stopReason === "stop"
    ) {
      const text = textContent(entry.message.content).trim();
      if (text)
        assistantItems.push({
          entryIndex: index,
          segmentIndex: 0,
          role: "assistant",
          text,
        });
    }
  });

  // Invariant: Match only immutable call ids and bound recorded output.
  const completedToolCallIds = new Set<string>();
  entries.forEach((entry, index) => {
    const message = entry.type === "message" ? entry.message : undefined;
    if (
      message?.role !== "toolResult" ||
      typeof message.toolCallId !== "string"
    )
      return;
    if (completedToolCallIds.has(message.toolCallId)) return;
    const call = toolCalls.get(message.toolCallId);
    if (
      !call ||
      call.entryIndex >= index ||
      typeof message.toolName !== "string" ||
      message.toolName !== call.name
    )
      return;
    completedToolCallIds.add(message.toolCallId);
    const toolName = call.name;
    const command =
      toolName === "bash" && typeof call.arguments.command === "string"
        ? boundedToolCommand(call.arguments.command)
        : undefined;
    toolItems.push({
      entryIndex: index,
      segmentIndex: call.segmentIndex,
      role: "tool",
      text: command ?? toolName,
      toolName,
      command,
      toolOutput: boundedToolOutput(message.content),
    });
  });

  // Invariant: Exchanges begin with the first user turn after a completed agent
  // message, keeping consecutive steers and their final response grouped.
  const conversation = [...userItems, ...assistantItems].sort(
    (left, right) =>
      left.entryIndex - right.entryIndex ||
      left.segmentIndex - right.segmentIndex,
  );
  const exchanges: TranscriptItem[][] = [];
  for (const item of conversation) {
    const current = exchanges.at(-1);
    const startNew =
      !current ||
      (item.role === "user" &&
        current.some((prior) => prior.role === "assistant"));
    if (startNew) exchanges.push([item]);
    else exchanges[exchanges.length - 1]!.push(item);
  }
  const recentConversation = exchanges.slice(-RECENT_EXCHANGES).flat();

  // Invariant: Retain all completed tool calls regardless of exchange age; only
  // the shared budget bounds history needed to assess pid ownership or secret
  // upload sequences.
  const selected = [...recentConversation, ...toolItems].sort(
    (left, right) =>
      left.entryIndex - right.entryIndex ||
      left.segmentIndex - right.segmentIndex,
  );
  const rendered = selected.map((item) => ({
    ...item,
    rendered: serializeTranscriptItem(item),
  }));

  const full = rendered.map((item) => item.rendered).join("\n\n");
  if (full.length <= maxChars) return full;

  // Invariant: Retain newest evidence; never preserve old authorization while
  // omitting later revocation. Mark omissions explicitly, not as benign
  // context.
  const marker = '{"omission":"older_evidence"}';
  const kept: typeof rendered = [];
  let used = marker.length + 2;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const item = rendered[index];
    if (!item || used + item.rendered.length + 2 > maxChars) break;
    kept.push(item);
    used += item.rendered.length + 2;
  }
  kept.reverse();
  if (kept.length > 0) {
    // Invariant: Put the marker first chronologically: only older evidence was
    // omitted.
    return `${marker}\n\n${kept.map((item) => item.rendered).join("\n\n")}`;
  }

  // Invariant: An oversized newest item keeps only its tail, never older
  // authorization. Middle truncation could hide revocation; without origin this
  // fragment cannot authorize.
  const newest = rendered.at(-1);
  const tailMarker =
    '{"omission":"newest_evidence_prefix","authorization":"unavailable"}';
  if (!newest) return tailMarker.slice(0, maxChars);

  // Invariant: Re-serialize suffixes as untrusted JSON; raw slicing can expose
  // body text as trusted metadata.
  const renderTail = (suffix: string) =>
    JSON.stringify({
      evidence_role: newest.role,
      trusted_recurse_origin: "unknown-truncated",
      body_suffix: suffix,
    });
  const separator = "\n\n";
  let low = 0;
  let high = newest.text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${tailMarker}${separator}${renderTail(newest.text.slice(-mid))}`;
    if (candidate.length <= maxChars) low = mid;
    else high = mid - 1;
  }
  const result = `${tailMarker}${separator}${renderTail(newest.text.slice(-low))}`;
  return result.length <= maxChars ? result : tailMarker.slice(0, maxChars);
}

function reviewDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export type ReviewEvidencePayload = Readonly<{
  evidence_role: "user" | "assistant";
  trusted_recurse_origin: RecurseOrigin | null;
  body: string;
}>;

export type ReviewToolCall = Readonly<{
  id: string;
  name: string;
  command: string | null;
}>;

export type ReviewToolResult = Readonly<{
  id: string;
  name: string;
  output: string;
}>;

export type CanonicalReviewSourceEntry = Readonly<{
  id: string;
  parentId: string | null;
  type: string;
  identityDigest: string;
  contentDigest: string;
  compaction: boolean;
  evidence: readonly ReviewEvidencePayload[];
  toolCalls: readonly ReviewToolCall[];
  ambiguousToolCallIds: readonly string[];
  toolResult: ReviewToolResult | null;
}>;

// Canonicalize bounded visible tool output. Row id is exact cursor identity;
// contentDigest excludes it so host copies align despite provider id rewrites.
export function canonicalReviewSourceEntry(
  entry: EntryLike,
): CanonicalReviewSourceEntry {
  if (
    !entry ||
    typeof entry.id !== "string" ||
    !entry.id ||
    entry.id.length > 512 ||
    (entry.parentId !== null &&
      entry.parentId !== undefined &&
      (typeof entry.parentId !== "string" || entry.parentId.length > 512))
  ) {
    throw new Error("review transcript contains an invalid row identity");
  }
  const parentId = entry.parentId ?? null;
  const evidence: ReviewEvidencePayload[] = [];
  const toolCalls: ReviewToolCall[] = [];
  const ambiguousToolCallIds: string[] = [];
  let toolResult: ReviewToolResult | null = null;

  if (entry.type === "message" && entry.message?.role === "user") {
    const text = textContent(entry.message.content).trim();
    if (text) {
      for (const segment of splitUserEvidence(text, true)) {
        evidence.push({
          evidence_role: "user",
          trusted_recurse_origin: segment.origin,
          body: segment.text,
        });
      }
    }
  } else if (entry.type === "message" && entry.message?.role === "assistant") {
    if (Array.isArray(entry.message.content)) {
      const calls = new Map<string, ReviewToolCall | null>();
      for (const block of entry.message.content) {
        if (!block || typeof block !== "object") continue;
        const call = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (
          call.type !== "toolCall" ||
          typeof call.id !== "string" ||
          call.id.length > 512
        )
          continue;
        if (calls.has(call.id)) {
          calls.set(call.id, null);
          continue;
        }
        if (
          typeof call.name !== "string" ||
          !call.arguments ||
          typeof call.arguments !== "object" ||
          Array.isArray(call.arguments) ||
          call.name.length > 256
        ) {
          calls.set(call.id, null);
          continue;
        }
        const args = call.arguments as Record<string, unknown>;
        calls.set(call.id, {
          id: call.id,
          name: call.name,
          command:
            call.name === "bash" && typeof args.command === "string"
              ? boundedToolCommand(args.command)
              : null,
        });
      }
      for (const [id, call] of calls) {
        if (call) toolCalls.push(call);
        else ambiguousToolCallIds.push(id);
      }
    }
    if (entry.message.stopReason === "stop") {
      const text = textContent(entry.message.content).trim();
      if (text)
        evidence.push({
          evidence_role: "assistant",
          trusted_recurse_origin: null,
          body: text,
        });
    }
  } else if (
    entry.type === "message" &&
    entry.message?.role === "toolResult" &&
    typeof entry.message.toolCallId === "string" &&
    typeof entry.message.toolName === "string" &&
    entry.message.toolCallId.length <= 512 &&
    entry.message.toolName.length <= 256
  ) {
    toolResult = {
      id: entry.message.toolCallId,
      name: entry.message.toolName,
      output: boundedToolOutput(entry.message.content),
    };
  }

  const type =
    typeof entry.type === "string" && entry.type.length <= 128
      ? entry.type
      : "unknown";
  const compaction = type === "compaction";
  const canonicalContent = {
    type,
    compaction,
    evidence,
    toolCalls,
    ambiguousToolCallIds,
    toolResult,
  };
  const contentDigest = reviewDigest(canonicalContent);
  return Object.freeze({
    id: entry.id,
    parentId,
    type,
    identityDigest: reviewDigest([entry.id, parentId, contentDigest]),
    contentDigest,
    compaction,
    evidence: Object.freeze(evidence),
    toolCalls: Object.freeze(toolCalls),
    ambiguousToolCallIds: Object.freeze(ambiguousToolCallIds),
    toolResult,
  });
}

const MAX_NOTICE_ACTION_CHARS = 800;
const MAX_REVIEW_PATH_CHARS = 1_000;

// Serialize bounded path display evidence, never filesystem authority
// (path-scope.ts owns that proof). JSON-encode and replace control/format
// chars. Missing, blank or non-string paths still yield reviewable records,
// without exposing other arguments.
export function formatPathOnlyProposedAction(
  toolName: "write" | "edit",
  input: unknown,
): string {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const raw = record?.path;
  if (typeof raw !== "string" || !raw.trim()) {
    return JSON.stringify(
      { operation: toolName, path_status: "missing-or-invalid" },
      null,
      2,
    );
  }
  const normalized = raw.normalize("NFC").replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "�");
  const points = Array.from(normalized);
  const bounded =
    points.length > MAX_REVIEW_PATH_CHARS
      ? `${points.slice(0, MAX_REVIEW_PATH_CHARS).join("")}… [path truncated; ${points.length} chars]`
      : normalized;
  return JSON.stringify(
    {
      operation: toolName,
      path: bounded,
      path_status: "untrusted-display-only",
    },
    null,
    2,
  );
}

// Bounded user-only action notice: bash command or write/edit path. Full input
// remains in the tool inspector, not this message.
export function summarizeActionForNotice(
  toolName: string,
  input: unknown,
): string {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const clip = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length > MAX_NOTICE_ACTION_CHARS
      ? `${trimmed.slice(0, MAX_NOTICE_ACTION_CHARS)}… (truncated)`
      : trimmed;
  };
  if (
    toolName === "bash" &&
    typeof record.command === "string" &&
    record.command.trim()
  ) {
    return `$ ${clip(record.command)}`;
  }
  const path = record.file_path ?? record.path ?? record.filePath;
  if (toolName === "write" || toolName === "edit") {
    return typeof path === "string" && path.trim()
      ? `${toolName} ${clip(path.normalize("NFC").replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "�"))}`
      : `${toolName} (missing or invalid path)`;
  }

  try {
    return clip(JSON.stringify({ tool: toolName, input }) ?? String(input));
  } catch {
    return clip(String(input));
  }
}

// `context` holds trusted call facts, such as the calling codemode call of a
// nested MCP call. They are serialized between the tool name and its input.
export function formatProposedAction(
  toolName: string,
  input: unknown,
  context?: Record<string, unknown>,
): string {
  let serialized: string;
  try {
    serialized =
      JSON.stringify({ tool: toolName, ...context, input }, null, 2) ??
      String(input);
  } catch {
    serialized = String(input);
  }
  // Invariant: JSON-encode retained fragments; raw suffixes can forge review
  // delimiters or origin records.
  return truncateSerializedAction(serialized, MAX_ACTION_CHARS);
}
