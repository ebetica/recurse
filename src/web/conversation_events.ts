// SSE transport for focused views and tree change notices. Reads are
// serialized and coalesced; a slow client holds at most one unread frame.
import { HttpError } from "./router";

type Read = (cursor: string | null) => Promise<readonly [number, Uint8Array]>;

async function streamEvents(
  cursor: string | null,
  read: Read,
  subscribe: (wake: () => void) => () => void,
  signal: AbortSignal,
  coalesceMs: number,
): Promise<readonly [number, ReadableStream<Uint8Array> | null]> {
  let dirty = false;
  let closed = false;
  let reading = false;
  let active = false;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let retryFiles: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 5000;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let lastFrame = "";
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(heartbeat);
    clearTimeout(retryFiles);
    clearTimeout(scheduled);
    unsubscribe();
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    cleanup();
    try {
      controller?.close();
    } catch {}
  };
  const scheduleHeartbeat = () => {
    clearTimeout(heartbeat);
    if (closed) return;
    heartbeat = setTimeout(
      () => {
        if (controller && controller.desiredSize! > 0)
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        scheduleHeartbeat();
      },
      active ? 5000 : 60_000,
    );
  };
  const advance = (body: Uint8Array): boolean => {
    const frame = new TextDecoder().decode(body);
    const id = frame.match(/^id: (.+)$/m)?.[1];
    if (id) cursor = id;
    const data = frame.match(/^data: (.+)$/m)?.[1];
    const page = data
      ? (JSON.parse(data) as { active_run?: unknown; files_pending?: boolean })
      : null;
    if (!page?.files_pending) {
      clearTimeout(retryFiles);
      retryFiles = undefined;
      retryDelay = 5000;
    } else if (!retryFiles && !closed) {
      retryFiles = setTimeout(() => {
        retryFiles = undefined;
        dirty = true;
        schedule();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60_000);
    }
    // Invariant: The sample clock orders run state, not visible changes.
    const comparable = frame.replace(
      /,"run_state_clock":\["[^"]+",[\d.]+\]/,
      "",
    );
    if (comparable === lastFrame) return false;
    lastFrame = comparable;
    if (page) {
      active = !!page.active_run;
      scheduleHeartbeat();
    }
    return true;
  };
  const flush = async () => {
    if (
      closed ||
      reading ||
      !dirty ||
      !controller ||
      controller.desiredSize! <= 0
    )
      return;
    dirty = false;
    reading = true;
    try {
      const [status, body] = await read(cursor);
      if (closed) return;
      if (status !== 200) throw new Error("conversation view unavailable");
      if (advance(body)) controller.enqueue(body);
    } catch (error) {
      if (!closed) {
        controller.error(error);
        cleanup();
      }
    } finally {
      reading = false;
      if (dirty) schedule();
    }
  };
  const schedule = () => {
    if (scheduled || closed) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void flush();
    }, coalesceMs);
  };
  unsubscribe = subscribe(() => {
    dirty = true;
    schedule();
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let initial: readonly [number, Uint8Array];
  try {
    initial = await read(cursor);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (closed) return [499, null];
  if (initial[0] !== 200) {
    cleanup();
    return [initial[0], null];
  }
  advance(initial[1]);
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(initial[1]);
      if (dirty) schedule();
    },
    pull() {
      if (dirty && !scheduled) void flush();
    },
    cancel() {
      cleanup();
    },
  });
  return [200, stream];
}

/** Serve a durable live stream, or a one-shot legacy event response. */
export async function conversationEvents(
  cursor: string | null,
  read: Read,
  subscribe: ((wake: () => void) => () => void) | null,
  signal: AbortSignal,
  coalesceMs = 150,
): Promise<Response> {
  const [status, body] = subscribe
    ? await streamEvents(cursor, read, subscribe, signal, coalesceMs)
    : await read(cursor);
  if (status !== 200 || !body) throw new HttpError(status);
  return new Response(body as ConstructorParameters<typeof Response>[0], {
    headers: {
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      ...(!subscribe
        ? { "content-length": String((body as Uint8Array).byteLength) }
        : {}),
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}
