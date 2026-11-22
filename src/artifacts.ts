// Owner-scoped Git Artifacts publish immutable versions via a CAS ref update.
// Git work is bounded/async; tree polls read revision markers, never history.
// Create/publish require document/app trees; older shapes remain readable.
// Saved app state lives outside the refs; see artifacts/README.md.

import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename as renamePath,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { APP_ENTRY, buildPage } from "./artifacts/page/index";
import {
  ArtifactBuild,
  ArtifactConflict,
  ArtifactCorrupt,
  ArtifactError,
  ArtifactInvalid,
  ArtifactLimit,
  ArtifactNotFound,
  DIRECTORY_FLAGS,
  FULL_SHA_RE,
  GIT_BUILDS,
  GIT_REF,
  HISTORY_MAX,
  ID_RE,
  MAX_MARKER_BYTES,
  OWNER_RE,
  TITLE_CONFIG_KEY,
  blob,
  changed,
  commit,
  commitDate,
  context,
  createRef,
  decode,
  errorCode,
  expectVersion,
  git,
  head,
  initRepo,
  isMissing,
  isObject,
  markerPath,
  normalizedId,
  normalizedOwner,
  normalizedTitle,
  oldestVersionDate,
  ownedBytes,
  ownerRoot,
  pathExists,
  publishRef,
  published,
  readFileBounded,
  readMarker,
  repoTitle,
  resolveVersion,
  safeRel,
  tree,
  type RecordValue,
  type ResolvedContext,
  type TreeRow,
  versionMetadata,
  writeFileAtomic,
  type ArtifactContext,
} from "./artifacts/store";
import { timed, timingDetail, timingId } from "./observability";
import { CHECKOUT_ROOT } from "./build_dir";
import { flockExclusive, lstatAt, openAt, procStat } from "./utils";
import { retirePath } from "./utils/trash-sweep";
import { pyCompactJson } from "./utils/python-json";

export const DOCUMENT_ENTRY = "index.md";

export type AppPage = { html: Buffer; sourceMap: string | null };

export const SVG_MEDIA_TYPE = "image/svg+xml";
const WIRE_MAX_BYTES = 100 * 1024 * 1024;
const LIST_MAX = 100;

export { ARTIFACT_ACTIVE_CSP } from "./artifact_frame_policy.js";
export {
  ArtifactBuild,
  ArtifactConflict,
  type ArtifactContext,
  ArtifactCorrupt,
  ArtifactError,
  ArtifactInvalid,
  ArtifactLimit,
  ArtifactNotFound,
  GIT_OUTPUT_MAX,
  GIT_REF,
  TITLE_CONFIG_KEY,
  revision,
} from "./artifacts/store";

function pythonInt(value: unknown): number | null {
  if (typeof value === "boolean") return Number(value);
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(codePointCompare)
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function pythonJson(value: unknown): string {
  let quoted = false;
  let escaped = false;
  let spaced = "";
  for (const character of pyCompactJson(sortKeys(value))) {
    spaced += character;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "," || character === ":") spaced += " ";
  }
  return spaced;
}

/** A document (index.md) or an app (index.html, which wins), or neither. */
function artifactKind(rows: readonly TreeRow[]): "document" | "app" | null {
  const roots = new Set(
    rows.filter(([, , , kind]) => kind === "blob").map(([name]) => name),
  );
  if (roots.has(APP_ENTRY)) return "app";
  if (roots.has(DOCUMENT_ENTRY)) return "document";
  return null;
}

// Derive the primary file: index conventions, then a lone file, then a root
// file.
function detectEntry(rows: readonly TreeRow[]): string | null {
  const blobs = rows
    .filter(([name, , , kind]) => kind === "blob" && name !== ".artifact.json")
    .map(([name]) => name);
  const roots = blobs.filter((name) => !name.includes("/"));
  for (const candidate of ["index.html", "index.md"]) {
    if (roots.includes(candidate)) return candidate;
  }
  if (blobs.length === 1) return blobs[0]!;
  if (roots.length) return roots.slice().sort(codePointCompare)[0]!;
  return null;
}

const FORMAT_SUFFIXES: Readonly<Record<string, string>> = {
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
};
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/vnd.microsoft.icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mjs": "text/javascript",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".py": "text/x-python",
  ".png": "image/png",
  ".sh": "application/x-sh",
  ".svg": SVG_MEDIA_TYPE,
  ".tar": "application/x-tar",
  ".text": "text/plain",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".xml": "text/xml",
  ".zip": "application/zip",
};

function mediaForName(name: string, inline = false): string {
  const extension = extname(name).toLowerCase();
  if (inline) {
    const images: Readonly<Record<string, string>> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": SVG_MEDIA_TYPE,
    };
    const safeImage = images[extension];
    if (safeImage) return safeImage;
  }
  const guessed = MIME_TYPES[extension] ?? "";
  if (
    guessed &&
    !guessed.startsWith("text/html") &&
    !guessed.startsWith("image/svg") &&
    !guessed.startsWith("application/javascript")
  ) {
    return guessed;
  }
  if (extension === ".svg") return SVG_MEDIA_TYPE;
  if ([".html", ".htm", ".xhtml"].includes(extension)) return "text/html";
  return guessed || "application/octet-stream";
}

