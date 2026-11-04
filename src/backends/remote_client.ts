// Bounded backend calls refuse redirects; only pre-connect failure is unsent.
// Stream with allowed headers and sandboxing; redact echoed keys.
// API v1 JSON is bounded and decoded before redaction, including escaped keys.
// Trusted agent markers require keys; never derive them from operator headers.
import { slowSpan } from "../observability/slow_span";

export interface RemoteTiming {
  route_class: string;
  total_ms: number;
  headers_ms: number | null;
  remote_server_ms: number | null;
  connect_ms: null;
  tls_ms: null;
  status: number | null;
}

/** Transport timing excludes secrets, request bodies and target identifiers. */
function timing(path: string, report?: (fields: RemoteTiming) => void) {
  const started = performance.now();
  let headersMs: number | null = null;
  let response: Response | undefined;
  let done = false;
  return {
    headers(value: Response) {
      response = value;
      headersMs = performance.now() - started;
    },
    finish() {
      if (done) return;
      done = true;
      const duration = response?.headers
        .get("server-timing")
        ?.match(/(?:^|,)\s*recurse;dur=(\d+(?:\.\d+)?)(?:\s*(?:,|$))/)?.[1];
      report?.({
        route_class: path.startsWith("/api/v1/")
          ? "api_v1"
          : path.endsWith("/deliver")
            ? "deliver"
            : path.startsWith("/api/relay/requests")
              ? "relay"
              : path.includes("transcript") ||
                  path === "/api/subagent-tool/read"
                ? "transcript"
                : (path.split(/[/?]/)[2] ?? "other"),
        total_ms: performance.now() - started,
        headers_ms: headersMs,
        remote_server_ms: duration === undefined ? null : Number(duration),
        connect_ms: null,
        tls_ms: null,
        status: response?.status ?? null,
      });
    },
  };
}

const PROXY_REQUEST_HEADERS = [
  "content-type",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "last-event-id",
  "accept",
  "x-recurse-trace",
  "x-recurse-client-dispatch-ms",
];
const PROXY_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
  "content-disposition",
  "retry-after",
  "x-recurse-run-state-clock",
  "x-recurse-api",
];

/** Stream proxy responses, redacting credentials even if a peer echoes them. */
export async function remoteStream(
  backend: { url: string; key: string | null },
  path: string,
  request: Request,
  longRunning: boolean,
  agent?: string,
  report?: (fields: RemoteTiming) => void,
): Promise<Response> {
  const span = timing(path, report);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = longRunning ? undefined : setTimeout(abort, 30_000);
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    span.finish();
  };
  if (request.signal.aborted) abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const headers = new Headers({ "accept-encoding": "identity" });
  for (const name of PROXY_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (backend.key) {
    headers.set("authorization", `Bearer ${backend.key}`);
    if (agent) headers.set("x-recurse-agent-caller", agent);
  }
  const source = request.body?.getReader();
  const cancelInput = () => void source?.cancel().catch(() => {});
  controller.signal.addEventListener("abort", cancelInput, { once: true });
  let input: Uint8Array<ArrayBuffer> | null = null;
  try {
    controller.signal.throwIfAborted();
    if (source) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await source.read();
        if (next.done) break;
        chunks.push(next.value);
        size += next.value.byteLength;
      }
      controller.signal.throwIfAborted();
      input = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        input.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  } catch (error) {
    cancelInput();
    controller.abort();
    cleanup();
    throw error;
  } finally {
    controller.signal.removeEventListener("abort", cancelInput);
    source?.releaseLock();
  }
  if (input) headers.set("content-length", String(input.byteLength));
  try {
    const response = await fetch(backend.url + path, {
      method: request.method,
      headers,
      body: input,
      redirect: "manual",
      signal: controller.signal,
    });
    span.headers(response);
    const outgoing = new Headers({ "x-content-type-options": "nosniff" });
    for (const name of PROXY_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (
        value !== null &&
        !(backend.key && value.includes(backend.key)) &&
        (name !== "x-recurse-run-state-clock" ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,12}(?:\.\d{1,17})?$/i.test(
            value,
          ))
      )
        outgoing.set(name, value);
    }
    const policy = response.headers.get("content-security-policy");
    const safePolicy =
      policy &&
      /(?:^|;)\s*sandbox(?:\s|;|$)/i.test(policy) &&
      !/allow-same-origin/i.test(policy) &&
      !(backend.key && policy.includes(backend.key));
    outgoing.set(
      "content-security-policy",
      safePolicy ? policy : "default-src 'none'; sandbox",
    );
    const pathname = path.split("?", 1)[0]!;
    if (
      pathname === "/api/v1" ||
      pathname.startsWith("/api/v1/") ||
      pathname === "/api/subagent-tool/read" ||
      pathname === "/api/subagent-tool/search"
    ) {
      const retryAfter = outgoing.get("retry-after");
      for (const name of [...outgoing.keys()]) outgoing.delete(name);
      outgoing.set("x-content-type-options", "nosniff");
      outgoing.set("content-security-policy", "default-src 'none'; sandbox");
      outgoing.set("cache-control", "no-store");
      if (retryAfter && /^\d{1,8}$/.test(retryAfter))
        outgoing.set("retry-after", retryAfter);
      if (
        request.method === "HEAD" ||
        response.status === 204 ||
        response.status === 401 ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel();
        cleanup();
        return new Response(null, {
          status: response.status,
          headers: outgoing,
        });
      }
      outgoing.set("content-type", "application/json");
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 2 * 1024 * 1024)
              return Response.json(
                {
                  detail:
                    pathname === "/api/subagent-tool/read" ||
                    pathname === "/api/subagent-tool/search"
                      ? "backend response exceeds 2 MiB; try a smaller --limit, or read on the remote directly if one line is too large"
                      : pathname.endsWith("/messages")
                        ? "backend response exceeds 2 MiB; try a smaller --limit, or read on the remote directly if one entry is too large"
                        : "backend response exceeds 2 MiB; narrow the subtree, or read the agent list on the remote directly",
                },
                { status: 502, headers: outgoing },
              );
            chunks.push(chunk.value);
          }
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const json = JSON.stringify(value);
        return new Response(
          backend.key ? json.replaceAll(backend.key, "[redacted]") : json,
          { status: response.status, headers: outgoing },
        );
      } catch {
        return Response.json(
          { detail: "invalid remote API response" },
          { status: 502, headers: outgoing },
        );
      } finally {
        await reader?.cancel().catch(() => {});
        cleanup();
      }
    }
    const reader = response.body?.getReader();
    if (!reader) {
      cleanup();
      return new Response(null, { status: response.status, headers: outgoing });
    }
    const key = backend.key ? Buffer.from(backend.key) : null;
    let pending = Buffer.alloc(0);
    const body = new ReadableStream<Uint8Array>({
      async pull(sink) {
        try {
          const next = await reader.read();
          if (!key) {
            if (!next.done) sink.enqueue(next.value);
          } else {
            pending = Buffer.concat([pending, next.value ?? new Uint8Array()]);
            let index: number;
            while ((index = pending.indexOf(new Uint8Array(key))) !== -1) {
              sink.enqueue(new Uint8Array(pending.subarray(0, index)));
              sink.enqueue(new TextEncoder().encode("[redacted]"));
              pending = pending.subarray(index + key.length);
            }
            let retained = 0;
            if (!next.done)
              for (
                let size = Math.min(key.length - 1, pending.length);
                size > 0;
                size--
              )
                if (
                  pending
                    .subarray(pending.length - size)
                    .equals(new Uint8Array(key.subarray(0, size)))
                ) {
                  retained = size;
                  break;
                }
            const emit = pending.length - retained;
            if (emit) sink.enqueue(new Uint8Array(pending.subarray(0, emit)));
            pending = pending.subarray(emit);
          }
          if (next.done) {
            cleanup();
            sink.close();
          }
        } catch {
          cleanup();
          controller.abort();
          sink.error(new Error("backend response unavailable"));
        }
      },
      async cancel() {
        controller.abort();
        cleanup();
        await reader.cancel().catch(() => {});
      },
    });
    if (key || response.headers.has("content-encoding"))
      outgoing.delete("content-length");
    return new Response(body, { status: response.status, headers: outgoing });
  } catch {
    controller.abort();
    cleanup();
    throw new RemoteCallError(false);
  }
}

