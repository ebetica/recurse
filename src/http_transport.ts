// Transport order: accounting -> compression -> auth/CSRF -> decode -> route.
// Bound gzip wire/decoded bytes and concurrent decoded bodies; decode off-loop.
// HEAD/range/SSE/no-transform/existing codings pass through unchanged.
// Log route templates and wire counts, never raw paths/queries/bodies.

import zlib from "node:zlib";
import {
  requestTiming,
  withRequestTiming,
} from "./observability/request_timing";

import {
  logEvent,
  INFO,
  type RuntimeLogger,
} from "./observability/runtime_logging";
import { HttpError, type Exchange, type Handler } from "./web/router";

export const DEFAULT_MAX_ENCODED_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_DECODED_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PROBE_BYTES = 1024 * 1024;
export const DEFAULT_MIN_SIZE = 1024;
export const DEFAULT_MIN_SAVINGS = 256;
export const DEFAULT_MIN_SAVINGS_RATIO = 0.05;
export const DEFAULT_STREAMING_MIN_SAVINGS_RATIO = 0.2;
export const DEFAULT_MAX_CONCURRENT_JOBS = 4;
export const DEFAULT_REQUEST_BODY_TIMEOUT = 30.0;

type ResponseInit_ = NonNullable<ConstructorParameters<typeof Response>[1]>;
type HeaderInit = ResponseInit_["headers"];
type BodyInit_ = ConstructorParameters<typeof Response>[0];
/** Buffer → plain Uint8Array view (the Bun and Node typings disagree). */
const u8 = (buf: Buffer): Uint8Array =>
  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const crc32 = (zlib as unknown as { crc32(data: Uint8Array): number }).crc32;

interface Hdrs {
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/** Python `str.strip()` over the Latin-1 range header values can hold. */
const PY_SPACE = "[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0]";
const STRIP_RE = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "g");
const strip = (text: string): string => text.replace(STRIP_RE, "");

/** A small counting semaphore; Python's asyncio.Semaphore. */
export class Slots {
  private waiters: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

export class RequestCodingError extends HttpError {
  constructor(status = 400, detail = "invalid compressed request body") {
    super(status, detail);
  }
}
const timedOut = () =>
  new RequestCodingError(408, "compressed request body timed out");
const tooLarge = () => new RequestCodingError(413, "request body is too large");
const unsupported = () =>
  new RequestCodingError(415, "unsupported request content encoding");

/** Cheap observable counter: how many gzip request bodies reached a decoder. */
export const decoderStats = { started: 0 };

function headerValues(headers: Hdrs, name: string): string[] {
  const value = headers.get(name);
  return value === null ? [] : [value];
}

function singleContentLength(headers: Hdrs): number | null {
  const value = headers.get("content-length");
  if (value === null) return null;
  // Invariant: Bun joins repeated fields with ", ", which the digit rule
  // refuses: more than one value is invalid.
  if (!/^[0-9]+$/.test(strip(value)))
    throw new RequestCodingError(400, "invalid compressed request body");
  return Number(strip(value));
}

function requestCoding(headers: Hdrs): "identity" | "gzip" {
  const value = headers.get("content-encoding");
  if (value === null) return "identity";
  const coding = strip(value).toLowerCase();
  if (coding !== "identity" && coding !== "gzip") throw unsupported();
  return coding;
}

function errorResponse(error: HttpError): Response {
  const body = JSON.stringify({ detail: error.detail });
  const headers: [string, string][] = [
    ["content-type", "application/json"],
    ["content-length", String(Buffer.byteLength(body))],
  ];
  // Invariant: RFC 9110 lets a 415 advertise the request codings the server
  // accepts.
  if (error.status === 415) headers.push(["accept-encoding", "gzip, identity"]);
  return new Response(body, { status: error.status, headers });
}

const INTEGRITY = ["content-digest", "digest", "content-md5"];

function stripContentIntegrity(headers: Hdrs, declarations = false): void {
  for (const name of INTEGRITY) headers.delete(name);
  if (!declarations) return;
  const retained = (headers.get("trailer") ?? "")
    .split(",")
    .map(strip)
    .filter((item) => item && !INTEGRITY.includes(item.toLowerCase()));
  if (retained.length) headers.set("trailer", retained.join(", "));
  else headers.delete("trailer");
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  deadline: number | null,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      if (deadline === null) next = await reader.read();
      else {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw timedOut();
        let timer: ReturnType<typeof setTimeout> | undefined;
        next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(timedOut()), remaining);
          }),
        ]).finally(() => clearTimeout(timer));
      }
      if (next.done) break;
      seen += next.value.byteLength;
      if (seen > maximum) throw tooLarge();
      parts.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  return concatBytes(parts);
}

