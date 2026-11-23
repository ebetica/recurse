// Saved app state is one bounded JSON file in the owner's pinned Git directory.
// Atomic replacements never touch the working tree or publish a version.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import {
  ArtifactCorrupt,
  ArtifactError,
  ArtifactInvalid,
  ArtifactLimit,
  ArtifactNotFound,
  DIRECTORY_FLAGS,
  deletionReceiptName,
  isMissing,
  normalizedId,
  normalizedOwner,
  type ArtifactContext,
} from "./artifacts/store";
import {
  APP_STATE_INVALID,
  APP_STATE_MAX_BYTES,
  APP_STATE_TOO_LARGE,
} from "./artifact_app_state_protocol";
import { lstatAt, openAt, renameAt, unlinkAt } from "./utils";

const FILE = "recurse-app-state.json";
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Pin each directory so app state cannot follow links or resurrect a deleted repo. */
async function withArtifactGitDirectory<T>(
  value: ArtifactContext,
  ownerValue: string,
  idValue: string,
  work: (gitDir: FileHandle) => Promise<T>,
): Promise<T> {
  const owner = normalizedOwner(ownerValue);
  const id = normalizedId(idValue);
  const flags = DIRECTORY_FLAGS | constants.O_NOFOLLOW;
  const handles: FileHandle[] = [];
  try {
    const root = await open(value.artifactsDir, flags);
    handles.push(root);
    const parent = await openAt(root.fd, owner, flags);
    handles.push(parent);
    const deleted = await lstatAt(parent.fd, deletionReceiptName(id)).catch(
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

function stateJson(bytes: Uint8Array): string {
  if (bytes.byteLength > APP_STATE_MAX_BYTES)
    throw new ArtifactLimit(APP_STATE_TOO_LARGE);
  try {
    const json = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    JSON.parse(json);
    return json;
  } catch {
    throw new ArtifactInvalid(APP_STATE_INVALID);
  }
}

async function readStateBytes(
  handle: FileHandle,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1)
      throw new ArtifactInvalid("Saved app state requires a regular file");
    if (info.size > APP_STATE_MAX_BYTES)
      throw new ArtifactLimit(APP_STATE_TOO_LARGE);
    const bytes = new Uint8Array(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > info.size)
      throw new ArtifactInvalid("Saved app state changed while reading");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readAppStateFile(
  path: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return readStateBytes(await open(path, READ_FLAGS));
}

export function readAppState(
  ctx: ArtifactContext,
  owner: string,
  id: string,
): Promise<string> {
  return withArtifactGitDirectory(ctx, owner, id, async ({ fd }) => {
    const handle = await openAt(fd, FILE, READ_FLAGS).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    return handle ? stateJson(await readStateBytes(handle)) : "null";
  });
}

export async function writeAppState(
  ctx: ArtifactContext,
  owner: string,
  id: string,
  bytes: Uint8Array,
): Promise<string> {
  const json = stateJson(bytes);
  await withArtifactGitDirectory(ctx, owner, id, async (directory) => {
    const { fd } = directory;
    const temporary = `.${FILE}.${randomUUID()}.tmp`;
    const handle = await openAt(
      fd,
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameAt(fd, temporary, fd, FILE);
      await directory.sync().catch(() => {});
    } catch (error) {
      await unlinkAt(fd, temporary).catch(() => {});
      throw error;
    }
  });
  return json;
}
