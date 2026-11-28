// Owner-scoped Git Artifacts publish immutable versions via a CAS ref update.
// Git work is bounded/async; tree polls read revision markers, never history.
// Create/publish require document/app trees; older shapes remain readable.
// Saved app state lives outside the refs; see artifacts/README.md.

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildPage } from "./artifacts/page/index";
import {
  APP_ENTRY,
  DOCUMENT_ENTRY,
  ArtifactBuild,
  ArtifactConflict,
  ArtifactCorrupt,
  ArtifactError,
  ArtifactInvalid,
  ArtifactNotFound,
  FULL_SHA_RE,
  GIT_BUILDS,
  HISTORY_MAX,
  TITLE_CONFIG_KEY,
  artifactKind,
  blob,
  cachedInfo,
  changed,
  commit,
  context,
  createRef,
  createRepositoryDirectory,
  decode,
  deleteArtifact,
  detectEntry,
  errorCode,
  excludeInstalls,
  expectVersion,
  finalizeDelete,
  git,
  head,
  initRepo,
  mediaForName,
  normalizedId,
  normalizedOwner,
  normalizedTitle,
  openRepository,
  openRepositoryWithHook,
  ownedBytes,
  publishRef,
  published,
  pythonInt,
  readFileBounded,
  resolveOwner,
  resolveVersion,
  safeRel,
  sourceEntry,
  tree,
  type RecordValue,
  type ResolvedContext,
  type TreeRow,
  versionMetadata,
  writeFileAtomic,
  type ArtifactContext,
} from "./artifacts/store";
import { timed } from "./observability";

export type AppPage = { html: Buffer; sourceMap: string | null };

const WIRE_MAX_BYTES = 100 * 1024 * 1024;

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
  SVG_MEDIA_TYPE,
  cancelStaleDeletion,
  deleteArtifact,
  finalizeDelete,
  hasDeletionReceipt,
  listArtifacts,
  migrateArtifactDirectories,
  migrateCommitHooks,
  pruneEmptyOwner,
  recoverArtifactDirectories,
  recoverableDeletions,
  resolveOwner,
  revision,
} from "./artifacts/store";

interface ArtifactRemovalDeps {
  artifacts: ArtifactContext;
  mutateExternalStorage<T>(work: () => Promise<T>): Promise<T>;
  deliverPlatformNote(owner: string, text: string): Promise<unknown>;
}

/** Displace the repository, durably notify its owner, then retire it. */
export async function removeArtifact(
  deps: ArtifactRemovalDeps,
  owner: string,
  id: string,
  expected: string,
  signal?: AbortSignal,
): Promise<{ result: RecordValue; complete: boolean }> {
  const result = await deps.mutateExternalStorage(() =>
    deleteArtifact(deps.artifacts, owner, id, expected, signal),
  );
  try {
    if (result.notification_pending) {
      await deps.mutateExternalStorage(() =>
        deps.deliverPlatformNote(
          owner,
          `[Artifact deleted] “${result.title}” (id: ${result.id}, version: ${result.version}) was deleted. ` +
            "Do not recreate it unless the operator explicitly asks.",
        ),
      );
    }
    const complete = await deps.mutateExternalStorage(() =>
      finalizeDelete(deps.artifacts, owner, id, String(result.deletion_id)),
    );
    return { result, complete };
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error;
    return { result, complete: false };
  }
}

export async function removePublishedArtifact(
  deps: ArtifactRemovalDeps,
  id: string,
  signal?: AbortSignal,
): Promise<{ result: RecordValue; complete: boolean }> {
  const owner = await resolveOwner(deps.artifacts, id);
  const ctx = context(deps.artifacts);
  const repo = await openRepository(ctx, owner, id);
  const version = await published(ctx, repo, false);
  if (!version) throw new ArtifactNotFound("artifact has not been published");
  return removeArtifact(deps, owner, id, version, signal);
}

function newId(ctx: ResolvedContext, title: string): string {
  const slug =
    title
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "artifact";
  return `${slug}-${ctx.ids().slice(0, 12)}`;
}

async function readSource(source: string, limit: number): Promise<Buffer> {
  try {
    safeRel(basename(source));
  } catch {
    throw new ArtifactInvalid("artifact source filename is unsafe");
  }
  return readFileBounded(source, limit);
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
      repo = await createRepositoryDirectory(ctx, owner, artifactId);
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactCorrupt("artifact repository could not be created");
    }
    await initRepo(ctx, repo);
    await git(ctx, repo, ["config", TITLE_CONFIG_KEY, title]);
    if (options.source !== undefined && options.source !== null) {
      const data = await readSource(options.source, WIRE_MAX_BYTES);
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
  const repo = await openRepositoryWithHook(ctx, owner, artifactId);
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
  const repo = await openRepositoryWithHook(ctx, owner, artifactId);
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
  const repo = await openRepositoryWithHook(ctx, owner, artifactId);
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
  const repo = await openRepositoryWithHook(ctx, owner, artifactId);
  return timed("artifact_metadata", () =>
    cachedInfo(ctx, owner, artifactId, repo),
  );
}

/** Match an owner’s published Git tree, never a working-tree path or symlink. */
export async function fileBytes(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  pathValue: string,
  options: { version?: string | null; download?: boolean } = {},
): Promise<[RecordValue & { media_type: string }, Buffer]> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const rel = safeRel(pathValue);
  const repo = await openRepositoryWithHook(ctx, owner, artifactId);
  const current = (await published(ctx, repo))!;
  const selected =
    options.version === null || options.version === undefined
      ? current
      : await resolveVersion(ctx, repo, options.version);
  const rows = await tree(ctx, repo, selected);
  const match = rows.find(([name]) => name === rel);
  if (!match) throw new ArtifactNotFound("artifact file not found");
  const data = await blob(ctx, repo, match[1], WIRE_MAX_BYTES);
  const meta = {
    id: artifactId,
    owner,
    path: rel,
    filename: basename(rel),
    version: selected,
    current_version: current,
    size_bytes: data.byteLength,
    media_type: mediaForName(rel, !(options.download ?? false)),
  };
  return [meta, data];
}

export async function versions(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  limit: number | null = HISTORY_MAX,
): Promise<{ versions: RecordValue[] }> {
  const ctx = context(value);
  const owner = normalizedOwner(ownerValue);
  const artifactId = normalizedId(idValue);
  const pageLimit = pythonInt(limit);
  if (pageLimit === null || pageLimit < 1 || pageLimit > HISTORY_MAX) {
    throw new ArtifactInvalid("invalid artifact history limit");
  }
  const repo = await openRepositoryWithHook(ctx, owner, artifactId);
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
  const repo = await openRepositoryWithHook(ctx, owner, artifactId);
  const current = (await published(ctx, repo))!;
  const target = await resolveVersion(ctx, repo, versionValue);
  expectVersion(current, expected);
  await publishRef(ctx, repo, target, current);
  if (current !== target) await changed(ctx, owner);
  return get(ctx, owner, artifactId);
}
