// Loopback callers use v1 or explicitly bundled-tool routes; default to web.
// Tool markers are compatibility guidance, not same-user isolation.

export type LoopbackAudience = "public" | "v1" | "tool" | "web";

/** Classify a decoded request path and method at the loopback boundary. */
export function loopbackAudience(
  method: string,
  path: string,
): LoopbackAudience {
  if (method === "GET" && ["/api/status", "/api/version"].includes(path))
    return "public";
  if (path.startsWith("/api/v1/")) return "v1";
  if (/^\/api\/backends\/[^/]+\/(?:settings-sync|sign-in)$/.test(path))
    return "web";
  if (
    (method === "GET" &&
      (/^\/api\/subagent-tool\/conversations(?:\/[^/]+\/transcript)?$/.test(
        path,
      ) ||
        /^\/api\/conversations\/[^/]+(?:\/spawn-outcome)?$/.test(path) ||
        path === "/api/backends" ||
        path === "/api/subagent-tool/search" ||
        path === "/api/subagent-tool/read" ||
        /^\/api\/relay\/messages\/[^/]+$/.test(path) ||
        /^\/api\/relay\/transcript\/[^/]+\/[^/]+$/.test(path))) ||
    (method === "POST" &&
      (path === "/api/conversations/spawn" ||
        /^\/api\/conversations\/[^/]+\/(?:spawn-outcome\/observe|deliver|reparent|tags)$/.test(
          path,
        ) ||
        path === "/api/agent-archive/revive" ||
        path === "/api/backends" ||
        path === "/api/relay/messages")) ||
    (method === "DELETE" && /^\/api\/conversations\/[^/]+$/.test(path)) ||
    (["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method) &&
      /^\/api\/backends\/[^/]+\/.+/.test(path))
  )
    return "tool";
  return "web";
}