/** Decode one complete gzip member exactly as zlib's 16+MAX_WBITS mode does. */
export async function gunzipBounded(
  data: Uint8Array,
  maximum: number,
): Promise<Uint8Array> {
  const bad = () => new RequestCodingError();
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 10 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 8)
    throw bad();
  const flags = buf[3]!;
  if (flags & 0xe0) throw bad();
  let offset = 10;
  if (flags & 4) {
    if (buf.length < offset + 2) throw bad();
    offset += 2 + buf.readUInt16LE(offset);
  }
  for (const bit of [8, 16]) {
    if (!(flags & bit)) continue;
    const end = buf.indexOf(0, offset);
    if (end < 0) throw bad();
    offset = end + 1;
  }
  if (flags & 2) {
    if (buf.length < offset + 2) throw bad();
    if ((crc32(data.subarray(0, offset)) & 0xffff) !== buf.readUInt16LE(offset))
      throw bad();
    offset += 2;
  }
  if (offset > buf.length) throw bad();
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    // Invariant: The async form decodes on the zlib thread pool, off the event
    // loop.
    result = await new Promise((resolve, reject) =>
      zlib.inflateRaw(
        data.subarray(offset),
        {
          info: true,
          maxOutputLength: Math.max(1, maximum + 1),
        } as zlib.ZlibOptions,
        (error, out) =>
          error ? reject(error) : resolve(out as unknown as typeof result),
      ),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      throw tooLarge();
    throw bad();
  }
  if (result.buffer.length > maximum) throw tooLarge();
  const trailer = offset + result.engine.bytesWritten;
  // Invariant: A truncated trailer, a bad CRC/length, or any bytes after the
  // member (a second member included) are refused like zlib's unused_data.
  if (buf.length !== trailer + 8) throw bad();
  const decoded = u8(result.buffer);
  if (buf.readUInt32LE(trailer) !== crc32(decoded)) throw bad();
  if (buf.readUInt32LE(trailer + 4) !== decoded.byteLength % 2 ** 32)
    throw bad();
  return decoded;
}

export interface DecompressionOptions {
  readonly enabled?: boolean;
  readonly maxEncodedBytes?: number;
  readonly maxDecodedBytes?: number;
  readonly maxConcurrentJobs?: number;
  readonly maxConcurrentGzipRequests?: number;
  readonly requestBodyTimeout?: number;
}

