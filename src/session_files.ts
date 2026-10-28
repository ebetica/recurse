// Bounded owner-scoped accepted-file pages/previews, without history scans.
// Derive collections from Config/validated lifetime key; no-follow final paths
// and recheck after async reads. Binding/claim callbacks fail closed.

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { Config, AGENT_DRAFT_KEY_RE, AGENT_TEMP_KEY_RE } from "./config";
import * as base from "./agents/runtime/attachments/base";
import { lstatAt, openAt, readdirAt } from "./utils/dir_fd";
import {
  assistantText,
  boundaryKind,
  contentText,
  entryIdentity,
  splitPiUserText,
  type JsonObject,
  type PiTurnGroup,
} from "./agents/view/session_entries";

export type Entry = Record<string, unknown>;
export type FileRecord = Record<string, string | number | boolean>;
export type FileListEntry = Record<
  string,
  string | number | boolean | string[]
>;
export interface FilePage {
  files: FileListEntry[];
  cursor: string | null;
  generation: number;
  stale: boolean;
  done: boolean;
  capped: boolean;
  records: number;
  bytes: 0;
}
export interface TextSnippet {
  kind: "text";
  text: string;
  truncated: boolean;
  bytes: number;
}
export interface CollectionSnapshot {
  readonly collection: string;
  readonly owner: string;
  readonly temp_key: string;
}
export type Reference = [storage: string, id: string | null, fallback: Entry];
export type ReferenceProof = readonly [
  triple: readonly [
    sessionId: string,
    recordedFile: string,
    recordedCwd: string,
  ],
  offset: number,
];
export interface SessionFilesContext {
  readonly config: Config;
  /** Same exact binding check as PiBackend.boundSessionFile. */
  readonly boundSessionFile?: (
    sessionId: string,
    recordedFile: string,
    recordedCwd: string,
  ) => string | null | Promise<string | null>;
}

export const MAX_LIST_FILES = 1000;
export const MAX_REFS_PER_MESSAGE = 50_000;
export const MAX_REFERENCE_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 256 * 1024;
export const MAX_TEXT_PREVIEW_BYTES = 64 * 1024;
export const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024;

const UPLOAD_ID_RE = base.FILE_ID_REGEX;
const PUBLISHED_ID_RE = base.ID_REGEX;
const MEDIA_RE = base.MEDIA_TYPE_REGEX;
const SAFE_RASTER_EXTENSIONS: Readonly<Record<string, string>> = {
  ...base.INLINE_RASTER_TYPES,
  jpg: base.INLINE_RASTER_TYPES.jpeg,
};
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "rst",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "py",
  "pyi",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "css",
  "scss",
  "less",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "rb",
  "php",
  "pl",
  "r",
  "lua",
  "diff",
  "patch",
  "dockerfile",
  "makefile",
]);
const ACTIVE_EXTENSIONS = new Set(["html", "htm", "xhtml", "svg", "xml"]);
const ACTIVE_PREFIX =
  /^[\t\n\v\f\r ]*(?:<!doctype html|<html(?:[\t\n\v\f\r ]|>)|<svg(?:[\t\n\v\f\r ]|>)|<script(?:[\t\n\v\f\r ]|>)|<\?xml)/iu;
const PYTHON_WHITESPACE =
  /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const PI_THREAD_GENERATION_BASE = 2 ** 31;
const PAGE_DEBRIS_SLACK = 64;
const MAX_MANIFEST_BYTES = base.MAX_MANIFEST_BYTES;
const CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW | CLOEXEC;
const DIRECTORY_FLAGS = constants.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC;

type Manifest = base.Manifest & Record<string, unknown>;
type Bytes = Uint8Array<ArrayBuffer>;
function allocBytes(length: number): Bytes {
  return Buffer.allocUnsafe(length) as unknown as Bytes;
}

function byteView(value: Buffer): Bytes {
  return value as unknown as Bytes;
}

interface OpenCollection {
  readonly snapshot: CollectionSnapshot;
  readonly config: Config;
  readonly instance: FileHandle;
  readonly ownerDirectory: FileHandle;
  readonly directory: FileHandle;
}

