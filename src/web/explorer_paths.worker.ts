// Descriptor-pinned reads for Explorer, called only in its Worker. Parent
// replacement cannot redirect a walk; every relative component is no-follow.
// Credential checks use the opened root's real location, including cwd aliases.
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readlink,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { descriptorPath, lstatAt, openAt } from "../utils/dir_fd";

const CREDENTIAL_RE =
  /^(?:\.env.*|id_(?:rsa|dsa|ecdsa|ed25519).*|\.netrc|_netrc|\.git-credentials|\.pgpass|\.npmrc|\.pypirc|\.vault-token|\.htpasswd|credentials(?:\..*)?|auth\.json|.*\.tfstate.*|.*\.(?:pem|key|p12|pfx))$/i;
const CREDENTIAL_SUFFIXES = [
  [".git", "config"],
  [".kube", "config"],
  [".docker", "config.json"],
  [".config", "gh", "hosts.yml"],
];
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

/**
 * Recurse state is private except the contents of visible managed worktrees.
 */
export function restricted(
  path: string,
  dataDir: string,
  privateRoots: readonly string[],
): boolean {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const base = dataDir.replace(/\/$/, "");
  const state = path === base || path.startsWith(`${base}/`);
  const [top, name] = path.slice(base.length + 1).split("/");
  return (
    privateRoots.some((root) => path === root || path.startsWith(`${root}/`)) ||
    CREDENTIAL_RE.test(parts.at(-1) ?? "") ||
    parts.includes(".ssh") ||
    CREDENTIAL_SUFFIXES.some((suffix) =>
      suffix.every((part, i) => parts.at(i - suffix.length) === part),
    ) ||
    (state && !(top === "worktrees" && name && !name.startsWith(".")))
  );
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

/**
 * Admit only the marker-backed worktrees managed by the existing worktree CLI.
 */
async function managedWorktree(
  path: string,
  dataDir: string,
): Promise<boolean> {
  if (!path.startsWith(`${dataDir}/worktrees/`)) return true;
  const name = path.slice(`${dataDir}/worktrees/`.length).split("/")[0]!;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ||
    ["CUTOVER", "TO_REAP"].includes(name)
  )
    return false;
  const marker = join(dataDir, "worktrees", ".markers", `${name}.json`);
  let handle;
  try {
    const before = await lstat(marker);
    if (!before.isFile() || before.size > 64 * 1024) return false;
    handle = await open(marker, FILE_FLAGS);
    const opened = await handle.stat();
    if (!sameFile(before, opened) || !opened.isFile()) return false;
    const bytes = new Uint8Array(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 64 * 1024) return false;
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytesRead),
      ),
    );
    return (
      value?.version === 1 &&
      value.name === name &&
      value.path === join(dataDir, "worktrees", name) &&
      !!value.holders &&
      typeof value.holders === "object" &&
      !Array.isArray(value.holders)
    );
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Pin the root, then open each child under its retained parent. */
export async function directory(
  root: string,
  parts: string[],
  dataDir: string,
  privateRoots: readonly string[],
) {
  let dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const [realRoot, realData, realPrivateRoots] = await Promise.all([
      openedRoot(dir, root),
      realpath(dataDir).catch(() => resolve(dataDir)),
      Promise.all(
        privateRoots.map((path) => realpath(path).catch(() => resolve(path))),
      ),
    ]);
    const target = `${realRoot}${parts.length ? "/" + parts.join("/") : ""}`;
    if (
      restricted(target, realData, realPrivateRoots) ||
      !(await managedWorktree(target, realData))
    )
      refuse(403, "private folder contents are not shown");
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
    const location = parts.length ? await openedRoot(dir, target) : realRoot;
    if (
      location !== target &&
      (restricted(location, realData, realPrivateRoots) ||
        !(await managedWorktree(location, realData)))
    )
      refuse(403, "private folder contents are not shown");
    return { dir, location, realData, realPrivateRoots };
  } catch (error) {
    await dir.close().catch(() => {});
    throw error;
  }
}

/**
 * Reject symlinks and non-regular files before opening, and verify the inode.
 */
export async function regularFile(
  root: string,
  parts: string[],
  dataDir: string,
  privateRoots: readonly string[],
) {
  if (!parts.length) refuse(422, "not a file");
  const name = parts.at(-1)!;
  const { dir, location, realData, realPrivateRoots } = await directory(
    root,
    parts.slice(0, -1),
    dataDir,
    privateRoots,
  );
  try {
    const before = await lstatAt(dir.fd, name);
    if (before.isSymbolicLink()) refuse(422, "symbolic links are not followed");
    if (!before.isFile()) refuse(422, "not a regular file");
    if (restricted(`${location}/${name}`, realData, realPrivateRoots))
      refuse(403, "credential file contents are not shown");
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