function formatFor(name: string): string {
  const suffix = extname(name).toLowerCase();
  const mapped = FORMAT_SUFFIXES[suffix];
  if (mapped) return mapped;
  if (mediaForName(name, true).startsWith("image/")) return "image";
  return suffix ? "code" : "file";
}

async function info(
  ctx: ResolvedContext,
  owner: string,
  artifactId: string,
  repo: string,
  knownCreatedAt = "",
): Promise<RecordValue> {
  const current = await published(ctx, repo, false);
  const sha = current ?? (await head(ctx, repo));
  const status = current ? "ready" : "draft";
  let createdAt = "";
  let updatedAt = "";
  let entry: string | null = null;
  if (sha !== null) {
    const rows = await tree(ctx, repo, sha);
    entry = detectEntry(rows);
    createdAt =
      knownCreatedAt ||
      (await oldestVersionDate(ctx, repo)) ||
      (await commitDate(ctx, repo, sha));
    updatedAt = await commitDate(ctx, repo, sha);
  }
  return {
    schema: 1,
    id: artifactId,
    owner,
    owner_agent_id: owner,
    title: await repoTitle(ctx, repo, artifactId),
    format: entry ? formatFor(entry) : "file",
    status,
    entry,
    filename: entry ? basename(entry) : "",
    created_at: createdAt,
    updated_at: updatedAt,
    version: current,
    current_version: current,
    repo_path: repo,
  };
}

const INFO_CACHE_MAX = 256;
type InfoCacheEntry = {
  identity: string;
  key: string;
  value: Promise<RecordValue>;
  holder: string;
};
const infoCache = new Map<string, InfoCacheEntry>();

async function refStamp(path: string): Promise<string> {
  try {
    const value = await stat(path);
    return `${value.size}:${value.mtimeMs}`;
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

async function contentStamp(
  path: string,
  limit: number,
): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(ownedBytes(await readFileBounded(path, limit)))
      .digest("hex");
  } catch (error) {
    if (error instanceof ArtifactNotFound) return "missing";
    if (error instanceof ArtifactLimit || error instanceof ArtifactInvalid)
      return null;
    throw error;
  }
}

/** Portable ref/config contents validate metadata without spawning Git. */
async function cachedInfo(
  ctx: ResolvedContext,
  owner: string,
  artifactId: string,
  repo: string,
): Promise<RecordValue> {
  const gitDir = join(repo, ".git");
  const directory = await stat(gitDir);
  const identity = `${directory.dev}:${directory.ino}`;
  // Invariant: HEAD may name any branch, including nested names; check its tip.
  const headText = (
    await readFileBounded(join(gitDir, "HEAD"), MAX_MARKER_BYTES)
  )
    .toString("utf8")
    .trim();
  const headRef = headText.startsWith("ref: ") ? headText.slice(5) : "HEAD";
  if (
    headRef !== "HEAD" &&
    (!headRef.startsWith("refs/") ||
      headRef.includes("\\") ||
      headRef.includes("\0") ||
      headRef.split("/").some((part) => !part || part === "." || part === ".."))
  ) {
    throw new ArtifactCorrupt("artifact HEAD ref is invalid");
  }
  const stamps = await Promise.all([
    contentStamp(join(gitDir, headRef), MAX_MARKER_BYTES),
    contentStamp(join(gitDir, GIT_REF), MAX_MARKER_BYTES),
    contentStamp(join(gitDir, "config"), 64 * 1024),
    refStamp(join(gitDir, "packed-refs")),
  ]);
  if (stamps.includes(null)) return info(ctx, owner, artifactId, repo);
  const snapshotKey = JSON.stringify([headText, ...stamps]);
  const key = JSON.stringify([identity, snapshotKey]);
  const previous = infoCache.get(repo);
  if (previous?.key === key) {
    timingDetail("artifact_cache_holder", previous.holder);
    return { ...(await timed("artifact_cache_wait", () => previous.value)) };
  }
  const value = (async () => {
    const snapshot = join(gitDir, "recurse-info.json");
    let savedValue: RecordValue | null = null;
    try {
      const saved: unknown = JSON.parse(
        (await readFileBounded(snapshot, 64 * 1024)).toString("utf8"),
      );
      if (
        isObject(saved) &&
        isObject(saved.value) &&
        saved.value.owner === owner &&
        saved.value.id === artifactId
      ) {
        savedValue = { ...saved.value, repo_path: repo };
        if (saved.key === snapshotKey) return savedValue;
      }
    } catch (error) {
      if (!(error instanceof ArtifactNotFound))
        console.warn(
          "Artifact metadata cache could not be read; refreshing",
          repo,
        );
    }
    const old = previous?.identity === identity ? await previous.value : null;
    const result = await info(
      ctx,
      owner,
      artifactId,
      repo,
      String(old?.created_at ?? savedValue?.created_at ?? ""),
    );
    try {
      await writeFileAtomic(
        ctx,
        snapshot,
        ownedBytes(
          Buffer.from(JSON.stringify({ key: snapshotKey, value: result })),
        ),
      );
    } catch {
      console.warn("Artifact metadata cache could not be written", repo);
    }
    return result;
  })();
  const entry = { identity, key, value, holder: timingId() ?? "background" };
  infoCache.delete(repo);
  infoCache.set(repo, entry);
  while (infoCache.size > INFO_CACHE_MAX) {
    infoCache.delete(infoCache.keys().next().value!);
  }
  try {
    return { ...(await value) };
  } catch (error) {
    if (infoCache.get(repo) === entry) infoCache.delete(repo);
    throw error;
  }
}

