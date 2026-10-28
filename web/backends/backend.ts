// Browser backend identity, isolated request health and same-origin proxy URLs.
// Home ids and URLs remain unchanged. Discovery registers approved backends;
// this module only binds identity and URL resolution. The remote's key policy
// decides which requests succeed; the browser keeps no second allowlist.
import { connectionHealth, createApiClient } from "../api.js";
import { ConnectionHealth } from "../connection/health.js";

import { validBackendLabel } from "../../src/backends/label.js";

export function parseConversationId(id: string): {
  label: string;
  cid: string;
} {
  const slash = id.indexOf("/");
  if (slash === -1) return { label: "", cid: id };
  const label = id.slice(0, slash);
  const cid = id.slice(slash + 1);
  if (!validBackendLabel(label) || !cid || cid.includes("/"))
    throw new Error("Invalid backend conversation id");
  return { label, cid };
}

export function conversationId(label: string, cid: string): string {
  if (cid.includes("/") || (label && !validBackendLabel(label)))
    throw new Error("Invalid backend conversation id");
  return label ? `${label}/${cid}` : cid;
}

export class Backend {
  readonly base: string;
  readonly connectionHealth: ConnectionHealth;
  apiVersion: number | null = null;
  directUrl = "";
  readonly api: ReturnType<typeof createApiClient>["api"];
  readonly apiJson: ReturnType<typeof createApiClient>["apiJson"];
  readonly jpost: ReturnType<typeof createApiClient>["jpost"];

  constructor(readonly label: string) {
    // Invariant: Dot-only labels normalize out of the proxy path in browsers.
    if (label && !validBackendLabel(label))
      throw new Error("Invalid backend label");
    this.base = label ? `/api/backends/${label}` : "/api";
    this.connectionHealth = label
      ? new ConnectionHealth(
          () => performance.now(),
          typeof navigator === "undefined" || navigator.onLine !== false,
        )
      : connectionHealth;
    const client = createApiClient(this.connectionHealth, !label);
    this.api = (path, opts, health) => client.api(this.url(path), opts, health);
    this.apiJson = (path, opts, health) =>
      client.apiJson(this.url(path), opts, health);
    this.jpost = (path, body, health) =>
      client.jpost(this.url(path), body, health);
  }

  url(path: string): string {
    if (!this.label) return path;
    if (path.startsWith(this.base + "/"))
      return resolveUrl(this, "/api" + path.slice(this.base.length));
    const qualified = `/api/conversations/${this.label}/`;
    const unqualified = path.startsWith(qualified)
      ? `/api/conversations/${path.slice(qualified.length)}`
      : path;
    const scoped = unqualified.replace(
      /^\/api\/conversations\/([^/?#]+)/,
      (_match, encoded: string) => {
        const { label, cid } = parseConversationId(decodeURIComponent(encoded));
        if (label && label !== this.label) throw new Error("Wrong backend");
        return `/api/conversations/${encodeURIComponent(cid)}`;
      },
    );
    return resolveUrl(this, scoped);
  }
}

export const homeBackend = new Backend("");
const registry = new Map<string, Backend>([["", homeBackend]]);

/** Every backend the sidebar, Settings and finder show: the home, then each
 * approved remote in discovery order. */
export function backends(): Backend[] {
  return [...registry.values()];
}

export function findBackend(label: string): Backend | undefined {
  return registry.get(label);
}

export function registerBackend(backend: Backend): void {
  if (!backend.label) throw new Error("Home backend is already registered");
  registry.set(backend.label, backend);
}

export function unregisterBackend(label: string): void {
  if (label) registry.delete(label);
}

export function backendFor(id: string): Backend {
  const { label } = parseConversationId(id);
  const backend = registry.get(label);
  if (!backend) throw new Error(`Unknown backend: ${label}`);
  return backend;
}

export function resolveContentLink(backend: Backend, href: string): string {
  if (!backend.label || !href.startsWith("#")) return resolveUrl(backend, href);
  const params = new URLSearchParams(href.slice(1));
  const id = params.get("agent");
  if (id && !parseConversationId(id).label)
    params.set("agent", conversationId(backend.label, id));
  return "#" + params.toString();
}

export function resolveUrl(backend: Backend, url: string): string {
  if (!backend.label) return url;
  if (!url.startsWith("/api/") || /[\\\s]/.test(url))
    throw new Error("Backend URL must be a relative /api/ path");
  const parsed = new URL(url, "https://backend.invalid");
  if (
    parsed.origin !== "https://backend.invalid" ||
    !parsed.pathname.startsWith("/api/")
  )
    throw new Error("Backend URL must stay within /api/");
  return backend.base + parsed.pathname.slice(4) + parsed.search + parsed.hash;
}
