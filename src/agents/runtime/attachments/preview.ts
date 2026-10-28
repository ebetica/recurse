// Read-only validated attachment download and public metadata projection.
// Pinned no-follow blob open rejects path/symlink swaps; the opened
// descriptor outlives the collection fd.
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstatAt, openAt } from "../../../utils/dir_fd";
import {
  AttachmentNotFound,
  FILE_ID_REGEX,
  MAX_FILE_BYTES,
  SOURCE_PUBLICATION,
  type Manifest,
  manifestBlob,
} from "./base";
import {
  collectionIdentityMatches,
  openCollection,
  readManifest,
} from "./store";

const same = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino;
export async function openIn(
  fd: FileHandle,
  owner: string,
  id: string,
  maxBytes: number | null,
): Promise<{ manifest: Manifest; blob: FileHandle; opened: Stats }> {
  if (!FILE_ID_REGEX.test(id)) throw new AttachmentNotFound();
  const manifest = await readManifest(fd, owner, id);
  if (!manifest || !manifest.published) throw new AttachmentNotFound();
  let blob: FileHandle | undefined;
  try {
    const name = manifestBlob(manifest);
    const before = await lstatAt(fd.fd, name);
    if (!before.isFile()) throw new AttachmentNotFound();
    blob = await openAt(
      fd.fd,
      name,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await blob.stat();
    const after = await lstatAt(fd.fd, name);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      !same(before, opened) ||
      !same(before, after) ||
      opened.size !== manifest.size ||
      (maxBytes !== null && opened.size > Math.max(Math.trunc(maxBytes), 0))
    )
      throw new AttachmentNotFound();
    return { manifest, blob, opened };
  } catch {
    await blob?.close();
    throw new AttachmentNotFound();
  }
}
/** Caller owns and closes the returned blob descriptor. */
export async function openFile(
  collection: string,
  owner: string,
  id: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<{ blob: FileHandle; manifest: Manifest } | null> {
  let fd;
  try {
    fd = await openCollection(collection);
  } catch {
    return null;
  }
  try {
    if (!(await collectionIdentityMatches(collection, fd))) return null;
    try {
      return await openIn(fd, owner, id, maxBytes);
    } catch (error) {
      if (error instanceof AttachmentNotFound) return null;
      throw error;
    }
  } finally {
    await fd.close();
  }
}
export async function describe(
  collection: string,
  owner: string,
  id: string,
  maxBytes: number | null = null,
): Promise<Manifest | null> {
  let fd;
  try {
    fd = await openCollection(collection);
  } catch {
    return null;
  }
  try {
    if (!(await collectionIdentityMatches(collection, fd))) return null;
    try {
      const { manifest, blob } = await openIn(fd, owner, id, maxBytes);
      await blob.close();
      return publicMetadata(manifest);
    } catch (error) {
      if (error instanceof AttachmentNotFound) return null;
      throw error;
    }
  } finally {
    await fd.close();
  }
}
/** Read the whole blob from its start, checking it against the manifest. */
async function verifiedRead(
  blob: FileHandle,
  manifest: Manifest,
  keep: Uint8Array | null,
): Promise<void> {
  let remaining = (await blob.stat()).size;
  let position = 0;
  const digest = createHash("sha256");
  const buffer = new Uint8Array(64 * 1024);
  while (remaining) {
    const chunk =
      keep?.subarray(position, position + Math.min(buffer.length, remaining)) ??
      buffer.subarray(0, Math.min(buffer.length, remaining));
    const { bytesRead } = await blob.read(chunk, 0, chunk.length, position);
    if (!bytesRead) throw new AttachmentNotFound();
    digest.update(chunk.subarray(0, bytesRead));
    remaining -= bytesRead;
    position += bytesRead;
  }
  if (keep !== null && position !== keep.length) throw new AttachmentNotFound();
  if (digest.digest("hex") !== manifest.sha256) throw new AttachmentNotFound();
}
export async function readDownload(
  collection: string,
  owner: string,
  id: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<[Manifest, Uint8Array]> {
  const found = await openFile(collection, owner, id, maxBytes);
  if (!found) throw new AttachmentNotFound();
  const { blob, manifest } = found;
  try {
    const result = new Uint8Array(Number(manifest.size));
    await verifiedRead(blob, manifest, result);
    return [manifest, result];
  } finally {
    await blob.close();
  }
}

export interface OpenedDownload {
  readonly manifest: Manifest;
  readonly blob: FileHandle;
  readonly size: number;
}
// Like readDownload, but holds no bytes: the blob is checked against its
// manifest in 64 KiB reads and handed back open, to be served from the same
// descriptor.
export async function openDownload(
  collection: string,
  owner: string,
  id: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<OpenedDownload> {
  const found = await openFile(collection, owner, id, maxBytes);
  if (!found) throw new AttachmentNotFound();
  const { blob, manifest } = found;
  try {
    await verifiedRead(blob, manifest, null);
    return { manifest, blob, size: Number(manifest.size) };
  } catch (error) {
    await blob.close();
    throw error;
  }
}
export function publicMetadata(manifest: Manifest): Manifest {
  return {
    id: manifest.id,
    name: manifest.name,
    size: manifest.size,
    media_type: manifest.media_type,
    inline_media_type: manifest.inline_media_type ?? null,
    source: Object.hasOwn(manifest, "source")
      ? manifest.source
      : SOURCE_PUBLICATION,
  };
}