function isObject(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pythonTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

function pythonStrip(value: string): string {
  const points = Array.from(value);
  let first = 0;
  let last = points.length;
  while (first < last && PYTHON_WHITESPACE.test(points[first]!)) first += 1;
  while (last > first && PYTHON_WHITESPACE.test(points[last - 1]!)) last -= 1;
  return points.slice(first, last).join("");
}

/** Display-safe leaf name used in file rows and preview records. */
export function safeName(value: unknown): string {
  if (typeof value !== "string") return "File";
  const leaf = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const normalized = Array.from(leaf.normalize("NFC"))
    .filter((character) => !/\p{C}/u.test(character))
    .join("");
  const name = Array.from(pythonStrip(normalized)).slice(0, 180).join("");
  return name && name !== "." && name !== ".." ? name : "File";
}

/** Last suffix after lowercasing, with the accepted make/docker names. */
export function extension(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile") return lower;
  return extname(lower).replace(/^\./u, "");
}

/** Valid fallback MIME value or the shared safe filename-based guess. */
export function mediaType(name: string, fallback?: unknown): string {
  if (typeof fallback === "string" && MEDIA_RE.test(fallback)) {
    return fallback.toLowerCase();
  }
  return base.mediaType(name);
}

function allUploadReferences(text: string): string[] {
  const regex = new RegExp(base.ATTACHMENT_REFERENCE_REGEX.source, "gu");
  return Array.from(text.matchAll(regex), (match) => match[1]!).filter(Boolean);
}

/** Upload references from one user message: ids, then content URLs. */
export function userRefs(message: Entry): Reference[] {
  const out: Reference[] = [];
  const values = message.attachment_ids;
  if (Array.isArray(values)) {
    for (const value of values.slice(0, MAX_REFS_PER_MESSAGE)) {
      if (typeof value === "string" && UPLOAD_ID_RE.test(value)) {
        out.push(["upload", value, {}]);
      }
    }
  }
  if (typeof message.content === "string") {
    for (const value of allUploadReferences(message.content)) {
      if (
        UPLOAD_ID_RE.test(value) &&
        !out.some(([, known]) => value === known)
      ) {
        out.push(["upload", value, {}]);
        if (out.length >= MAX_REFS_PER_MESSAGE) break;
      }
    }
  }
  return out;
}

/** Publication references from one assistant message, optionally resolved. */
export function assistantRefs(
  message: Entry,
  callIndex: Readonly<Record<string, Manifest>> | null = null,
): Reference[] {
  const out: Reference[] = [];
  if (Array.isArray(message.attachments)) {
    for (const item of message.attachments.slice(0, MAX_REFS_PER_MESSAGE)) {
      if (!isObject(item)) continue;
      const value = item.id;
      out.push([
        "published",
        typeof value === "string" && PUBLISHED_ID_RE.test(value) ? value : null,
        item,
      ]);
    }
  }
  const publishCalls = Array.isArray(message.publish_calls)
    ? message.publish_calls
    : [];
  for (const raw of publishCalls) {
    if (!isObject(raw)) continue;
    const callId = raw.call_id;
    const resolved =
      callIndex !== null && typeof callId === "string"
        ? callIndex[callId]
        : undefined;
    const fallback = { name: pythonTruthy(raw.path) ? raw.path : "File" };
    const resolvedId = resolved?.id;
    out.push([
      "published",
      typeof resolvedId === "string" ? resolvedId : null,
      fallback,
    ]);
    if (out.length >= MAX_REFS_PER_MESSAGE) break;
  }
  return out;
}

/** References from one projected Pi entry. */
export function refs(
  entry: Entry,
  callIndex: Readonly<Record<string, Manifest>> | null = null,
): Reference[] {
  if (!isObject(entry.message)) return [];
  if (entry.kind === "user") return userRefs(entry.message);
  if (entry.kind === "assistant")
    return assistantRefs(entry.message, callIndex);
  return [];
}

/** Scroll fence for one conversation: per-session, never a ledger era. */
export function piThreadGeneration(sessionId: string | null): number {
  if (typeof sessionId !== "string" || !sessionId) return 0;
  const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return (
    PI_THREAD_GENERATION_BASE + (Number.parseInt(digest.slice(0, 8), 16) >>> 1)
  );
}

// One Pi timestamp as epoch seconds, from a standard Pi ISO date/time string.
export function piTimestamp(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return value >= 1e11 ? value / 1000 : value;
  }
  if (typeof value !== "string" || !value) return null;
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:$|[Tt ])/u.exec(value);
  if (date === null) return null;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (year === 0) return null;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : null;
}

