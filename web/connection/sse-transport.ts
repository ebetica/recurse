// Fetch SSE seeds Last-Event-ID on first connect and every reconnect. Decodes
// frames immediately; server retry plus capped exponential backoff handles
// consecutive failures, reset by any dispatched event.

export interface SseFrame {
  kind: string;
  id: string | null;
  data: string;
}

export interface SseParser {
  readonly lastEventId: string | null;
  readonly retryMs: number;
  push(chunk: string): SseFrame[];
}

export function createSseParser(initialId: string | null = null): SseParser {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let lastEventId = initialId;
  let retryMs = 3000;

  return {
    get lastEventId() {
      return lastEventId;
    },
    get retryMs() {
      return retryMs;
    },
    push(chunk: string): SseFrame[] {
      const out: SseFrame[] = [];
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (let line of lines) {
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length > 0)
            out.push({
              kind: event || "message",
              id: lastEventId,
              data: data.join("\n"),
            });
          event = "";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        let field = line;
        let value = "";
        if (colon !== -1) {
          field = line.slice(0, colon);
          value = line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
        }
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") {
          if (!value.includes("\0")) lastEventId = value;
        } else if (field === "retry") {
          if (/^\d+$/.test(value)) retryMs = parseInt(value, 10);
        }
      }
      return out;
    },
  };
}

export interface SseConnectionHandlers {
  /** `at`: performance.now() when the frame's request was sent. */
  onEvent: (kind: string, id: string | null, data: string, at?: number) => void;
  onFailure: (status: number | null) => void;
}

export interface SseConnectionOptions {
  lastEventId?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxDelayMs?: number;
}

export interface SseConnection {
  close(): void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function openSseConnection(
  url: string,
  options: SseConnectionOptions,
  handlers: SseConnectionHandlers,
): SseConnection | null {
  const fetchImpl =
    options.fetchImpl ?? (typeof fetch === "undefined" ? null : fetch);
  if (!fetchImpl) return null;
  const sleep = options.sleep ?? defaultSleep;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const controller = new AbortController();
  const parser = createSseParser(options.lastEventId ?? null);
  let closed = false;
  let failures = 0;

  const fail = async (status: number | null): Promise<void> => {
    if (closed) return;
    failures += 1;
    handlers.onFailure(status);
    await sleep(Math.min(parser.retryMs * 2 ** (failures - 1), maxDelayMs));
    if (!closed) void connect();
  };

  let requestedAt = 0;
  const pump = async (body: ReadableStream<Uint8Array>): Promise<boolean> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let sawEvent = false;
    try {
      let finished = false;
      while (!finished) {
        const next = await reader.read();
        if (closed || next.done) {
          finished = true;
          continue;
        }
        for (const frame of parser.push(
          decoder.decode(next.value, { stream: true }),
        )) {
          sawEvent = true;
          failures = 0;
          try {
            handlers.onEvent(frame.kind, frame.id, frame.data, requestedAt);
          } catch (error) {
            console.error("Conversation event handler failed", error);
            throw error;
          }
          if (closed) {
            finished = true;
            break;
          }
        }
      }
    } catch {
      if (!closed) await fail(null);
      return false;
    } finally {
      try {
        await reader.cancel();
      } catch {}
    }
    return sawEvent;
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (parser.lastEventId) headers["Last-Event-ID"] = parser.lastEventId;
    let response: Response;
    requestedAt = performance.now();
    try {
      response = await fetchImpl(url, { headers, signal: controller.signal });
    } catch {
      if (!closed) await fail(null);
      return;
    }
    if (closed) return;
    if (!response.ok || !response.body) {
      await fail(response.ok ? null : response.status);
      return;
    }
    const sawEvent = await pump(response.body);
    if (closed) return;
    // Invariant: Clean EOF: the server ended the stream (a terminal error
    // frame, a restart). Reconnect at the base retry unless nothing arrived at
    // all, which backs off like a failure.
    if (sawEvent) {
      await sleep(parser.retryMs);
      if (!closed) void connect();
    } else await fail(null);
  };

  void connect();
  return {
    close(): void {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}
