// Operators/live loopback agents share transport; keys stay private here.
// Agents never reach Settings, credentials or safety changes, whatever the key.
// Bound per-label calls through EOF/cancellation; offline calls queue nothing.
// Validate paths; refuse redirects; sandbox remote apps under an opaque origin.
import { validBackendLabel } from "../backends/label";
import { backendAgentAllowed, remoteSettingsRoute } from "../auth/backend_keys";
import type { ConnectedBackends } from "../backends/connected";
import { requireBackendOperator, requireLocalAgent } from "./backends";
import { UPLOAD_BODY_MAX_BYTES } from "./files";
import { HttpError, type Router } from "./router";

const SINGLE = new Set(["tree", "version", "status", "models"]);
const PREFIX = new Set([
  "conversations",
  "attachments",
  "attachment-drafts",
  "artifacts",
]);

export function registerBackendProxy(
  router: Router,
  store: ConnectedBackends,
  agents: { title(cid: string): string | undefined } = {
    title: () => undefined,
  },
  audit: (fields: {
    agent: string;
    label: string;
    route: string;
    duration_ms: number;
  }) => void = () => {},
) {
  const inFlight = new Map<string, number>();
  router.add(
    ["GET", "HEAD", "POST", "PUT", "DELETE"],
    "/api/backends/{label}/{path:path}",
    async (ex) => {
      const agent =
        ex.state.auth_method === "loopback"
          ? requireLocalAgent(ex, agents)
          : (requireBackendOperator(ex), null);
      const path = ex.params.path!;
      const parts = path.split("/");
      if (
        !validBackendLabel(ex.params.label) ||
        /%2f|%5c/i.test(ex.url.pathname) ||
        parts.some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[%\\\u0000-\u001f\u007f]/.test(part),
        ) ||
        !(
          PREFIX.has(parts[0]!) ||
          (parts.length === 1 && SINGLE.has(path)) ||
          (agent &&
            /^subagent-tool\/conversations\/[A-Za-z0-9_-]+\/transcript$/.test(
              path,
            )) ||
          (!agent && remoteSettingsRoute("/api/" + path))
        )
      )
        throw new HttpError(403, "not available through the proxy");
      if (agent && !backendAgentAllowed(ex.request.method, `/api/${path}`))
        throw new HttpError(403, "remote agent not allowed here");
      const label = ex.params.label!;
      if (agent) {
        store.relayReady(label);
        if ((inFlight.get(label) ?? 0) >= 16)
          throw new HttpError(
            429,
            `too many agent requests in flight to ${label}`,
          );
        inFlight.set(label, (inFlight.get(label) ?? 0) + 1);
      }
      const started = performance.now();
      let finished = false;
      const finish = () => {
        if (!agent || finished) return;
        finished = true;
        const remaining = (inFlight.get(label) ?? 1) - 1;
        if (remaining) inFlight.set(label, remaining);
        else inFlight.delete(label);
        audit({
          agent,
          label,
          route: `${ex.request.method} /api/${path}`,
          duration_ms: performance.now() - started,
        });
      };
      const target = "/api/" + parts.map(encodeURIComponent).join("/");
      const longRunning =
        router.match(ex.request.method, "/api/" + path)?.route.longRunning ??
        false;
      let bodyError: HttpError | undefined;
      let request = ex.request;
      if (path === "attachments" && request.method === "POST" && request.body) {
        let size = 0;
        const body = request.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, sink) {
              size += chunk.length;
              if (size > UPLOAD_BODY_MAX_BYTES) {
                bodyError = new HttpError(413, "request body is too large");
                sink.error(bodyError);
              } else sink.enqueue(chunk);
            },
          }),
        );
        request = new Request(request, { body, duplex: "half" } as RequestInit);
      }
      try {
        const response = await store.proxy(
          ex.params.label!,
          target + ex.url.search,
          request,
          longRunning,
          agent ?? undefined,
        );
        if (response.status === 401) {
          await response.body?.cancel();
          throw new HttpError(
            424,
            `Backend ${ex.params.label}'s key was revoked: reconnect in Settings`,
          );
        }
        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.status !== 304
        ) {
          await response.body?.cancel();
          throw new HttpError(
            502,
            `Backend ${ex.params.label} returned a redirect`,
          );
        }
        if (!agent || !response.body) {
          finish();
          return response;
        }
        const reader = response.body.getReader();
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  finish();
                  controller.close();
                } else controller.enqueue(chunk.value);
              } catch (error) {
                finish();
                controller.error(error);
              }
            },
            async cancel(reason) {
              try {
                await reader.cancel(reason);
              } finally {
                finish();
              }
            },
          }),
          { status: response.status, headers: response.headers },
        );
      } catch (error) {
        finish();
        if (bodyError) throw bodyError;
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          502,
          agent
            ? store.offlineReason(label)
            : `Backend ${ex.params.label} is unreachable`,
        );
      }
    },
    { longRunning: true },
  );
}