/** One Pi entry as a Files-pane message with structured references. */
export function piEntryMessage(entry: Entry): Entry | null {
  const kind = boundaryKind(entry as JsonObject);
  const message = entry.message;
  if (!isObject(message)) return null;
  const entryId = entryIdentity(entry as JsonObject)?.[0] ?? "";
  if (kind === "user" && message.role === "user") {
    const rendered = contentText(message.content);
    if (rendered === null) return null;
    const [, , , content] = splitPiUserText(rendered[0]);
    return {
      id: entryId ? `pi:${entryId}` : null,
      ts: piTimestamp(entry.timestamp),
      content,
    };
  }
  const text = assistantText(entry as JsonObject);
  if (text === null) return null;
  const calls: Entry[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (
        !isObject(block) ||
        block.type !== "toolCall" ||
        block.name !== "publish_attachment"
      )
        continue;
      const argumentsValue = block.arguments;
      const path = isObject(argumentsValue) ? argumentsValue.path : undefined;
      calls.push({
        call_id: block.id,
        name: block.name,
        path: typeof path === "string" ? path : null,
      });
    }
  }
  return {
    id: entryId ? `pi:${entryId}` : null,
    ts: piTimestamp(entry.timestamp),
    text,
    publish_calls: calls,
  };
}

/** Oldest-first per-entry rows with their turn, for bounded paging. */
export function piFlattenEntries(groups: readonly PiTurnGroup[]): Entry[] {
  const out: Entry[] = [];
  for (const group of groups) {
    const turn = group.start_entry_id
      ? `pi:${group.start_entry_id}`
      : `pi:offset:${group.start_offset}`;
    for (const [offset, end, entry] of [...group.rows].sort(
      (a, b) => a[0] - b[0],
    )) {
      const boundary = boundaryKind(entry);
      const kind =
        boundary === "user"
          ? "user"
          : assistantText(entry) !== null
            ? "assistant"
            : null;
      if (kind === null) continue;
      const message = piEntryMessage(entry);
      if (message === null) continue;
      const row: Entry = { kind, offset, turn, message };
      if (end !== null) row.end_offset = end;
      out.push(row);
    }
  }
  return out;
}

function validateLimit(value: unknown): number {
  let integer: number;
  if (typeof value === "boolean") integer = Number(value);
  else if (typeof value === "number" && Number.isFinite(value))
    integer = Math.trunc(value);
  else if (
    typeof value === "string" &&
    /^[\t\n\v\f\r ]*[+-]?\d+[\t\n\v\f\r ]*$/u.test(value)
  ) {
    integer = Number(value.trim());
  } else {
    throw new TypeError("limit must be an integer");
  }
  if (!Number.isSafeInteger(integer))
    throw new RangeError("limit is outside the safe range");
  return Math.min(Math.max(integer, 1), MAX_LIST_FILES);
}

function validTempKey(value: string): boolean {
  return AGENT_TEMP_KEY_RE.test(value) || AGENT_DRAFT_KEY_RE.test(value);
}

function expectedCollection(
  snapshot: CollectionSnapshot,
  config: Config,
): string | null {
  if (
    typeof snapshot.owner !== "string" ||
    !snapshot.owner ||
    typeof snapshot.temp_key !== "string" ||
    !validTempKey(snapshot.temp_key) ||
    typeof snapshot.collection !== "string" ||
    !isAbsolute(snapshot.collection)
  )
    return null;
  let expected: string;
  try {
    expected = resolve(
      config.paths.AGENT_FILES_DIR,
      config.agentTempLeaf(snapshot.temp_key),
      "uploads",
    );
  } catch {
    return null;
  }
  return resolve(snapshot.collection) === expected ? expected : null;
}

