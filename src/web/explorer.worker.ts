// Bounded Explorer I/O: lazy cursors, pinned downloads, owner-only save temps.
// Cursors expire; downloads close with responses; handles have a global cap.
// Saves never log text. Version checks are best-effort against external
// writers, not an atomic CAS.
import { constants, type Stats } from "node:fs";
import { realpath, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  entriesAt,
  lstatAt,
  openAt,
  renameAt,
  statAt,
  unlinkAt,
} from "../utils/dir_fd";
import { runBounded, safeGitEnv } from "../workdir_git";
import { loadPromptContextFiles } from "../agents/durable/prompt_resources";
import { resolveRoots } from "../local_roots";
import {
  EXPLORER_CHUNK_BYTES,
  EXPLORER_DOWNLOAD_BYTES,
  EXPLORER_EDIT_BYTES,
  EXPLORER_PAGE_SIZE,
  type ExplorerMessage,
  type ExplorerReply,
  type ExplorerRequests,
  type ExplorerScope,
  type ExplorerEntry,
  type ExplorerListing,
  type ExplorerPreview,
} from "./explorer_io";
import {
  directory,
  pathParts,
  regularFile,
  sameFile,
  refuse,
  textChunk,
} from "./explorer_paths.worker";

type Listing = {
  owner: string;
  root: string;
  path: string;
  dir: FileHandle;
  iterator: AsyncIterator<string>;
  next: IteratorResult<string>;
  expires: number;
  busy: boolean;
};
type Download = {
  owner: string;
  handle: FileHandle;
  size: number;
};
const listings = new Map<string, Listing>();
const downloads = new Map<string, Download>();
const calls = new Map<number, AbortController>();
const active = new Set<Promise<void>>();
let sealed = false;
const listingOwners = new Map<string, AbortController>();
const HANDLE_IDLE_MS = 60_000;
let saving: Promise<unknown> = Promise.resolve();
let opening = 0;
const port = globalThis as unknown as Worker;

async function release(owner: string, token: string): Promise<void> {
  const listing = listings.get(token);
  if (listing?.owner === owner) {
    listings.delete(token);
    await listing.iterator.return?.();
    await listing.dir.close().catch(() => {});
  }
  const download = downloads.get(token);
  if (download?.owner === owner) {
    downloads.delete(token);
    await download.handle.close().catch(() => {});
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of listings)
    if (!entry.busy && entry.expires < now) void release(entry.owner, token);
}, 10_000).unref();

function reserve(): () => void {
  if (listings.size + downloads.size + opening >= 32)
    refuse(429, "too many open folders or downloads; try again shortly");
  opening++;
  return () => {
    opening--;
  };
}

async function ignored(
  root: string,
  paths: string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  const result = await runBounded(
    [
      "git",
      "-c",
      "core.fsmonitor=false",
      "--no-optional-locks",
      "--no-replace-objects",
      "check-ignore",
      "--stdin",
      "-z",
    ],
    root,
    safeGitEnv(process.env),
    256 * 1024,
    1,
    signal,
    new TextEncoder().encode(paths.map((path) => `./${path}\0`).join("")),
  );
  if (!result || result.truncated || (result.code !== 0 && result.code !== 1))
    return new Set();
  return new Set(
    new TextDecoder()
      .decode(result.out)
      .split("\0")
      .filter((path) => path.startsWith("./"))
      .map((path) => path.slice(2)),
  );
}