/** Decode and bound every HTTP request body; register inside auth. */
export function requestDecompression(
  next: Handler,
  options: DecompressionOptions = {},
): Handler {
  const enabled = options.enabled ?? true;
  const maxEncoded = options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES;
  const maxDecoded = options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
  const workSlots = new Slots(
    options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
  );
  const gzipSlots = new Slots(
    options.maxConcurrentGzipRequests ?? DEFAULT_MAX_CONCURRENT_JOBS,
  );
  const timeout =
    (options.requestBodyTimeout ?? DEFAULT_REQUEST_BODY_TIMEOUT) * 1000;
  return async (ex) => {
    try {
      const { headers } = ex.request;
      const coding = requestCoding(headers);
      const length = singleContentLength(headers);
      let routeLimit = ex.bodyLimit;
      if (routeLimit === null || !(routeLimit > 0)) routeLimit = maxDecoded;
      const encodedMaximum = Math.min(maxEncoded, routeLimit);
      const decodedMaximum = Math.min(maxDecoded, routeLimit);
      const declared =
        coding === "gzip"
          ? encodedMaximum
          : Math.min(encodedMaximum, decodedMaximum);
      if (length !== null && length > declared) throw tooLarge();
      if (coding === "gzip" && !enabled) throw unsupported();
      const source = ex.request;
      if (coding === "identity") {
        if (source.body)
          ex.request = withBody(
            source,
            source.headers,
            boundedStream(
              source.body,
              Math.min(encodedMaximum, decodedMaximum),
            ),
          );
        return await next(ex);
      }
      // Invariant: Hold the slot through handling so small compressed inputs
      // cannot create many simultaneous 32 MiB decoded bodies.
      return await gzipSlots.run(async () => {
        const decodedHeaders = new Headers(
          source.headers as unknown as HeaderInit,
        );
        decodedHeaders.delete("content-encoding");
        decodedHeaders.delete("content-length");
        stripContentIntegrity(decodedHeaders, true);
        let decoded: Promise<Uint8Array> | null = null;
        const decode = () =>
          (decoded ??= (async () => {
            const encoded = source.body
              ? await readBounded(
                  source.body,
                  encodedMaximum,
                  performance.now() + timeout,
                )
              : new Uint8Array();
            decoderStats.started += 1;
            return await workSlots.run(async () =>
              gunzipBounded(encoded, decodedMaximum),
            );
          })());
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const bytes = await decode();
            if (bytes.byteLength) controller.enqueue(bytes);
            controller.close();
          },
        });
        ex.request = withBody(source, decodedHeaders, body);
        return await next(ex);
      });
    } catch (error) {
      if (error instanceof RequestCodingError) return errorResponse(error);
      throw error;
    }
  };
}

function withBody(
  source: Request,
  headers: Hdrs,
  body: ReadableStream<Uint8Array>,
): Request {
  return new Request(source.url, {
    method: source.method,
    headers: headers as unknown as HeaderInit,
    body,
    signal: source.signal,
    duplex: "half",
  } as ConstructorParameters<typeof Request>[1]);
}

function boundedStream(
  body: ReadableStream<Uint8Array>,
  maximum: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maximum) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
}

export interface Negotiation {
  readonly gzip: number;
  readonly identity: number;
  readonly explicit: ReadonlyMap<string, number>;
  readonly wildcard: number;
  readonly headerPresent: boolean;
}

function quality(n: Negotiation, coding: string): number {
  if (coding === "identity") return n.identity;
  // Invariant: An absent field means any app-supplied coding is acceptable.
  if (!n.headerPresent) return 1;
  return n.explicit.get(coding) ?? n.wildcard;
}
const preferGzip = (n: Negotiation) => n.gzip > 0 && n.gzip >= n.identity;
const requireGzip = (n: Negotiation) => n.gzip > 0 && n.identity <= 0;

const QVALUE_RE = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;

export function negotiateAcceptEncoding(headers: Hdrs): Negotiation {
  const values = headerValues(headers, "accept-encoding");
  if (!values.length)
    return {
      gzip: 0,
      identity: 1,
      explicit: new Map(),
      wildcard: 0,
      headerPresent: false,
    };
  const explicit = new Map<string, number>();
  for (const item of values.join(",").split(",")) {
    const parts = item.split(";").map(strip);
    const token = parts[0]!.toLowerCase();
    if (!token) continue;
    let q = 1;
    let valid = true;
    for (const parameter of parts.slice(1)) {
      const at = parameter.indexOf("=");
      const raw = at < 0 ? "" : strip(parameter.slice(at + 1));
      if (at < 0 || strip(parameter.slice(0, at)).toLowerCase() !== "q") {
        valid = false;
        break;
      }
      if (!QVALUE_RE.test(raw)) {
        valid = false;
        break;
      }
      q = Number(raw);
    }
    if (valid) explicit.set(token, q);
  }
  const wildcard = explicit.get("*") ?? 0;
  return {
    gzip: explicit.get("gzip") ?? wildcard,
    identity: explicit.get("identity") ?? (explicit.get("*") === 0 ? 0 : 1),
    explicit,
    wildcard,
    headerPresent: true,
  };
}

