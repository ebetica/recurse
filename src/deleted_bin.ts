// Retain deleted trees, then rename expired day partitions through trash.
// EXDEV is refused, never copied. Manifests intentionally omit fsync.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { lstatAtSync, openAtSync, renameAtSync } from "./utils/dir_fd";
import { parsePythonJson, pyCompactJson } from "./utils/py_compact_json";
import { expire as expirePartitions } from "./utils/partition_expiry";

const CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0) |
  CLOEXEC;
const PARTITION_RE = /^[0-9]{8}$/u;
const KEY_RE = /^[A-Za-z0-9_-]{1,120}$/u;
const fullMatch = (pattern: RegExp, value: string): boolean =>
  pattern.exec(value)?.[0] === value;
export const TREE_NAME = "tree";
export const MANIFEST_NAME = "manifest.json";

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

function isSystemError(error: unknown): error is SystemError {
  return errorCode(error) !== undefined;
}

function missing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isCollision(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
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

export interface DepositOptions {
  kind: string;
  key: string;
  device?: number | null;
  inode?: number | null;
  manifest: Record<string, unknown>;
  home?: string | null;
  now?: number;
  ids?: () => string;
}

function entryDirs(deletedDir: string): string[] {
  let partitions: string[];
  try {
    partitions = readdirSync(deletedDir)
      .filter((name) => fullMatch(PARTITION_RE, name))
      .sort(compareCodePoints);
  } catch (error) {
    if (isSystemError(error)) return [];
    throw error;
  }
  const found: string[] = [];
  for (const partition of partitions) {
    const holder = join(deletedDir, partition);
    let names: string[];
    try {
      names = readdirSync(holder).sort(compareCodePoints);
    } catch (error) {
      if (isSystemError(error)) continue;
      throw error;
    }
    for (const name of names) {
      const entry = join(holder, name);
      try {
        if (
          statSync(join(entry, MANIFEST_NAME)).isFile() &&
          statSync(join(entry, TREE_NAME)).isDirectory()
        )
          found.push(entry);
      } catch (error) {
        if (!isSystemError(error)) throw error;
      }
    }
  }
  return found;
}

function readManifest(entry: string): Record<string, unknown> | null {
  try {
    const value = parsePythonJson(
      readFileSync(join(entry, MANIFEST_NAME), "utf8"),
    );
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function pythonOr(value: unknown, fallback: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 0)
  )
    return fallback;
  return value;
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
    parent = openSync(dirname(path), DIRECTORY_FLAGS);
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
    mkdirSync(holder, { recursive: true });
    if (statSync(holder).dev !== info.dev) {
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
        mkdirSync(entry, { mode: 0o700 });
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

    const entryFd = openSync(entry, DIRECTORY_FLAGS);
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
        writeFileSync(
          temporaryFd,
          pyCompactJson(record, { separators: "default" }),
          "utf8",
        );
      } finally {
        closeSync(temporaryFd);
      }
      renameAtSync(entryFd, temporary, entryFd, MANIFEST_NAME);
      // Invariant: rename(2) refuses EXDEV; do not replace it with a copy
      // fallback.
      renameAtSync(parent, name, entryFd, TREE_NAME);
    } finally {
      closeSync(entryFd);
    }
    return entryId;
  } finally {
    closeSync(parent);
  }
}

// Restorable manifests newest first; only manifests are read, never tree
// contents.
export function entries(paths: DeletedBinPaths): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const entry of entryDirs(paths.deletedDir)) {
    const record = readManifest(entry);
    if (record !== null) found.push(record);
  }
  found.sort((left, right) => {
    const a = pythonOr(left.deleted_at, 0);
    const b = pythonOr(right.deleted_at, 0);
    if (typeof a === "number" && typeof b === "number") return b - a;
    if (typeof a === "string" && typeof b === "string")
      return compareCodePoints(b, a);
    return 0;
  });
  return found;
}

// Restore bytes only if the original parent exists and the destination is free.
export function restore(
  entryId: string,
  paths: DeletedBinPaths,
): Record<string, unknown> | null {
  for (const entry of entryDirs(paths.deletedDir)) {
    const record = readManifest(entry);
    if (record === null || record.entry_id !== entryId) continue;
    const original = record.original_path;
    if (typeof original !== "string") return null;
    const destination = original;
    const components = destination.split(sep);
    const parent = dirname(destination);
    if (
      !isAbsolute(destination) ||
      components.includes("..") ||
      lstatIsSymlink(parent) ||
      !isDirectory(parent)
    )
      return null;
    if (existsSync(destination) || lstatIsSymlink(destination)) return null;
    const tree = join(entry, TREE_NAME);
    if (!isDirectory(tree) || lstatIsSymlink(tree)) return null;
    try {
      renameSync(tree, destination);
    } catch (error) {
      if (!isSystemError(error)) throw error;
      return null;
    }
    try {
      unlinkSync(join(entry, MANIFEST_NAME));
    } catch (error) {
      if (!missing(error)) {
        if (!isSystemError(error)) throw error;
        return record;
      }
    }
    try {
      rmdirSync(entry);
    } catch (error) {
      if (!isSystemError(error)) throw error;
    }
    return record;
  }
  return null;
}

function lstatIsSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
}

// Retire expired partitions; sweeping trash is a separate bounded operation.
export function expire(
  paths: DeletedBinPaths,
  options: { now?: number; limit?: number } = {},
): number {
  return expirePartitions(paths.deletedDir, paths.trashDir, {
    retentionDays: paths.retentionDays,
    limit: options.limit ?? paths.expiryLimit,
    ...(options.now === undefined ? {} : { now: options.now }),
  }).retired;
}
