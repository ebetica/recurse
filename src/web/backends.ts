// Agents request/list connections, never supply credentials or contact URLs.
// Only operator sessions sign in, dismiss or disconnect.
import type { ConnectedBackends } from "../backends/connected";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Router, type Exchange } from "./router";

/** Loopback tokens identify the instance; the header names a live agent. */
export function requireLocalAgent(
  ex: Exchange,
  agents: { title(cid: string): string | undefined },
): string {
  const cid = ex.request.headers.get("x-recurse-agent");
  if (
    ex.state.auth_method !== "loopback" ||
    !cid ||
    agents.title(cid) === undefined
  )
    throw new HttpError(403, "local agent required");
  return cid;
}

export function requireBackendOperator(ex: Exchange): void {
  if (
    ex.request.headers.has("x-loopback-token") ||
    ex.request.headers.has("authorization") ||
    !["cookie", "tailscale", "local"].includes(String(ex.state.auth_method))
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
    return ex.state.auth_method === "loopback" &&
      cid &&
      agents.title(cid) !== undefined
      ? cid
      : null;
  };
  const requireOperator = requireBackendOperator;
  router.get("/api/backends", async (ex) => {
    if (!requester(ex)) requireOperator(ex);
    return jsonResponse(
      store.list().map((row) => ({
        ...row,
        requested_by_title: row.requested_by
          ? (agents.title(row.requested_by) ?? null)
          : null,
      })),
    );
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
      if ("password" in body)
        throw new HttpError(403, "agents cannot supply passwords");
      await store.request(body.label, body.url, cid);
    } else await store.connect(body.label, body.url, body.password);
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
      await store.signIn(label, body.password);
    } catch (error) {
      text = `Signing in to backend ${label} failed: ${error instanceof HttpError ? error.message : "Sign-in failed"}`;
      throw error;
    } finally {
      if (cid && agents.title(cid) !== undefined)
        await agents.deliverPlatformNote(cid, text).catch(() => {});
    }
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
