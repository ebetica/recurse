// Pure presentation helpers for the working row's background-shell chip and
// on-demand details. Keeping labels and durations here makes the compact UI
// regression-testable without a browser DOM; conversation.ts owns the lit
// template and interaction.
import type { BackgroundShell } from "../types.js";
import type { ViewBlock } from "../row-thread-state/view-blocks.js";

// Open shells from the view's stream rows (bg-shell markers), independent
// of the poll-fed conversation record. The view validates row shapes
// server-side, so presence of the row is the liveness signal.
export function streamShellRows(
  rows: readonly ViewBlock[] | undefined,
): ViewBlock[] {
  if (!rows) return [];
  return rows.filter((row) => row.kind === "marker" && row.role === "shell");
}

// The stream drives the working-row chip when it knows any open shell;
// otherwise the poll-fed record stands in (pre-marker sessions never
// emitted running markers). Never summed: the same shell rides both
// feeds while a run overlaps the poll.
export function pickShellCount(stream: number, fallback: number): number {
  return stream > 0 ? stream : Math.max(0, fallback);
}

export function liveBackgroundShells(
  items: readonly BackgroundShell[],
  activeCount = items.length,
  backgroundCount?: number,
): { items: BackgroundShell[]; count: number } {
  const isLive = (item: BackgroundShell): boolean =>
    (item.mode === "background" || item.mode === "monitor") &&
    (item.status === "running" || item.status === "stopping");
  const live = items.filter(isLive);
  const count = Number.isFinite(backgroundCount)
    ? Math.max(0, Math.floor(backgroundCount!))
    : items.every(isLive)
      ? Math.max(live.length, activeCount)
      : live.length;
  return { items: live, count };
}

export function shellSummary(activeCount: number): string {
  if (activeCount <= 0) return "";
  return `${activeCount} active shell${activeCount === 1 ? "" : "s"}`;
}

export function idleShellSummary(
  status: "ready" | "disabled" | "unavailable" | undefined,
  activeCount: number,
): string {
  if (status === "unavailable")
    return "Background shell details are unavailable.";
  return shellSummary(activeCount);
}

export function shouldShowShellUnavailable(
  status: string | undefined,
  shellCount: number,
): boolean {
  return status === "unavailable" && shellCount <= 0;
}

export function shellStatusSummary(
  items: readonly BackgroundShell[],
  activeCount = items.length,
): string {
  const summary = shellSummary(activeCount);
  const stopping = items.filter((item) => item.status === "stopping").length;
  return stopping ? `${summary} · ${stopping} stopping` : summary;
}

export function shellStatusText(item: BackgroundShell): string {
  return item.status === "stopping" ? "Stopping" : "Running";
}

export function formatShellElapsed(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

export function formatShellStarted(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return "Start time unavailable";
  return `Started ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
