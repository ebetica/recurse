// O(1) legacy session-header validation of recorded id/file/cwd, no scans.
// Importer/history/prompts/usage read originals through this binding check.
// Leaves open via dir_fd; strict UTF-8 headers refuse UTF-16/32.
// Header cache is module-wide; JS integers beyond 2^53 lose precision.
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { lstatAt, openAt } from "../utils/dir_fd";
import { parsePythonJson } from "../utils/py_compact_json";

export type SessionHeader = Record<string, unknown> & {
  id: string;
  cwd: string;
  _recurse_file_size: number;
  _recurse_header_size: number;
};

// Pi's character grammar plus a filename-safe bound for this flat store.
export const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
export const SESSION_HEADER_MAX = 16 * 1024;
export const HEADER_CACHE_MAX = 4096;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIR_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW;
type Identity = [bigint, bigint, bigint, bigint, bigint];
// Keyed by `${store}\0${name}`; insertion order gives Python's FIFO eviction.
const headerCache = new Map<string, [Identity, SessionHeader]>();

/** Test hook: forget every cached header. */
export function clearSessionHeaderCache(): void {
  headerCache.clear();
}

const lst = (path: string): Promise<BigIntStats> =>
  lstat(path, { bigint: true });
const sameInode = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino;
// Python `Path(value).absolute()` spelling: join cwd, drop `.` and empty parts.
export function pyAbsolute(value: string, cwd = process.cwd()): string {
  const full = value.startsWith("/") ? value : `${cwd}/${value}`;
  const anchor = /^\/\/(?!\/)/.test(full) ? "//" : "/";
  const parts = full.split("/").filter((part) => part && part !== ".");
  return anchor + parts.join("/");
}

/** Python `str(Path(value))`: the relative-or-absolute normalized spelling. */
export function pyPath(value: string): string {
  if (value.startsWith("/")) return pyAbsolute(value);
  const parts = value.split("/").filter((part) => part && part !== ".");
  return parts.length ? parts.join("/") : ".";
}

const parentOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? path.slice(0, index + 1) || "." : path.slice(0, index);
};
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const suffixOf = (name: string): string => {
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
};

/** Open a real directory with its inode pinned across lstat/open/lstat. */
async function openPinnedDir(path: string): Promise<FileHandle | null> {
  const root = pyAbsolute(path);
  let handle: FileHandle | undefined;
  try {
    const before = await lst(root);
    if (!before.isDirectory() || before.isSymbolicLink()) return null;
    handle = await open(root, DIR_FLAGS);
    const opened = await handle.stat({ bigint: true });
    const after = await lst(root);
    if (!sameInode(before, opened) || !sameInode(after, opened)) {
      await handle.close();
      return null;
    }
    return handle;
  } catch {
    if (handle) await handle.close();
    return null;
  }
}

async function readHeaderLine(handle: FileHandle): Promise<Uint8Array> {
  const buffer = new Uint8Array(SESSION_HEADER_MAX + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      null,
    );
    if (bytesRead === 0) break;
    const newline = buffer.subarray(total, total + bytesRead).indexOf(10);
    if (newline >= 0) return buffer.slice(0, total + newline + 1);
    total += bytesRead;
  }
  return buffer.slice(0, total);
}

function parseHeader(raw: Uint8Array): unknown {
  const body =
    raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
      ? raw.subarray(3)
      : raw;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    return parsePythonJson(text);
  } catch {
    return undefined;
  }
}

export class SessionIndex {
  readonly sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  private openSessionRoot(): Promise<FileHandle | null> {
    return openPinnedDir(this.sessionDir);
  }

  private cacheHeader(
    key: string,
    identity: Identity,
    header: SessionHeader,
  ): void {
    headerCache.delete(key);
    headerCache.set(key, [identity, header]);
    while (headerCache.size > HEADER_CACHE_MAX)
      headerCache.delete(headerCache.keys().next().value!);
  }

  /** Validate and parse one session leaf relative to a pinned store fd. */
  private async sessionHeaderAt(
    root: FileHandle,
    name: string,
  ): Promise<SessionHeader | null> {
    const key = `${pyAbsolute(this.sessionDir)}\0${name}`;
    let handle: FileHandle | undefined;
    let raw: Uint8Array;
    let opened: BigIntStats;
    let identity: Identity;
    try {
      const before = await lstatAt(root.fd, name, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n) return null;
      identity = [
        before.dev,
        before.ino,
        before.size,
        before.mtimeNs,
        before.ctimeNs,
      ];
      const cached = headerCache.get(key);
      if (cached && cached[0].every((value, i) => value === identity[i]))
        return { ...cached[1] };
      handle = await openAt(root.fd, name, constants.O_RDONLY | NOFOLLOW);
      opened = await handle.stat({ bigint: true });
      const after = await lstatAt(root.fd, name, { bigint: true });
      if (
        !sameInode(before, opened) ||
        !sameInode(after, opened) ||
        !opened.isFile() ||
        opened.nlink !== 1n
      )
        return null;
      raw = await readHeaderLine(handle);
    } catch {
      return null;
    } finally {
      if (handle) await handle.close();
    }
    if (raw[raw.length - 1] !== 10 || raw.length > SESSION_HEADER_MAX)
      return null;
    const header = parseHeader(raw);
    if (
      header === null ||
      typeof header !== "object" ||
      Array.isArray(header) ||
      (header as Record<string, unknown>).type !== "session"
    )
      return null;
    const record = header as Record<string, unknown>;
    const sessionId = record.id;
    const cwd = record.cwd;
    if (
      typeof sessionId !== "string" ||
      !SESSION_ID.test(sessionId) ||
      typeof cwd !== "string" ||
      !cwd ||
      [...cwd].length > 4096 ||
      !name.endsWith(`_${sessionId}.jsonl`)
    )
      return null;
    // Invariant: Private observations used only to prove an interrupted --fork
    // finished.
    record._recurse_file_size = Number(opened.size);
    record._recurse_header_size = raw.length;
    this.cacheHeader(key, identity, record as SessionHeader);
    return { ...(record as SessionHeader) };
  }

  /** One validated header for a path that must be a direct store leaf. */
  async sessionHeader(path: string): Promise<SessionHeader | null> {
    const candidate = pyAbsolute(path);
    if (
      parentOf(candidate) !== pyAbsolute(this.sessionDir) ||
      suffixOf(nameOf(candidate)) !== ".jsonl"
    )
      return null;
    const root = await this.openSessionRoot();
    if (!root) return null;
    try {
      return await this.sessionHeaderAt(root, nameOf(candidate));
    } finally {
      await root.close();
    }
  }

  /** Validate one conversation-recorded file binding in O(1); no scan. */
  async boundSessionFile(
    sessionId: unknown,
    recordedFile: unknown,
    recordedCwd: unknown,
  ): Promise<string | null> {
    if (
      typeof sessionId !== "string" ||
      !SESSION_ID.test(sessionId) ||
      typeof recordedFile !== "string" ||
      !recordedFile ||
      typeof recordedCwd !== "string" ||
      !recordedCwd
    )
      return null;
    const header = await this.sessionHeader(recordedFile);
    if (!header || header.id !== sessionId || header.cwd !== recordedCwd)
      return null;
    return pyPath(recordedFile);
  }
}
