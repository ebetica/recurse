// Projects compaction markers at their durable boundary and queued actions.
// Clear replaces history, so only its queued state appears here; no
// DOM/network.

// Backend marker role; markers arrive as their own pseudo-turn.
export const MARKER_ROLE = "marker";

interface MarkerLike {
  role?: string;
  marker?: string;
  content?: string;
}

interface PendingLike {
  status?: string;
  compacting?: boolean;
  pending_actions?: string[];
}

// Fallback marker text for older records missing backend-authored wording.
const MARKER_FALLBACK: Record<string, string> = {
  compact:
    "Context summarized — the agent continues from a summary of the conversation up to this point.",
  clear:
    "Context cleared — earlier thread history is preserved, and the agent started fresh here.",
};
const MARKER_FALLBACK_OTHER = "Context changed here.";

export function threadMarkerText(m: MarkerLike): string {
  const text = (m.content || "").trim();
  if (text) return text;
  return MARKER_FALLBACK[m.marker || ""] || MARKER_FALLBACK_OTHER;
}

// What an action that has NOT taken effect yet is doing. `waiting` is true when
// a turn is still running, so the action only applies once that turn ends —
// never phrased as if it already happened. Shared by the thread's pending line
// and the composer's own reply to the command, so both read the same.
export function actionStatusText(
  action: string,
  waiting: boolean,
): string | null {
  if (action === "clear") {
    return waiting
      ? "The agent will start fresh when this turn ends"
      : "Deleting this history and starting fresh…";
  }
  if (action === "compact") {
    return waiting
      ? "Context will be summarized when this turn ends"
      : "Summarizing context…";
  }
  return null;
}

// What is queued but has NOT happened yet, for the line at the end of the
// thread. A clear supersedes a queued compaction, so it wins. Null when nothing
// is pending — the ordinary case.
export function pendingActionNote(
  conv: PendingLike | undefined | null,
): string | null {
  if (!conv) return null;
  const pending = conv.pending_actions || [];
  const running = conv.status === "running";
  if (pending.includes("clear")) return actionStatusText("clear", running);
  if (conv.compacting) return actionStatusText("compact", false);
  if (pending.includes("compact")) return actionStatusText("compact", running);
  return null;
}