/** Native listings need titles and paths, not publication refs or history. */
async function compactInfo(
  ctx: ResolvedContext,
  owner: string,
  artifactId: string,
  repo: string,
): Promise<RecordValue> {
  const config = await contentStamp(join(repo, ".git", "config"), 64 * 1024);
  const snapshot = join(repo, ".git", "recurse-info.json");
  let saved: RecordValue = {};
  let title: string | null = null;
  try {
    const loaded: unknown = JSON.parse(
      (await readFileBounded(snapshot, 64 * 1024)).toString("utf8"),
    );
    if (isObject(loaded)) saved = loaded;
    const cached = saved.titleSnapshot;
    if (
      config !== null &&
      isObject(cached) &&
      cached.owner === owner &&
      cached.id === artifactId &&
      cached.config === config &&
      typeof cached.title === "string"
    ) {
      title = normalizedTitle(cached.title);
    } else if (
      config !== null &&
      isObject(saved.value) &&
      saved.value.owner === owner &&
      saved.value.id === artifactId &&
      typeof saved.value.title === "string" &&
      typeof saved.key === "string"
    ) {
      const stamps: unknown = JSON.parse(saved.key);
      if (Array.isArray(stamps) && stamps[3] === config)
        title = normalizedTitle(saved.value.title);
    }
  } catch {
    // Invariant: Invalid/missing metadata only costs a bounded title lookup.
  }
  if (title === null) {
    title = await repoTitle(ctx, repo, artifactId);
    if (config !== null) {
      try {
        await writeFileAtomic(
          ctx,
          snapshot,
          ownedBytes(
            Buffer.from(
              JSON.stringify({
                ...saved,
                titleSnapshot: { owner, id: artifactId, config, title },
              }),
            ),
          ),
        );
      } catch {
        console.warn("Artifact title cache could not be written", repo);
      }
    }
  }
  return { id: artifactId, owner, title, repo_path: repo };
}

function ensure(
  ctx: ResolvedContext,
  ownerValue: string,
  idValue: string,
): Promise<string> {
  return timed("artifact_ensure", () =>
    ensureRepository(ctx, ownerValue, idValue),
  );
}

async function ensureRepository(
  ctx: ResolvedContext,
  ownerValue: string,
  idValue: string,
  refreshHook = true,
): Promise<string> {
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const root = await ownerRoot(ctx, owner);
  const marker = await readMarker(
    join(root, `.deleted-${artifactId}.json`),
    owner,
    artifactId,
  );
  if (marker !== null) throw new ArtifactNotFound("artifact not found");
  const repo = join(root, artifactId);
  try {
    const repoInfo = await lstat(repo);
    if (repoInfo.isSymbolicLink() || !repoInfo.isDirectory()) {
      throw new ArtifactCorrupt("artifact repository is invalid");
    }
    const gitInfo = await stat(join(repo, ".git"));
    if (!gitInfo.isDirectory())
      throw new ArtifactCorrupt("artifact repository is invalid");
    if (refreshHook)
      await timed("artifact_hook", () => installCommitHook(ctx, repo));
    return repo;
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    if (isMissing(error)) throw new ArtifactNotFound("artifact not found");
    throw new ArtifactCorrupt("artifact repository is invalid");
  }
}

