// Descriptor-level attachment identity/locking and bounded scans, no admission.
// Leaf reads reject symlinks before/after open, including concurrent swaps.
// Manifest publication fsyncs neither the temporary file nor parent.
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  lstatAt,
  openAt,
  readdirAt,
  renameAt,
  unlinkAt,
} from "../../../utils/dir_fd";
import { flockExclusive, type FlockOptions } from "../../../utils/flock";
import {
  AttachmentError,
  CALL_ID_REGEX,
  displayName,
  FILE_ID_REGEX,
  ID_REGEX,
  INLINE_RASTER_TYPES,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MEDIA_TYPE_REGEX,
  RUN_ID_REGEX,
  SOURCE_PUBLICATION,
  SOURCE_UPLOAD,
  SOURCES,
  VERSION,
  type Manifest,
} from "./base";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const same = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino;
const hex64 = /^[0-9a-f]{64}$/;
export const manifestName = (id: string): string => `${id}.json`;
export const blobName = (id: string): string => `${id}.blob`;

/** Write the complete buffer, refusing a short write. */
export async function writeAll(
  handle: FileHandle,
  data: Uint8Array,
): Promise<void> {
  for (let offset = 0; offset < data.length; ) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
      null,
    );
    if (bytesWritten <= 0) throw new Error("short attachment write");
    offset += bytesWritten;
  }
}

/** Atomic manifest publication; intentionally no fsync. */
export async function writeManifestJson(
  ownerFd: FileHandle,
  name: string,
  value: Manifest,
  ids: () => string = () => randomUUID().replaceAll("-", ""),
): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  if (data.length > MAX_MANIFEST_BYTES)
    throw new AttachmentError("attachment metadata is too large");
  const tmp = `.${name}.${ids()}.tmp`;
  const handle = await openAt(
    ownerFd.fd,
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(handle, data);
  } finally {
    await handle.close();
  }
  try {
    await renameAt(ownerFd.fd, tmp, ownerFd.fd, name);
  } catch (error) {
    await unlinkAt(ownerFd.fd, tmp).catch(() => {});
    throw error;
  }
}

// One validated manifest; invalid, foreign, unsafe and missing leaves are
// absent.
export async function readManifest(
  ownerFd: FileHandle,
  owner: string,
  id: string,
): Promise<Manifest | null> {
  if (!FILE_ID_REGEX.test(id)) return null;
  const name = manifestName(id);
  let handle: FileHandle | undefined;
  try {
    const before = await lstatAt(ownerFd.fd, name);
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > MAX_MANIFEST_BYTES
    )
      return null;
    handle = await openAt(ownerFd.fd, name, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    const after = await lstatAt(ownerFd.fd, name);
    if (
      !opened.isFile() ||
      opened.size <= 0 ||
      opened.size > MAX_MANIFEST_BYTES ||
      !after.isFile() ||
      !same(before, opened) ||
      !same(before, after)
    )
      return null;
    const data = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        null,
      );
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const final = await handle.stat();
    if (!same(before, final) || final.size !== data.length) return null;
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
    );
    return manifestFieldsValid(value, id, owner) && validBinding(value)
      ? (value as Manifest)
      : null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

export function manifestFieldsValid(
  value: unknown,
  id: string,
  owner: string,
): value is Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const v = value as Record<string, unknown>;
  let safeName: string;
  try {
    safeName = displayName(v.name);
  } catch {
    return false;
  }
  return (
    (v.version === VERSION || v.version === true) &&
    v.id === id &&
    v.owner === owner &&
    v.blob === blobName(id) &&
    safeName === v.name &&
    ((typeof v.size === "number" && Number.isInteger(v.size)) ||
      typeof v.size === "boolean") &&
    Number(v.size) > 0 &&
    Number(v.size) <= MAX_FILE_BYTES &&
    typeof v.sha256 === "string" &&
    hex64.test(v.sha256) &&
    typeof v.media_type === "string" &&
    MEDIA_TYPE_REGEX.test(v.media_type) &&
    (v.inline_media_type == null ||
      (Object.values(INLINE_RASTER_TYPES) as string[]).includes(
        v.inline_media_type as string,
      )) &&
    (typeof v.created_at === "number" || typeof v.created_at === "boolean") &&
    Number.isFinite(Number(v.created_at)) &&
    typeof v.published === "boolean" &&
    SOURCES.has(
      (Object.hasOwn(v, "source") ? v.source : SOURCE_PUBLICATION) as string,
    )
  );
}

