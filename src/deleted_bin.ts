// Retain deleted trees, then rename expired day partitions through trash.
// EXDEV is refused, never copied. Manifests intentionally omit fsync.
// Partition expiry runs in the existing trash Worker, never on the event loop.
import { randomUUID } from "node:crypto";
import fs, { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lstatAtSync, openAtSync, renameAtSync } from "./utils/dir_fd";
import { pyCompactJson } from "./utils/python-json";
import { expire as expirePartitions } from "./utils/partition_expiry";

const CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0) |
  CLOEXEC;
const KEY_RE = /^[A-Za-z0-9_-]{1,120}$/u;
const fullMatch = (pattern: RegExp, value: string): boolean =>
  pattern.exec(value)?.[0] === value;
const TREE_NAME = "tree";
const MANIFEST_NAME = "manifest.json";

type SystemError = Error & { code?: string; path?: string };

function errorCode(error: unknown): string | undefined {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    typeof (error as SystemError).code !== "string"
  )
    return undefined;
  return (error as SystemError).code;
}

function missing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isCollision(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function partitionFor(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10).replaceAll("-", "");
}

function idsDefault(): string {
  return randomUUID().replaceAll("-", "");
}

export interface DeletedBinPaths {
  deletedDir: string;
  trashDir: string;
  retentionDays: number;
  expiryLimit: number;
}

interface DepositOptions {
  kind: string;
  key: string;
  device?: number | null;
  inode?: number | null;
  manifest: Record<string, unknown>;
  home?: string | null;
  now?: number;
  ids?: () => string;
}

// Move an identity-verified directory into the restore bin; missing or swapped
// paths return null.
export function deposit(
  path: string,
  options: DepositOptions,
  paths: DeletedBinPaths,
): string | null {
  if (!fullMatch(KEY_RE, options.kind) || !fullMatch(KEY_RE, options.key))
    throw new TypeError("a bin entry is keyed by one safe component");
  const stamp = options.now ?? Date.now() / 1000;
  const ids = options.ids ?? idsDefault;
  let parent: number;
  try {
    // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
    parent = fs.openSync(dirname(path), DIRECTORY_FLAGS);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const name = basename(path);
    let info;
    try {
      info = lstatAtSync(parent, name);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (
      options.device != null &&
      options.inode != null &&
      (info.dev !== options.device || info.ino !== options.inode)
    )
      return null;

    let entryId = `${options.kind}-${options.key}`;
    const holder = join(paths.deletedDir, partitionFor(stamp));
    // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
    fs.mkdirSync(holder, { recursive: true });
    // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
    if (fs.statSync(holder).dev !== info.dev) {
      const error = new Error(
        "deleted bin is on a different filesystem",
      ) as SystemError;
      error.code = "EXDEV";
      error.path = holder;
      throw error;
    }
    let entry = join(holder, entryId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
        fs.mkdirSync(entry, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isCollision(error)) throw error;
        entryId = `${options.kind}-${options.key}.${ids().slice(0, 8)}`;
        entry = join(holder, entryId);
      }
      if (attempt === 99) {
        const error = new Error("no free bin entry name") as SystemError;
        error.code = "EEXIST";
        error.path = holder;
        throw error;
      }
    }

    // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
    const entryFd = fs.openSync(entry, DIRECTORY_FLAGS);
    try {
      const record: Record<string, unknown> = {
        ...options.manifest,
        kind: options.kind,
        key: options.key,
        entry_id: entryId,
        deleted_at: stamp,
        original_path: options.home || path,
      };
      const temporary = `.${ids()}`;
      const temporaryFd = openAtSync(
        entryFd,
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
        fs.writeFileSync(
          temporaryFd,
          pyCompactJson(record, { separators: "default" }),
          "utf8",
        );
      } finally {
        // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
        fs.closeSync(temporaryFd);
      }
      renameAtSync(entryFd, temporary, entryFd, MANIFEST_NAME);
      // Invariant: rename(2) refuses EXDEV; do not replace it with a copy
      // fallback.
      renameAtSync(parent, name, entryFd, TREE_NAME);
    } finally {
      // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
      fs.closeSync(entryFd);
    }
    return entryId;
  } finally {
    // oxlint-disable-next-line no-restricted-properties -- known: main-thread deleted-entry listing/restore/retirement filesystem operation
    fs.closeSync(parent);
  }
}

// Retire expired partitions; sweeping trash is a separate bounded operation.
export async function expire(
  paths: DeletedBinPaths,
  options: { now?: number; limit?: number } = {},
): Promise<number> {
  return (
    await expirePartitions(paths.deletedDir, paths.trashDir, {
      retentionDays: paths.retentionDays,
      limit: options.limit ?? paths.expiryLimit,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  ).retired;
}
