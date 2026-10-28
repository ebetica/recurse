// Monitor lines emit only once newline-terminated, carrying partial lines
// forward. Flush caps retain recent lines and summarize overflow so fast
// writers cannot flood the agent.

export interface SplitResult {
  /** Complete lines (without their trailing newline). */
  lines: string[];
  /** Leftover partial line not yet terminated by a newline. */
  pending: string;
}

// Combine pending text and a new chunk into complete LF/CRLF lines and a
// pending remainder.
export function splitCompleteLines(
  pending: string,
  chunk: string,
): SplitResult {
  const combined = pending + chunk;
  const parts = combined.split("\n");

  const newPending = parts.pop() ?? "";
  const lines = parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  return { lines, pending: newPending };
}

export interface CapResult {
  /** Lines to actually deliver. */
  shown: string[];
  /** How many lines were dropped (0 when nothing was capped). */
  omitted: number;
}

// Keep at most maxLines recent lines and report the dropped count.
export function capLines(lines: string[], maxLines: number): CapResult {
  const limit = Math.max(1, Math.floor(maxLines));
  if (lines.length <= limit) return { shown: lines, omitted: 0 };
  const shown = lines.slice(lines.length - limit);
  return { shown, omitted: lines.length - limit };
}