/** Pin each directory so app state cannot follow links or resurrect a deleted repo. */
export async function withArtifactGitDirectory<T>(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  work: (gitDir: FileHandle) => Promise<T>,
): Promise<T> {
  const owner = normalizedOwner(ownerValue);
  const id = normalizedId(idValue);
  const flags = DIRECTORY_FLAGS | fsConstants.O_NOFOLLOW;
  const handles: FileHandle[] = [];
  try {
    const root = await open(value.artifactsDir, flags);
    handles.push(root);
    const parent = await openAt(root.fd, owner, flags);
    handles.push(parent);
    const deleted = await lstatAt(parent.fd, `.deleted-${id}.json`).catch(
      (error) => {
        if (!isMissing(error)) throw error;
      },
    );
    if (deleted) throw new ArtifactNotFound("artifact not found");
    const repo = await openAt(parent.fd, id, flags);
    handles.push(repo);
    const gitDir = await openAt(repo.fd, ".git", flags);
    handles.push(gitDir);
    return await work(gitDir);
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    if (isMissing(error)) throw new ArtifactNotFound("artifact not found");
    throw new ArtifactCorrupt("saved app state is unavailable");
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

const RETIRING_PREFIX = ".retiring-owner-";

function retiringOwner(ctx: ResolvedContext, owner: string): string {
  return join(
    ctx.artifactsDir,
    RETIRING_PREFIX + createHash("sha256").update(owner).digest("hex"),
  );
}

async function ownerAdmission<T>(
  ctx: ResolvedContext,
  work: () => Promise<T>,
): Promise<T> {
  await mkdir(ctx.artifactsDir, { recursive: true });
  const handle = await open(
    ctx.artifactsDir,
    DIRECTORY_FLAGS | fsConstants.O_NOFOLLOW,
  );
  try {
    const unlock = await flockExclusive(
      handle.fd,
      `${ctx.artifactsDir}:artifact-owner-admission`,
    );
    try {
      return await work();
    } finally {
      unlock();
    }
  } finally {
    await handle.close();
  }
}

async function disposableOwner(root: string, files: boolean): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.every(
    (entry) =>
      entry.isFile() &&
      (files
        ? !entry.name.startsWith(".deleted-") && entry.name !== ".git"
        : entry.name === ".revision"),
  );
}

async function retireOwner(
  ctx: ResolvedContext,
  owner: string,
  files: boolean,
): Promise<boolean> {
  const root = join(ctx.artifactsDir, owner);
  const marker = retiringOwner(ctx, owner);
  const admitted = await ownerAdmission(ctx, async () => {
    if (await pathExists(marker)) return false;
    let info: Stats;
    try {
      info = await lstat(root);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!info.isDirectory() || !(await disposableOwner(root, files)))
      return false;
    const process = await procStat(globalThis.process.pid);
    if (process.state !== "ok")
      throw new ArtifactCorrupt(
        "artifact cleanup process identity unavailable",
      );
    await writeFileAtomic(
      ctx,
      marker,
      ownedBytes(
        Buffer.from(
          JSON.stringify({
            owner,
            identity: `${info.dev}:${info.ino}`,
            files,
            pid: process.stat.pid,
            start: process.stat.startTime,
          }),
        ),
      ),
    );
    return true;
  });
  if (!admitted) return false;
  const retired = await retirePath(root, ctx.trashDir);
  await unlink(marker);
  return retired;
}

/** Recover interrupted retirements without stealing a live cleanup's fence. */
export async function recoverArtifactDirectories(
  value: ArtifactContext,
): Promise<void> {
  const ctx = context(value);
  await mkdir(ctx.artifactsDir, { recursive: true });
  for (const name of await readdir(ctx.artifactsDir)) {
    if (!name.startsWith(RETIRING_PREFIX)) continue;
    const marker = join(ctx.artifactsDir, name);
    const root = await ownerAdmission(ctx, async () => {
      let saved: unknown;
      try {
        saved = JSON.parse(
          (await readFileBounded(marker, MAX_MARKER_BYTES)).toString("utf8"),
        );
      } catch (error) {
        if (error instanceof ArtifactNotFound) return null;
        throw error;
      }
      if (
        !isObject(saved) ||
        typeof saved.owner !== "string" ||
        !saved.owner ||
        saved.owner !== basename(saved.owner) ||
        saved.owner.startsWith(".") ||
        retiringOwner(ctx, saved.owner) !== marker ||
        typeof saved.pid !== "number"
      )
        throw new ArtifactCorrupt("artifact cleanup marker is invalid");
      const ownerProcess = await procStat(saved.pid);
      if (
        ownerProcess.state === "ok" &&
        ownerProcess.stat.startTime === saved.start
      )
        return null;
      if (ownerProcess.state !== "ok" && ownerProcess.state !== "dead")
        return null;
      const candidate = join(ctx.artifactsDir, saved.owner);
      const info = await lstat(candidate).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (
        !info ||
        !info.isDirectory() ||
        `${info.dev}:${info.ino}` !== saved.identity ||
        !(await disposableOwner(candidate, saved.files === true))
      ) {
        await unlink(marker);
        return null;
      }
      const current = await procStat(process.pid);
      if (current.state !== "ok")
        throw new ArtifactCorrupt(
          "artifact cleanup process identity unavailable",
        );
      await writeFileAtomic(
        ctx,
        marker,
        ownedBytes(
          Buffer.from(
            JSON.stringify({
              ...saved,
              pid: current.stat.pid,
              start: current.stat.startTime,
            }),
          ),
        ),
      );
      return candidate;
    });
    if (root) {
      await retirePath(root, ctx.trashDir);
      await unlink(marker);
    }
  }
}

/** Retire an owner only when it has no repository or deletion receipts. */
export async function pruneEmptyOwner(
  value: ArtifactContext,
  ownerValue: string,
): Promise<boolean> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  return retireOwner(ctx, owner, false);
}

