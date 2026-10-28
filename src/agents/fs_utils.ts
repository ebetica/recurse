// Async durable JSON leaves and pinned no-follow child opens. Check identity
// before/open/after, including directories where O_NOFOLLOW may be ignored.
// Atomic JSON fsyncs the new file before rename, not the parent.
// JS normalizes integral floats and integer-like object key ordering.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lstatAt, openAt } from "../utils/dir_fd";
import { parsePythonJson, pyCompactJson } from "../utils/py_compact_json";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const DIR_FLAGS = constants.O_RDONLY | DIRECTORY | NOFOLLOW;
const isMissing = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;
const same = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

// Open or create a regular lock leaf, rejecting a planted link or path swap.
export async function openPinnedLockFile(
  name: string,
  parent: FileHandle,
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 20; attempt++) {
    let handle: FileHandle | undefined;
    try {
      let before: Stats;
      try {
        before = await lstatAt(parent.fd, name);
      } catch (error) {
        if (!isMissing(error, "ENOENT")) throw error;
        try {
          handle = await openAt(
            parent.fd,
            name,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
            0o600,
          );
        } catch (createError) {
          if (isMissing(createError, "EEXIST")) continue;
          throw createError;
        }
        before = await handle.stat();
      }
      if (!before.isFile()) throw new Error(`unsafe lock: ${name}`);
      if (!handle) {
        try {
          handle = await openAt(parent.fd, name, constants.O_RDWR | NOFOLLOW);
        } catch (openError) {
          if (isMissing(openError, "ENOENT")) continue;
          throw openError;
        }
      }
      const opened = await handle.stat();
      const after = await lstatAt(parent.fd, name);
      if (!same(before, opened) || !same(before, after) || !after.isFile())
        throw new Error(`replaced lock: ${name}`);
      await handle.chmod(0o600);
      return handle;
    } catch (error) {
      if (handle) await handle.close();
      throw error;
    }
  }
  throw new Error(`lock publication did not stabilize: ${name}`);
}

/** Open an existing regular child through its pinned parent. Caller closes. */
export async function openPinnedRegularFile(
  name: string,
  parent: FileHandle,
  flags = constants.O_RDONLY,
): Promise<{ handle: FileHandle; stat: Stats }> {
  const before = await lstatAt(parent.fd, name);
  if (!before.isFile()) throw new Error(`unsafe regular file: ${name}`);
  const handle = await openAt(parent.fd, name, flags | NOFOLLOW);
  try {
    const stat = await handle.stat();
    const after = await lstatAt(parent.fd, name);
    if (
      !same(before, stat) ||
      !same(before, after) ||
      !stat.isFile() ||
      !after.isFile()
    )
      throw new Error(`replaced regular file: ${name}`);
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Open an existing directory through its pinned parent. Caller closes. */
export async function openPinnedDirectory(
  name: string,
  parent: FileHandle,
): Promise<FileHandle> {
  const before = await lstatAt(parent.fd, name);
  if (!before.isDirectory()) throw new Error(`unsafe directory: ${name}`);
  const handle = await openAt(parent.fd, name, DIR_FLAGS);
  try {
    const opened = await handle.stat();
    const after = await lstatAt(parent.fd, name);
    if (
      !same(before, opened) ||
      !same(before, after) ||
      !opened.isDirectory() ||
      !after.isDirectory()
    )
      throw new Error(`replaced directory: ${name}`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Read a pinned regular JSON object, returning null for any unsafe leaf. */
export async function readJson(
  path: string,
  maxBytes?: number,
): Promise<Record<string, unknown> | null> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || (maxBytes !== undefined && before.size > maxBytes))
      return null;
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    if (maxBytes !== undefined && opened.size > maxBytes) return null;
    const after = await lstat(path);
    if (
      !same(before, opened) ||
      !same(before, after) ||
      !opened.isFile() ||
      !after.isFile()
    )
      return null;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    const buffer = new Uint8Array(64 * 1024);
    for (;;) {
      const budget =
        maxBytes === undefined
          ? buffer.length
          : Math.min(buffer.length, maxBytes + 1 - total);
      if (budget <= 0) return null;
      const { bytesRead } = await handle.read(buffer, 0, budget, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.slice(0, bytesRead));
      total += bytesRead;
      if (maxBytes !== undefined && total > maxBytes) return null;
    }
    const final = await handle.stat();
    if (
      !same(before, final) ||
      (maxBytes !== undefined && final.size !== total)
    )
      return null;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    // Invariant: Preserve an initial BOM so JSON.parse rejects it like Python
    // json.loads.
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(data);
    const value: unknown = parsePythonJson(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

/** Write and fsync one 0600 JSON leaf before publishing it by rename. */
export async function atomicJson(
  path: string,
  value: Record<string, unknown>,
  ids: () => string = () => randomUUID().replaceAll("-", ""),
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${basename(path)}.${ids()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    const bytes = new TextEncoder().encode(pyCompactJson(value));
    for (let offset = 0; offset < bytes.length; ) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (bytesWritten <= 0) throw new Error("short atomic JSON write");
      offset += bytesWritten;
    }
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  await rename(temporary, path);
}
