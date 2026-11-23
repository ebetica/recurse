// Full and compact Artifact listings share one persisted metadata snapshot.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { timed, timingDetail, timingId } from "../../observability";
import { codePointCompare, detectEntry, formatFor } from "./formats";
import {
  ArtifactCorrupt,
  ArtifactError,
  ArtifactInvalid,
  ArtifactLimit,
  ArtifactNotFound,
  ID_RE,
  MAX_MARKER_BYTES,
  OWNER_RE,
  context,
  isMissing,
  isObject,
  normalizedId,
  normalizedOwner,
  normalizedTitle,
  openRepository,
  ownedBytes,
  ownerRoot,
  pythonInt,
  readFileBounded,
  writeFileAtomic,
  type ArtifactContext,
  type RecordValue,
  type ResolvedContext,
} from "./layout";
import {
  GIT_REF,
  commitDate,
  head,
  oldestVersionDate,
  published,
  repoTitle,
  tree,
} from "./refs";

const LIST_MAX = 100;

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
export async function cachedInfo(
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
  const [headStamp, publishedStamp, config, packedStamp] = await Promise.all([
    contentStamp(join(gitDir, headRef), MAX_MARKER_BYTES),
    contentStamp(join(gitDir, GIT_REF), MAX_MARKER_BYTES),
    contentStamp(join(gitDir, "config"), 64 * 1024),
    refStamp(join(gitDir, "packed-refs")),
  ]);
  if (headStamp === null || publishedStamp === null || config === null)
    return info(ctx, owner, artifactId, repo);
  const snapshotKey = JSON.stringify([
    headText,
    headStamp,
    publishedStamp,
    config,
    packedStamp,
  ]);
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
        if (saved.key === snapshotKey && saved.config === config)
          return savedValue;
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
          Buffer.from(
            JSON.stringify({ key: snapshotKey, config, value: result }),
          ),
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
      saved.config === config
    ) {
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
      await openRepository(ctx, name, artifactId);
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
    limit?: number | null;
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
        const repo = await openRepository(ctx, selected, name);
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
