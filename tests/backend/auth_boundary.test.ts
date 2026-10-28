import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { buildApp, WebLogSink, type App } from "../../src/web/app";
import { startServer, type RunningServer } from "../../src/server";
import { jsonResponse } from "../../src/web/router";
import { appWorld } from "./web_app_support";

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