function sameDirectory(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function openVerifiedDirectory(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isDirectory())
    throw new Error("directory path is not a directory");
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    if (!sameDirectory(opened, before) || !sameDirectory(after, before)) {
      throw new Error("directory changed while opening");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openVerifiedChild(
  parent: FileHandle,
  name: string,
): Promise<FileHandle> {
  if (!name || name === "." || name === ".." || name.includes("/")) {
    throw new Error("directory child must be one path component");
  }
  const before = await lstatAt(parent.fd, name);
  if (!before.isDirectory())
    throw new Error("directory child is not a directory");
  const handle = await openAt(parent.fd, name, DIRECTORY_FLAGS);
  try {
    const opened = await handle.stat();
    const after = await lstatAt(parent.fd, name);
    if (!sameDirectory(opened, before) || !sameDirectory(after, before)) {
      throw new Error("directory child changed while opening");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openCollection(
  snapshot: CollectionSnapshot,
  context: SessionFilesContext,
): Promise<OpenCollection | null> {
  if (expectedCollection(snapshot, context.config) === null) return null;
  let instance: FileHandle | null = null;
  let ownerDirectory: FileHandle | null = null;
  try {
    instance = await openVerifiedDirectory(
      context.config.paths.AGENT_FILES_DIR,
    );
    ownerDirectory = await openVerifiedChild(
      instance,
      context.config.agentTempLeaf(snapshot.temp_key),
    );
    const directory = await openVerifiedChild(ownerDirectory, "uploads");
    return {
      snapshot,
      config: context.config,
      instance,
      ownerDirectory,
      directory,
    };
  } catch {
    if (ownerDirectory !== null)
      await ownerDirectory.close().catch(() => undefined);
    if (instance !== null) await instance.close().catch(() => undefined);
    return null;
  }
}

async function collectionIsCurrent(opened: OpenCollection): Promise<boolean> {
  let instanceNow: FileHandle | null = null;
  let ownerNow: FileHandle | null = null;
  let collectionNow: FileHandle | null = null;
  try {
    instanceNow = await openVerifiedDirectory(
      opened.config.paths.AGENT_FILES_DIR,
    );
    if (!sameDirectory(await instanceNow.stat(), await opened.instance.stat()))
      return false;
    ownerNow = await openVerifiedChild(
      instanceNow,
      opened.config.agentTempLeaf(opened.snapshot.temp_key),
    );
    if (
      !sameDirectory(await ownerNow.stat(), await opened.ownerDirectory.stat())
    )
      return false;
    collectionNow = await openVerifiedChild(ownerNow, "uploads");
    return sameDirectory(
      await collectionNow.stat(),
      await opened.directory.stat(),
    );
  } catch {
    return false;
  } finally {
    if (collectionNow !== null)
      await collectionNow.close().catch(() => undefined);
    if (ownerNow !== null) await ownerNow.close().catch(() => undefined);
    if (instanceNow !== null) await instanceNow.close().catch(() => undefined);
  }
}

async function closeCollection(opened: OpenCollection): Promise<void> {
  await opened.directory.close().catch(() => undefined);
  await opened.ownerDirectory.close().catch(() => undefined);
  await opened.instance.close().catch(() => undefined);
}

function isFinitePythonNumber(value: unknown): value is number | boolean {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function validManifest(
  value: unknown,
  attachmentId: string,
  owner: string,
): value is Manifest {
  if (!isObject(value)) return false;
  const source = Object.hasOwn(value, "source")
    ? value.source
    : base.SOURCE_PUBLICATION;
  let safeDisplay: string;
  try {
    safeDisplay = base.displayName(value.name);
  } catch {
    return false;
  }
  const size = value.size;
  const created = value.created_at;
  const sizeNumber =
    typeof size === "number" && Number.isInteger(size)
      ? size
      : typeof size === "boolean"
        ? Number(size)
        : NaN;
  const inline = value.inline_media_type;
  const validInline =
    inline === null ||
    inline === undefined ||
    (typeof inline === "string" &&
      (Object.values(base.INLINE_RASTER_TYPES) as readonly string[]).includes(
        inline,
      ));
  if (
    value.version !== base.VERSION ||
    value.id !== attachmentId ||
    value.owner !== owner ||
    value.blob !== `${attachmentId}.blob` ||
    safeDisplay !== value.name ||
    !Number.isInteger(sizeNumber) ||
    sizeNumber <= 0 ||
    sizeNumber > base.MAX_FILE_BYTES ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    typeof value.media_type !== "string" ||
    !MEDIA_RE.test(value.media_type) ||
    !validInline ||
    !isFinitePythonNumber(created) ||
    typeof value.published !== "boolean" ||
    typeof source !== "string" ||
    !base.SOURCES.has(source)
  )
    return false;

  if (source === base.SOURCE_UPLOAD) {
    for (const key of ["run_id", "tool_call_id"] as const) {
      const candidate = value[key];
      if (
        candidate !== null &&
        candidate !== undefined &&
        typeof candidate !== "string"
      )
        return false;
      if (typeof candidate === "string") {
        const pattern =
          key === "run_id" ? base.RUN_ID_REGEX : base.CALL_ID_REGEX;
        if (!pattern.test(candidate)) return false;
      }
    }
    const intent = value.intent_sha256;
    return (
      intent === "" ||
      (typeof intent === "string" && /^[0-9a-f]{64}$/u.test(intent))
    );
  }
  return (
    typeof value.run_id === "string" &&
    base.RUN_ID_REGEX.test(value.run_id) &&
    typeof value.tool_call_id === "string" &&
    base.CALL_ID_REGEX.test(value.tool_call_id) &&
    typeof value.intent_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.intent_sha256)
  );
}

async function readManifest(
  opened: OpenCollection,
  attachmentId: string,
): Promise<Manifest | null> {
  if (!UPLOAD_ID_RE.test(attachmentId)) return null;
  let handle: FileHandle | null = null;
  try {
    handle = await openAt(
      opened.directory.fd,
      `${attachmentId}.json`,
      READ_FLAGS,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MANIFEST_BYTES)
      return null;
    const data = allocBytes(MAX_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < data.length) {
      const result = await handle.read(
        data,
        length,
        data.length - length,
        length,
      );
      if (result.bytesRead <= 0) break;
      length += result.bytesRead;
    }
    if (length !== stat.size || length > MAX_MANIFEST_BYTES) return null;
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          data.subarray(0, length),
        ),
      );
    } catch {
      return null;
    }
    return validManifest(value, attachmentId, opened.snapshot.owner)
      ? value
      : null;
  } catch {
    return null;
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

async function openBlob(
  opened: OpenCollection,
  manifest: Manifest,
  maxBytes: number | null,
): Promise<FileHandle | null> {
  const id = manifest.id;
  if (
    typeof id !== "string" ||
    !UPLOAD_ID_RE.test(id) ||
    manifest.blob !== `${id}.blob`
  )
    return null;
  let handle: FileHandle | null = null;
  try {
    handle = await openAt(opened.directory.fd, `${id}.blob`, READ_FLAGS);
    const stat = await handle.stat();
    const manifestSize =
      typeof manifest.size === "boolean"
        ? Number(manifest.size)
        : manifest.size;
    if (
      !stat.isFile() ||
      stat.size !== manifestSize ||
      (maxBytes !== null && stat.size > Math.max(Math.trunc(maxBytes), 0))
    ) {
      await handle.close();
      return null;
    }
    return handle;
  } catch {
    if (handle !== null) await handle.close().catch(() => undefined);
    return null;
  }
}

async function describe(
  opened: OpenCollection,
  attachmentId: string,
  maxBytes: number | null = null,
): Promise<Manifest | null> {
  const manifest = await readManifest(opened, attachmentId);
  if (manifest === null || manifest.published !== true) return null;
  const blob = await openBlob(opened, manifest, maxBytes);
  if (blob === null) return null;
  await blob.close().catch(() => undefined);
  return manifest;
}

async function acceptedPage(
  opened: OpenCollection,
  limit: number,
  before: [number, string] | null = null,
): Promise<{ rows: Manifest[]; truncated: boolean }> {
  const rows: Manifest[] = [];
  try {
    if (!(await collectionIsCurrent(opened))) return { rows, truncated: false };
    const names = (await readdirAt(opened.directory.fd)).sort();
    let debris = 0;
    let truncated = false;
    for (const name of names) {
      if (debris >= limit + PAGE_DEBRIS_SLACK) {
        truncated = true;
        break;
      }
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!UPLOAD_ID_RE.test(id)) continue;
      const manifest = await readManifest(opened, id);
      if (manifest !== null && manifest.published === true) {
        if (
          !before ||
          Number(manifest.created_at) < before[0] ||
          (Number(manifest.created_at) === before[0] &&
            String(manifest.id) > before[1])
        )
          rows.push(manifest);
      } else debris += 1;
    }
    rows.sort(
      (a, b) =>
        Number(b.created_at) - Number(a.created_at) ||
        (String(a.id) < String(b.id)
          ? -1
          : String(a.id) > String(b.id)
            ? 1
            : 0),
    );
    return {
      rows: rows.slice(0, limit),
      truncated: truncated || rows.length > limit,
    };
  } catch {
    return { rows: [], truncated: false };
  }
}

/**
 * Preview kind of a filename-listed SVG, audio, or video file, or of a PDF
 * (which the browser draws with pdf.js from the download bytes), else null.
 */
function mediaPreview(name: string, size: number): string | null {
  if (extension(name) === "pdf") return "pdf";
  const media = base.inlineMediaType(name);
  if (media === null) return null;
  if (media.startsWith("image/"))
    return size <= MAX_IMAGE_PREVIEW_BYTES ? "image" : null;
  return media.startsWith("audio/") ? "audio" : "video";
}

function uploadRecord(attachmentId: string, info: Manifest): FileRecord {
  const name = safeName(info.name);
  const ext = extension(name);
  const rawSize = info.size;
  const size =
    typeof rawSize === "boolean" ? Number(rawSize) : (rawSize as number);
  const displayedSize = rawSize as number | boolean;
  const preview =
    typeof info.inline_media_type === "string" &&
    SAFE_RASTER_EXTENSIONS[ext] === info.inline_media_type &&
    size <= MAX_IMAGE_PREVIEW_BYTES
      ? "image"
      : (mediaPreview(name, size) ??
        (TEXT_EXTENSIONS.has(ext) && size <= MAX_TEXT_FILE_BYTES
          ? "text"
          : "none"));
  const type =
    !Object.hasOwn(SAFE_RASTER_EXTENSIONS, ext) || preview === "image"
      ? mediaType(name)
      : "application/octet-stream";
  return {
    id: attachmentId,
    name,
    size: displayedSize,
    media_type: type,
    preview,
    created_at: Number(info.created_at),
  };
}

function publishedRecord(
  attachmentId: string | null,
  fallback: Entry,
  info: Manifest | null,
): FileRecord {
  if (attachmentId === null || info === null) {
    const name = safeName(fallback.name);
    const rawSize = fallback.size;
    const size =
      typeof rawSize === "boolean" ||
      (typeof rawSize === "number" && Number.isInteger(rawSize))
        ? rawSize
        : 0;
    return {
      name,
      size,
      media_type: mediaType(name, fallback.media_type),
      unavailable: fallback.unavailable === "copied" ? "copied" : "missing",
    };
  }
  const name = safeName(info.name);
  const rawSize = info.size;
  const size =
    typeof rawSize === "boolean" ? Number(rawSize) : (rawSize as number);
  const displayedSize = rawSize as number | boolean;
  const preview =
    pythonTruthy(info.inline_media_type) && size <= MAX_IMAGE_PREVIEW_BYTES
      ? "image"
      : (mediaPreview(name, size) ??
        (TEXT_EXTENSIONS.has(extension(name)) && size <= MAX_TEXT_FILE_BYTES
          ? "text"
          : "none"));
  return {
    id: attachmentId,
    name,
    size: displayedSize,
    media_type: mediaType(name, info.media_type),
    preview,
    created_at: Number(info.created_at),
  };
}

/** Newest-first keyset pages scan live manifests, never history. */
export async function listPage(
  snapshot: CollectionSnapshot,
  context: SessionFilesContext,
  sessionId: string | null = null,
  cursor: string | null = null,
  limit: unknown = MAX_LIST_FILES,
  generation: number | null = null,
): Promise<FilePage> {
  let before: [number, string] | null = null;
  if (cursor !== null) {
    try {
      const value = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        typeof value[0] !== "number" ||
        !Number.isFinite(value[0]) ||
        typeof value[1] !== "string" ||
        !UPLOAD_ID_RE.test(value[1])
      )
        throw new TypeError("bad file cursor");
      before = value as [number, string];
    } catch {
      throw new TypeError("bad file cursor");
    }
  }
  let nextCursor: string | null = null;
  const currentGeneration = piThreadGeneration(sessionId);
  const stale = generation !== null && generation !== currentGeneration;
  const files: FileListEntry[] = [];
  let capped = false;
  if (!stale) {
    const opened = await openCollection(snapshot, context);
    if (opened !== null) {
      try {
        const boundedLimit = validateLimit(limit);
        const page = await acceptedPage(opened, boundedLimit + 1, before);
        capped = page.truncated && page.rows.length <= boundedLimit;
        const last = page.rows[boundedLimit - 1];
        if (last && page.rows.length > boundedLimit)
          nextCursor = Buffer.from(
            JSON.stringify([Number(last.created_at), last.id]),
          ).toString("base64url");
        for (const item of page.rows.slice(0, boundedLimit)) {
          const itemId = item.id;
          if (typeof itemId !== "string") continue;
          const storage =
            item.source === base.SOURCE_UPLOAD ? "upload" : "published";
          const info = await describe(opened, itemId);
          if (info === null) continue;
          const record =
            storage === "upload"
              ? uploadRecord(itemId, info)
              : publishedRecord(itemId, item, info);
          if (!("id" in record)) continue;
          files.push({
            key: `${storage}:${itemId}`,
            storage,
            references: 0,
            sources: [],
            ...record,
          });
        }
        if (!(await collectionIsCurrent(opened))) files.length = 0;
      } finally {
        await closeCollection(opened);
      }
    }
  }
  return {
    files,
    cursor: nextCursor,
    generation: currentGeneration,
    stale,
    done: !stale && nextCursor === null,
    capped,
    records: files.length,
    bytes: 0,
  };
}

async function readSessionEntry(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<{ entry: Entry; end: number } | null> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  )
    return null;
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, READ_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || offset >= stat.size) return null;
    const length = Math.min(maxBytes, stat.size - offset);
    const bytes = allocBytes(length);
    let bytesRead = 0;
    let newline = -1;
    while (bytesRead < length && newline < 0) {
      const result = await handle.read(
        bytes,
        bytesRead,
        length - bytesRead,
        offset + bytesRead,
      );
      if (result.bytesRead <= 0) break;
      const previous = bytesRead;
      bytesRead += result.bytesRead;
      const found = bytes.subarray(previous, bytesRead).indexOf(0x0a);
      if (found >= 0) newline = previous + found;
    }
    if (newline < 0) return null;
    const data = bytes.subarray(0, newline);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const value: unknown = JSON.parse(decoded);
    return isObject(value) ? { entry: value, end: offset + newline + 1 } : null;
  } catch {
    return null;
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

async function referenceAt(
  proof: ReferenceProof,
  storage: string,
  attachmentId: string,
  opened: OpenCollection,
  context: SessionFilesContext,
): Promise<boolean> {
  const [triple, offset] = proof;
  const [sessionId, recordedFile, recordedCwd] = triple;
  const resolveBound = context.boundSessionFile;
  if (resolveBound === undefined) return false;
  let path: string | null;
  try {
    path = await resolveBound(sessionId, recordedFile, recordedCwd);
  } catch {
    return false;
  }
  if (typeof path !== "string" || !path) return false;
  const ranged = await readSessionEntry(path, offset, MAX_REFERENCE_LINE_BYTES);
  if (ranged === null) return false;
  const raw = ranged.entry;
  const message = piEntryMessage(raw);
  if (message === null) return false;
  const entry: Entry = {
    kind: boundaryKind(raw) === "user" ? "user" : "assistant",
    offset,
    turn: null,
    message,
    end_offset: ranged.end,
  };
  if (storage === "published") {
    const calls = isObject(entry.message) ? entry.message.publish_calls : null;
    if (!Array.isArray(calls)) return false;
    const rows = await acceptedPage(opened, Number.POSITIVE_INFINITY);
    if (rows.truncated) return false;
    const byCall = new Map<string, string>();
    for (const item of rows.rows) {
      if (
        typeof item.tool_call_id === "string" &&
        typeof item.id === "string" &&
        !byCall.has(item.tool_call_id)
      ) {
        byCall.set(item.tool_call_id, item.id);
      }
    }
    return calls.some(
      (call) =>
        isObject(call) &&
        typeof call.call_id === "string" &&
        byCall.get(call.call_id) === attachmentId,
    );
  }
  return refs(entry).some(
    ([kind, value]) => kind === storage && value === attachmentId,
  );
}

export function textPreview(data: Bytes, name: string): TextSnippet | null {
  const ext = extension(name);
  if (ACTIVE_EXTENSIONS.has(ext) || !TEXT_EXTENSIONS.has(ext)) return null;
  const bytes = new Uint8Array(data);
  const probe = bytes.subarray(
    bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
      ? 3
      : 0,
  );
  if (
    bytes.includes(0) ||
    ACTIVE_PREFIX.test(Buffer.from(probe).toString("latin1")) ||
    base.inlineRasterMediaType(bytes.subarray(0, 16)) !== null
  )
    return null;
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let controls = 0;
  for (const character of value) {
    if (
      /\p{C}/u.test(character) &&
      character !== "\n" &&
      character !== "\r" &&
      character !== "\t"
    )
      controls += 1;
  }
  if (controls > 0) return null;
  const encoded = byteView(Buffer.from(value, "utf8"));
  const truncated = encoded.length > MAX_TEXT_PREVIEW_BYTES;
  let snippet = value;
  if (truncated) {
    let prefix = encoded.subarray(0, MAX_TEXT_PREVIEW_BYTES);
    while (prefix.length > 0) {
      try {
        snippet = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
        break;
      } catch {
        prefix = prefix.subarray(0, prefix.length - 1);
      }
    }
  }
  return {
    kind: "text",
    text: snippet,
    truncated,
    bytes: Math.min(encoded.length, MAX_TEXT_PREVIEW_BYTES),
  };
}

async function downloadText(
  opened: OpenCollection,
  attachmentId: string,
): Promise<{ manifest: Manifest; data: Bytes } | null> {
  const manifest = await readManifest(opened, attachmentId);
  if (manifest === null || manifest.published !== true) return null;
  const handle = await openBlob(opened, manifest, MAX_TEXT_FILE_BYTES);
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    const data = allocBytes(stat.size);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < data.length) {
      const length = Math.min(64 * 1024, data.length - offset);
      const { bytesRead } = await handle.read(data, offset, length, offset);
      if (bytesRead <= 0) return null;
      hash.update(data.subarray(offset, offset + bytesRead));
      offset += bytesRead;
    }
    if (
      hash.digest("hex") !== manifest.sha256 ||
      !(await collectionIsCurrent(opened))
    )
      return null;
    return { manifest, data };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Bounded text preview, optionally authorized by an exact transcript offset.
export async function previewSnippet(
  snapshot: CollectionSnapshot,
  context: SessionFilesContext,
  storage: string,
  attachmentId: string,
  proof: ReferenceProof | null = null,
): Promise<TextSnippet | null> {
  if (storage !== "upload" && storage !== "published") return null;
  const pattern = storage === "upload" ? UPLOAD_ID_RE : PUBLISHED_ID_RE;
  if (!pattern.test(attachmentId)) return null;
  const opened = await openCollection(snapshot, context);
  if (opened === null) return null;
  try {
    if (
      proof !== null &&
      !(await referenceAt(proof, storage, attachmentId, opened, context))
    )
      return null;
    const downloaded = await downloadText(opened, attachmentId);
    if (downloaded === null) return null;
    const result = textPreview(
      downloaded.data,
      safeName(downloaded.manifest.name),
    );
    if (result === null || !(await collectionIsCurrent(opened))) return null;
    return result;
  } finally {
    await closeCollection(opened);
  }
}
