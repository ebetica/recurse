// Bounded backend calls never follow redirects or expose transport errors.
// Only pre-connect failures are definitely unsent; other errors are uncertain.
// Stream responses with allowed headers, sandboxing and echoed-key redaction.
// Trusted agent markers require keys; never derive them from operator headers.

const PROXY_REQUEST_HEADERS = [
  "content-type",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "last-event-id",
  "accept",
  "x-recurse-trace",
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
];

/** Stream proxy responses, redacting credentials even if a peer echoes them. */
export async function remoteStream(
  backend: { url: string; key: string | null },
  path: string,
  request: Request,
  longRunning: boolean,
  agent?: string,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = longRunning ? undefined : setTimeout(abort, 30_000);
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
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
    const outgoing = new Headers({ "x-content-type-options": "nosniff" });
    for (const name of PROXY_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null && !(backend.key && value.includes(backend.key)))
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
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; retryAfter: string | null; data: unknown }> {
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
          ...(options.home
            ? {
                "x-recurse-home": options.home.id,
                "x-recurse-home-name": options.home.name,
              }
            : {}),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      },
    );
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
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(text);
      data = backend.key
        ? JSON.parse(
            JSON.stringify(parsed).replaceAll(backend.key, "[redacted]"),
          )
        : parsed;
    } catch {}
    const retry = response.headers.get("retry-after");
    return {
      status: response.status,
      retryAfter: retry && /^\d{1,8}$/.test(retry) ? retry : null,
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
  }
}
