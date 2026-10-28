// Clock stamps apply only to model-bound copies, retaining system
// identity/positions. A user stamp is its stored placement time, so storage
// rebuilds it; stale silent turns stamp only the last tool result once per
// interval. UTC minute precision; timestamp keys fall back to index.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Ten minutes: a reminder may attach at most this often per session. */
export const REMINDER_INTERVAL_MS_DEFAULT = 10 * 60 * 1000;

const reminderIntervalMs = REMINDER_INTERVAL_MS_DEFAULT;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** `2026-09-16 21:40`: minute-precision UTC wall clock, minimal tokens. */
export function formatClockMinute(nowMs: number): string {
  const date = new Date(nowMs);
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}` +
    ` ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
  );
}

/** `[2026-09-16 21:40 UTC]`: the per-user-message stamp. */
export function userStamp(nowMs: number): string {
  return `[${formatClockMinute(nowMs)} UTC]`;
}

/** `[time: 2026-09-16 21:51 UTC]`: the between-tool-calls reminder. */
export function reminderStamp(nowMs: number): string {
  return `[time: ${formatClockMinute(nowMs)} UTC]`;
}

export interface TimestampState {
  stamps: Map<string, { text: string; at: number }>;
  lastSeenMs: number | null;
}

export function createTimestampState(): TimestampState {
  return { stamps: new Map(), lastSeenMs: null };
}

function stampKey(message: AgentMessage, index: number): string {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return `t:${timestamp}`;
  }
  return `i:${index}`;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  if (typeof block !== "object" || block === null) return false;
  const record = block as Record<string, unknown>;
  return record["type"] === "text" && typeof record["text"] === "string";
}

// Append a stamp without mutation; exotic shapes stay unchanged and unstamped.
function appendLine(content: unknown, line: string): unknown {
  if (typeof content === "string") {
    return `${content}\n${line}`;
  }
  if (Array.isArray(content)) {
    const blocks = [...content];
    const last = blocks[blocks.length - 1];
    if (isTextBlock(last)) {
      blocks[blocks.length - 1] = { ...last, text: `${last.text}\n${line}` };
    } else {
      blocks.push({ type: "text", text: line });
    }
    return blocks;
  }
  return content;
}

function roleOf(message: AgentMessage): unknown {
  return (message as { role?: unknown }).role;
}

// Copy model-bound messages with fixed user-arrival stamps and at most one
// stale-turn reminder on the last toolResult; never mutate the caller's
// objects.
export function applyTimestamps(
  messages: AgentMessage[],
  state: TimestampState,
  nowMs: number = Date.now(),
): AgentMessage[] {
  const out = [...messages];
  let newestSeen = state.lastSeenMs;
  let newStamp = false;
  // Invariant: Disambiguate same-ms keys by occurrence, stable through
  // append/compaction, so later calls reuse stamps instead of inventing input.
  const occurrence = new Map<string, number>();
  messages.forEach((message, index) => {
    if (roleOf(message) !== "user") return;
    const content = (message as { content?: unknown }).content;
    // Invariant: Unshown stamps must not reset freshness for exotic shapes.
    if (typeof content !== "string" && !Array.isArray(content)) return;
    const base = stampKey(message, index);
    const seen = occurrence.get(base) ?? 0;
    occurrence.set(base, seen + 1);
    const key = seen === 0 ? base : `${base}#${seen}`;
    let entry = state.stamps.get(key);
    if (entry === undefined) {
      // Invariant: A restart or copied history rebuilds the same stamp.
      const stored = (message as { timestamp?: unknown }).timestamp;
      const at =
        typeof stored === "number" && Number.isFinite(stored) ? stored : nowMs;
      entry = { text: userStamp(at), at };
      state.stamps.set(key, entry);
      newStamp = true;
    }
    const next = appendLine(content, entry.text);
    if (next !== content) {
      out[index] = {
        ...(message as unknown as Record<string, unknown>),
        content: next,
      } as unknown as AgentMessage;
    }
    if (newestSeen === null || entry.at > newestSeen) {
      newestSeen = entry.at;
    }
  });
  // Spec: New user stamps suppress reminders; silent stale turns remind only on
  // the last tool result, once per interval.
  if (
    !newStamp &&
    state.lastSeenMs !== null &&
    nowMs - state.lastSeenMs > reminderIntervalMs
  ) {
    for (let index = out.length - 1; index >= 0; index--) {
      if (roleOf(out[index] as AgentMessage) !== "toolResult") continue;
      const current = out[index] as unknown as { content?: unknown };
      const next = appendLine(current.content, reminderStamp(nowMs));
      if (next !== current.content) {
        out[index] = {
          ...(current as unknown as Record<string, unknown>),
          content: next,
        } as unknown as AgentMessage;
      }
      state.lastSeenMs = nowMs;
      return out;
    }
  }
  state.lastSeenMs = newestSeen;
  return out;
}
