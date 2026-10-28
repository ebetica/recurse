// Atomic attachment admission and committed removal.
// Temporary blobs are not fsynced; the manifest writer closes and renames
// without fsync, and neither module fsyncs the directory.
// Files are pinned through collection descriptors and source file handles.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, extname } from "node:path";
import { lstatAt, openAt, renameAt, unlinkAt } from "../../../utils/dir_fd";
import {
  AttachmentError,
  FILE_ID_REGEX,
  RUN_ID_REGEX,
  CALL_ID_REGEX,
  MAX_FILE_BYTES,
  MEDIA_TYPE_REGEX,
  SOURCE_PUBLICATION,
  SOURCE_UPLOAD,
  SOURCES,
  UPLOAD_LIMITS,
  PUBLICATION_LIMITS,
  VERSION,
  displayName,
  inlineRasterMediaType,
  intentDigest,
  manifestBlob,
  mediaType,
  type Manifest,
  type OwnerLimits,
} from "./base";
import { publicMetadata } from "./preview";
import {
  blobName,
  cleanupDebris,
  manifestName,
  readManifest,
  withLockedCollection,
  writeAll,
  writeManifestJson,
} from "./store";

const defaultId = (): string => randomUUID().replaceAll("-", "");
export interface PublishOptions {
  limits?: OwnerLimits;
  now?: number;