export function validBinding(value: Manifest): boolean {
  if (
    (Object.hasOwn(value, "source") ? value.source : SOURCE_PUBLICATION) ===
    SOURCE_UPLOAD
  ) {
    for (const [key, pattern] of [
      ["run_id", RUN_ID_REGEX],
      ["tool_call_id", CALL_ID_REGEX],
    ] as const) {
      const candidate = value[key];
      if (
        candidate != null &&
        (typeof candidate !== "string" || !pattern.test(candidate))
      )
        return false;
    }
    return (
      value.intent_sha256 === "" ||
      (typeof value.intent_sha256 === "string" &&
        hex64.test(value.intent_sha256))
    );
  }
  return (
    typeof value.run_id === "string" &&
    RUN_ID_REGEX.test(value.run_id) &&
    typeof value.tool_call_id === "string" &&
    CALL_ID_REGEX.test(value.tool_call_id) &&
    typeof value.intent_sha256 === "string" &&
    hex64.test(value.intent_sha256)
  );
}

/** Remove orphaned blobs and temporaries; returns the valid manifests read. */
export async function cleanupDebris(
  ownerFd: FileHandle,
  owner: string,
): Promise<Manifest[]> {
  let names: string[];
  try {
    names = await readdirAt(ownerFd.fd);
  } catch {
    return [];
  }
  const manifests = new Set<string>();
  const valid: Manifest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !FILE_ID_REGEX.test(name.slice(0, -5)))
      continue;
    const manifest = await readManifest(ownerFd, owner, name.slice(0, -5));
    if (!manifest) continue;
    manifests.add(name.slice(0, -5));
    valid.push(manifest);
  }
  for (const name of names) {
    let remove = name.startsWith(".") && name.endsWith(".tmp");
    if (name.endsWith(".blob") && FILE_ID_REGEX.test(name.slice(0, -5)))
      remove ||= !manifests.has(name.slice(0, -5));
    if (remove) {
      try {
        const info = await lstatAt(ownerFd.fd, name);
        if (info.isFile() || info.isSymbolicLink())
          await unlinkAt(ownerFd.fd, name);
      } catch {}
    }
  }
  return valid;
}

export async function existingForCall(
  ownerFd: FileHandle,
  owner: string,
  runId: string,
  toolCallId: string,
  published?: boolean,
): Promise<Manifest | null> {
  let names: string[];
  try {
    names = await readdirAt(ownerFd.fd);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || !ID_REGEX.test(name.slice(0, -5))) continue;
    const manifest = await readManifest(ownerFd, owner, name.slice(0, -5));
    if (
      manifest &&
      manifest.run_id === runId &&
      manifest.tool_call_id === toolCallId &&
      (published === undefined || manifest.published === published)
    )
      return manifest;
  }
  return null;
}

/** Open supplied, already-existing collection; caller closes the descriptor. */
export async function openCollection(collection: string): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(collection, constants.O_RDONLY | constants.O_DIRECTORY);
    if ((await handle.stat()).isDirectory()) return handle;
  } catch {}
  await handle?.close();
  throw new AttachmentError("attachment collection is unavailable");
}
export async function collectionIdentityMatches(
  collection: string,
  fd: FileHandle,
): Promise<boolean> {
  try {
    const opened = await fd.stat(),
      visible = await stat(collection);
    return opened.isDirectory() && same(opened, visible);
  } catch {
    return false;
  }
}
// Hold the collection directory's kernel flock; identity rechecked after
// acquiring.
export async function withLockedCollection<T>(
  collection: string,
  fn: (fd: FileHandle) => Promise<T>,
  options?: FlockOptions,
): Promise<T> {
  const fd = await openCollection(collection);
  let unlock: (() => void) | undefined;
  try {
    unlock = await flockExclusive(fd.fd, collection, options);
    if (!(await collectionIdentityMatches(collection, fd)))
      throw new AttachmentError("attachment collection was retired");
    return await fn(fd);
  } finally {
    try {
      unlock?.();
    } finally {
      await fd.close();
    }
  }
}

export async function iterManifests(
  fd: FileHandle,
  owner: string,
): Promise<Array<[string, Manifest]>> {
  let names: string[];
  try {
    names = await readdirAt(fd.fd);
  } catch {
    return [];
  }
  const out: Array<[string, Manifest]> = [];
  for (const name of names)
    if (name.endsWith(".json") && FILE_ID_REGEX.test(name.slice(0, -5))) {
      const manifest = await readManifest(fd, owner, name.slice(0, -5));
      if (manifest) out.push([name.slice(0, -5), manifest]);
    }
  return out;
}
