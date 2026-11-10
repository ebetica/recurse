// Descriptor-pinned reads for Explorer, called only in its Worker. Parent
// replacement cannot redirect a walk; every relative component is no-follow.
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readlink,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { descriptorPath, lstatAt, openAt } from "../utils/dir_fd";

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function refuse(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
export const sameFile = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino;

/**
 * Only normal, relative components may reach descriptor-relative operations.
 */
export function pathParts(path: string): string[] {
  if (!path) return [];
  const parts = path.split("/");
  if (
    path.includes("\0") ||
    path.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    refuse(422, "path must be relative to the working folder");
  return parts;
}

async function openedRoot(dir: FileHandle, root: string): Promise<string> {
  const path =
    process.platform === "linux"
      ? await readlink(descriptorPath(dir.fd))
      : await realpath(root);
  const [opened, named] = await Promise.all([
    dir.stat(),
    lstat(path).catch(() => null),
  ]);
  if (!named || !sameFile(opened, named))
    refuse(409, "the folder changed; try again");
  return path.replace(/\/$/, "");
}

/** Pin the root, then open each child under its retained parent. */
export async function directory(root: string, parts: string[]) {
  let dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const realRoot = await openedRoot(dir, root);
    const target = `${realRoot}${parts.length ? "/" + parts.join("/") : ""}`;
    for (const part of parts) {
      const before = await lstatAt(dir.fd, part);
      if (before.isSymbolicLink())
        refuse(422, "symbolic links are not followed");
      if (!before.isDirectory()) refuse(422, "not a directory");
      const next = await openAt(dir.fd, part, DIRECTORY_FLAGS);
      const opened = await next.stat().catch(() => null);
      if (!opened?.isDirectory() || !sameFile(before, opened)) {
        await next.close();
        refuse(409, "the folder changed; try again");
      }
      await dir.close();
      dir = next;
    }
    if (parts.length) await openedRoot(dir, target);
    return { dir };
  } catch (error) {
    await dir.close().catch(() => {});
    throw error;
  }
}

/**
 * Reject symlinks and non-regular files before opening, and verify the inode.
 */
export async function regularFile(root: string, parts: string[]) {
  if (!parts.length) refuse(422, "not a file");
  const name = parts.at(-1)!;
  const { dir } = await directory(root, parts.slice(0, -1));
  try {
    const before = await lstatAt(dir.fd, name);
    if (before.isSymbolicLink()) refuse(422, "symbolic links are not followed");
    if (!before.isFile()) refuse(422, "not a regular file");
    const handle = await openAt(dir.fd, name, FILE_FLAGS);
    const stats = await handle.stat().catch(() => null);
    if (!stats?.isFile() || !sameFile(before, stats)) {
      await handle.close().catch(() => {});
      refuse(409, "the file changed while opening; try again");
    }
    return { handle, stats, name };
  } finally {
    await dir.close().catch(() => {});
  }
}

/** Preserve the UTF-8 byte offset when the chunk ends inside a character. */
export function textChunk(
  bytes: Uint8Array,
  truncated: boolean,
): { text: string; length: number } | null {
  if (bytes.includes(0)) return null;
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      const data = bytes.subarray(0, bytes.length - cut);
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(data),
        length: data.length,
      };
    } catch {}
  }
  return null;
}
