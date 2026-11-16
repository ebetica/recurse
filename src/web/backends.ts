// Agents request/list connections, never supply credentials or contact URLs.
// Only operator sessions sign in, dismiss or disconnect. Listing probes stale
// connections in the background; remotes reach /api/remote-events only with
// a callback token.
import { authMethod, isOperator } from "./request_auth";
import type { ConnectedBackends } from "../backends/connected";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Router, type Exchange } from "./router";

/** Loopback tokens identify the instance; the header names a live agent. */
export function requireLocalAgent(
  ex: Exchange,
  agents: { title(cid: string): string | undefined },
): string {
  const cid = ex.request.headers.get("x-recurse-agent");
  if (authMethod(ex) !== "loopback" || !cid || agents.title(cid) === undefined)
    throw new HttpError(403, "local agent required");
  return cid;
}

export function requireBackendOperator(ex: Exchange): void {
  if (
    ex.request.headers.has("x-loopback-token") ||
    ex.request.headers.has("authorization") ||
    !isOperator(ex)
  )
    throw new HttpError(403, "operator session required");
}

export function registerBackendRoutes(
  router: Router,
  store: ConnectedBackends,
  agents: {
    title: (cid: string) => string | undefined;
    deliverPlatformNote: (cid: string, text: string) => Promise<unknown>;
  } = { title: () => undefined, deliverPlatformNote: async () => {} },
): void {
  const requester = (ex: Exchange) => {
    const cid = ex.request.headers.get("x-recurse-agent");
    return authMethod(ex) === "loopback" &&
      cid &&
      agents.title(cid) !== undefined
      ? cid
      : null;
  };
  const requireOperator = requireBackendOperator;
  router.get("/api/backends", async (ex) => {
    if (!requester(ex)) requireOperator(ex);
    return jsonResponse(store.listForAgents(agents.title));
  });
  router.post("/api/backends", async (ex) => {
    const cid = requester(ex);
    if (!cid) requireOperator(ex);
    let body: Record<string, unknown>;
    try {
      body = await jsonDictBody(ex);
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    if (cid) {
      if ("password" in body || "code" in body)
        throw new HttpError(403, "agents cannot supply passwords");
      await store.request(body.label, body.url, cid);
    } else await store.connect(body.label, body.url, body.password, body.code);
    return jsonResponse({ ok: true });
  });
  router.post("/api/backends/{label}/sign-in", async (ex) => {
    requireOperator(ex);
    const body = await jsonDictBody(ex);
    const label = ex.params.label!;
    const cid = store
      .list()
      .find(
        (row) => row.label === label && row.state === "pending",
      )?.requested_by;
    let text = `Backend ${label} is now connected`;
    try {
      await store.signIn(label, body.password, body.code);
    } catch (error) {
      text = `Signing in to backend ${label} failed: ${error instanceof HttpError ? error.message : "Sign-in failed"}`;
      throw error;
    } finally {
      if (cid && agents.title(cid) !== undefined)
        await agents.deliverPlatformNote(cid, text).catch(() => {});
    }
    return jsonResponse({ ok: true });
  });
  router.post("/api/remote-events", async (ex) => {
    const label = ex.state.remote_event_label;
    if (authMethod(ex) !== "remote-callback" || typeof label !== "string")
      throw new HttpError(403, "remote callback token required");
    const { type } = await jsonDictBody(ex);
    if (type !== "relay" && type !== "test")
      throw new HttpError(422, "unknown remote event");
    store.remoteEvent(label, type);
    return jsonResponse({ ok: true });
  });
  router.delete("/api/backends/{label}", async (ex) => {
    requireOperator(ex);
    return jsonResponse({
      ok: true,
      warning: await store.disconnect(ex.params.label!),
    });
  });
}
