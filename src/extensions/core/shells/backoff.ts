// Shared notice/wait cadence, measured from backgrounding, not spawn. Steps
// repeat the last interval; default starts at five minutes and ends at six
// hours.

export const DEFAULT_WAIT_SCHEDULE_SECONDS = [
  300, 600, 1800, 3600, 10800, 21600,
];

// Delay for a zero-based schedule step; repeat the last interval past the end.
export function delayMsForStep(
  step: number,
  schedule: readonly number[] = DEFAULT_WAIT_SCHEDULE_SECONDS,
): number {
  const list = schedule.length > 0 ? schedule : DEFAULT_WAIT_SCHEDULE_SECONDS;
  const index = Math.min(Math.max(0, Math.floor(step)), list.length - 1);
  return Math.max(1, Math.floor(list[index] * 1000));
}

/** "2m", "30m", "1hr", "6hr" — sub-minute values only appear in tests. */
export function fmtWait(seconds: number): string {
  if (seconds < 60) {
    return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(1))}s`;
  }
  if (seconds < 3600) return `${seconds / 60}m`;
  return `${seconds / 3600}hr`;
}
