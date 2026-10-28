import { createHash } from "node:crypto";
import net from "node:net";
import zlib from "node:zlib";

export type BodySpec =
  | null
  | undefined
  | readonly BodySpec[]
  | { readonly text: string; readonly repeat?: number }
  | { readonly hex: string }
  | { readonly random: number; readonly seed: string };

export interface CaseRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: readonly (readonly [string, string])[];
  readonly body?: BodySpec;
  readonly gzip?: {
    readonly body: BodySpec;
    readonly truncate?: number;
    readonly append_hex?: string;
  };
  readonly chunked?: boolean;
  readonly chunk?: number;
}

export interface NormalisedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface CorpusCase {
  readonly name: string;
  readonly request: CaseRequest;
  readonly response: NormalisedResponse;
  readonly events?: readonly string[];
}

export const KEPT_HEADERS = new Set([
  "accept-encoding",
  "accept-ranges",
  "allow",
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-length",
  "content-range",
  "content-security-policy",
  "content-type",
  "etag",
  "location",
  "retry-after",
  "set-cookie",
  "trailer",
  "vary",
  "x-accel-buffering",
  "x-content-type-options",
  "x-scripted",
]);
const TIMING_FIELDS = ["ms", "seconds", "window_s", "p50_ms_", "p95_ms_"];

const latin1 = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const concat = (parts: readonly Uint8Array[]) =>
  new Uint8Array(Buffer.concat(parts as Uint8Array[]));

export function materialise(spec: BodySpec): Uint8Array {
  if (spec === null || spec === undefined) return new Uint8Array();
  if (Array.isArray(spec)) return concat(spec.map(materialise));
  const one = spec as Exclude<BodySpec, readonly BodySpec[] | null | undefined>;
  if ("text" in one)
    return new TextEncoder().encode(one.text.repeat(one.repeat ?? 1));
  if ("hex" in one) return new Uint8Array(Buffer.from(one.hex, "hex"));
  const out: Uint8Array[] = [];
  let size = 0;
  for (let counter = 0; size < one.random; counter += 1) {
    const digest = createHash("sha256")
      .update(`${one.seed}:${counter}`)
      .digest();
    out.push(new Uint8Array(digest));
    size += digest.length;
  }
  return concat(out).subarray(0, one.random);
}

export function requestBytes(request: CaseRequest): Uint8Array {
  let body = materialise(request.body);
  if (request.gzip) {
    body = new Uint8Array(
      zlib.gzipSync(materialise(request.gzip.body), { level: 9 }),
    );
    if (request.gzip.truncate)
      body = body.subarray(0, body.length - request.gzip.truncate);
    body = concat([
      body,
      new Uint8Array(Buffer.from(request.gzip.append_hex ?? "", "hex")),
    ]);
  }
  const headers = (request.headers ?? []).map(
    ([name, value]) => [name, value] as [string, string],
  );
  const names = new Set(headers.map(([name]) => name.toLowerCase()));
  if (!names.has("host")) headers.unshift(["Host", "127.0.0.1"]);
  if (request.chunked) headers.push(["Transfer-Encoding", "chunked"]);
  else if (
    !names.has("content-length") &&
    (body.length || request.method !== "GET")
  )
    headers.push(["Content-Length", String(body.length)]);
  headers.push(["Connection", "close"]);
  let head = `${request.method} ${request.path} HTTP/1.1\r\n`;
  head += headers.map(([n, v]) => `${n}: ${v}\r\n`).join("") + "\r\n";
  if (request.chunked) {
    const size = request.chunk ?? 8192;
    const framed: Uint8Array[] = [];
    for (let i = 0; i < body.length; i += size) {
      const piece = body.subarray(i, i + size);
      framed.push(latin1(`${piece.length.toString(16)}\r\n`), piece);
      framed.push(latin1("\r\n"));
    }
    framed.push(latin1("0\r\n\r\n"));
    body = concat(framed);
  }
  return concat([latin1(head), body]);
}

export function exchange(port: number, raw: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const method = Buffer.from(raw).toString("latin1").split(" ", 1)[0];
    const socket = net.connect(port, "127.0.0.1");
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(concat(chunks));
    };
    const complete = () => {
      const response = Buffer.from(concat(chunks));
      const split = response.indexOf("\r\n\r\n");
      if (split < 0) return false;
      const head = response.subarray(0, split).toString("latin1");
      const status = Number(head.split("\r\n", 1)[0]!.split(" ")[1]);
      const bodyLength = response.length - split - 4;
      if (method === "HEAD" || status === 204 || status === 304) return true;
      const transfer = /(?:^|\r\n)transfer-encoding:\s*[^\r\n]*chunked/i.test(
        head,
      );
      if (transfer)
        return response
          .subarray(split + 4)
          .includes(Buffer.from("\r\n0\r\n\r\n"));
      const match = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(head);
      return match ? bodyLength >= Number(match[1]) : false;
    };
    socket.on("data", (data) => {
      chunks.push(new Uint8Array(data));
      if (complete()) finish();
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      if (error.code === "ECONNRESET" || error.code === "EPIPE") return;
      settled = true;
      reject(error);
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(concat(chunks));
      }
    });
    socket.setTimeout(20_000, () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.write(raw);
  });
}

