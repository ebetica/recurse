// Formats live tool summaries supplied by the backend security boundary.
// Bounded partial args fail closed on credential-shaped text; visible actions
// stay bounded so long paths cannot hide the operation.
import type { ToolCall, ToolEntry } from "../types";

export interface WorkingActivityView {
  text: string;
  title: string;
  ariaLabel: string;
}

const sensitiveToolName =
  /(?:api[_-]?key|access[_-]?token|token|auth(?:orization)?|bearer|password|passwd|secret|private[_-]?key|client[_-]?secret|oauth|(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|(?:AKIA|ASIA)[0-9A-Z]{12,})/i;
const safeToolName = (value: string | null | undefined): string =>
  value &&
  /^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/.test(value) &&
  !sensitiveToolName.test(value)
    ? value
    : "tool";

const SETTLED_TOOL_PHRASES: Record<string, string> = {
  chdir: "changed directory",
  clear: "cleared context",
  compact: "compacted context",
  wait: "waited",
};

/** Describe safe, named tools not represented by the aggregate stat fields. */
export function namedToolSummary(tools: readonly ToolEntry[] | undefined): {
  parts: string[];
  count: number;
} {
  const counts = new Map<string, number>();
  for (const tool of tools || []) {
    if (tool.status === "truncated" || tool.stat.kind !== "other") continue;
    const name = tool.name?.toLowerCase().replaceAll("-", "_");
    if (name && (name === "publish_attachment" || SETTLED_TOOL_PHRASES[name]))
      counts.set(name, (counts.get(name) || 0) + (tool.count ?? 1));
  }
  const parts = [...counts].map(([name, count]) =>
    name === "publish_attachment"
      ? `published ${count} file${count === 1 ? "" : "s"}`
      : count === 1
        ? SETTLED_TOOL_PHRASES[name]
        : `${SETTLED_TOOL_PHRASES[name]} ${count} times`,
  );
  return { parts, count: [...counts.values()].reduce((sum, n) => sum + n, 0) };
}

const MAX_ACTIVITY_CHARS = 30;
const codePoints = (value: string): string[] => [...value];

function clipTail(value: string, limit: number): string {
  const chars = codePoints(value);
  if (limit <= 0) return "";
  if (chars.length <= limit) return value;
  if (limit === 1) return "…";
  const tail = chars.slice(-(limit - 1)).join("");
  const boundary = tail.indexOf("/");
  return `…${boundary > 0 ? tail.slice(boundary) : tail}`;
}

function clipHead(value: string, limit: number): string {
  const chars = codePoints(value);
  if (limit <= 0) return "";
  if (chars.length <= limit) return value;
  if (limit === 1) return "…";
  return `${chars.slice(0, limit - 1).join("")}…`;
}

const REDACTED_THINKING =
  /^(?:\[?(?:redacted|encrypted)(?:[ _-](?:thinking|reasoning))?\]?|<encrypted>)+$/iu;

// Formats thinking titles; only the live pill's available width clips.
export function thinkingSummaryLabel(value: unknown): string {
  if (typeof value !== "string") return "Thinking";
  const latest = [...value.matchAll(/\*\*(.+?)\*\*/gu)].at(-1)?.[1] ?? value;
  const title = latest.replaceAll("**", "").trim();
  if (!title || REDACTED_THINKING.test(title)) return "Thinking";
  return title;
}

// Keeps thinking prose newest-first without clipping provider text. The bounded
// endpoint feeds layout's four-line clamp and tail anchoring.
export function thinkingSummaryTail(value: unknown): string {
  if (typeof value !== "string") return "";
  const heading = [...value.matchAll(/\*\*(.+?)\*\*/gu)].at(-1);
  const body = heading
    ? value.slice((heading.index ?? 0) + heading[0].length)
    : value;
  return body.trim();
}

/** Plain prose beneath the title already shown by the live bar. */
export function thinkingSummaryBody(value: string, title: string): string {
  const text = value.trim();
  const heading = /^\*\*(.+?)\*\*[ \t]*(?:\r?\n|$)/u.exec(text);
  const body =
    heading && thinkingSummaryLabel(heading[0]) === title
      ? text.slice(heading[0].length)
      : text;
  return body.replaceAll("**", "").trim();
}

function actionText(call: ToolCall): string {
  const rawName = safeToolName(call.name).toLowerCase();
  const name = clipHead(rawName, MAX_ACTIVITY_CHARS - 2);
  const detail = call.input?.trim();
  if (!detail) return name;

  const prefix = `${name}: `;
  if (name === "bash" || name === "shell") {
    // Invariant: The redacted backend summary is "Run <program> [subcommand]".
    // Keep the executable recognizable and make the safe command visually
    // distinct. A bash read instead projects its bare file target: keep the
    // filename end like every other path detail.
    const command = detail.replace(/^run\s+/i, "");
    if (command === detail) {
      return `${prefix}${clipTail(detail, MAX_ACTIVITY_CHARS - codePoints(prefix).length)}`;
    }
    const limit = MAX_ACTIVITY_CHARS - codePoints(prefix).length - 2;
    return `${prefix}\`${clipHead(command, limit)}\``;
  }
  return `${prefix}${clipTail(detail, MAX_ACTIVITY_CHARS - codePoints(prefix).length)}`;
}

export interface LiveActivityRow {
  id?: string;
  running?: boolean;
  name?: string | null;
  input?: string | null;
  // Bounded partial JSON args decode a primary argument until summary arrives.
  args?: string | null;
  kind?: string;
  role?: string;
  text?: string;
  thinking?: string | null;
  thinking_title?: string | null;
  thinking_elapsed_ms?: number;
  has_thinking?: boolean;
  live?: boolean;
  // A persisted row whose thinking summary is still streaming live.
  live_thinking?: boolean;
  stop_reason?: string | null;
}

export type LiveActivityKind = "tool" | "thinking" | "starting";

export interface LiveActivityPanel {
  kind: LiveActivityKind;
  label: string;
  title: string;
  key: string;
  // Tool-only name/argument split; Thinking/Starting use just the label.
  name?: string;
  args?: string;
  // Elapsed thinking time is rendered in its own ticking span.
  thinkingElapsedMs?: number;
  hasThinking?: boolean;
  thinkingActive?: boolean;
}

// Shows the current turn's latest thinking title, independent of tools. Only
// rows after its final user row qualify; old titles/tools never leak.
export function liveActivityState(
  rows: readonly LiveActivityRow[],
  promptAccepted?: boolean,
): LiveActivityPanel {
  let turnStart = 0;
  let hasBoundary = false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.role === "user" || rows[i]?.role === "custom") {
      turnStart = i + 1;
      hasBoundary = true;
    }
  }
  const currentRows = rows.slice(turnStart);
  const lastReply = currentRows.findLastIndex(
    (row) =>
      row.role === "assistant" &&
      !row.live &&
      row.stop_reason !== "toolUse" &&
      Boolean(row.text?.trim() || row.stop_reason),
  );
  const currentRunRows = currentRows.slice(lastReply + 1);
  const isThinking = (row: LiveActivityRow): boolean =>
    Boolean(
      row.has_thinking || row.thinking_title?.trim() || row.thinking?.trim(),
    );
  // Invariant: Settled final replies fence off the prior turn during admission;
  // persisted thinking in an unfinished tool round survives quiet model waits.
  if (
    promptAccepted !== undefined &&
    (!hasBoundary ||
      !currentRunRows.some(
        (row) =>
          row.live ||
          row.running ||
          row.live_thinking ||
          (promptAccepted && isThinking(row)),
      ))
  )
    return promptAccepted
      ? {
          kind: "thinking",
          label: "Thinking",
          title: "Thinking",
          key: "thinking",
        }
      : {
          kind: "starting",
          label: "Starting agent…",
          title: "Starting agent…",
          key: "starting",
        };
  const latestThinking = [...currentRunRows].reverse().find(isThinking);
  const thinkingActive = Boolean(
    latestThinking &&
    (latestThinking.live || latestThinking.live_thinking) &&
    (!latestThinking.stop_reason || latestThinking.stop_reason === "pending") &&
    !latestThinking.text?.trim() &&
    !currentRunRows
      .slice(currentRunRows.indexOf(latestThinking) + 1)
      .some((row) => row.kind === "tool_call"),
  );
  const summary = thinkingSummaryLabel(
    latestThinking?.thinking_title ?? latestThinking?.thinking,
  );
  const thinking =
    latestThinking && !thinkingActive && summary === "Thinking"
      ? "Waiting"
      : summary;
  const thinkingElapsedMs =
    typeof latestThinking?.thinking_elapsed_ms === "number" &&
    Number.isFinite(latestThinking.thinking_elapsed_ms)
      ? Math.max(0, latestThinking.thinking_elapsed_ms)
      : undefined;
  const hasContent = currentRunRows.some(
    (row) =>
      row.live === true ||
      row.live_thinking === true ||
      row.kind === "tool_call" ||
      (row.kind === "text" && (row.text ?? "").trim().length > 0),
  );
  if (latestThinking || hasContent)
    return {
      kind: "thinking",
      label:
        latestThinking && !thinkingActive && thinking !== "Waiting"
          ? `Waiting · ${thinking}`
          : thinking,
      title: thinking,
      key: `thinking:${latestThinking?.id ?? currentRunRows[0]?.id ?? "current"}\0${thinking}`,
      thinkingElapsedMs,
      ...(latestThinking ? { hasThinking: true, thinkingActive } : {}),
    };
  return {
    kind: "starting",
    label: "Starting agent…",
    title: "Starting agent…",
    key: "starting",
  };
}

export type ActivityStatusKind = "panel" | "summary" | "waiting";

export function activityStatusKind(
  streaming: boolean,
  activeShells: number,
  activeAgents: number,
  isLast = true,
  queued = false,
): ActivityStatusKind {
  // Invariant: Only the latest boundary owns a live/Waiting surface. An
  // admitted next turn supersedes the stopped response's Waiting panel.
  if (!isLast) return "summary";
  if (streaming) return "panel";
  if (queued) return "summary";
  if (activeShells > 0 || activeAgents > 0) return "waiting";
  return "summary";
}
// the same bounded text. Full tool details remain behind the eye disclosure.
// A turn still waiting on its prompt says resuming when its first send reused
// a warm core, starting when it spawned cold (or the backend predates the
// signal, which keeps the long-standing generic text).
export function workingActivityView(
  action: ToolCall | null,
  stopping = false,
  warming = false,
  coreReused: boolean | null = null,
): WorkingActivityView {
  let text: string;
  if (stopping) {
    text = "Interrupting…";
  } else if (warming && !action) {
    text = coreReused === true ? "Resuming agent…" : "Starting agent…";
  } else if (action) {
    text = actionText(action);
  } else {
    text = "Working…";
  }
  return { text, title: text, ariaLabel: text };
}