function mergeVary(headers: Hdrs): void {
  const values = (headers.get("vary") ?? "")
    .split(",")
    .map(strip)
    .filter(Boolean);
  if (values.includes("*")) {
    headers.set("vary", "*");
    return;
  }
  if (!values.some((item) => item.toLowerCase() === "accept-encoding"))
    values.push("Accept-Encoding");
  headers.set("vary", values.join(", "));
}

const noTransform = (headers: Hdrs) =>
  (headers.get("cache-control") ?? "")
    .split(",")
    .some(
      (item) => strip(item.split("=")[0]!).toLowerCase() === "no-transform",
    );

function existingCodingsAcceptable(headers: Hdrs, n: Negotiation): boolean {
  const codings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((item) => strip(item).toLowerCase())
    .filter(Boolean);
  return codings.length > 0 && codings.every((item) => quality(n, item) > 0);
}

const isEventStream = (headers: Hdrs) =>
  (headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");

function noBody(method: string, status: number): boolean {
  return method === "HEAD" || status < 200 || [204, 205, 304].includes(status);
}

function transformable(method: string, response: Response): boolean {
  const { headers, status } = response;
  return !(
    method === "HEAD" ||
    status < 200 ||
    [204, 205, 206, 304].includes(status) ||
    headers.has("content-range") ||
    headers.has("content-encoding") ||
    noTransform(headers) ||
    isEventStream(headers)
  );
}

function beneficial(
  original: number,
  compressed: number,
  minimum: number,
  minimumSavings: number,
  minimumRatio: number,
): boolean {
  if (original < minimum) return false;
  const required = Math.max(minimumSavings, Math.ceil(original * minimumRatio));
  return original - compressed >= required;
}

/** Bound a probe across 16 evenly spaced regions of the retained parts. */
export function representativeSample(
  parts: readonly Uint8Array[],
  total: number,
  limit: number,
): Uint8Array {
  if (total <= limit) return concatBytes(parts);
  const count = 16;
  const width = Math.max(1, Math.floor(limit / count));
  const output: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    let offset = Math.floor(((total - width) * index) / (count - 1));
    let remaining = width;
    let base = 0;
    for (const part of parts) {
      const end = base + part.byteLength;
      if (offset < end && remaining) {
        const local = Math.max(0, offset - base);
        const take = Math.min(remaining, part.byteLength - local);
        output.push(part.subarray(local, local + take));
        offset += take;
        remaining -= take;
      }
      base = end;
      if (!remaining) break;
    }
  }
  return concatBytes(output).subarray(0, limit);
}

const gzipAsync = (data: Uint8Array, level: number) =>
  new Promise<Uint8Array>((resolve, reject) =>
    zlib.gzip(data, { level }, (error, out) =>
      error ? reject(error) : resolve(u8(out)),
    ),
  );

/** One gzip stream with a sync flush after every chunk, as Python streams. */
class StreamingGzip {
  private readonly gz: zlib.Gzip;
  private out: Buffer[] = [];
  constructor(level: number) {
    this.gz = zlib.createGzip({ level });
    this.gz.on("data", (chunk: Buffer) => this.out.push(chunk));
  }
  async push(data: Uint8Array, final: boolean): Promise<Uint8Array> {
    if (final)
      await new Promise<void>((resolve, reject) => {
        this.gz.once("end", resolve);
        this.gz.once("error", reject);
        this.gz.end(data);
      });
    else {
      if (data.byteLength) this.gz.write(data);
      await new Promise<void>((resolve) =>
        this.gz.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve()),
      );
    }
    const chunk = concatBytes(this.out.map(u8));
    this.out = [];
    return chunk;
  }
  close(): void {
    this.gz.destroy();
  }
}

