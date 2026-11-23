// Write the receipt before displacing a repository; startup resumes unfinished deletions.
import { Buffer } from "node:buffer";
import { lstat, readdir, rename as renamePath, stat } from "node:fs/promises";
import { join } from "node:path";
import { retirePath } from "../../utils/trash-sweep";
import {
  ArtifactCorrupt,
  ArtifactError,
  OWNER_RE,
  changed,
  context,
  deletionReceiptName,
  isMissing,
  normalizedId,
  normalizedOwner,
  ownedBytes,
  ownerRoot,
  pathExists,
  readMarker,
  writeFileAtomic,
  type ArtifactContext,
  type RecordValue,
} from "./layout";
import { expectVersion, published, repoTitle } from "./refs";

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
  const markerFile = join(root, deletionReceiptName(artifactId));
  const marker = await readMarker(markerFile, owner, artifactId);
  const repo = join(root, artifactId);
  const exists = await pathExists(repo);
  if (marker !== null && !exists) return deletionResult(marker, true);
  const current = exists ? await published(ctx, repo, false) : null;
  expectVersion(current, expected);
  const valueToWrite: RecordValue = {
    owner_agent_id: owner,
    id: artifactId,
    title: exists ? await repoTitle(ctx, repo, artifactId) : artifactId,
    version: current ?? "",
    deletion_id: marker?.deletion_id || ctx.ids(),
    notification_pending: marker?.notification_pending ?? true,
  };
  await writeFileAtomic(
    ctx,
    markerFile,
    ownedBytes(Buffer.from(JSON.stringify(valueToWrite), "utf8")),
  );
  const displaced = join(root, `.deleted-${artifactId}`);
  if (exists) {
    try {
      const info = await lstat(displaced);
      if (!info.isDirectory())
        throw new ArtifactCorrupt("artifact deletion path is unsafe");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await renamePath(repo, displaced);
    } catch (error) {
      // Both paths share a parent; ENOENT means the repository is gone.
      if (!isMissing(error))
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
  const markerFile = join(root, deletionReceiptName(artifactId));
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
    ownedBytes(Buffer.from(JSON.stringify(marker), "utf8")),
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
  const markerFile = join(
    await ownerRoot(ctx, owner),
    deletionReceiptName(artifactId),
  );
  const marker = await readMarker(markerFile, owner, artifactId);
  if (marker === null || marker.deletion_id !== deletionId) return false;
  marker.notification_pending = false;
  await writeFileAtomic(
    ctx,
    markerFile,
    ownedBytes(Buffer.from(JSON.stringify(marker), "utf8")),
  );
  return true;
}