/** Retire legacy empty/non-repository roots once; preserve uncertain trees. */
export async function migrateArtifactDirectories(
  value: ArtifactContext,
): Promise<void> {
  const ctx = context(value);
  await mkdir(ctx.artifactsDir, { recursive: true });
  const marker = join(ctx.artifactsDir, ".owner-directories-v1");
  if (await pathExists(marker)) return;
  let retired = 0;
  let skippedReceipts = 0;
  let skippedDirectories = 0;
  for (const entry of await readdir(ctx.artifactsDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = join(ctx.artifactsDir, entry.name);
    const children = await readdir(root, { withFileTypes: true });
    if (children.some((child) => child.name.startsWith(".deleted-"))) {
      skippedReceipts++;
      continue;
    }
    // Invariant: Any nested directory or Git marker may contain a valid repo.
    if (children.some((child) => !child.isFile() || child.name === ".git")) {
      skippedDirectories++;
      continue;
    }
    if (await retireOwner(ctx, entry.name, true)) retired++;
  }
  await writeFileAtomic(
    ctx,
    marker,
    ownedBytes(
      Buffer.from(
        JSON.stringify({ retired, skippedReceipts, skippedDirectories }),
      ),
    ),
  );
}

/** Refresh existing repositories once after the commit publisher moved. */
export async function migrateCommitHooks(
  value: ArtifactContext,
): Promise<void> {
  const ctx = context(value);
  await mkdir(ctx.artifactsDir, { recursive: true });
  const marker = join(ctx.artifactsDir, ".commit-hooks-publish-commit-v1");
  try {
    await lstat(marker);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  for (const owner of await readdir(ctx.artifactsDir, {
    withFileTypes: true,
  })) {
    if (!owner.isDirectory() || !OWNER_RE.test(owner.name)) continue;
    const root = await ownerRoot(ctx, owner.name);
    for (const repo of await readdir(root, { withFileTypes: true })) {
      if (!repo.isDirectory() || !ID_RE.test(repo.name)) continue;
      try {
        await ensure(ctx, owner.name, repo.name);
      } catch (error) {
        if (!(error instanceof ArtifactNotFound)) throw error;
      }
    }
  }
  await writeFileAtomic(ctx, marker, ownedBytes(Buffer.from("1\n")));
}

async function installCommitHook(
  ctx: ResolvedContext,
  repo: string,
): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const path = join(repo, ".git", "hooks", "post-commit");
  const marker = "#!/bin/sh\n# Recurse Artifact: commit = publish.\n";
  const hook = `${marker}if [ "$RECURSE_ARTIFACT_COMMIT" != 1 ]; then\n  exec ${quote(process.execPath)} ${quote(join(CHECKOUT_ROOT, "src/artifacts/publish_commit.ts"))} .\nfi\n`;
  const current = await readFile(path, "utf8").catch((error) => {
    if (isMissing(error)) return "";
    throw error;
  });
  if (current === hook) return;
  if (current && !current.startsWith(marker))
    throw new ArtifactConflict(
      "Artifact post-commit hook already exists; preserve it before enabling automatic publication",
    );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, hook, { mode: 0o700 });
  await chmod(path, 0o700);
  await git(ctx, repo, ["config", "core.hooksPath", ".git/hooks"]);
  await excludeInstalls(repo);
}

function newId(ctx: ResolvedContext, title: string): string {
  const slug =
    title
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "artifact";
  return `${slug}-${ctx.ids().slice(0, 12)}`;
}

async function readSource(
  source: string,
  limit: number,
): Promise<[string, Buffer]> {
  const name = basename(source);
  let safeName: string;
  try {
    safeName = safeRel(name);
  } catch {
    throw new ArtifactInvalid("artifact source filename is unsafe");
  }
  return [safeName, await readFileBounded(source, limit)];
}

export async function create(
  value: ArtifactContext,
  options: { owner: string; title: string; source?: string | null },
): Promise<RecordValue> {
  const ctx = context(value);
  const owner = normalizedOwner(options.owner);
  const title = normalizedTitle(options.title);
  const sourceName =
    options.source === undefined || options.source === null
      ? null
      : sourceEntry(ctx, options.source);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const artifactId = newId(ctx, title);
    let repo: string;
    try {
      repo = await ownerAdmission(ctx, async () => {
        if (await pathExists(retiringOwner(ctx, owner)))
          throw new ArtifactConflict(
            "artifact owner cleanup is pending; retry after cleanup",
          );
        const root = await ownerRoot(ctx, owner, true);
        const candidate = join(root, artifactId);
        await mkdir(candidate, { mode: 0o700 });
        return candidate;
      });
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactCorrupt("artifact repository could not be created");
    }
    await initRepo(ctx, repo);
    await git(ctx, repo, ["config", TITLE_CONFIG_KEY, title]);
    if (options.source !== undefined && options.source !== null) {
      const [, data] = await readSource(options.source, WIRE_MAX_BYTES);
      await writeFileAtomic(ctx, join(repo, sourceName!), ownedBytes(data));
    }
    const sha = await commit(ctx, repo, "Create artifact");
    if (sha !== null) await publishCommit(ctx, repo, sha);
    await changed(ctx, owner);
    return get(ctx, owner, artifactId);
  }
  throw new ArtifactConflict("could not allocate an artifact id");
}

export async function publish(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  options: {
    expected?: string | null;
    /** The post-commit hook publishes HEAD without staging workspace edits. */
    committed?: boolean;
    // Receive a newly published app page/map, not documents or built versions.
    onBuild?: (build: AppPage) => void;
  } = {},
): Promise<RecordValue> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const repo = await ensure(ctx, owner, artifactId);
  const current = await published(ctx, repo, false);
  expectVersion(current, options.expected);
  await excludeInstalls(repo);
  const sha = options.committed
    ? await head(ctx, repo)
    : await commit(ctx, repo, "Publish artifact");
  if (sha === null)
    throw new ArtifactInvalid("artifact workspace is empty; write files first");
  const build = await publishCommit(
    ctx,
    repo,
    sha,
    options.expected,
    options.onBuild !== undefined,
  );
  if (current !== sha) await changed(ctx, owner);
  if (build) options.onBuild?.(build);
  return get(ctx, owner, artifactId);
}

