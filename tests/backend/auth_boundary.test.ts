import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildApp, WebLogSink, type App } from "../../src/web/app";
import { startServer, type RunningServer } from "../../src/server";
import { jsonResponse } from "../../src/web/router";
import { loopbackAudience } from "../../src/web/route_audience";
import { appWorld, PASSWORD } from "./web_app_support";
import audiences from "./fixtures/loopback_routes.json";

const PUBLIC = new Set(["POST /login"]);
const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

let root = "";
let app: App;
let running: RunningServer;
let reached = 0;

beforeAll(async () => {
  const world = appWorld({ password: true });
  root = world.root;
  app = await buildApp({
    env: world.env,
    sink: new WebLogSink(() => {}),
  });
  app.router.post("/api/late-route", async () => {
    reached++;
    return jsonResponse({ ok: true });
  });
  running = startServer({
    handler: app.handler,
    logger: app.instance.log.agents,
  });
});
afterAll(async () => {
  await running?.server.stop(true);
  await app?.instance.shutdown();
  if (root) rmSync(root, { recursive: true, force: true });
});

const concrete = (template: string) =>
  template.replace(/\{(\w+):path\}/g, "a/b").replace(/\{(\w+)\}/g, "abc123");

function routeKeys(): string[] {
  const keys: string[] = [];
  for (const route of app.router.routes())
    for (const method of route.methods) keys.push(`${method} ${route.path}`);
  return keys;
}

// Feature: #2926 Loopback scripts use v1; bundled tools retain their internal routes.
test("loopback audiences classify every registered route and restrict scripts", async () => {
  const token = JSON.parse(
    readFileSync(join(root, "data", "server.json"), "utf8"),
  ).token as string;
  const baseHeaders = { "x-loopback-token": token };
  const routes = app.router
    .routes()
    .filter((route) => route.path !== "/api/late-route");
  const inventory = routes
    .flatMap((route) =>
      route.methods.map(
        (method) =>
          `${method} ${route.path} ${loopbackAudience(method, concrete(route.path))}`,
      ),
    )
    .sort();
  expect(inventory).toEqual(audiences);
  for (const route of routes) {
    if (!route.path.startsWith("/api/")) continue;
    for (const method of route.methods) {
      const path = concrete(route.path);
      const audience = loopbackAudience(method, path);
      if (audience === "public" || audience === "v1") continue;
      const response = await fetch(`${running.url}${path}`, {
        method,
        redirect: "manual",
        headers: { ...baseHeaders, "content-type": "application/json" },
        body: method === "GET" || method === "HEAD" ? undefined : "{}",
      });
      expect([method, route.path, response.status]).toEqual([
        method,
        route.path,
        403,
      ]);
    }
  }
  for (const path of [
    "/api/status",
    "/api/version",
    "/api/v1/version",
    "/api/v1/schema",
  ])
    expect(
      (await fetch(`${running.url}${path}`, { headers: baseHeaders })).status,
    ).toBe(200);
  const index = "/api/subagent-tool/conversations";
  for (const marker of ["", "unknown", "subagent, worktree"]) {
    const response = await fetch(`${running.url}${index}`, {
      headers: { ...baseHeaders, "x-recurse-bundled-tool": marker },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "web_only" });
  }
  const duplicate = new Headers([
    ["x-loopback-token", token],
    ["x-recurse-bundled-tool", "subagent"],
    ["x-recurse-bundled-tool", "worktree"],
  ]);
  expect(
    (await fetch(`${running.url}${index}`, { headers: duplicate })).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${running.url}${index}/`, {
        headers: baseHeaders,
        redirect: "manual",
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${running.url}/api/v1/../tree`, { headers: baseHeaders }))
      .status,
  ).toBe(403);
  const bundled = await fetch(`${running.url}${index}`, {
    headers: { ...baseHeaders, "x-recurse-bundled-tool": "worktree" },
  });
  expect(bundled.status).not.toBe(403);
  const web = await fetch(`${running.url}/api/tree`, { headers: baseHeaders });
  expect(await web.json()).toEqual({
    detail: "web app only: use /api/v1 or tools/subagent.ts",
    code: "web_only",
  });
  const login = await fetch(`${running.url}/login`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ password: PASSWORD }),
  });
  expect(login.status).toBe(303);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      await fetch(`${running.url}/api/tree`, {
        headers: { ...baseHeaders, cookie },
      })
    ).status,
  ).not.toBe(403);
  expect(
    (
      await fetch(`${running.url}/api/late-route`, {
        method: "POST",
        headers: { ...baseHeaders, "x-recurse-bundled-tool": "subagent" },
      })
    ).status,
  ).toBe(403);
  expect(reached).toBe(0);
  const openWorld = appWorld();
  const openApp = await buildApp({
    env: openWorld.env,
    sink: new WebLogSink(() => {}),
  });
  const openServer = startServer({
    handler: openApp.handler,
    logger: openApp.instance.log.agents,
  });
  try {
    const openToken = JSON.parse(
      readFileSync(join(openWorld.root, "data", "server.json"), "utf8"),
    ).token as string;
    expect((await fetch(`${openServer.url}/api/tree`)).status).not.toBe(403);
    expect(
      (
        await fetch(`${openServer.url}/api/tree`, {
          headers: { "x-loopback-token": openToken },
        })
      ).status,
    ).toBe(403);
  } finally {
    await openServer.server.stop(true);
    await openApp.instance.shutdown();
    rmSync(openWorld.root, { recursive: true, force: true });
  }
});

test("every route without a credential is refused, except PUBLIC", async () => {
  const keys = routeKeys();
  expect(keys).toContain("POST /api/late-route");
  for (const route of app.router.routes())
    for (const method of route.methods) {
      const key = `${method} ${route.path}`;
      const response = await fetch(`${running.url}${concrete(route.path)}`, {
        method,
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: method === "GET" || method === "HEAD" ? undefined : "{}",
      });
      const text = await response.text();
      if (PUBLIC.has(key)) {
        expect([key, response.status]).toEqual([key, 401]);
        expect(text).toContain("Wrong password");
        continue;
      }
      expect(text).not.toContain("Wrong password");
      expect([key, response.status]).toEqual([key, 401]);
    }
  expect(reached).toBe(0);
});

test("every mutating route refuses a cross-site request before auth", async () => {
  for (const route of app.router.routes())
    for (const method of route.methods) {
      if (!MUTATING.has(method)) continue;
      const key = `${method} ${route.path}`;
      const response = await fetch(`${running.url}${concrete(route.path)}`, {
        method,
        redirect: "manual",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: "{}",
      });
      const text = await response.text();
      expect([key, response.status]).toEqual([key, 403]);
      expect(text).toContain("cross-site request blocked");
    }
  expect(reached).toBe(0);
});
