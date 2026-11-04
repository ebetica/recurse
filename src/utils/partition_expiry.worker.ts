/** Date-partition expiry primitives run only in the trash Worker. */
import fs, { constants } from "node:fs";
import { lstatAtSync } from "./dir_fd";
import { retireAt } from "./trash";
import {
  partitionAgeDays,
  type ExpiryOptions,
  type ExpiryResult,
} from "./partition_expiry";

const CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0) |
  CLOEXEC;
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

/** Worker-only pass using pinned descriptors and native no-follow calls. */
export function expireInWorker(
  root: string,
  trashRoot: string,
  options: ExpiryOptions,
): ExpiryResult {
  const stamp = options.now ?? Date.now() / 1000;
  let names: string[];
  let rootFd: number;
  try {
    names = fs.readdirSync(root).sort(compareCodePoints);
    rootFd = fs.openSync(root, DIRECTORY_FLAGS);
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
    fs.closeSync(rootFd);
  }
  return { examined, retired, recent, malformed, unreadable, deferred, cursor };
}