/**
 * The name a create source is stored under: index.md for Markdown and
 * index.html for HTML, so the new Artifact is a document or an app.
 */
function sourceEntry(ctx: ResolvedContext, source: string): string {
  const name = basename(source);
  if (ctx.anyKind) return name;
  const format = FORMAT_SUFFIXES[extname(name).toLowerCase()];
  if (format === "markdown") return DOCUMENT_ENTRY;
  if (format === "html") return APP_ENTRY;
  throw new ArtifactInvalid(
    `a new Artifact starts from a Markdown (.md) or HTML (.html) file, not ${JSON.stringify(name)}`,
  );
}

/** Check the kind, build an app, then move the published ref to `sha`. */
async function publishCommit(
  ctx: ResolvedContext,
  repo: string,
  sha: string,
  expected?: string | null,
  sourceMap = false,
): Promise<AppPage | null> {
  const rows = await tree(ctx, repo, sha);
  if (!ctx.anyKind && artifactKind(rows) === null)
    throw new ArtifactInvalid(
      `an Artifact needs ${DOCUMENT_ENTRY} (a document) or ${APP_ENTRY} (an app) at the top level`,
    );
  const build =
    detectEntry(rows) === APP_ENTRY
      ? await recordBuild(ctx, repo, sha, rows, sourceMap)
      : null;
  await publishRef(ctx, repo, sha, expected);
  return build;
}

