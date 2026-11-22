// Saved app state is one bounded JSON file in the owner's pinned Git directory.
// Atomic replacements never touch the working tree or publish a version.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import {
  ArtifactInvalid,
  ArtifactLimit,
  type ArtifactContext,
  withArtifactGitDirectory,
} from "./artifacts";
import {
  APP_STATE_INVALID,
  APP_STATE_MAX_BYTES,
  APP_STATE_TOO_LARGE,
} from "./artifact_app_state_protocol";
import { openAt, renameAt, unlinkAt } from "./utils";

const FILE = "recurse-app-state.json";
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

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
