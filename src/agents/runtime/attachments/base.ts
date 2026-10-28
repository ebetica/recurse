// Shared attachment shapes, budgets and name/media helpers; MIME uses
// media_types.
// JSON cannot distinguish integral floats, so manifestSize accepts both.

import { createHash } from "node:crypto";
import { guessType } from "../../../media_types";

export type Manifest = Record<string, string | number | boolean | null>;

export const VERSION = 1;
/** Largest stored file: the publication cap. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Uploads stay smaller: the upload route holds the whole body in memory. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_NAME_CHARS = 180;
export const MAX_MANIFEST_BYTES = 8192;
export const SOURCE_UPLOAD = "upload";
export const SOURCE_PUBLICATION = "publication";
export const SOURCES: ReadonlySet<string> = new Set([
  SOURCE_UPLOAD,
  SOURCE_PUBLICATION,
]);

const END = "(?![\\s\\S])";
export const RUN_ID_REGEX = new RegExp(
  `^(?:[0-9a-f]{32}|legacy:(?:running|[0-9]+(?:\\.[0-9]+)?))${END}`,
);
export const FILE_ID_REGEX = new RegExp(
  `^[0-9a-f]{32}(?:\\.[a-z0-9]{1,16})?${END}`,
);
export const ATTACHMENT_REFERENCE_REGEX =
  /\/api\/(?:conversations\/[A-Za-z0-9_-]+\/attachments|attachments)\/([^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000)"'<>]+)/;
export const DRAFT_ATTACHMENT_REGEX =
  /\/api\/attachment-drafts\/[a-f0-9]{32}\/([^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000)"'<>]+)/;
export const ID_REGEX = new RegExp(`^[0-9a-f]{32}${END}`);
export const CALL_ID_REGEX = new RegExp(`^[\\x21-\\x7e]{1,256}${END}`);
export const MEDIA_TYPE_REGEX = new RegExp(
  `^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+${END}`,
);

export const INLINE_RASTER_TYPES = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
});

// Preview media types; serving requires nosniff and a script-free sandbox CSP.
export const INLINE_MEDIA_TYPES: Readonly<Record<string, string>> =
  Object.freeze({
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mov: "video/quicktime",
  });

/** Inline media type for a filename listed in INLINE_MEDIA_TYPES, else null. */
export function inlineMediaType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(INLINE_MEDIA_TYPES, ext)
    ? INLINE_MEDIA_TYPES[ext]!
    : null;
}

/** Error for unsafe publication requests or attachment storage limits. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** The requested owner-scoped attachment is unavailable. */
export class AttachmentNotFound extends Error {
  constructor(message = "") {
    super(message);
    this.name = "AttachmentNotFound";
  }
}

export interface OwnerLimits {
  readonly maxFileBytes: number;
  /** Publications admitted per conversation in any 60 seconds. */
  readonly publishesPerMinute?: number;
}

export const UPLOAD_LIMITS: OwnerLimits = Object.freeze({
  maxFileBytes: MAX_UPLOAD_BYTES,
});
export const PUBLICATION_LIMITS: OwnerLimits = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  publishesPerMinute: 120,
});

/** Size field from a manifest, with Python's bool-is-an-int behavior. */
export function manifestSize(manifest: Manifest): number | boolean {
  const size = manifest.size;
  if (typeof size !== "number" || !Number.isInteger(size)) {
    if (typeof size !== "boolean") {
      throw new AttachmentError("attachment manifest is corrupt");
    }
  }
  return size;
}

/** Blob leaf name from a manifest. */
export function manifestBlob(manifest: Manifest): string {
  const blob = manifest.blob;
  if (typeof blob !== "string") {
    throw new AttachmentError("attachment manifest is corrupt");
  }
  return blob;
}

const PYTHON_WHITESPACE =
  /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

function pythonLength(value: string): number {
  return Array.from(value).length;
}

function isPythonWhitespace(value: string): boolean {
  return PYTHON_WHITESPACE.test(value);
}

/** Validate and normalize one attachment display filename. */
export function displayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new AttachmentError("attachment needs a safe display filename");
  }
  const leaf = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const normalized = Array.from(leaf.normalize("NFC"))
    .filter((ch) => !/\p{C}/u.test(ch))
    .join("");
  const chars = Array.from(normalized);
  let first = 0;
  let last = chars.length;
  while (first < last && isPythonWhitespace(chars[first]!)) first += 1;
  while (last > first && isPythonWhitespace(chars[last - 1]!)) last -= 1;
  const name = chars.slice(first, last).join("");
  if (
    !name ||
    name === "." ||
    name === ".." ||
    pythonLength(name) > MAX_NAME_CHARS
  ) {
    throw new AttachmentError("attachment needs a safe display filename");
  }
  return name;
}

/** Guess the safe response media type from a filename. */
export function mediaType(name: string): string {
  const guessed = guessType(name, false)[0] ?? "application/octet-stream";
  return MEDIA_TYPE_REGEX.test(guessed)
    ? guessed.toLowerCase()
    : "application/octet-stream";
}

/** Identify a supported raster format from bytes, never from its filename. */
export function inlineRasterMediaType(data: Uint8Array): string | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return INLINE_RASTER_TYPES.png;
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return INLINE_RASTER_TYPES.jpeg;
  }
  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38 &&
    (data[4] === 0x37 || data[4] === 0x39) &&
    data[5] === 0x61
  ) {
    return INLINE_RASTER_TYPES.gif;
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return INLINE_RASTER_TYPES.webp;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hash the exact model/helper path and optional filename parameters. */
export function intentDigest(params: unknown): string | null {
  if (
    !isRecord(params) ||
    !Object.hasOwn(params, "path") ||
    typeof params.path !== "string"
  ) {
    return null;
  }
  const path = params.path;
  if (!path || pythonLength(path) > 4096) return null;
  let name: string | undefined;
  if (Object.hasOwn(params, "name")) {
    if (typeof params.name !== "string" || !params.name) return null;
    name = params.name;
    if (pythonLength(name) > 512) return null;
  }
  const value: Record<string, string> = {};
  if (name !== undefined) value.name = name;
  value.path = path;
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}
