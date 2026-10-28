// Only the focused conversation streams SSE seeded from its held tail id.
// Bounded gaps resync as deltas; streams own ongoing rows, polls keep chrome.
// /view tails are unsubscribed fallback, failed-stream catch-up, or settled-run
// readback before painting idle.
import { backendFor } from "./backends/backend.js";
import {
  openSseConnection,
  type SseConnection,
  type SseConnectionHandlers,
  type SseConnectionOptions,
} from "./connection/sse-transport.js";
import type { ViewPage } from "./row-thread-state/view-blocks.js";

export function focusedEventsUrl(cid: string): string {
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/events`,
  );
}

// A served page is one JSON object shaped like a /view window. Malformed
// payloads keep the held rows and never blank the thread.
export function parseFocusedEventPage(raw: unknown): ViewPage | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const page = parsed as Record<string, unknown>;
  if (
    typeof page["instance_id"] !== "string" ||
    typeof page["revision"] !== "number" ||
    !Array.isArray(page["blocks"])
  )
    return null;
  return parsed as ViewPage;
}

export function parseTerminalStatus(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const status = (JSON.parse(raw) as { status?: unknown }).status;
    return typeof status === "string" && status ? status : null;
  } catch {
    return null;
  }
}

export interface FocusedEventHandlers {
  onPage: (kind: "snapshot" | "rows", page: ViewPage, at: number) => void;
  onTerminal: (status: string) => void;
  onTransportError: () => void;
}

export interface FocusedEventOptions {
  /** Held tail cursor ({instance}:{revision}) to resync from on connect. */
  lastEventId?: string | null;
}

export type FocusedTransportFactory = (
  url: string,
  options: SseConnectionOptions,
  handlers: SseConnectionHandlers,
) => SseConnection | null;

const defaultFactory: FocusedTransportFactory = (url, options, handlers) =>
  openSseConnection(url, options, handlers);

export interface FocusedSubscription {
  readonly cid: string;
  close(): void;
}

// A terminal `error` frame ends the server stream (gone/unavailable); any
// other failure just ends the attempt and the transport reconnects with the
// latest id. A 404 means the conversation never opened: report it as gone so
// the poll loop's absence grace owns navigation.
export function subscribeFocusedEvents(
  cid: string,
  handlers: FocusedEventHandlers,
  options: FocusedEventOptions = {},
  factory: FocusedTransportFactory = defaultFactory,
): FocusedSubscription | null {
  const conn = factory(
    focusedEventsUrl(cid),
    {
      lastEventId: options.lastEventId ?? null,
      ...(backendFor(cid).label
        ? { fetchImpl: (url, init) => backendFor(cid).api(String(url), init) }
        : {}),
    },
    {
      onEvent: (kind, _id, data, at = 0) => {
        if (kind === "snapshot" || kind === "rows") {
          const page = parseFocusedEventPage(data);
          if (page) handlers.onPage(kind, page, at);
        } else if (kind === "error") {
          const status = parseTerminalStatus(data);
          if (status) handlers.onTerminal(status);
        }
      },
      onFailure: (status) => {
        if (status === 404) handlers.onTerminal("gone");
        else handlers.onTransportError();
      },
    },
  );
  if (!conn) return null;
  let closed = false;
  return {
    cid,
    close(): void {
      if (closed) return;
      closed = true;
      conn.close();
    },
  };
}
