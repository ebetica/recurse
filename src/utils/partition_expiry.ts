// Retire expired UTC date-partitioned directories without inspecting their
// contents. Configuration and the clock are supplied by callers; retirement is
// one same-filesystem rename through trash, and EXDEV remains an error rather
// than a copy. The existing trash Worker owns all blocking filesystem calls.
import { expirePartitions } from "./trash_sweep";

const DATE_PARTITION = /^[0-9]{8}$/u;
const fullMatch = (pattern: RegExp, value: string): boolean =>
  pattern.exec(value)?.[0] === value;

// Days between a valid UTC YYYYMMDD partition and now; invalid names are null.
export function partitionAgeDays(name: string, now: number): number | null {
  if (!fullMatch(DATE_PARTITION, name)) return null;
  const year = Number(name.slice(0, 4));
  const month = Number(name.slice(4, 6));
  const day = Number(name.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return (now - date.getTime() / 1000) / 86400;
}

export interface ExpiryResult {
  examined: number;
  retired: number;
  recent: number;
  malformed: number;
  unreadable: number;
  deferred: number;
  cursor: string | null;
}

export interface ExpiryOptions {
  retentionDays: number;
  limit: number;
  now?: number;
}

/** Examine partitions off-thread and retire at most `limit` old days. */
export function expire(
  root: string,
  trashRoot: string,
  options: ExpiryOptions,
): Promise<ExpiryResult> {
  return expirePartitions(root, trashRoot, {
    ...options,
    now: options.now ?? Date.now() / 1000,
  });
}