  ids?: () => string;
}
function baseManifest(
  id: string,
  owner: string,
  display: string,
  size: number,
  sha256: string,
  prefix: Uint8Array,
  source: string,
  now?: number,
): Manifest {
  return {
    version: VERSION,
    id,
    owner,
    name: display,
    size,
    media_type: mediaType(display),
    inline_media_type: inlineRasterMediaType(prefix),
    sha256,
    created_at: now ?? Date.now() / 1000,
    blob: blobName(id),
    source,
  };
}
function mintUploadId(filename: string, ids: () => string): [string, string] {
  const original = Array.from(basename(filename || ""))
    .slice(0, 255)
    .join("");
  const ext = extname(original)
    .replace(/^\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16);
  const id = ids();
  return [ext ? `${id}.${ext}` : id, ext];
}
/** A failure removes its temporary blob, not a renamed final blob. */
async function writeTmpBlob(
  fd: FileHandle,
  id: string,
  readChunk: () => Uint8Array | Promise<Uint8Array>,
  maxBytes: number,
  ids: () => string,
  tooLargeMessage = `file is too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`,
): Promise<{ tmp: string; size: number; sha256: string; prefix: Uint8Array }> {
  const tmp = `.${blobName(id)}.${ids()}.tmp`;
  const output = await openAt(
    fd.fd,
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const digest = createHash("sha256");
  const prefix = new Uint8Array(16);
  let size = 0,
    prefixSize = 0;
  try {
    for (;;) {
      const chunk = await readChunk();
      if (!chunk.length) break;
      size += chunk.length;
      if (size > maxBytes) throw new AttachmentError(tooLargeMessage);
      digest.update(chunk);
      const take = Math.min(16 - prefixSize, chunk.length);
      prefix.set(chunk.subarray(0, take), prefixSize);
      prefixSize += take;
      await writeAll(output, chunk);
    }
  } catch (error) {
    await output.close();
    await unlinkAt(fd.fd, tmp).catch(() => {});
    throw error;
  }
  await output.close();
  return {
    tmp,
    size,
    sha256: digest.digest("hex"),
    prefix: prefix.subarray(0, prefixSize),
  };
}
async function prepareCollection(fd: FileHandle, owner: string): Promise<void> {
  await cleanupDebris(fd, owner);
}
/** Immediately visible authenticated browser upload. */
export async function addUpload(
  collection: string,
  owner: string,
  data: Uint8Array,
  filename: string,
  options: PublishOptions = {},
): Promise<Manifest> {
  const { limits = UPLOAD_LIMITS, now, ids = defaultId } = options;
  if (!(data instanceof Uint8Array) || !data.length)
    throw new AttachmentError("attachment upload is empty");
  if (data.length > limits.maxFileBytes)
    throw new AttachmentError(
      `file is too large (max ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB)`,
    );
  const display = displayName(basename(filename || ""));
  const [id, ext] = mintUploadId(filename, ids);
  let offset = 0;
  return await withLockedCollection(collection, async (fd) => {
    await prepareCollection(fd, owner);
    const staged = await writeTmpBlob(
      fd,
      id,
      () => {
        const chunk = data.subarray(offset, offset + 64 * 1024);
        offset += chunk.length;
        return chunk;
      },
      data.length,
      ids,
    );
    let tmp = staged.tmp;
    try {
      if (staged.size !== data.length)
        throw new AttachmentError("attachment bytes failed verification");
      await renameAt(fd.fd, tmp, fd.fd, blobName(id));
      tmp = "";
      const manifest = {
        ...baseManifest(
          id,
          owner,
          display,
          staged.size,
          staged.sha256,
          staged.prefix,
          SOURCE_UPLOAD,
          now,
        ),
        intent_sha256: "",
        run_id: null,
        tool_call_id: null,
        published: true,
      };
      await writeManifestJson(fd, manifestName(id), manifest, ids);
      return { ...publicMetadata(manifest), ext };
    } finally {
      if (tmp) await unlinkAt(fd.fd, tmp).catch(() => {});
    }
  });
}
/** Manifest unlink is the commit; a stuck blob remains for later cleanup. */
export async function removeFile(
  collection: string,
  owner: string,
  id: string,
): Promise<boolean> {
  if (!FILE_ID_REGEX.test(id || "")) return false;
  try {
    return await withLockedCollection(collection, async (fd) => {
      const manifest = await readManifest(fd, owner, id);
      if (!manifest) return false;
      const result = await removeCommittedLocked(
        fd,
        id,
        manifestBlob(manifest),
      );
      if (result === "record-failed") return false;
      return true;
    });
  } catch (error) {
    if (error instanceof AttachmentError) return false;
    throw error;
  }
}
export async function removeCommittedLocked(
  fd: FileHandle,
  id: string,
  blob: string,
): Promise<"removed" | "record-failed" | "blob-stuck"> {
  try {
    await unlinkAt(fd.fd, manifestName(id));
  } catch (error) {
    console.warn("attachment record removal failed:", String(error));
    return "record-failed";
  }
  try {
    await unlinkAt(fd.fd, blob);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("attachment blob cleanup failed:", String(error));
      return "blob-stuck";
    }
  }
  try {
    await lstatAt(fd.fd, blob);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "removed";
    throw error;
  }
  console.warn("attachment blob persists after unlink");
  return "blob-stuck";
}
export interface ImportRequest {
  fileId: string;
  name: string;
  size: number;
  sha256: string;
  created: number;
  source: string;
  published: boolean;
  readChunk: () => Uint8Array | Promise<Uint8Array>;
  runId?: string | null;
  toolCallId?: string | null;
  intentSha256?: string;
  mediaType?: string | null;
  inlineMediaType?: string | null;
  ids?: () => string;
}
function importRequest(req: ImportRequest): {
  display: string;
  media: string;
  inline: string | null;
  binding: Manifest;
} {
  if (!FILE_ID_REGEX.test(req.fileId || ""))
    throw new AttachmentError("attachment id is invalid");
  if (!SOURCES.has(req.source))
    throw new AttachmentError("attachment source is invalid");
  const display = displayName(req.name);
  if (
    (typeof req.size !== "boolean" && !Number.isInteger(req.size)) ||
    Number(req.size) <= 0
  )
    throw new AttachmentError("attachment size is invalid");
  if (typeof req.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(req.sha256))
    throw new AttachmentError("attachment checksum is invalid");
  if (
    (typeof req.created !== "number" && typeof req.created !== "boolean") ||
    !Number.isFinite(Number(req.created))
  )
    throw new AttachmentError("attachment timestamp is invalid");
  let binding: Manifest;
  if (req.source === SOURCE_PUBLICATION) {
    if (
      typeof req.runId !== "string" ||
      !RUN_ID_REGEX.test(req.runId) ||
      typeof req.toolCallId !== "string" ||
      !CALL_ID_REGEX.test(req.toolCallId)
    )
      throw new AttachmentError("attachments require a valid Pi tool call");
    if (!/^[0-9a-f]{64}$/.test(req.intentSha256 ?? ""))
      throw new AttachmentError("attachment intent is invalid");
    binding = {
      intent_sha256: req.intentSha256!,
      run_id: req.runId!,
      tool_call_id: req.toolCallId!,
    };
  } else {
    if ((req.intentSha256 ?? "") !== "")
      throw new AttachmentError("attachment intent is invalid");
    binding = { intent_sha256: "", run_id: null, tool_call_id: null };
  }
  const media =
    req.mediaType && MEDIA_TYPE_REGEX.test(req.mediaType)
      ? req.mediaType
      : mediaType(display);
  const inline =
    req.inlineMediaType &&
    Object.values({
      png: "image/png",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    }).includes(req.inlineMediaType)
      ? req.inlineMediaType
      : null;
  return { display, media, inline, binding };
}
/** Import an existing file, resuming by (id, checksum). */
export async function importFile(
  collection: string,
  owner: string,
  req: ImportRequest,
): Promise<Manifest> {
  const { display, media, inline, binding } = importRequest(req);
  return withLockedCollection(collection, async (fd) => {
    await cleanupDebris(fd, owner);
    let present = false;
    try {
      await lstatAt(fd.fd, manifestName(req.fileId));
      present = true;
    } catch {}
    const existing = await readManifest(fd, owner, req.fileId);
    if (existing) {
      if (
        Number(existing.size) === Number(req.size) &&
        existing.sha256 === req.sha256 &&
        (existing.source ?? SOURCE_PUBLICATION) === req.source
      )
        return publicMetadata(existing);
      throw new AttachmentError("attachment id already exists");
    }
    if (present) throw new AttachmentError("attachment manifest is corrupt");
    const staged = await writeTmpBlob(
      fd,
      req.fileId,
      req.readChunk,
      Number(req.size),
      req.ids ?? defaultId,
      "attachment source exceeds its recorded size",
    );
    let tmp = staged.tmp;
    try {
      if (staged.size !== Number(req.size) || staged.sha256 !== req.sha256)
        throw new AttachmentError("attachment bytes failed verification");
      await renameAt(fd.fd, tmp, fd.fd, blobName(req.fileId));
      tmp = "";
      const manifest = {
        ...baseManifest(
          req.fileId,
          owner,
          display,
          staged.size,
          staged.sha256,
          staged.prefix,
          req.source,
          Number(req.created),
        ),
        media_type: media,
        inline_media_type: inline,
        ...binding,
        published: req.source === SOURCE_PUBLICATION ? !!req.published : true,
      };
      await writeManifestJson(fd, manifestName(req.fileId), manifest, req.ids);
      const stored = await readManifest(fd, owner, req.fileId);
      if (!stored || stored.sha256 !== req.sha256)
        throw new AttachmentError("attachment bytes failed verification");
      return publicMetadata(stored);
    } finally {
      if (tmp) await unlinkAt(fd.fd, tmp).catch(() => {});
    }
  });
}
function stageRequest(source: string, name?: string | null): [string, string] {
  if (typeof source !== "string" || !source)
    throw new AttachmentError("attachment path is required");
  const intent = intentDigest(
    name == null ? { path: source } : { path: source, name },
  );
  if (intent === null)
    throw new AttachmentError("attachment parameters are invalid");
  return [displayName(name ?? basename(source)), intent];
}
async function openedSource(
  source: string,
  workdir: string,
): Promise<{ fd: FileHandle; size: number }> {
  let fd: FileHandle;
  try {
    fd = await open(
      isAbsolute(source) ? source : join(workdir, source),
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "No such file or directory"
        : code === "EACCES"
          ? "Permission denied"
          : code === "EISDIR"
            ? "Is a directory"
            : (error as Error).message;
    throw new AttachmentError(`cannot open ${source}: ${reason}`);
  }
  try {
    const info = await fd.stat();
    if (!info.isFile())
      throw new AttachmentError("source must be a regular file");
    if (info.size > MAX_FILE_BYTES)
      throw new AttachmentError(
        `file is too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB)`,
      );
    return { fd, size: info.size };
  } catch (error) {
    await fd.close();
    throw error;
  }
}
/** Refuse a publication over the per-minute limit, counted from manifests. */
function admitPublishRate(
  manifests: Manifest[],
  limits: OwnerLimits,
  now: number,
): void {
  const limit = limits.publishesPerMinute;
  if (limit === undefined) return;
  let recent = 0;
  for (const manifest of manifests)
    if (
      (manifest.source ?? SOURCE_PUBLICATION) === SOURCE_PUBLICATION &&
      Number(manifest.created_at) > now - 60
    )
      recent += 1;
  if (recent >= limit)
    throw new AttachmentError(
      `publish limit reached: at most ${limit} files per minute per conversation; try again in a minute`,
    );
}
// Replayed publications return the committed file. Multi-file calls match
// source intent too, so each path/name pair is admitted once per call.
export async function registerFile(
  collection: string,
  owner: string,
  runId: string,
  toolCallId: string,
  source: string,
  workdir: string,
  options: PublishOptions & {
    name?: string | null;
    manyPerCall?: boolean;
  } = {},
): Promise<Manifest> {
  if (typeof runId !== "string" || !RUN_ID_REGEX.test(runId))
    throw new AttachmentError("attachments require an active agent turn");
  if (typeof toolCallId !== "string" || !CALL_ID_REGEX.test(toolCallId))
    throw new AttachmentError("attachments require a valid Pi tool call");
  const { limits = PUBLICATION_LIMITS, now, ids = defaultId } = options;
  const [display, sourceIntent] = stageRequest(source, options.name);
  const { fd: sourceFd, size } = await openedSource(source, workdir);
  try {
    if (size <= 0) throw new AttachmentError("attachment source is empty");
    if (size > limits.maxFileBytes)
      throw new AttachmentError(
        `file is too large (max ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB)`,
      );
    return await withLockedCollection(collection, async (fd) => {
      const manifests = await cleanupDebris(fd, owner);
      const old = manifests.find(
        (manifest) =>
          manifest.run_id === runId &&
          manifest.tool_call_id === toolCallId &&
          (!options.manyPerCall || manifest.intent_sha256 === sourceIntent),
      );
      if (old) return publicMetadata(old);
      const created = now ?? Date.now() / 1000;
      admitPublishRate(manifests, limits, created);
      const id = ids();
      const staged = await writeTmpBlob(
        fd,
        id,
        async () => {
          const chunk = new Uint8Array(64 * 1024);
          const { bytesRead } = await sourceFd.read(
            chunk,
            0,
            chunk.length,
            null,
          );
          return chunk.subarray(0, bytesRead);
        },
        size,
        ids,
        "source grew beyond the attachment size limit",
      );
      let tmp = staged.tmp;
      try {
        if (staged.size !== size)
          throw new AttachmentError(
            "source changed while it was being attached",
          );
        await renameAt(fd.fd, tmp, fd.fd, blobName(id));
        tmp = "";
        const manifest = {
          ...baseManifest(
            id,
            owner,
            display,
            staged.size,
            staged.sha256,
            staged.prefix,
            SOURCE_PUBLICATION,
            created,
          ),
          intent_sha256: sourceIntent,
          run_id: runId,
          tool_call_id: toolCallId,
          published: true,
        };
        await writeManifestJson(fd, manifestName(id), manifest, ids);
        return publicMetadata(manifest);
      } finally {
        if (tmp) await unlinkAt(fd.fd, tmp).catch(() => {});
      }
    });
  } finally {
    await sourceFd.close();
  }
}
