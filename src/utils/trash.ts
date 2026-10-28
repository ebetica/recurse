// Retire by same-filesystem rename; reclaim bytes later with bounded sweeps.
// Pinned parent descriptors (./dir_fd) preserve parent/no-follow identity.
// Fail closed without them; never fall back to pathname recursive deletion.
// Inputs supply paths/limits only, not config/agent state or retention policy.
import fs from "node:fs";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  lstatAtSync,
  mkdirAtSync,
  openAtSync,
  readdirAtSync,
  renameAtSync,
  rmdirAtSync,
  unlinkAtSync,
} from "./dir_fd";

const ENTRY_RE = /^[0-9a-f]{32}$/u;
const CLOEXEC = (fsConstants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIR_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_DIRECTORY ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0) |
  CLOEXEC;

type SystemError = Error & {
  code?: string;
  errno?: number;
  path?: string;
};
type LogFailure = (error: Error, path: string) => void;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as SystemError).code;
  return typeof code === "string" ? code : undefined;
}

function isSystemError(error: unknown): error is SystemError {
  return errorCode(error) !== undefined;
}

function systemError(code: string, message: string, path: string): SystemError {
  const error = new Error(message) as SystemError;
  error.code = code;
  error.path = path;
  return error;
}

function sameDirectory(
  left: { isDirectory(): boolean; dev: number; ino: number },
  right: { isDirectory(): boolean; dev: number; ino: number },
) {
  return left.isDirectory() && left.dev === right.dev && left.ino === right.ino;
}

function filesystemPath(path: string): string {
  const value = path || ".";
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function openVerified(root: string, dirFd?: number): number {
  const path = filesystemPath(root);
  const visible = () =>
    dirFd === undefined ? lstatSync(path) : lstatAtSync(dirFd, root);
  const before = visible();
  if (!before.isDirectory()) {
    throw systemError("ENOTDIR", "trash root is not a directory", root);
  }
  const fd =
    dirFd === undefined
      ? fs.openSync(path, DIR_FLAGS)
      : openAtSync(dirFd, root, DIR_FLAGS);
  try {
    const opened = fstatSync(fd);
    const after = visible();
    if (!sameDirectory(opened, before) || !sameDirectory(after, before)) {
      throw systemError("ESTALE", "trash root changed while opening", root);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openRoot(root: string): number {
  try {
    return openVerified(root);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    mkdirSync(filesystemPath(root), { recursive: true });
    return openVerified(root);
  }
}

function openChildRoot(dirFd: number, child: string): number {
  if (!child || child === "." || child === ".." || child.includes("/")) {
    throw new TypeError("a trash root is named by a single path component");
  }
  for (const attempt of [1, 2]) {
    try {
      mkdirAtSync(dirFd, child, 0o700);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    try {
      return openVerified(child, dirFd);
    } catch (error) {
      const info = lstatAtSync(dirFd, child);
      if (attempt === 2 || info.isDirectory()) throw error;
      // Invariant: The private child name is reserved for this trash root.
      // Replace a planted symlink or file, never a directory that might hold
      // live data.
      unlinkAtSync(dirFd, child);
    }
  }
  throw new Error("unreachable");
}

/** Move `path` into trash `root`. Return false if it was already gone. */
export function retire(path: string, root: string): boolean {
  const source = filesystemPath(path);
  let parent: number;
  try {
    parent = openVerified(dirname(source));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  try {
    return retireAt(parent, basename(source), root);
  } finally {
    closeSync(parent);
  }
}

/** Retire one entry of an already-verified parent directory. */
export function retireAt(dirFd: number, name: string, root: string): boolean {
  return retireEntry(dirFd, name, () => openRoot(root));
}

/** Retire an entry into a trash root beside it under the same parent fd. */
export function retireIntoChild(
  dirFd: number,
  name: string,
  child: string,
): boolean {
  return retireAtIntoChild(dirFd, name, dirFd, child);
}

/** Rename one entry into a trash child of its own parent directory. */
export function retireWithinParent(
  dirFd: number,
  name: string,
  child: string,
): boolean {
  return retireIntoChild(dirFd, name, child);
}

/** Retire from one pinned parent into a child of another pinned parent. */
export function retireAtIntoChild(
  dirFd: number,
  name: string,
  rootParentFd: number,
  child: string,
): boolean {
  return retireEntry(dirFd, name, () => openChildRoot(rootParentFd, child));
}

// Retire each path, skipping missing entries and isolating filesystem errors.
export function retireAll(
  paths: Iterable<string>,
  root: string,
  log?: LogFailure,
): number {
  let retired = 0;
  for (const path of paths) {
    try {
      if (retire(path, root)) retired += 1;
    } catch (error) {
      if (!isSystemError(error)) throw error;
      log?.(error, path);
    }
  }
  return retired;
}

function retireEntry(
  dirFd: number,
  name: string,
  openRootCallback: () => number,
): boolean {
  if (!name || name === "." || name === ".." || name.includes("/")) {
    throw new TypeError("a retired entry is named by a single path component");
  }
  try {
    lstatAtSync(dirFd, name);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  const rootFd = openRootCallback();
  try {
    // Invariant: rename raises EXDEV across filesystems; it never
    // copy-deletes.
    renameAtSync(dirFd, name, rootFd, randomBytes(16).toString("hex"));
  } finally {
    closeSync(rootFd);
  }
  return true;
}

function removeTreeAt(parentFd: number, name: string): void {
  const before = lstatAtSync(parentFd, name);
  if (!before.isDirectory()) {
    unlinkAtSync(parentFd, name);
    return;
  }

  const childFd = openVerified(name, parentFd);
  try {
    const opened = fstatSync(childFd);
    if (!sameDirectory(opened, before)) {
      throw systemError(
        "ESTALE",
        "retired directory changed while opening",
        name,
      );
    }
    for (const entry of readdirAtSync(childFd)) {
      removeTreeAt(childFd, entry);
    }
  } finally {
    closeSync(childFd);
  }
  // Invariant: This path is resolved through the pinned parent; if the entry
  // was swapped for a symlink, rmdir fails rather than following it.
  rmdirAtSync(parentFd, name);
}

/** Delete at most `limit` retired entries; the rest wait for the next pass. */
export function sweep(root: string, limit: number): number {
  let rootFd: number;
  try {
    rootFd = openVerified(root);
  } catch (error) {
    if (isSystemError(error)) return 0;
    throw error;
  }
  let removed = 0;
  try {
    for (const name of readdirAtSync(rootFd)) {
      if (removed >= limit) break;
      if (!ENTRY_RE.test(name) || name.length !== 32) continue;
      try {
        removeTreeAt(rootFd, name);
        removed += 1;
      } catch (error) {
        if (!isSystemError(error)) throw error;
      }
    }
  } finally {
    closeSync(rootFd);
  }
  return removed;
}