async function list(
  scope: ExplorerScope & { cursor?: string },
  signal: AbortSignal,
): Promise<ExplorerListing> {
  const parts = pathParts(scope.path);
  let token = scope.cursor;
  let item: Listing | undefined;
  if (token) {
    item = listings.get(token);
    if (
      !item ||
      item.owner !== scope.owner ||
      item.root !== scope.root ||
      item.path !== scope.path ||
      item.expires < Date.now()
    )
      refuse(409, "folder listing expired; refresh the folder");
    if (item.busy) refuse(409, "folder page is already loading");
  } else {
    const releaseSlot = reserve();
    try {
      const opened = await directory(scope.root, parts);
      try {
        const iterable = await entriesAt(opened.dir.fd);
        const iterator = iterable[Symbol.asyncIterator]();
        item = {
          ...scope,
          ...opened,
          iterator,
          next: await iterator.next(),
          expires: Date.now() + HANDLE_IDLE_MS,
          busy: false,
        };
        token = randomUUID();
        listings.set(token, item);
      } catch (error) {
        await opened.dir.close();
        throw error;
      }
    } finally {
      releaseSlot();
    }
  }
  item.busy = true;
  try {
    if (scope.cursor) {
      const current = await directory(scope.root, parts);
      try {
        if (!sameFile(await current.dir.stat(), await item.dir.stat()))
          refuse(409, "the folder changed; refresh the folder");
      } finally {
        await current.dir.close();
      }
    }
    const names: string[] = [];
    while (!item.next.done && names.length < EXPLORER_PAGE_SIZE) {
      if (signal.aborted) refuse(499, "request cancelled");
      names.push(item.next.value);
      item.next = await item.iterator.next();
    }
    const prefix = parts.length ? `${parts.join("/")}/` : "";
    const [stats, ignoredPaths] = await Promise.all([
      Promise.all(
        names.map(async (name) => {
          const stat = await lstatAt(item.dir.fd, name).catch(() => null);
          return stat?.isSymbolicLink()
            ? ((await statAt(item.dir.fd, name).catch(() => null)) ?? stat)
            : stat;
        }),
      ),
      ignored(
        scope.root,
        names.map((name) => prefix + name),
        signal,
      ),
    ]);
    const entries: ExplorerEntry[] = [];
    names.forEach((name, i) => {
      const stat = stats[i];
      if (!stat) return;
      const type = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other";
      entries.push({
        name,
        type,
        size: type === "file" ? stat.size : 0,
        ignored: ignoredPaths.has(prefix + name),
      });
    });
    entries.sort(
      (a, b) =>
        Number(b.type === "directory") - Number(a.type === "directory") ||
        a.name.localeCompare(b.name),
    );
    const more = !item.next.done;
    item.expires = Date.now() + HANDLE_IDLE_MS;
    let nextToken: string | null = null;
    if (more) {
      listings.delete(token!);
      nextToken = randomUUID();
      listings.set(nextToken, item);
    } else await release(scope.owner, token!);
    return { root: scope.root, path: scope.path, entries, cursor: nextToken };
  } catch (error) {
    await release(scope.owner, token!);
    throw error;
  } finally {
    item.busy = false;
  }
}

const versionOf = (stats: Stats) =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
const absent = (error: unknown) =>
  (error as { code?: string }).code === "ENOENT";

/** A missing file whose folder exists is `missing`, so it can be created. */
async function opened(scope: ExplorerScope) {
  const parts = pathParts(scope.path);
  try {
    return await regularFile(scope.root, parts);
  } catch (error) {
    if (!absent(error) || !parts.length) throw error;
    const { dir } = await directory(scope.root, parts.slice(0, -1));
    const found = await lstatAt(dir.fd, parts.at(-1)!).then(
      () => true,
      (lstatError) => !absent(lstatError),
    );
    await dir.close();
    if (found) throw error;
    return null;
  }
}

/** Resolve existing targets, or the canonical parent of a new file. */
async function destination(scope: ExplorerScope): Promise<string> {
  const parts = pathParts(scope.path);
  if (!parts.length) refuse(422, "not a file");
  try {
    return await realpath(join(scope.root, ...parts));
  } catch (error) {
    if (!absent(error)) throw error;
    const { dir, canonicalPath } = await directory(
      scope.root,
      parts.slice(0, -1),
    );
    try {
      const exists = await lstatAt(dir.fd, parts.at(-1)!).then(
        () => true,
        (error) => {
          if (!absent(error)) throw error;
          return false;
        },
      );
      if (exists) throw error;
      return join(canonicalPath, parts.at(-1)!);
    } finally {
      await dir.close();
    }
  }
}

async function promptResource(
  scope: ExplorerScope,
  canonicalPath: string,
): Promise<boolean> {
  if (
    [scope.path, canonicalPath].some((path) =>
      /\.(md|markdown|mdx)\.*$/i.test(path),
    )
  )
    return true;
  const files = await loadPromptContextFiles(
    scope.contextRoot ?? scope.root,
    scope.agentDir ?? resolveRoots().piAgent,
  );
  for (const file of files)
    if ((await realpath(file.path).catch(() => file.path)) === canonicalPath)
      return true;
  return false;
}