function parseResponse(raw: Uint8Array) {
  const buf = Buffer.from(raw);
  const split = buf.indexOf("\r\n\r\n");
  const lines = buf.subarray(0, split).toString("latin1").split("\r\n");
  let rest = new Uint8Array(buf.subarray(split + 4));
  const status = Number(lines[0]!.split(" ")[1]);
  const headers = lines.slice(1).map((line) => {
    const at = line.indexOf(":");
    return [
      line.slice(0, at).trim().toLowerCase(),
      line.slice(at + 1).trim(),
    ] as const;
  });
  if (
    headers.some(([n, v]) => n === "transfer-encoding" && v.includes("chunked"))
  ) {
    const body: Uint8Array[] = [];
    let data = Buffer.from(rest);
    for (;;) {
      const end = data.indexOf("\r\n");
      const size = parseInt(
        data.subarray(0, end).toString().split(";")[0]!,
        16,
      );
      if (!size) break;
      body.push(new Uint8Array(data.subarray(end + 2, end + 2 + size)));
      data = data.subarray(end + 2 + size + 2);
    }
    rest = concat(body);
  }
  return { status, headers, body: rest };
}

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export function normalise(raw: Uint8Array, method: string): NormalisedResponse {
  const parsed = parseResponse(raw);
  let body = parsed.body;
  const headers: Record<string, string> = {};
  for (const [name, value] of parsed.headers)
    if (KEPT_HEADERS.has(name))
      headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  if (headers["content-length"] === String(body.length) && method !== "HEAD")
    headers["content-length"] = "<wire>";
  if (headers["content-encoding"] === "gzip" && body.length)
    body = new Uint8Array(zlib.gunzipSync(body));
  if (headers.etag === `W/"${sha256(body)}"` && body.length)
    headers.etag = 'W/"<sha256 of body>"';
  if (headers.allow)
    headers.allow = headers.allow
      .split(",")
      .map((item) => item.trim())
      .sort()
      .join(", ");
  if (headers.location)
    headers.location = headers.location.replace(
      /^(\w+:\/\/[^/:]+):\d+/,
      "$1:<PORT>",
    );
  const kind = (headers["content-type"] ?? "").split(";")[0]!.trim();
  let rendered: unknown;
  if (kind === "application/json" && body.length)
    rendered = { json: JSON.parse(Buffer.from(body).toString("utf8")) };
  else if (kind === "application/x-ndjson" && body.length <= 65536)
    rendered = {
      ndjson: Buffer.from(body)
        .toString("utf8")
        .split("\n")
        .filter((line) => line)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return line;
          }
        }),
    };
  else if (kind.startsWith("text/") && body.length <= 512)
    rendered = { text: Buffer.from(body).toString("utf8") };
  else if (!body.length) rendered = { empty: true };
  else rendered = { bytes: body.length, sha256: sha256(body) };
  return { status: parsed.status, headers, body: rendered };
}

export function normaliseEvent(
  line: string,
  gzipIn: boolean,
  gzipOut: boolean,
): string {
  const parts: string[] = [];
  for (const part of line.split(" ")) {
    const key = part.split("=")[0]!;
    if (TIMING_FIELDS.some((prefix) => key.startsWith(prefix))) continue;
    if (gzipIn && key === "bytes_in") parts.push("bytes_in=<gzip>");
    else if (gzipOut && (key === "bytes_out" || /^bytes_\d+$/.test(key)))
      parts.push(`${key}=<gzip>`);
    else parts.push(part);
  }
  return parts.join(" ");
}

export interface Replayed {
  readonly name: string;
  readonly response: NormalisedResponse;
  readonly events?: string[];
}

export async function runCases(
  port: number,
  cases: readonly CorpusCase[],
  events?: string[],
): Promise<Replayed[]> {
  const out: Replayed[] = [];
  for (const item of cases) {
    const before = events?.length ?? 0;
    const raw = await exchange(port, requestBytes(item.request));
    const response = normalise(raw, item.request.method);
    if (events === undefined) {
      out.push({ name: item.name, response });
      continue;
    }
    const deadline = Date.now() + 2000;
    while (events.length === before && Date.now() < deadline)
      await Bun.sleep(5);
    await Bun.sleep(20);
    out.push({
      name: item.name,
      response,
      events: events
        .slice(before)
        .map((line) =>
          normaliseEvent(
            line,
            item.request.gzip !== undefined,
            response.headers["content-encoding"] === "gzip",
          ),
        ),
    });
  }
  return out;
}

export function mismatches(
  cases: readonly CorpusCase[],
  replayed: readonly Replayed[],
  expectEvents = true,
): string[] {
  const problems: string[] = [];
  cases.forEach((item, index) => {
    const got = replayed[index]!;
    const want: Record<string, unknown> = { response: item.response };
    const have: Record<string, unknown> = { response: got.response };
    if (expectEvents && item.events !== undefined) {
      want.events = item.events;
      have.events = got.events;
    }
    if (!Bun.deepEquals(want, have))
      problems.push(
        `${item.name}:\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(have)}`,
      );
  });
  return problems;
}
