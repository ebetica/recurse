// Canonical held rows, read epochs and Clear barriers, independent of fetching
// and painting. The row owner mutates and union-prunes these same maps.
import type { ClearedMarker, RowThread } from "./row-thread.js";

export const rowThreads = new Map<string, RowThread>();
export const rowThreadEpoch = new Map<string, number>();
export const rowThreadCleared = new Map<string, ClearedMarker>();

/** The newest stored offset, excluding live rows that are not committed. */
export function newestCommittedOffset(cid: string): number {
  return (rowThreads.get(cid)?.rows ?? []).reduce(
    (newest, row) => (row.live ? newest : Math.max(newest, row.offset ?? 0)),
    0,
  );
}

export function rowThreadContextKey(id: string): string {
  return JSON.stringify([
    rowThreads.get(id)?.instanceId,
    rowThreadEpoch.get(id),
  ]);
}

/** A confirmed Clear is still waiting for a fresh-session view. */
export function rowThreadClearPending(id: string): boolean {
  return rowThreadCleared.has(id);
}