const weakEtagOf = (headers: Hdrs) => {
  const etag = headers.get("etag");
  return etag !== null && etag.startsWith('W/"') ? etag : null;
};

function notAcceptable(): Response {
  const body = '{"detail":"no acceptable response content encoding"}';
  return new Response(body, {
    status: 406,
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
      vary: "Accept-Encoding",
    },
  });
}

function identityHeaders(method: string, response: Response) {
  const headers = new Headers(response.headers as unknown as HeaderInit);
  mergeVary(headers);
  const adaptiveUncertain = !(
    headers.has("content-encoding") ||
    headers.has("content-range") ||
    noTransform(headers) ||
    isEventStream(headers)
  );
  if ((response.status === 304 || method === "HEAD") && adaptiveUncertain) {
    // Invariant: The matching adaptive GET may use gzip and omit these fields;
    // a weak validator already covers both codings.
    const weak = weakEtagOf(headers);
    for (const field of ["etag", "content-length", ...INTEGRITY])
      headers.delete(field);
    if (weak !== null) headers.set("etag", weak);
  }
  return headers;
}

function encodedHeaders(response: Response, length: number | null) {
  const headers = new Headers(response.headers as unknown as HeaderInit);
  mergeVary(headers);
  headers.set("content-encoding", "gzip");
  if (length === null) headers.delete("content-length");
  else headers.set("content-length", String(length));
  stripContentIntegrity(headers, true);
  headers.delete("accept-ranges");
  // Invariant: Strong validators cannot survive adaptive coding; weak ones
  // cover the pre-compression representation and stay.
  if (weakEtagOf(headers) === null) headers.delete("etag");
  return headers;
}

function rebuilt(response: Response, headers: Hdrs, body: BodyInit_): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers as unknown as HeaderInit,
  });
}

/** Prefix parts followed by whatever the reader still holds. */
function resumed(
  parts: readonly Uint8Array[],
  reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
  } | null,
  encode?: (chunk: Uint8Array, final: boolean) => Promise<Uint8Array>,
  cleanup?: () => void,
): ReadableStream<Uint8Array> {
  const queue = [...parts];
  let finished = reader === null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let chunk: Uint8Array;
        let final: boolean;
        if (queue.length) {
          chunk = queue.shift()!;
          final = finished && !queue.length;
        } else if (!finished) {
          const next = await reader!.read();
          if (next.done) {
            finished = true;
            chunk = new Uint8Array();
            final = true;
          } else {
            chunk = next.value!;
            final = false;
          }
        } else {
          controller.close();
          cleanup?.();
          return;
        }
        const out = encode ? await encode(chunk, final) : chunk;
        if (out.byteLength) controller.enqueue(out);
        if (final) {
          controller.close();
          cleanup?.();
          return;
        }
        if (out.byteLength) return;
      }
    },
    async cancel(reason) {
      cleanup?.();
      await reader?.cancel(reason);
    },
  });
}

export interface CompressionOptions {
  readonly enabled?: boolean;
  readonly probeBytes?: number;
  readonly minimumSize?: number;
  readonly minimumSavings?: number;
  readonly minimumSavingsRatio?: number;
  readonly streamingMinSavingsRatio?: number;
  readonly bufferedLevel?: number;
  readonly streamingLevel?: number;
  readonly maxConcurrentJobs?: number;
}