export class RemoteCallError extends Error {
  constructor(
    readonly unsent: boolean,
    readonly timedOut = false,
  ) {
    super(
      timedOut
        ? "backend request timed out"
        : "backend unreachable or response unavailable",
    );
  }
}
export class RemoteResponseTooLarge extends Error {
  constructor() {
    super("backend response too large; try a smaller --limit");
  }
}
export async function remoteCall(
  backend: { url: string; key: string | null },
  path: string,
  options: {
    home?: { id: string; name: string };
    query?: URLSearchParams;
    method?: string;
    body?: unknown;
    timeoutMs?: number;
    maxResponseBytes?: number;
    ifNoneMatch?: string;
    signal?: AbortSignal;
    report?: (fields: RemoteTiming) => void;
  } = {},
): Promise<{
  status: number;
  retryAfter: string | null;
  etag: string | null;
  data: unknown;
  api: string | null;
}> {
  const span = timing(path, options.report);
  if (!/^\/api\/[A-Za-z0-9/_-]+$/.test(path))
    throw new Error("invalid backend API path");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 10_000);
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(
      backend.url +
        path +
        (options.query ? "?" + options.query.toString() : ""),
      {
        method: options.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...(backend.key ? { authorization: `Bearer ${backend.key}` } : {}),
          "content-type": "application/json",
          ...(options.ifNoneMatch
            ? { "if-none-match": options.ifNoneMatch }
            : {}),
          ...(options.home
            ? {
                "x-recurse-home": options.home.id,
                "x-recurse-home-name": options.home.name,
              }
            : {}),
        },
        ...(options.body === undefined
          ? {}
          : {
              body: slowSpan("remote_request_encode", undefined, () =>
                JSON.stringify(options.body),
              ),
            }),
      },
    );
    span.headers(response);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > (options.maxResponseBytes ?? 256 * 1024))
            throw new RemoteResponseTooLarge();
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    let data: unknown = null;
    try {
      data = slowSpan("remote_response_decode", undefined, () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(text);
        return backend.key
          ? JSON.parse(
              JSON.stringify(parsed).replaceAll(backend.key, "[redacted]"),
            )
          : parsed;
      });
    } catch {}
    const retry = response.headers.get("retry-after");
    const etag = response.headers.get("etag");
    return {
      status: response.status,
      api: response.headers.get("x-recurse-api"),
      retryAfter: retry && /^\d{1,8}$/.test(retry) ? retry : null,
      etag:
        etag &&
        etag.length <= 256 &&
        !(backend.key && etag.includes(backend.key))
          ? etag
          : null,
      data,
    };
  } catch (error) {
    if (error instanceof RemoteResponseTooLarge) throw error;
    const code = (error as { code?: string }).code;
    throw new RemoteCallError(
      ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "DNSException"].includes(
        code ?? "",
      ),
      timedOut,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    span.finish();
  }
}
