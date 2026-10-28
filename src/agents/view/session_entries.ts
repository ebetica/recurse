// Bounded Pi reads preserve byte ranges and sender ids/titles without an index.
// Fresh O_NOFOLLOW descriptors can pin BigInt dev/ino against rotation.
// Async readers serve live history; sync reads support turn scans.
// JS-number offsets/stat values beyond MAX_SAFE_INTEGER are unsupported.

import { Buffer } from "node:buffer";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { open as openAsync, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

export type JsonObject = Record<string, unknown>;
export type JsonlRange = [start: number, end: number, entry: JsonObject];
export type ExpectedIdentity = readonly [dev: bigint, ino: bigint];
export interface SessionStats extends Stats {
  readonly identity: ExpectedIdentity;
}
export interface Assistant {
  entry_id: string;
  content: string;
}

export interface PiTurnGroup {
  start_offset: number;
  start_entry_id: string;
  rows: Array<[number, number | null, JsonObject]>;
  closed_by: "input" | "compaction" | null;
}

export const LINE_BYTES = 2 << 20;
export const VIEW_RAW_LINE_BYTES = 128 << 20;
export const CHUNK_BYTES = 64 << 10;
export const HEADER_BYTES = 64 << 10;
export const PI_TURN_SCAN_BYTES = 4 << 20;
export const PI_TURN_SCAN_LINES = 4000;

type Bytes = Uint8Array<ArrayBuffer>;
const NL = 10;

function allocBytes(length: number): Bytes {
  return Buffer.allocUnsafe(length) as unknown as Bytes;
}

function emptyBytes(): Bytes {
  return allocBytes(0);
}

function copyBytes(value: Uint8Array): Bytes {
  const copy = allocBytes(value.length);
  copy.set(value);
  return copy;
}

function encodeUtf8(value: string): Bytes {
  return new TextEncoder().encode(value) as Bytes;
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    value as Uint8Array<ArrayBuffer>,
  );
}

function concatBytes(chunks: readonly Bytes[], length?: number): Bytes {
  const total = length ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = allocBytes(total);
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.length, total - offset);
    if (count <= 0) continue;
    joined.set(chunk.subarray(0, count), offset);
    offset += count;
  }
  return joined;
}

function indexOfByte(value: Uint8Array, byte: number, from = 0): number {
  for (let index = Math.max(0, from); index < value.length; index += 1) {
    if (value[index] === byte) return index;
  }
  return -1;
}

function lastIndexOfByte(
  value: Uint8Array,
  byte: number,
  from = value.length - 1,
): number {
  for (let index = Math.min(from, value.length - 1); index >= 0; index -= 1) {
    if (value[index] === byte) return index;
  }
  return -1;
}
const VIEW_CHUNK_BYTES = 16 << 20;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: number): number {
  // Invariant: Python's int(True) and int(False) are 1 and 0 respectively.
  if (typeof value === "boolean") return Number(value);
  if (!Number.isFinite(value))
    throw new RangeError("expected a finite integer");
  return Math.trunc(value);
}