/** Adaptively gzip every negotiable response; register outside auth. */
export function responseCompression(
  next: Handler,
  options: CompressionOptions = {},
): Handler {
  const probe = options.probeBytes ?? DEFAULT_PROBE_BYTES;
  const minimum = options.minimumSize ?? DEFAULT_MIN_SIZE;
  const savings = options.minimumSavings ?? DEFAULT_MIN_SAVINGS;
  const ratio = options.minimumSavingsRatio ?? DEFAULT_MIN_SAVINGS_RATIO;
  const streamRatio =
    options.streamingMinSavingsRatio ?? DEFAULT_STREAMING_MIN_SAVINGS_RATIO;
  const bufferedLevel = options.bufferedLevel ?? 4;
  const streamingLevel = options.streamingLevel ?? 1;
  const slots = new Slots(
    options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
  );
  const work = <T>(fn: () => Promise<T>) => slots.run(fn);
  if (options.enabled === false) return next;

  return async (ex) => {
    const method = ex.request.method.toUpperCase();
    const n = negotiateAcceptEncoding(ex.request.headers);
    const response = await next(ex);
    const { headers, status } = response;

    if (!preferGzip(n)) {
      const acceptable = headers.has("content-encoding")
        ? existingCodingsAcceptable(headers, n)
        : noBody(method, status) || n.identity > 0;
      if (!acceptable) return discard(response, notAcceptable());
      mergeVary(headers);
      return response;
    }
    if (headers.has("content-encoding")) {
      if (!existingCodingsAcceptable(headers, n))
        return discard(response, notAcceptable());
      return inPlace(response, identityHeaders(method, response));
    }
    if (!transformable(method, response)) {
      if (requireGzip(n) && !noBody(method, status))
        return discard(response, notAcceptable());
      return inPlace(response, identityHeaders(method, response));
    }

    // Invariant: A body that had a declared length keeps it (bytes); a streamed
    // one stays chunked, as uvicorn framed the original messages.
    const identity = (parts: Uint8Array[], reader: typeof source) =>
      rebuilt(
        response,
        identityHeaders(method, response),
        reader === null && headers.has("content-length")
          ? concatBytes(parts)
          : resumed(parts, reader),
      );
    const choose = (raw: number, compressed: number, r: number) =>
      requireGzip(n) || beneficial(raw, compressed, minimum, savings, r);

    const source = response.body ? response.body.getReader() : null;
    const buffer: Uint8Array[] = [];
    let buffered = 0;
    for (;;) {
      const read = source ? await source.read() : { done: true as const };
      if (read.done) break;
      const body = read.value!;
      if (body.byteLength < probe - buffered) {
        buffer.push(body);
        buffered += body.byteLength;
        continue;
      }
      // Invariant: Python sees `more_body` with each message; a stream reveals
      // its end only on the next read. A chunk followed by the end is a final
      // message.
      const after = await source!.read();
      if (after.done) {
        buffer.push(body);
        buffered += body.byteLength;
        break;
      }
      // Invariant: Streaming: the prefix decides once, and the headers then
      // commit.
      const parts = [...buffer, body].filter((part) => part.byteLength);
      const total = buffered + body.byteLength;
      const peeked = after.value!;
      const sample = representativeSample(parts, total, probe);
      const compressedSample = await work(() => gzipAsync(sample, 1));
      if (!choose(sample.byteLength, compressedSample.byteLength, streamRatio))
        return identity([...parts, peeked], source);
      const gz = new StreamingGzip(streamingLevel);
      return rebuilt(
        response,
        encodedHeaders(response, null),
        resumed(
          [...parts, peeked],
          source,
          (chunk, final) => work(() => gz.push(chunk, final)),
          () => gz.close(),
        ),
      );
    }

    const parts = buffer.filter((part) => part.byteLength);
    const total = buffered;
    if (total < minimum && !requireGzip(n)) return identity(parts, null);
    if (total > probe && !requireGzip(n)) {
      const sample = representativeSample(parts, total, probe);
      const compressedSample = await work(() => gzipAsync(sample, 1));
      if (!choose(sample.byteLength, compressedSample.byteLength, ratio))
        return identity(parts, null);
    }
    const raw = concatBytes(parts);
    const compressed = await work(() => gzipAsync(raw, bufferedLevel));
    // Invariant: The final comparison keeps buffered gzip from ever expanding
    // the body.
    if (choose(total, compressed.byteLength, ratio))
      return rebuilt(
        response,
        encodedHeaders(response, compressed.byteLength),
        compressed,
      );
    return identity(parts, null);
  };
}

