// Retire expired UTC date-partitioned directories without inspecting their
// contents. Configuration and the clock are supplied by callers; retirement is
// one same- filesystem rename through trash, and EXDEV remains an error rather
// than a copy.
import { closeSync, constants, openSync, readdirSync } from "node:fs";
import { lstatAtSync } from "./dir_fd";
import { retireAt } from "./trash";

const CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0) |
  CLOEXEC;
const DATE_PARTITION = /^[0-9]{8}$/u;
const fullMatch = (pattern: RegExp, value: string): boolean =>
  pattern.exec(value)?.[0] === value;

type SystemError = Error & { code?: string };

function isSystemError(error: unknown): error is SystemError {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as SystemError).code === "string"
  );
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

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

/** Examine one stat per date partition and retire at most `limit` old days. */
export function expire(
  root: string,
  trashRoot: string,
  options: { retentionDays: number; limit: number; now?: number },
): ExpiryResult {
  const stamp = options.now ?? Date.now() / 1000;
  let names: string[];
  let rootFd: number;
  try {
    names = readdirSync(root).sort(compareCodePoints);
    rootFd = openSync(root, DIRECTORY_FLAGS);
  } catch (error) {
    if (!isSystemError(error)) throw error;
    return {
      examined: 0,
      retired: 0,
      recent: 0,
      malformed: 0,
      unreadable: 1,
      deferred: 0,
      cursor: null,
    };
  }

  let examined = 0;
  let retired = 0;
  let recent = 0;
  let malformed = 0;
  let unreadable = 0;
  let deferred = 0;
  let cursor: string | null = null;
  try {
    for (const name of names) {
      examined += 1;
      const age = partitionAgeDays(name, stamp);
      if (age === null) {
        malformed += 1;
        continue;
      }
      let isDirectory: boolean;
      try {
        isDirectory = lstatAtSync(rootFd, name).isDirectory();
      } catch (error) {
        if (!isSystemError(error)) throw error;
        unreadable += 1;
        if (cursor === null) cursor = name;
        continue;
      }
      if (!isDirectory) {
        unreadable += 1;
      } else if (age < options.retentionDays + 1) {
        recent += 1;
      } else if (retired >= options.limit) {
        deferred += 1;
      } else {
        try {
          if (retireAt(rootFd, name, trashRoot)) {
            retired += 1;
            continue;
          }
          unreadable += 1;
        } catch (error) {
          if (!isSystemError(error)) throw error;
          unreadable += 1;
        }
      }
      if (cursor === null) cursor = name;
    }
  } finally {
    closeSync(rootFd);
  }
  return { examined, retired, recent, malformed, unreadable, deferred, cursor };
}
