import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ConnectedBackends } from "../../src/backends/connected";
import { BackendKeys } from "../../src/auth/backend_keys";
import { buildApp, WebLogSink } from "../../src/web/app";
import { appWorld, PASSWORD } from "./web_app_support";
import { until } from "./fixtures/durable_host/host";

// Regression: #3145 Startup relay polls use the persisted sleep check-in URL.
test("advertised relay check-ins survive home restarts without polling the web URL", async () => {
  const world = appWorld({ password: true });
  const keys = new BackendKeys(world.env.CHAT_DATA_DIR!);
  let sleeping = false;
  const checks: string[] = [];
  const check = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      checks.push(new URL(request.url).pathname);
      if (!sleeping) return Response.json({ requests: [] });
      if (!(await keys.verify(request.headers.get("authorization") ?? "")))
        return new Response(null, { status: 401 });
      return Response.json({ requests: [], sleep_seconds: 3600 });
    },
  });
  world.env.RECURSE_SLEEP_CHECK_URL = check.url.origin;
  const app = await buildApp({
    env: world.env,
    sink: new WebLogSink(() => {}),
  });
  const server = await app.serve({ port: 0 });
  const seen: string[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push(url.pathname);
      if (url.pathname === "/api/relay/requests")
        url.searchParams.set("wait", "0");
      return fetch(server.url + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      });
    },
  });
  const load = () =>
    ConnectedBackends.load(join(world.root, "home"), "Home", () => {});
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    const original = await load();
    await original.connect("R", gateway.url.origin, PASSWORD);
    sleeping = true;
    const home = await load();
    const signal = new AbortController().signal;
    const before = seen.length;
    expect((await home.poll("R", ["Home"], signal, 25)).data).toEqual({
      requests: [],
      sleep_seconds: 3600,
    });
    expect((await home.poll("R", ["Home"], signal, 25)).data).toEqual({
      requests: [],
      sleep_seconds: 3600,
    });
    await home.refreshStale();
    expect(seen.slice(before)).toEqual([]);
    expect(checks).toEqual(["/api/relay/requests", "/api/relay/requests"]);
    sleeping = false;
    expect((await home.poll("R", ["Home"], signal, 25)).status).toBe(200);
    expect(seen.slice(before)).toContain("/api/relay/requests");
    sleeping = true;
    await keys.revoke();
    const revokedAt = seen.length;
    expect((await home.poll("R", ["Home"], signal, 25)).status).toBe(401);
    expect(home.list()[0]!.state).toBe("key_revoked");
    expect(home.pollingLabels()).toEqual([]);
    expect(seen.length).toBe(revokedAt);
    expect((await load()).list()[0]!.state).toBe("key_revoked");
  } finally {
    gateway.stop(true);
    check.stop(true);
    await server.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    await rm(world.root, { recursive: true, force: true });
  }
});
