// Descriptor-pinned reads for Explorer, called only in its Worker. Parent
// replacement cannot redirect a walk. A symbolic link is followed wherever it
// points; the link itself must be unchanged after its target is opened.
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readlink,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { descriptorPath, lstatAt, openAt, statAt } from "../utils/dir_fd";

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FOLLOW = ~constants.O_NOFOLLOW;

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

async function openedPath(dir: FileHandle, root: string): Promise<string> {
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

/**
 * Open `name` under `dir` if it is (or links to) `kind`. The opened inode must
 * be the one checked, and a link must still be the same link afterwards.
 */
async function openChild(
  dir: FileHandle,
  name: string,
  kind: "directory" | "file",
) {
  const before = await lstatAt(dir.fd, name);
  const link = before.isSymbolicLink();
  const target = link ? await statAt(dir.fd, name) : before;
  if (kind === "directory" ? !target.isDirectory() : !target.isFile())
    refuse(
      422,
      kind === "directory" ? "not a directory" : "not a regular file",
    );
  const flags = kind === "directory" ? DIRECTORY_FLAGS : FILE_FLAGS;
  const handle = await openAt(dir.fd, name, link ? flags & FOLLOW : flags);
  const [opened, after] = await Promise.all([
    handle.stat().catch(() => null),
    link ? lstatAt(dir.fd, name).catch(() => null) : before,
  ]);
  if (
    !opened ||
    !after ||
    !sameFile(target, opened) ||
    !sameFile(before, after)
  ) {
    await handle.close().catch(() => {});
    refuse(409, "the folder changed; try again");
  }
  return { handle, stats: opened };
}

/** Pin the root, then open each child under its retained parent. */
export async function directory(root: string, parts: string[]) {
  let dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const realRoot = await openedPath(dir, root);
    const target = `${realRoot}${parts.length ? "/" + parts.join("/") : ""}`;
    for (const part of parts) {
      const next = await openChild(dir, part, "directory");
      await dir.close();
      dir = next.handle;
    }
    const canonicalPath = parts.length
      ? await openedPath(dir, target)
      : realRoot;
    return { dir, canonicalPath: canonicalPath || "/" };
  } catch (error) {
    await dir.close().catch(() => {});
    throw error;
  }
}

/** Open a regular file, following a symbolic link, and verify the inode. */
export async function regularFile(root: string, parts: string[]) {
  if (!parts.length) refuse(422, "not a file");
  const name = parts.at(-1)!;
  const { dir } = await directory(root, parts.slice(0, -1));
  try {
    const { handle, stats } = await openChild(dir, name, "file");
    try {
      const canonicalPath = await openedPath(
        handle,
        `${root}/${parts.join("/")}`,
      );
      return { handle, stats, name, canonicalPath };
    } catch (error) {
      await handle.close();
      throw error;
    }
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