/** Installed packages are build input, never Artifact history. */
async function excludeInstalls(repo: string): Promise<void> {
  const path = join(repo, ".git", "info", "exclude");
  const text = await readFile(path, "utf8").catch(() => "");
  if (text.split("\n").includes("node_modules/")) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${text.replace(/\n?$/u, "\n")}node_modules/\n`);
}

/** Build an app from validated tree rows, reading each file's Git blob. */
async function buildTree(
  ctx: ResolvedContext,
  repo: string,
  rows: readonly TreeRow[],
  sourceMap = false,
): Promise<AppPage> {
  const blobs = new Map(
    rows
      .filter(([name]) => name !== ".artifact.json")
      .map(([name, blobSha]) => [name, blobSha]),
  );
  const built = await buildPage(
    [...blobs.keys()],
    (path) =>
      blob(ctx, repo, blobs.get(path)!, WIRE_MAX_BYTES).then(ownedBytes),
    { maxBytes: WIRE_MAX_BYTES, sourceMap },
  );
  if (!built.ok) throw new ArtifactBuild(built.log);
  return built;
}

// Build committed validated blobs before publication; a concurrent build
// for the same version is equally valid.
async function recordBuild(
  ctx: ResolvedContext,
  repo: string,
  sha: string,
  rows: readonly TreeRow[],
  sourceMap = false,
): Promise<AppPage | null> {
  const ref = `${GIT_BUILDS}${sha}`;
  const recorded = () =>
    git(ctx, repo, ["rev-parse", "--verify", "-q", `${ref}^{blob}`], {
      check: false,
    }).then((result) => result.returncode === 0);
  if (await recorded()) return null;
  const built = await buildTree(ctx, repo, rows, sourceMap);
  const page = join(repo, ".git", `recurse-page-${randomUUID()}.html`);
  try {
    await writeFile(page, ownedBytes(built.html));
    const hashed = await git(ctx, repo, ["hash-object", "-w", page]);
    const blobSha = decode(hashed.stdout).trim();
    if (!FULL_SHA_RE.test(blobSha))
      throw new ArtifactCorrupt("artifact build could not be stored");
    if (!(await createRef(ctx, repo, ref, blobSha, recorded)))
      throw new ArtifactCorrupt("artifact build could not be stored");
    return built;
  } finally {
    await unlink(page).catch(() => undefined);
  }
}

/**
 * The page the Artifacts pane runs for a version: its recorded app build, or
 * the raw HTML entry of a version published before apps were built.
 */
export async function pageBytes(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  options: { version?: string | null } = {},
): Promise<Buffer> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const repo = await ensure(ctx, owner, artifactId);
  const selected =
    options.version === null || options.version === undefined
      ? (await published(ctx, repo))!
      : await resolveVersion(ctx, repo, options.version);
  const built = await git(
    ctx,
    repo,
    ["rev-parse", "--verify", "-q", `${GIT_BUILDS}${selected}^{blob}`],
    { check: false },
  );
  const blobSha = decode(built.stdout).trim();
  if (built.returncode === 0 && FULL_SHA_RE.test(blobSha))
    return blob(ctx, repo, blobSha, WIRE_MAX_BYTES);
  const entry = detectEntry(await tree(ctx, repo, selected));
  if (!entry || mediaForName(entry) !== "text/html")
    throw new ArtifactNotFound("artifact has no page");
  return (
    await fileBytes(ctx, owner, artifactId, entry, { version: selected })
  )[1];
}

export async function rename(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  titleValue: string,
): Promise<RecordValue> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const title = normalizedTitle(titleValue);
  const repo = await ensure(ctx, owner, artifactId);
  await git(ctx, repo, ["config", TITLE_CONFIG_KEY, title]);
  return get(ctx, owner, artifactId);
}

export async function get(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
): Promise<RecordValue> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const repo = await ensure(ctx, owner, artifactId);
  return timed("artifact_metadata", () =>
    cachedInfo(ctx, owner, artifactId, repo),
  );
}

export async function resolveOwner(
  value: ArtifactContext,
  idValue: string,
): Promise<string> {
  const ctx = context(value);
  const artifactId = normalizedId(idValue);
  let rootInfo;
  try {
    rootInfo = await stat(ctx.artifactsDir);
  } catch (error) {
    if (isMissing(error)) throw new ArtifactNotFound("artifact not found");
    throw error;
  }
  if (!rootInfo.isDirectory()) {
    throw new ArtifactNotFound("artifact not found");
  }
  for (const name of await readdir(ctx.artifactsDir)) {
    if (!OWNER_RE.test(name)) continue;
    const candidate = join(ctx.artifactsDir, name);
    try {
      const ownerInfo = await lstat(candidate);
      if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink()) continue;
      const repo = join(candidate, artifactId);
      const repoInfo = await stat(repo);
      if (!repoInfo.isDirectory()) continue;
      await ensureRepository(ctx, name, artifactId, false);
      return name;
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      if (isMissing(error)) continue;
      throw error;
    }
  }
  throw new ArtifactNotFound("artifact not found");
}

export async function listArtifacts(
  value: ArtifactContext,
  ownerValue: string | null,
  options: {
    status?: string | null;
    limit?: number | boolean | null;
    compact?: boolean;
  } = {},
): Promise<{ artifacts: RecordValue[] }> {
  const ctx = context(value);
  const owner = ownerValue === null ? null : normalizedOwner(ownerValue);
  const limit = pythonInt(
    options.limit === undefined ? LIST_MAX : options.limit,
  );
  const status = options.status ?? null;
  if (limit === null || limit < 1 || limit > LIST_MAX) {
    throw new ArtifactInvalid("invalid artifact list limit");
  }
  if (status !== null && status !== "draft" && status !== "ready") {
    throw new ArtifactInvalid("invalid artifact status filter");
  }
  let owners = owner === null ? [] : [owner];
  if (owner === null) {
    try {
      const root = await stat(ctx.artifactsDir);
      if (root.isDirectory()) {
        owners = (await readdir(ctx.artifactsDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && OWNER_RE.test(entry.name))
          .map((entry) => entry.name)
          .sort(codePointCompare);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const rows: RecordValue[] = [];
  for (const selected of owners) {
    let root: string;
    try {
      root = await ownerRoot(ctx, selected);
    } catch (error) {
      if (error instanceof ArtifactNotFound) continue;
      throw error;
    }
    for (const name of (await timed("artifact_scan", () => readdir(root))).sort(
      codePointCompare,
    )) {
      if (rows.length >= limit) return { artifacts: rows };
      if (!ID_RE.test(name)) continue;
      try {
        const itemInfo = await lstat(join(root, name));
        if (!itemInfo.isDirectory() || itemInfo.isSymbolicLink()) continue;
        const repo = await ensureRepository(ctx, selected, name, false);
        const item: RecordValue = await timed("artifact_metadata", () =>
          options.compact && status === null
            ? compactInfo(ctx, selected, name, repo)
            : cachedInfo(ctx, selected, name, repo),
        );
        if (status === null || item.status === status)
          rows.push(
            options.compact
              ? {
                  id: item.id,
                  owner: item.owner,
                  title: item.title,
                  repo_path: item.repo_path,
                }
              : item,
          );
      } catch (error) {
        if (error instanceof ArtifactNotFound) continue;
        throw error;
      }
    }
  }
  return { artifacts: rows };
}

export async function fileBytes(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  pathValue: string,
  options: { version?: string | null; download?: boolean } = {},
): Promise<[RecordValue, Buffer]> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const rel = safeRel(pathValue);
  const repo = await ensure(ctx, owner, artifactId);
  const current = (await published(ctx, repo))!;
  const selected =
    options.version === null || options.version === undefined
      ? current
      : await resolveVersion(ctx, repo, options.version);
  const rows = await tree(ctx, repo, selected);
  const match = rows.find(
    ([name, , , kind]) => name === rel && kind === "blob",
  );
  if (!match) throw new ArtifactNotFound("artifact file not found");
  const data = await blob(ctx, repo, match[1], WIRE_MAX_BYTES);
  const media = mediaForName(rel, !(options.download ?? false));
  const meta: RecordValue = {
    id: artifactId,
    owner,
    path: rel,
    filename: basename(rel),
    version: selected,
    current_version: current,
    size_bytes: data.byteLength,
    media_type: media,
  };
  return [meta, data];
}

export async function versions(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  limit: number | boolean | null = HISTORY_MAX,
): Promise<{ versions: RecordValue[] }> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const pageLimit = pythonInt(limit);
  if (pageLimit === null || pageLimit < 1 || pageLimit > HISTORY_MAX) {
    throw new ArtifactInvalid("invalid artifact history limit");
  }
  const repo = await ensure(ctx, owner, artifactId);
  const current = (await published(ctx, repo))!;
  const metadata = await versionMetadata(ctx, repo);
  const values = [
    current,
    ...Object.keys(metadata).filter((item) => item !== current),
  ];
  return {
    versions: values.slice(0, pageLimit).map((version) => ({
      version,
      status: "ready",
      created_at: metadata[version]![0],
      message: metadata[version]![1],
    })),
  };
}

export async function restore(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  versionValue: string,
  expected?: string | null,
): Promise<RecordValue> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const repo = await ensure(ctx, owner, artifactId);
  const current = (await published(ctx, repo))!;
  const target = await resolveVersion(ctx, repo, versionValue);
  expectVersion(current, expected);
  await publishRef(ctx, repo, target, current);
  if (current !== target) await changed(ctx, owner);
  return get(ctx, owner, artifactId);
}

function deletionResult(value: RecordValue, already: boolean): RecordValue {
  return {
    id: value.id,
    owner_agent_id: value.owner_agent_id,
    title: value.title,
    version: value.version,
    deletion_id: value.deletion_id,
    deleted: true,
    already_deleted: already,
    notification_pending: Boolean(value.notification_pending ?? true),
  };
}

export async function deleteArtifact(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  expected: string,
): Promise<RecordValue> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const root = await ownerRoot(ctx, owner);
  const markerFile = join(root, `.deleted-${artifactId}.json`);
  const marker = await readMarker(markerFile, owner, artifactId);
  const repo = join(root, artifactId);
  if (marker !== null && !(await pathExists(repo)))
    return deletionResult(marker, true);
  const current = (await pathExists(repo))
    ? await published(ctx, repo, false)
    : null;
  expectVersion(current, expected);
  const valueToWrite: RecordValue = {
    owner_agent_id: owner,
    id: artifactId,
    title: (await pathExists(repo))
      ? await repoTitle(ctx, repo, artifactId)
      : artifactId,
    version: current ?? "",
    deletion_id: marker?.deletion_id || ctx.ids(),
    notification_pending: marker?.notification_pending ?? true,
  };
  await writeFileAtomic(
    ctx,
    markerFile,
    ownedBytes(Buffer.from(pythonJson(valueToWrite), "utf8")),
  );
  const displaced = join(root, `.deleted-${artifactId}`);
  if (await pathExists(repo)) {
    try {
      const info = await lstat(displaced);
      if (!info.isDirectory())
        throw new ArtifactCorrupt("artifact deletion path is unsafe");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await renamePath(repo, displaced);
    } catch {
      throw new ArtifactCorrupt("artifact deletion could not be completed");
    }
  }
  await changed(ctx, owner);
  return deletionResult(valueToWrite, false);
}

export async function finalizeDelete(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  deletionId: string,
): Promise<boolean> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const root = await ownerRoot(ctx, owner);
  const markerFile = join(root, `.deleted-${artifactId}.json`);
  const marker = await readMarker(markerFile, owner, artifactId);
  if (marker === null || marker.finalized) return false;
  if (marker.deletion_id !== deletionId) return false;
  const displaced = join(root, `.deleted-${artifactId}`);
  if (await pathExists(displaced)) {
    try {
      await retirePath(displaced, ctx.trashDir);
    } catch {
      throw new ArtifactCorrupt("artifact cleanup is pending");
    }
  }
  marker.notification_pending = false;
  marker.finalized = true;
  await writeFileAtomic(
    ctx,
    markerFile,
    ownedBytes(Buffer.from(pythonJson(marker), "utf8")),
  );
  return true;
}

export async function recoverableDeletions(
  value: ArtifactContext,
): Promise<RecordValue[]> {
  const ctx = context(value);
  const rows: RecordValue[] = [];
  let rootInfo;
  try {
    rootInfo = await stat(ctx.artifactsDir);
  } catch (error) {
    if (isMissing(error)) return rows;
    throw error;
  }
  if (!rootInfo.isDirectory()) return rows;
  for (const owner of await readdir(ctx.artifactsDir)) {
    if (!OWNER_RE.test(owner)) continue;
    let ownerInfo;
    try {
      ownerInfo = await lstat(join(ctx.artifactsDir, owner));
    } catch {
      continue;
    }
    if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink()) continue;
    for (const name of await readdir(join(ctx.artifactsDir, owner))) {
      if (!name.startsWith(".deleted-") || !name.endsWith(".json")) continue;
      const id = name.slice(".deleted-".length, -".json".length);
      try {
        const marker = await readMarker(
          join(ctx.artifactsDir, owner, name),
          owner,
          id,
        );
        if (marker !== null && !marker.finalized)
          rows.push(deletionResult(marker, false));
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
      }
    }
  }
  return rows;
}

export async function cancelStaleDeletion(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  deletionId: string,
): Promise<boolean> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const markerFile = await markerPath(ctx, owner, artifactId);
  const marker = await readMarker(markerFile, owner, artifactId);
  if (marker === null || marker.deletion_id !== deletionId) return false;
  marker.notification_pending = false;
  await writeFileAtomic(
    ctx,
    markerFile,
    ownedBytes(Buffer.from(pythonJson(marker), "utf8")),
  );
  return true;
}

export function mediaType(meta: RecordValue, download = false): string {
  if (download)
    return mediaForName(String(meta.filename || meta.name || "file"));
  return String(meta.media_type || "application/octet-stream");
}