async function preview(
  scope: ExplorerScope & { offset: number; version?: string },
): Promise<ExplorerPreview> {
  const file = await opened(scope);
  const canonicalPath = file?.canonicalPath ?? (await destination(scope));
  if (!file)
    return {
      root: scope.root,
      path: scope.path,
      canonicalPath,
      promptResource: await promptResource(scope, canonicalPath),
      size: 0,
      version: "",
      kind: "missing",
      next: null,
    };
  const { handle, stats } = file;
  try {
    const warning = await promptResource(scope, canonicalPath);
    const version = versionOf(stats);
    if (scope.offset && scope.version !== version)
      refuse(409, "the file changed; reopen it");
    if (scope.offset > stats.size)
      refuse(422, "offset is past the end of the file");
    const bytes = new Uint8Array(
      Math.min(EXPLORER_CHUNK_BYTES, stats.size - scope.offset),
    );
    const { bytesRead } = await handle.read(
      bytes,
      0,
      bytes.length,
      scope.offset,
    );
    const text = textChunk(
      bytes.subarray(0, bytesRead),
      scope.offset + bytesRead < stats.size,
    );
    const after = await handle.stat();
    if (
      after.size !== stats.size ||
      after.mtimeMs !== stats.mtimeMs ||
      after.ctimeMs !== stats.ctimeMs
    )
      refuse(409, "the file changed; reopen it");
    const next = scope.offset + (text?.length ?? bytesRead);
    return {
      root: scope.root,
      path: scope.path,
      size: stats.size,
      version,
      canonicalPath,
      promptResource: warning,
      kind: text ? "text" : "binary",
      ...(text ? { text: text.text } : {}),
      next: next < stats.size ? next : null,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Replace or create a file with UTF-8 text via an owner-only temporary file.
 * New files use mode 0600; replaced files keep their mode.
 */
async function save(scope: ExplorerRequests["save"]): Promise<ExplorerPreview> {
  const bytes = new TextEncoder().encode(scope.text);
  if (bytes.length > EXPLORER_EDIT_BYTES)
    refuse(413, "the file is too large to save here");
  const parts = pathParts(scope.path);
  if (!parts.length) refuse(422, "not a file");
  const unchangedDestination = async () => {
    let target: string;
    try {
      target = await destination(scope);
    } catch {
      refuse(409, "The file destination changed; reopen it before saving.");
    }
    if (target !== scope.canonicalPath)
      refuse(409, "The file destination changed; reopen it before saving.");
    return target;
  };
  const target = await unchangedDestination();
  const name = basename(target);
  const { dir } = await directory(dirname(target), []);
  const temp = `.${name.slice(0, 200)}.${randomUUID().slice(0, 8)}.tmp`;
  let written = false;
  try {
    const before = await lstatAt(dir.fd, name).catch((error) =>
      absent(error) ? null : Promise.reject(error),
    );
    const current = (stats: Stats | null) => {
      if (stats && !stats.isFile()) refuse(422, "not a regular file");
      if (scope.overwrite) return;
      if (scope.version === null && stats)
        refuse(409, "A file with this name already exists.");
      if (
        scope.version !== null &&
        (!stats || versionOf(stats) !== scope.version)
      )
        refuse(409, "The file changed on disk since you opened it.");
    };
    current(before);
    const handle = await openAt(
      dir.fd,
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    written = true;
    try {
      await handle.writeFile(bytes);
      await handle.chmod(before ? before.mode & 0o7777 : 0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    current(
      await lstatAt(dir.fd, name).catch((error) =>
        absent(error) ? null : Promise.reject(error),
      ),
    );
    await unchangedDestination();
    const namedParent = await directory(dirname(target), []);
    try {
      if (!sameFile(await namedParent.dir.stat(), await dir.stat()))
        refuse(409, "The file destination changed; reopen it before saving.");
    } finally {
      await namedParent.dir.close();
    }
    await renameAt(dir.fd, temp, dir.fd, name);
    written = false;
  } finally {
    if (written) await unlinkAt(dir.fd, temp).catch(() => {});
    await dir.close().catch(() => {});
  }
  return preview({ ...scope, offset: 0, version: undefined });
}

async function request(message: ExplorerMessage, signal: AbortSignal) {
  const { args } = message;
  if (message.op === "release") {
    await release(message.args.owner, message.args.token);
    return null;
  }
  if (message.op === "read") {
    const { owner, token, offset, length } = message.args;
    const item = downloads.get(token);
    if (!item || item.owner !== owner) refuse(404, "download expired");
    const bytes = new Uint8Array(
      Math.min(64 * 1024, length, Math.max(0, item.size - offset)),
    );
    const { bytesRead } = await item.handle.read(
      bytes,
      0,
      bytes.length,
      offset,
    );
    return bytes.subarray(0, bytesRead);
  }
  if (message.op === "list") return list(message.args, signal);
  if (message.op === "preview") return preview(message.args);
  if (message.op === "save") {
    // Invariant: One save at a time, so each version check and its rename
    // cannot interleave with another Recurse save of the same file.
    const run = saving.then(() => save(message.args));
    saving = run.catch(() => {});
    return run;
  }
  if (message.op === "admit") {
    const root = await directory(
      message.args.root,
      pathParts(message.args.path),
    );
    await root.dir.close();
    return null;
  }
  const releaseSlot = reserve();
  try {
    const scope = args as ExplorerScope;
    const opened = await regularFile(scope.root, pathParts(scope.path));
    if (opened.stats.size > EXPLORER_DOWNLOAD_BYTES) {
      await opened.handle.close();
      refuse(413, "file is too large to download here");
    }
    const token = randomUUID();
    downloads.set(token, {
      owner: scope.owner,
      handle: opened.handle,
      size: opened.stats.size,
    });
    return { token, name: opened.name, size: opened.stats.size };
  } finally {
    releaseSlot();
  }
}

port.onmessage = (
  event: MessageEvent<ExplorerMessage | { op: "abort"; id: number }>,
) => {
  const message = event.data;
  if (message.op === "abort") {
    calls.get(message.id)?.abort();
    return;
  }
  if (message.op === "shutdown") {
    sealed = true;
    for (const controller of calls.values()) controller.abort();
    void Promise.allSettled([...active])
      .then(async () => {
        for (const [token, item] of listings) await release(item.owner, token);
        for (const [token, item] of downloads) await release(item.owner, token);
        reply({ id: message.id, value: null });
      })
      .catch((error) => fail(message.id, error));
    return;
  }
  if (sealed) {
    fail(message.id, { status: 503, message: "file browser is stopping" });
    return;
  }
  const controller = new AbortController();
  calls.set(message.id, controller);
  const key =
    message.op === "list" && !message.args.cursor
      ? `${message.args.owner}\0${message.args.path}`
      : null;
  if (key) {
    listingOwners.get(key)?.abort();
    listingOwners.set(key, controller);
  }
  const done = request(message, controller.signal)
    .then(
      (value) => reply({ id: message.id, value }),
      (error) => fail(message.id, error),
    )
    .finally(() => {
      calls.delete(message.id);
      active.delete(done);
      if (key && listingOwners.get(key) === controller)
        listingOwners.delete(key);
    });
  active.add(done);
};

function reply(value: ExplorerReply): void {
  port.postMessage(value);
}
function fail(id: number, error: unknown): void {
  const item = error as { status?: number; code?: string; message?: string };
  const status =
    item.status ??
    (item.code === "EACCES" || item.code === "EPERM"
      ? 403
      : ["ELOOP", "EMLINK", "ENOTDIR"].includes(item.code ?? "")
        ? 422
        : ["EROFS", "ENOSPC", "EDQUOT"].includes(item.code ?? "")
          ? 507
          : 404);
  reply({
    id,
    error: {
      status,
      message: item.status
        ? item.message!
        : status === 403
          ? "permission denied"
          : status === 422
            ? "not a folder or regular file"
            : status === 507
              ? "the disk is full or read-only"
              : "file or folder not found",
    },
  });
}
