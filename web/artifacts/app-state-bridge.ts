// Bind the mounted iframe to its viewer-selected Artifact with a MessagePort.
// Messages cannot choose a backend, owner or id. Each viewer-loaded document
// gets a single-use nonce that its page script spends before app code runs,
// so a document the frame navigates to cannot connect.
import {
  APP_STATE_FRAGMENT,
  APP_STATE_INVALID,
  APP_STATE_MAX_BYTES,
  APP_STATE_RECONNECT,
  APP_STATE_TOO_LARGE,
} from "../../src/artifact_app_state_protocol.js";
import { backendFor } from "../backends/index.js";
import { artifactAppStatePath } from "./model.js";

const LOAD_ERROR = "Could not load saved app state";
const SAVE_ERROR = "Could not save app state";
const POLL_MS = 2000;
const resetFrame = new WeakMap<HTMLIFrameElement, () => string>();

type Connection = {
  port: MessagePort;
  abort: AbortController;
  etag: string | null;
};

const requestSignal = ({ abort }: Connection) =>
  AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]);

async function readJson(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(LOAD_ERROR);
  const bytes = new Uint8Array(APP_STATE_MAX_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > bytes.length) {
        await reader.cancel();
        throw new Error(APP_STATE_TOO_LARGE);
      }
      bytes.set(value, size);
      size += value.length;
    }
    const json = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes.subarray(0, size));
    JSON.parse(json);
    return json;
  } finally {
    reader.releaseLock();
  }
}

/** Change the query so a frame URL with a fragment loads a new document. */
export function reloadAppFrame(frame: HTMLIFrameElement): void {
  const fragment = resetFrame.get(frame)?.();
  if (!fragment) return;
  const url = new URL(frame.src);
  url.hash = fragment;
  url.searchParams.set(
    "reload",
    String(Number(url.searchParams.get("reload")) + 1),
  );
  frame.src = url.href;
}

export function attachAppState(
  frame: HTMLIFrameElement,
  agent: string,
  id: string,
  signal: AbortSignal,
  active: () => boolean,
): string {
  const backend = backendFor(agent);
  const path = artifactAppStatePath(agent, id);
  let token = "";
  let connection: Connection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let saving = false;
  let savesStarted = 0;
  const mounted = () => !signal.aborted && frame.isConnected;
  const visible = () =>
    active() &&
    frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  function closeConnection(): void {
    connection?.abort.abort();
    connection?.port.close();
    connection = undefined;
  }

  function disconnect(): void {
    closeConnection();
    clearTimeout(timer);
    timer = undefined;
  }

  function renew(): string {
    disconnect();
    token = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
    return APP_STATE_FRAGMENT + token;
  }

  async function poll(): Promise<void> {
    if (polling || !mounted() || !connection) return;
    const target = connection;
    const { etag } = target;
    const sequence = savesStarted;
    polling = true;
    try {
      if (saving || !visible() || (document.hidden && etag !== null)) return;
      const response = await backend.api(path, {
        headers: etag ? { "if-none-match": etag } : {},
        cache: "no-store",
        signal: requestSignal(target),
      });
      if (response.status === 304) return;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(LOAD_ERROR);
      }
      const json = await readJson(response);
      if (
        mounted() &&
        visible() &&
        target === connection &&
        sequence === savesStarted
      ) {
        target.etag = response.headers.get("etag");
        target.port.postMessage({ type: "state", json });
      }
    } catch {
      if (
        mounted() &&
        visible() &&
        target === connection &&
        sequence === savesStarted &&
        etag === null
      )
        target.port.postMessage({ type: "state", error: LOAD_ERROR });
    } finally {
      polling = false;
      if (mounted() && connection)
        timer = setTimeout(() => {
          timer = undefined;
          void poll();
        }, POLL_MS);
    }
  }

  async function save(target: Connection, json: string): Promise<void> {
    const reply = (error?: string) =>
      target.port.postMessage({ type: "saved", error });
    if (!visible()) return reply(SAVE_ERROR);
    if (saving) return reply("An app state save is already in progress");
    if (
      json.length > APP_STATE_MAX_BYTES ||
      new TextEncoder().encode(json).byteLength > APP_STATE_MAX_BYTES
    )
      return reply(APP_STATE_TOO_LARGE);
    saving = true;
    savesStarted++;
    try {
      const response = await backend.api(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: json,
        signal: requestSignal(target),
      });
      await response.body?.cancel();
      if (response.ok) {
        target.etag = response.headers.get("etag");
        reply();
      } else {
        reply(
          response.status === 413
            ? APP_STATE_TOO_LARGE
            : response.status === 400
              ? APP_STATE_INVALID
              : SAVE_ERROR,
        );
      }
    } catch {
      reply(SAVE_ERROR);
    } finally {
      saving = false;
    }
  }

  window.addEventListener(
    "message",
    (event) => {
      if (!mounted() || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (
        data?.type !== "recurse-app-state:connect" ||
        Object.keys(data).length !== 2 ||
        event.ports.length !== 1
      )
        return;
      const port = event.ports[0]!;
      if (!token || data.token !== token) {
        port.postMessage({ type: "refused", error: APP_STATE_RECONNECT });
        port.close();
        return;
      }
      token = "";
      const target: Connection = {
        port,
        abort: new AbortController(),
        etag: null,
      };
      connection = target;
      port.onmessage = ({ data, ports }) => {
        if (!mounted() || connection !== target || ports.length !== 0) return;
        if (data?.type === "load" && Object.keys(data).length === 1) {
          if (timer === undefined) void poll();
        } else if (
          data?.type === "save" &&
          typeof data.json === "string" &&
          Object.keys(data).length === 2
        )
          void save(target, data.json);
      };
    },
    { signal },
  );
  signal.addEventListener(
    "abort",
    () => {
      resetFrame.delete(frame);
      frame.remove();
      disconnect();
    },
    { once: true },
  );
  resetFrame.set(frame, renew);
  return renew();
}