/** Keep the original body source (bytes keep their length); swap headers. */
function inPlace(
  response: Response,
  headers: Hdrs & Iterable<[string, string]>,
) {
  for (const name of [...response.headers.keys()])
    response.headers.delete(name);
  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

function discard(original: Response, replacement: Response): Response {
  void original.body?.cancel().catch(() => {});
  return replacement;
}

export const SUMMARY_INTERVAL_SECONDS = 300.0;
export const HEARTBEAT_INTERVAL_SECONDS = 60.0;
export const SUMMARY_TOP_ROUTES = 10;
export const SUMMARY_MAX_SAMPLES = 1024;
export const SUMMARY_MAX_ROUTES = 64;
export const UNKNOWN_ROUTE = ":unknown";

/** `/api/x/{cid}` and `/static/{path:path}` → log-safe `:param` segments. */
export function templateRoute(template: string | null): string {
  if (template === null || !template.startsWith("/")) return UNKNOWN_ROUTE;
  return template.replace(/\{([\p{L}\p{N}_]+)(:[^}]*)?\}/gu, ":$1");
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(ratio * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)]!;
}

class RouteWindow {
  count = 0;
  bytesIn = 0;
  bytesOut = 0;
  samples: number[] = [];
  add(bytesIn: number, bytesOut: number, ms: number, random: () => number) {
    this.count += 1;
    this.bytesIn += bytesIn;
    this.bytesOut += bytesOut;
    if (this.samples.length < SUMMARY_MAX_SAMPLES) this.samples.push(ms);
    else this.samples[Math.floor(random() * SUMMARY_MAX_SAMPLES)] = ms;
  }
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export interface AccountingOptions {
  readonly logger: RuntimeLogger;
  readonly summaryInterval?: number;
  readonly heartbeatInterval?: number;
  /** Monotonic seconds. */
  readonly clock?: () => number;
  readonly random?: () => number;
}

// Count wire bytes per response and log bandwidth events; register outermost.
export function httpAccounting(
  next: Handler,
  options: AccountingOptions,
): Handler {
  const clock = options.clock ?? (() => performance.now() / 1000);
  const random = options.random ?? Math.random;
  const summaryInterval = options.summaryInterval ?? SUMMARY_INTERVAL_SECONDS;
  const heartbeatInterval =
    options.heartbeatInterval ?? HEARTBEAT_INTERVAL_SECONDS;
  let windows = new Map<string, RouteWindow>();
  let windowStart = clock();
  const log = (event: string, fields: Record<string, unknown>) => {
    try {
      const { conversation_id, ...eventFields } = fields;
      logEvent(options.logger, INFO, event, {
        fields: eventFields,
        conversation_id,
      });
    } catch {
      // Invariant: Accounting must never break a response.
    }
  };

  const record = (
    key: string,
    bytesIn: number,
    bytesOut: number,
    ms: number,
    now: number,
  ) => {
    let window = windows.get(key);
    if (window === undefined) {
      if (windows.size >= SUMMARY_MAX_ROUTES) {
        key = `${key.split("@")[0]}@:other`;
        window = windows.get(key);
      }
      if (window === undefined) windows.set(key, (window = new RouteWindow()));
    }
    window.add(bytesIn, bytesOut, ms, random);
    if (now - windowStart < summaryInterval) return;
    const ranked = [...windows.entries()]
      .sort((a, b) => b[1].bytesOut - a[1].bytesOut)
      .slice(0, SUMMARY_TOP_ROUTES);
    const fields: Record<string, unknown> = {
      window_s: round3(now - windowStart),
    };
    ranked.forEach(([routeKey, item], index) => {
      const samples = [...item.samples].sort((a, b) => a - b);
      fields[`route_${index}`] = routeKey;
      fields[`count_${index}`] = item.count;
      fields[`bytes_${index}`] = item.bytesOut;
      fields[`p50_ms_${index}`] = round3(percentile(samples, 0.5));
      fields[`p95_ms_${index}`] = round3(percentile(samples, 0.95));
    });
    windows = new Map();
    windowStart = now;
    log("http_summary", fields);
  };

  return async (ex) => {
    const started = clock();
    const timing = requestTiming(ex.path);
    const method = ex.request.method;
    const state = {
      bytesIn: 0,
      bytesOut: 0,
      chunks: 0,
      events: 0,
      lastHeartbeat: started,
    };
    const source = ex.request;
    if (source.body)
      ex.request = withBody(
        source,
        source.headers,
        source.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              state.bytesIn += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
        ),
      );
    let status = 500;
    let encoding = "identity";
    let sse = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const ended = clock();
      const ms = (ended - started) * 1000;
      const route = templateRoute(ex.route);
      const trace =
        ex.request.headers.get("x-recurse-trace") ?? ex.query.switch_trace;
      log("http_response", {
        method,
        route,
        status,
        bytes_in: state.bytesIn,
        bytes_out: state.bytesOut,
        encoding,
        ms,
        ...timing?.fields(),
        ...(ex.params.cid ? { conversation_id: ex.params.cid } : {}),
        ...(typeof trace === "string" && /^[a-f0-9]{32}$/.test(trace)
          ? { trace_id: trace }
          : {}),
      });
      if (sse || state.chunks > 1)
        log("sse_stream", {
          route,
          bytes_out: state.bytesOut,
          events: state.events,
          seconds: ended - started,
        });
      record(`${method}@${route}`, state.bytesIn, state.bytesOut, ms, ended);
    };
    let response: Response;
    try {
      response = await withRequestTiming(timing, () => next(ex));
    } catch (error) {
      finish();
      throw error;
    }
    status = response.status;
    encoding = response.headers.get("content-encoding") ?? "identity";
    sse = isEventStream(response.headers);
    // Invariant: A sized body goes to Bun untouched, so Bun keeps its
    // Content-Length (Bun frames any wrapped stream as chunked). It is counted
    // by its declared length.
    const declared = response.headers.get("content-length");
    if (!response.body || (declared !== null && /^[0-9]+$/.test(declared))) {
      if (response.body) state.bytesOut = Number(declared);
      state.chunks = 1;
      finish();
      return response;
    }
    const reader = response.body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (error) {
          finish();
          throw error;
        }
        if (read.done) {
          controller.close();
          finish();
          return;
        }
        const chunk = read.value;
        state.bytesOut += chunk.byteLength;
        state.chunks += 1;
        if (sse) state.events += countBlankLines(chunk);
        if (sse || state.chunks > 1) {
          const now = clock();
          if (now - state.lastHeartbeat >= heartbeatInterval) {
            state.lastHeartbeat = now;
            log("sse_heartbeat", {
              route: templateRoute(ex.route),
              bytes_out: state.bytesOut,
              events: state.events,
              seconds: now - started,
            });
          }
        }
        controller.enqueue(chunk);
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason);
      },
    });
    return rebuilt(response, response.headers, counted);
  };
}

function countBlankLines(chunk: Uint8Array): number {
  let count = 0;
  for (let i = 0; i + 1 < chunk.byteLength; i += 1)
    if (chunk[i] === 10 && chunk[i + 1] === 10) {
      count += 1;
      i += 1;
    }
  return count;
}

export type { Exchange };