function validOffset(value: unknown): value is number | boolean {
  // Invariant: bool is an int in Python, so preserve its accepted byte-offset
  // behavior.
  if (typeof value === "boolean") return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function openSession(
  path: string,
  expect?: ExpectedIdentity,
): { fd: number; info: Stats; identity: ExpectedIdentity } {
  const flags =
    constants.O_RDONLY |
    ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags);
  let info: Stats;
  let identity: ExpectedIdentity;
  try {
    info = fstatSync(fd);
    const exact = fstatSync(fd, { bigint: true });
    identity = [exact.dev, exact.ino];
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (!info.isFile() || info.nlink !== 1) {
    closeSync(fd);
    throw new Error("Pi session is not a regular file");
  }
  if (expect && (identity[0] !== expect[0] || identity[1] !== expect[1])) {
    closeSync(fd);
    throw new Error("Pi session changed during the read");
  }
  return { fd, info, identity };
}

/** Read no more than `length` bytes at one exact file position. */
function readAt(fd: number, offset: number, length: number): Bytes {
  const chunks: Bytes[] = [];
  let done = 0;
  while (done < length) {
    const chunk = allocBytes(Math.min(CHUNK_BYTES, length - done));
    const count = readSync(fd, chunk, 0, chunk.length, offset + done);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    done += count;
  }
  return concatBytes(chunks, done);
}

/** A bounded, positional readline cursor which retains its small read-ahead. */
class FileCursor {
  private position: number;
  private readPosition: number;
  private buffer = emptyBytes();
  private used = 0;

  constructor(
    private readonly fd: number,
    private readonly size: number,
    offset: number,
  ) {
    this.position = Number(offset);
    this.readPosition = Number(offset);
  }

  private fill(maxBytes: number): boolean {
    if (this.used < this.buffer.length) return true;
    const remaining = Math.min(maxBytes, this.size - this.readPosition);
    if (remaining <= 0) return false;
    const chunk = allocBytes(Math.min(CHUNK_BYTES, remaining));
    const count = readSync(this.fd, chunk, 0, chunk.length, this.readPosition);
    if (count <= 0) return false;
    this.buffer = chunk.subarray(0, count);
    this.used = 0;
    this.readPosition += count;
    return true;
  }

  readline(maxBytes: number): Bytes {
    const limit = Math.max(asInt(maxBytes), 0);
    if (limit === 0) return emptyBytes();
    const pieces: Bytes[] = [];
    let length = 0;
    while (length < limit && this.position < this.size) {
      if (this.used >= this.buffer.length) {
        if (!this.fill(limit - length)) break;
      }
      const available = Math.min(
        this.buffer.length - this.used,
        limit - length,
      );
      const newline = indexOfByte(this.buffer, NL, this.used);
      const count =
        newline >= this.used && newline < this.used + available
          ? newline - this.used + 1
          : available;
      pieces.push(this.buffer.subarray(this.used, this.used + count));
      this.used += count;
      this.position += count;
      length += count;
      if (count > 0 && pieces.at(-1)!.at(-1) === 10) break;
    }
    return concatBytes(pieces, length);
  }
}

interface AsyncOpenSession {
  handle: FileHandle;
  size: number;
  identity: ExpectedIdentity;
}

export interface AsyncSessionInfo {
  readonly size: number;
  readonly identity: ExpectedIdentity;
}

async function openSessionAsync(
  path: string,
  expect?: ExpectedIdentity,
): Promise<AsyncOpenSession> {
  const flags =
    constants.O_RDONLY |
    ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
  const handle = await openAsync(path, flags);
  try {
    const info = await handle.stat();
    const exact = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("Pi session is not a regular file");
    if (!Number.isSafeInteger(info.size))
      throw new RangeError("Pi session exceeds safe byte offsets");
    const identity: ExpectedIdentity = [exact.dev, exact.ino];
    if (expect && (identity[0] !== expect[0] || identity[1] !== expect[1]))
      throw new Error("Pi session changed during the read");
    return { handle, size: info.size, identity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Async positional cursor; bounded read-ahead is reused across adjacent lines.
class AsyncFileCursor {
  private position: number;
  private readPosition: number;
  private buffer = emptyBytes();
  private used = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly size: number,
    offset: number,
  ) {
    this.position = Number(offset);
    this.readPosition = Number(offset);
  }

  tell(): number {
    return this.position;
  }

  async previousByte(offset: number): Promise<number | undefined> {
    const byte = allocBytes(1);
    const { bytesRead } = await this.handle.read(byte, 0, 1, offset);
    return bytesRead === 0 ? undefined : byte[0];
  }

  private async fill(maxBytes: number): Promise<boolean> {
    if (this.used < this.buffer.length) return true;
    const remaining = Math.min(maxBytes, this.size - this.readPosition);
    if (remaining <= 0) return false;
    const chunk = allocBytes(Math.min(CHUNK_BYTES, remaining));
    const { bytesRead } = await this.handle.read(
      chunk,
      0,
      chunk.length,
      this.readPosition,
    );
    if (bytesRead <= 0) return false;
    this.buffer = chunk.subarray(0, bytesRead);
    this.used = 0;
    this.readPosition += bytesRead;
    return true;
  }

  async readline(maxBytes: number): Promise<Bytes> {
    const limit = Math.max(asInt(maxBytes), 0);
    if (limit === 0) return emptyBytes();
    const pieces: Bytes[] = [];
    let length = 0;
    while (length < limit && this.position < this.size) {
      if (this.used >= this.buffer.length) {
        if (!(await this.fill(limit - length))) break;
      }
      const available = Math.min(
        this.buffer.length - this.used,
        limit - length,
      );
      const newline = indexOfByte(this.buffer, NL, this.used);
      const count =
        newline >= this.used && newline < this.used + available
          ? newline - this.used + 1
          : available;
      pieces.push(this.buffer.subarray(this.used, this.used + count));
      this.used += count;
      this.position += count;
      length += count;
      if (count > 0 && pieces.at(-1)!.at(-1) === NL) break;
    }
    return concatBytes(pieces, length);
  }
}

interface AsyncAccumulatedLine {
  raw: Bytes | null;
  used: number;
  complete: boolean;
  oversize: boolean;
}

async function readAtAsync(
  handle: FileHandle,
  offset: number,
  length: number,
): Promise<Bytes> {
  const chunks: Bytes[] = [];
  let done = 0;
  while (done < length) {
    const chunk = allocBytes(Math.min(CHUNK_BYTES, length - done));
    const { bytesRead } = await handle.read(
      chunk,
      0,
      chunk.length,
      offset + done,
    );
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    done += bytesRead;
  }
  return concatBytes(chunks, done);
}

async function accumulateAsyncLine(
  cursor: AsyncFileCursor,
  size: number,
  scanned: number,
  byteLimit: number,
  maxLineBytes = LINE_BYTES,
): Promise<AsyncAccumulatedLine> {
  const chunks: Bytes[] = [];
  let length = 0;
  let complete = false;
  let oversize = false;
  let used = 0;
  const scanEnd = byteLimit + maxLineBytes + 1;
  while (cursor.tell() < size && scanned + used < scanEnd) {
    const chunk = await cursor.readline(
      Math.min(maxLineBytes + 1, scanEnd - scanned - used),
    );
    if (chunk.length === 0) break;
    used += chunk.length;
    if (chunk.at(-1) === NL) complete = true;
    if (!oversize) {
      if (length + chunk.length > maxLineBytes + 1) {
        oversize = true;
        chunks.length = 0;
        length = 0;
      } else {
        chunks.push(chunk);
        length += chunk.length;
      }
    }
    if (complete) break;
  }
  return {
    raw: oversize ? null : concatBytes(chunks, length),
    used,
    complete,
    oversize,
  };
}

/** Async exact/page reads for cold paths that must not block the event loop. */
export class AsyncJsonlRangeReader {
  constructor(
    private readonly path: string,
    private readonly expectedIdentity?: ExpectedIdentity,
  ) {}

  // Safe open-file size and exact identity, for pinning a sequence of reads.
  async sessionInfo(): Promise<AsyncSessionInfo> {
    const { handle, size, identity } = await openSessionAsync(this.path);
    try {
      return { size, identity };
    } finally {
      await handle.close();
    }
  }

  async entryAt(offset: number, maxBytes: number): Promise<JsonObject | null> {
    if (!validOffset(offset)) return null;
    const limit = Math.max(asInt(maxBytes), 1);
    const { handle, size } = await openSessionAsync(
      this.path,
      this.expectedIdentity,
    );
    try {
      const cursor = new AsyncFileCursor(handle, size, Number(offset));
      const raw = await cursor.readline(limit + 1);
      if (raw.length > limit || raw.length === 0 || raw.at(-1) !== NL)
        return null;
      return entry(raw.subarray(0, -1));
    } finally {
      await handle.close();
    }
  }

  async forwardPage(
    start: number,
    options: {
      maxBytes: number;
      maxLines: number;
      stripImages?: boolean;
    },
  ): Promise<[rows: JsonlRange[], end: number, eof: boolean]> {
    if (!validOffset(start))
      throw new RangeError("expected a non-negative integer byte offset");
    const byteLimit = Math.max(asInt(options.maxBytes), 1);
    const lineLimit = Math.max(asInt(options.maxLines), 1);
    const { handle, size } = await openSessionAsync(
      this.path,
      this.expectedIdentity,
    );
    if (start >= size) {
      await handle.close();
      return [[], size, true];
    }
    const rows: JsonlRange[] = [];
    let offset = Number(start);
    let completeEnd = offset;
    let scanned = 0;
    const cursor = new AsyncFileCursor(handle, size, offset);
    try {
      if (offset > 0 && (await cursor.previousByte(offset - 1)) !== NL)
        await cursor.readline(LINE_BYTES + 1);
      offset = cursor.tell();
      completeEnd = offset;
      while (offset < size && rows.length < lineLimit && scanned < byteLimit) {
        const lineStart = offset;
        const stripImages = options.stripImages ?? false;
        const line = await accumulateAsyncLine(
          cursor,
          size,
          stripImages ? 0 : scanned,
          byteLimit,
          stripImages ? VIEW_RAW_LINE_BYTES : LINE_BYTES,
        );
        offset = cursor.tell();
        let parsed: JsonObject | null = null;
        if (line.complete && !line.oversize) {
          const raw = line.raw?.subarray(0, -1);
          parsed =
            raw === undefined
              ? null
              : stripImages
                ? viewEntry(raw)
                : entry(raw);
          if (parsed !== null) rows.push([lineStart, offset, parsed]);
          completeEnd = offset;
        } else if (line.complete) {
          completeEnd = offset;
        } else {
          break;
        }
        if (stripImages) {
          scanned +=
            line.complete &&
            !line.oversize &&
            parsed !== null &&
            line.raw !== null
              ? pythonJsonBytes(parsed, line.raw.subarray(0, -1))
              : Math.min(line.used, byteLimit);
        } else scanned += line.used;
      }
    } finally {
      await handle.close();
    }
    return [rows, completeEnd, completeEnd >= size];
  }

  // Newest-first bounded newline-terminated raw rows without blocking the loop.
  async backwardLines(
    end: number,
    lower: number,
    maxBytes: number,
    options: { stripImages?: boolean } = {},
  ): Promise<[rows: Array<[number, number, Uint8Array]>, capped: boolean]> {
    const { handle } = await openSessionAsync(this.path, this.expectedIdentity);
    try {
      const [rows, capped] = await linesBackwardDetailAsync(
        (offset, length) => readAtAsync(handle, offset, length),
        end,
        lower,
        maxBytes,
        options.stripImages ? VIEW_RAW_LINE_BYTES : LINE_BYTES,
      );
      return [
        rows.map(([offset, raw]) => [offset, offset + raw.length + 1, raw]),
        capped,
      ];
    } finally {
      await handle.close();
    }
  }
}

function decodeJson(raw: Bytes): unknown | null {
  try {
    const text = decodeUtf8(raw);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function pythonFloatJsonLength(value: number): number {
  if (!Number.isFinite(value))
    return Number.isNaN(value) ? 3 : value < 0 ? 9 : 8;
  if (Object.is(value, -0)) return 4;
  if (value === 0) return 3;

  const rendered = String(value);
  const sign = rendered.startsWith("-") ? 1 : 0;
  const unsigned = sign === 1 ? rendered.slice(1) : rendered;
  const exponentIndex = unsigned.search(/[eE]/);
  let digits: string;
  let exponent: number;
  if (exponentIndex >= 0) {
    const mantissa = unsigned.slice(0, exponentIndex);
    const point = mantissa.indexOf(".");
    const before = point < 0 ? mantissa : mantissa.slice(0, point);
    const allDigits = mantissa.replace(".", "");
    digits = allDigits.replace(/0+$/, "");
    exponent = Number(unsigned.slice(exponentIndex + 1)) + before.length - 1;
  } else {
    const point = unsigned.indexOf(".");
    const beforeLength = point < 0 ? unsigned.length : point;
    const allDigits = unsigned.replace(".", "");
    const first = allDigits.search(/[1-9]/);
    digits = allDigits.slice(first).replace(/0+$/, "");
    exponent = beforeLength - first - 1;
  }

  if (exponent >= 16 || exponent <= -5) {
    const exponentDigits = Math.max(2, String(Math.abs(exponent)).length);
    return (
      sign + digits.length + (digits.length > 1 ? 1 : 0) + 2 + exponentDigits
    );
  }
  if (exponent >= 0) {
    const integerDigits = exponent + 1;
    return (
      sign +
      (digits.length <= integerDigits ? integerDigits + 2 : digits.length + 1)
    );
  }
  return sign + 2 + (-exponent - 1) + digits.length;
}

type JsonNumberMetadata =
  | { kind: "number"; token: string }
  | { kind: "array"; items: JsonNumberMetadata[] }
  | { kind: "object"; properties: Map<string, JsonNumberMetadata> }
  | null;

function jsonNumberMetadata(raw: Uint8Array): JsonNumberMetadata {
  const text = decodeUtf8(raw);
  let index = 0;
  const skipSpace = (): void => {
    while (/[ \t\r\n]/.test(text[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"')
        return JSON.parse(text.slice(start, index)) as string;
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const parseValue = (): JsonNumberMetadata => {
    skipSpace();
    const current = text[index];
    if (current === '"') {
      parseString();
      return null;
    }
    if (current === "[") {
      index += 1;
      const items: JsonNumberMetadata[] = [];
      skipSpace();
      if (text[index] === "]") {
        index += 1;
        return { kind: "array", items };
      }
      while (true) {
        items.push(parseValue());
        skipSpace();
        if (text[index++] === "]") break;
        if (text[index - 1] !== ",")
          throw new SyntaxError("invalid JSON array");
      }
      return { kind: "array", items };
    }
    if (current === "{") {
      index += 1;
      const properties = new Map<string, JsonNumberMetadata>();
      skipSpace();
      if (text[index] === "}") {
        index += 1;
        return { kind: "object", properties };
      }
      while (true) {
        skipSpace();
        if (text[index] !== '"') throw new SyntaxError("invalid JSON key");
        const key = parseString();
        skipSpace();
        if (text[index++] !== ":") throw new SyntaxError("invalid JSON object");
        properties.set(key, parseValue());
        skipSpace();
        if (text[index++] === "}") break;
        if (text[index - 1] !== ",")
          throw new SyntaxError("invalid JSON object");
      }
      return { kind: "object", properties };
    }
    if (current === "t") {
      index += 4;
      return null;
    }
    if (current === "f") {
      index += 5;
      return null;
    }
    if (current === "n") {
      index += 4;
      return null;
    }
    const start = index;
    if (current === "-") index += 1;
    if (text[index] === "0") index += 1;
    else while (text[index] >= "0" && text[index] <= "9") index += 1;
    if (text[index] === ".") {
      index += 1;
      while (text[index] >= "0" && text[index] <= "9") index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      while (text[index] >= "0" && text[index] <= "9") index += 1;
    }
    if (index === start) throw new SyntaxError("invalid JSON value");
    return { kind: "number", token: text.slice(start, index) };
  };

  const root = parseValue();
  skipSpace();
  if (index !== text.length) throw new SyntaxError("trailing JSON data");
  return root;
}

function pythonNumberCorrection(
  value: unknown,
  metadata: JsonNumberMetadata,
): number {
  if (typeof value === "number") {
    if (metadata?.kind !== "number")
      throw new SyntaxError("missing number metadata");
    const token = metadata.token;
    const pythonLength = /[.eE]/.test(token)
      ? pythonFloatJsonLength(Number(token))
      : token === "-0"
        ? 1
        : token.length;
    return pythonLength - (JSON.stringify(value)?.length ?? 4);
  }
  if (Array.isArray(value)) {
    if (metadata?.kind !== "array" || metadata.items.length !== value.length)
      throw new SyntaxError("missing array metadata");
    return value.reduce(
      (sum, item, index) =>
        sum + pythonNumberCorrection(item, metadata.items[index]!),
      0,
    );
  }
  if (isObject(value)) {
    if (metadata?.kind !== "object")
      throw new SyntaxError("missing object metadata");
    let correction = 0;
    for (const key of Object.keys(value)) {
      const child = metadata.properties.get(key);
      if (child === undefined)
        throw new SyntaxError("missing property metadata");
      correction += pythonNumberCorrection(value[key], child);
    }
    return correction;
  }
  if (metadata !== null) throw new SyntaxError("unexpected number metadata");
  return 0;
}

function pythonJsonBytes(value: unknown, raw?: Uint8Array): number {
  // Invariant: json.dumps uses ASCII escapes and spaces after separators by
  // default. JSON.parse erases whether a number was an int or float, so correct
  // each retained value using the original JSON token.
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return 0;
  let bytes = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < encoded.length; ) {
    const codePoint = encoded.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    if (inString) {
      if (escaped) {
        bytes += 1;
        escaped = false;
      } else if (char === "\\") {
        bytes += 1;
        escaped = true;
      } else if (char === '"') {
        bytes += 1;
        inString = false;
      } else if (codePoint > 0x7f) {
        bytes += codePoint > 0xffff ? 12 : 6;
      } else bytes += 1;
    } else if (char === '"') {
      bytes += 1;
      inString = true;
    } else if (char === "," || char === ":") bytes += 2;
    else bytes += 1;
    index += char.length;
  }
  if (raw === undefined) return bytes;
  try {
    return bytes + pythonNumberCorrection(value, jsonNumberMetadata(raw));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Parse an ordinary Pi entry; malformed or over-limit rows are absent. */
export function entry(raw: Uint8Array | string): JsonObject | null {
  const bytes = typeof raw === "string" ? encodeUtf8(raw) : copyBytes(raw);
  if (bytes.length > LINE_BYTES) return null;
  const value = decodeJson(bytes);
  return isObject(value) ? value : null;
}

// Parse a view row, discarding base64 image data before it reaches the view.
export function viewEntry(raw: Uint8Array | string): JsonObject | null {
  const bytes = typeof raw === "string" ? encodeUtf8(raw) : copyBytes(raw);
  if (bytes.length > VIEW_RAW_LINE_BYTES) return null;
  const value = decodeJson(bytes);
  if (!isObject(value)) return null;
  const message = value.message;
  const content = isObject(message) ? message.content : undefined;
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (!isObject(part) || part.type !== "image") return part;
      const metadata = { ...part };
      delete metadata.data;
      return metadata;
    });
    value.message = { ...(isObject(message) ? message : {}), content: parts };
  }
  return pythonJsonBytes(value, bytes) <= LINE_BYTES ? value : null;
}

export function entryIdentity(
  value: JsonObject,
): [entryId: string, parentId: string | null] | null {
  const id = value.id;
  const parent = value.parentId;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    (parent !== null &&
      parent !== undefined &&
      (typeof parent !== "string" || parent.length === 0))
  ) {
    return null;
  }
  return [id, parent === undefined ? null : parent];
}

export function boundaryKind(value: JsonObject): string | null {
  const kind = value.type;
  if (kind === "custom_message") return "custom";
  if (kind === "compaction") return "compaction";
  const message = value.message;
  if (kind === "message" && isObject(message)) {
    const role = message.role;
    if (role === "user" || role === "custom") return role;
  }
  return null;
}

function textValues(content: unknown): string[] | null {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return null;
  const values: string[] = [];
  for (const raw of content) {
    if (!isObject(raw)) return null;
    if (raw.type === "text") {
      const value = Object.hasOwn(raw, "text") ? raw.text : "";
      if (typeof value !== "string") return null;
      values.push(value);
    }
  }
  return values;
}

export function contentText(
  content: unknown,
  maxChars?: number | null,
): [text: string, truncated: boolean] | null {
  const values = textValues(content);
  if (values === null) return null;
  if (maxChars === null || maxChars === undefined) {
    return [values.join(""), false];
  }
  let remaining = asInt(maxChars);
  const parts: string[] = [];
  let truncated = false;
  for (const value of values) {
    const points = Array.from(value);
    if (points.length > remaining) {
      parts.push(points.slice(0, remaining).join(""));
      truncated = true;
      break;
    }
    parts.push(value);
    remaining -= points.length;
  }
  if (!truncated && parts.length < values.length) truncated = true;
  return [parts.join(""), truncated];
}

export function assistantText(value: JsonObject): string | null {
  const message = value.message;
  if (
    value.type !== "message" ||
    !isObject(message) ||
    message.role !== "assistant"
  ) {
    return null;
  }
  return contentText(message.content)?.[0] ?? null;
}

function ensureParagraphBreak(parts: string[]): void {
  const suffix = parts.slice(-2).join("");
  const lastTwo = Array.from(suffix).slice(-2).join("");
  if (parts.length > 0 && !lastTwo.endsWith("\n\n")) {
    parts.push(lastTwo.endsWith("\n") ? "\n" : "\n\n");
  }
}

export function joinText(
  entries: Array<[entryId: string, text: string]>,
): Assistant {
  const parts: string[] = [];
  for (const [, text] of [...entries].reverse()) {
    if (text) {
      ensureParagraphBreak(parts);
      parts.push(text);
    }
  }
  return { entry_id: entries[0]![0], content: parts.join("") };
}

function rowEntryId(value: JsonObject): string {
  return entryIdentity(value)?.[0] ?? "";
}

function rowRange(
  row: [number, JsonObject] | [number, number | null, JsonObject],
): [number, number | null, JsonObject] {
  return [row[0], row.length === 3 ? row[1] : null, row.at(-1)! as JsonObject];
}

// Split oldest-first entries into ranges between user and compaction bounds.
export function groupPiTurns(
  rows: Array<[number, JsonObject] | [number, number | null, JsonObject]>,
): PiTurnGroup[] {
  const groups: PiTurnGroup[] = [];
  let current: Array<[number, number | null, JsonObject]> = [];
  const flush = (closedBy: "input" | "compaction" | null): void => {
    if (current.length === 0) return;
    const first = current[0]!;
    groups.push({
      start_offset: first[0],
      start_entry_id: rowEntryId(first[2]),
      rows: current,
      closed_by: closedBy,
    });
    current = [];
  };
  for (const row of rows) {
    const ranged = rowRange(row);
    const boundary = boundaryKind(ranged[2]);
    if (boundary === "compaction") {
      flush("compaction");
      continue;
    }
    if (boundary === "user" && current.length > 0) flush("input");
    current.push(ranged);
  }
  flush(null);
  return groups;
}

function splitBuffer(buffer: Bytes): Bytes[] {
  const result: Bytes[] = [];
  let start = 0;
  for (;;) {
    const index = indexOfByte(buffer, NL, start);
    if (index < 0) {
      result.push(buffer.subarray(start));
      return result;
    }
    result.push(buffer.subarray(start, index));
    start = index + 1;
  }
}

async function linesBackwardDetailAsync(
  readChunk: (offset: number, length: number) => Promise<Bytes>,
  end: number,
  lower: number,
  maxBytes: number,
  maxLineBytes = LINE_BYTES,
): Promise<[Array<[number, Bytes]>, boolean]> {
  let pos = end;
  let head = emptyBytes();
  let first = true;
  let pending = end;
  let scanned = 0;
  let skipping = false;
  let skippedAny = false;
  const rows: Array<[number, Bytes]> = [];
  const chunkBytes = maxLineBytes > LINE_BYTES ? VIEW_CHUNK_BYTES : CHUNK_BYTES;
  while (pos > lower && scanned < maxBytes) {
    const step = Math.min(chunkBytes, pos - lower, maxBytes - scanned);
    if (step <= 0) break;
    pos -= step;
    scanned += step;
    let chunk = await readChunk(pos, step);
    if (skipping) {
      const cut = lastIndexOfByte(chunk, NL);
      if (cut < 0) continue;
      pending = pos + cut + 1;
      chunk = chunk.subarray(0, cut);
      skipping = false;
    }
    let buffer = concatBytes([chunk, head]);
    if (first) {
      const cut = lastIndexOfByte(buffer, NL);
      if (cut < 0) {
        head = emptyBytes();
        continue;
      }
      pending = pos + cut + 1;
      buffer = buffer.subarray(0, cut);
      first = false;
    }
    const pieces = splitBuffer(buffer);
    head = pieces[0]!;
    const fresh = pieces.slice(1);
    if (head.length > maxLineBytes) {
      head = emptyBytes();
      skipping = true;
      skippedAny = true;
    } else if (pos === lower && head.length > 0) {
      fresh.unshift(head);
      head = emptyBytes();
    }
    for (const line of fresh.reverse()) {
      const offset = pending - line.length - 1;
      if (line.length <= maxLineBytes) rows.push([offset, line]);
      pending = offset;
    }
  }
  return [rows, pos > lower || skippedAny];
}

function linesBackwardDetail(
  readChunk: (offset: number, length: number) => Bytes,
  end: number,
  lower: number,
  maxBytes: number,
  maxLineBytes = LINE_BYTES,
): [Array<[number, Bytes]>, boolean] {
  let pos = end;
  let head = emptyBytes();
  let first = true;
  let pending = end;
  let scanned = 0;
  let skipping = false;
  let skippedAny = false;
  const rows: Array<[number, Bytes]> = [];
  const chunkBytes = maxLineBytes > LINE_BYTES ? VIEW_CHUNK_BYTES : CHUNK_BYTES;
  while (pos > lower && scanned < maxBytes) {
    const step = Math.min(chunkBytes, pos - lower, maxBytes - scanned);
    if (step <= 0) break;
    pos -= step;
    scanned += step;
    let chunk = readChunk(pos, step);
    if (skipping) {
      const cut = lastIndexOfByte(chunk, NL);
      if (cut < 0) continue;
      pending = pos + cut + 1;
      chunk = chunk.subarray(0, cut);
      skipping = false;
    }
    let buffer = concatBytes([chunk, head]);
    if (first) {
      const cut = lastIndexOfByte(buffer, NL);
      if (cut < 0) {
        head = emptyBytes();
        continue;
      }
      pending = pos + cut + 1;
      buffer = buffer.subarray(0, cut);
      first = false;
    }
    const pieces = splitBuffer(buffer);
    head = pieces[0]!;
    const fresh = pieces.slice(1);
    if (head.length > maxLineBytes) {
      head = emptyBytes();
      skipping = true;
      skippedAny = true;
    } else if (pos === lower && head.length > 0) {
      fresh.unshift(head);
      head = emptyBytes();
    }
    for (const line of fresh.reverse()) {
      const offset = pending - line.length - 1;
      if (line.length <= maxLineBytes) rows.push([offset, line]);
      pending = offset;
    }
  }
  return [rows, pos > lower || skippedAny];
}

/** Synchronous header and bounded reverse reads for legacy turn scans. */
export class JsonlRangeReader {
  constructor(private readonly path: string) {}

  private open(expect?: ExpectedIdentity): {
    fd: number;
    info: Stats;
    identity: ExpectedIdentity;
  } {
    return openSession(this.path, expect);
  }

  /** Session header as byte length, entry and stat, or null. */
  header(): [length: number, entry: JsonObject, stat: SessionStats] | null {
    let opened: { fd: number; info: Stats; identity: ExpectedIdentity };
    try {
      opened = this.open();
    } catch {
      return null;
    }
    const { fd, info, identity } = opened;
    try {
      const raw = new FileCursor(fd, info.size, 0).readline(HEADER_BYTES + 1);
      if (raw.length > HEADER_BYTES || raw.at(-1) !== 10) return null;
      const value = entry(raw.subarray(0, -1));
      return value === null
        ? null
        : [raw.length, value, Object.assign(info, { identity })];
    } finally {
      closeSync(fd);
    }
  }

  /** Newest-first newline-terminated raw rows below end. */
  backwardLines(
    end: number,
    lower: number,
    maxBytes: number,
    expect?: ExpectedIdentity,
    stripImages = false,
  ): [rows: Array<[number, number, Bytes]>, capped: boolean] {
    const { fd } = this.open(expect);
    try {
      const [lines, capped] = linesBackwardDetail(
        (offset, length) => readAt(fd, offset, length),
        end,
        lower,
        maxBytes,
        stripImages ? VIEW_RAW_LINE_BYTES : LINE_BYTES,
      );
      return [
        lines.map(([offset, raw]) => [offset, offset + raw.length + 1, raw]),
        capped,
      ];
    } finally {
      closeSync(fd);
    }
  }
}

const ORIGIN_LINE_RE =
  /^\[recurse-origin: (operator|agent|scheduled|platform|service)\]$/;
const SENDER_LINE_RE =
  /^\[recurse-from: ([A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:@[A-Za-z0-9._-]{1,32})?)\]$/;
const SENDER_NAME_LINE_RE = /^\[recurse-from-name: ([^\n]+)\](?![\s\S])/;
const ORIGIN_TAG_RE =
  /^\[recurse-origin: (operator|agent|scheduled|platform|service)\][ \t]*\r?\n/;
const PYTHON_SPACE =
  "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const DELIVERY_TRAILER_RE = new RegExp(
  `\\n?\\[recurse-delivery:[A-Za-z0-9_.:-]{1,128}\\][${PYTHON_SPACE}]*$`,
);
const STRIP_PYTHON_SPACE_RE = new RegExp(
  `^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`,
  "g",
);

function pyStrip(value: string): string {
  return value.replace(STRIP_PYTHON_SPACE_RE, "");
}

function consumeSenderLines(
  lines: string[],
): [string | null, string | null, string[]] {
  if (lines.length === 0) return [null, null, lines];
  const sender = SENDER_LINE_RE.exec(pyStrip(lines[0]!))?.[1];
  if (sender === undefined) return [null, null, lines];
  const rest = lines.slice(1);
  const candidate =
    rest.length > 0
      ? SENDER_NAME_LINE_RE.exec(pyStrip(rest[0]!))?.[1]
      : undefined;
  if (candidate === undefined) return [sender, null, rest];
  const name = Array.from(pyStrip(candidate)).slice(0, 256).join("");
  return [sender, name || null, rest.slice(1)];
}

/** Remove Recurse delivery framing from one Pi user payload. */
export function splitPiUserText(
  original: string,
): [
  origin: string | null,
  sender: string | null,
  senderName: string | null,
  text: string,
] {
  let text = original;
  const trailer = DELIVERY_TRAILER_RE.exec(text);
  if (trailer && trailer.index + trailer[0].length === text.length) {
    text = text.slice(0, trailer.index);
  }
  const tag = ORIGIN_TAG_RE.exec(text);
  if (tag) {
    const [sender, senderName, split] = consumeSenderLines(
      text.slice(tag[0].length).split("\n"),
    );
    return [tag[1]!, sender, senderName, split.join("\n")];
  }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const origin = ORIGIN_LINE_RE.exec(pyStrip(lines[index]!))?.[1];
    if (origin === undefined) continue;
    const [sender, senderName, consumed] = consumeSenderLines(
      lines.slice(index + 1),
    );
    return [origin, sender, senderName, consumed.join("\n")];
  }
  return [null, null, null, text];
}

function sessionStreamOk(path: string, maxSessionBytes: number): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && info.nlink === 1 && info.size <= maxSessionBytes;
  } catch {
    return false;
  }
}

/** Newest-first active-chain ranges below end for about `want` turns. */
export function scanSessionTurns(
  sessionId: string,
  sessionFile: string,
  sessionCwd: string,
  requestedEnd: number,
  want: number,
  options: {
    maxBytes?: number;
    maxSessionBytes: number;
    mustInclude?: number | null;
  },
): [rows: JsonlRange[], top: boolean, fence: null, ok: boolean] {
  const reader = new JsonlRangeReader(sessionFile);
  try {
    const opened = reader.header();
    if (opened === null) return [[], false, null, false];
    const [headerLength, header, stat] = opened;
    if (
      stat.nlink !== 1 ||
      stat.size > options.maxSessionBytes ||
      header.type !== "session" ||
      header.id !== sessionId ||
      header.cwd !== sessionCwd
    )
      return [[], false, null, false];
    const size = stat.size;
    const floor = headerLength;
    const identity = stat.identity;
    const maxBytes = options.maxBytes ?? 0;
    const scanMax = maxBytes
      ? Math.min(Math.max(asInt(maxBytes), 1), PI_TURN_SCAN_BYTES)
      : PI_TURN_SCAN_BYTES;
    let end = Math.min(Math.max(asInt(requestedEnd), 0), size);
    const indexed = new Map<
      string,
      {
        offset: number;
        end: number;
        entry: JsonObject;
        parentId: string | null;
      }
    >();
    let tip: string | null = null;
    let bottom = end;
    let budget = Math.min(CHUNK_BYTES, scanMax);
    let scanned = 0;
    const withMarkers = (
      chain: JsonlRange[],
      dangling: string | null,
    ): JsonlRange[] => {
      const chained = new Set(chain.map((row) => row[2].id));
      const fringe = new Set(chained);
      if (dangling !== null) fringe.add(dangling);
      const extra: JsonlRange[] = [];
      for (const node of indexed.values()) {
        if (
          node.entry.type === "compaction" &&
          !chained.has(node.entry.id) &&
          fringe.has(node.parentId)
        )
          extra.push([node.offset, node.end, node.entry]);
      }
      return extra.length === 0
        ? chain
        : [...chain, ...extra].sort((left, right) => right[0] - left[0]);
    };
    while (true) {
      const [ranges, capped] = reader.backwardLines(
        bottom,
        floor,
        budget,
        identity,
      );
      let rows = ranges.map(
        ([offset, , raw]) => [offset, raw] as [number, Bytes],
      );
      let pageCapped = capped;
      if (rows.length > PI_TURN_SCAN_LINES) {
        rows = rows.slice(0, PI_TURN_SCAN_LINES);
        pageCapped = true;
      }
      for (let index = 0; index < rows.length; index += 1) {
        const [offset, raw] = rows[index]!;
        const [, lineEnd] = ranges[index]!;
        const value = entry(raw);
        if (value === null) continue;
        const id = entryIdentity(value);
        if (id === null || indexed.has(id[0])) continue;
        indexed.set(id[0], {
          offset,
          end: lineEnd,
          entry: value,
          parentId: id[1],
        });
        if (tip === null) tip = id[0];
      }
      if (tip === null && (bottom <= floor || scanned >= scanMax)) {
        return [[], bottom <= floor, null, true];
      }
      if (tip === null) {
        const step = Math.min(budget, bottom - floor);
        bottom -= step;
        scanned += step;
        if (pageCapped) budget = Math.min(scanMax, budget * 4);
        if (!sessionStreamOk(sessionFile, options.maxSessionBytes)) {
          return [[], false, null, false];
        }
        continue;
      }
      const chain: JsonlRange[] = [];
      const seen = new Set<string>();
      let current: string | null = tip;
      let boundaries = 0;
      let missing = false;
      while (current !== null && !seen.has(current)) {
        seen.add(current);
        const node = indexed.get(current);
        if (node === undefined) {
          missing = true;
          break;
        }
        const { offset, end: lineEnd, entry: value, parentId } = node;
        const boundary = boundaryKind(value);
        if (boundary === "user" || boundary === "custom") boundaries += 1;
        chain.push([offset, lineEnd, value]);
        current = parentId;
        if (
          boundaries > want + 1 &&
          (options.mustInclude == null || offset <= options.mustInclude)
        )
          break;
      }
      if (current === null && !missing) {
        return [withMarkers(chain, current), true, null, true];
      }
      if (!missing) {
        return [withMarkers(chain, current), false, null, true];
      }
      if (bottom <= floor) {
        return [withMarkers(chain, current), false, null, true];
      }
      if (!pageCapped && budget >= scanMax) {
        return [withMarkers(chain, current), false, null, true];
      }
      if (pageCapped) budget = Math.min(scanMax, budget * 4);
      bottom = Math.min(...Array.from(indexed.values(), (node) => node.offset));
      if (!sessionStreamOk(sessionFile, options.maxSessionBytes)) {
        return [[], false, null, false];
      }
    }
  } catch {
    return [[], false, null, false];
  }
}
