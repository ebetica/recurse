import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, WebLogSink } from "../../src/web/app";
import { retire } from "../../src/utils/trash";
import { appWorld, PASSWORD } from "../backend/web_app_support";
import { until } from "../backend/fixtures/durable_host/host";
import { ROOT, runBrowserTests, type BrowserTest } from "./common";

// Feature: #2695 Backend-bound browser clients isolate revoked keys and outages from home authentication.
export const test_backend_client: BrowserTest = async (browser) => {
  const worlds = [appWorld({ password: true }), appWorld({ password: true })];
  const apps = await Promise.all(
    worlds.map(({ env }) => buildApp({ env, sink: new WebLogSink(() => {}) })),
  );
  const servers = await Promise.all(apps.map((app) => app.serve({ port: 0 })));
  const context = await browser.newContext();
  const page = await context.newPage();
  const login = async (base: string) => {
    const response = await fetch(base + "/login", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ password: PASSWORD }),
    });
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  try {
    await until(() =>
      apps.every((app) => app.instance.lifecycle.readinessSnapshot().ready),
    );
    const home = servers[0]!.url;
    const remote = servers[1]!.url;
    const homeCookie = await login(home);
    const remoteCookie = await login(remote);
    await page.goto(home + "/login");
    await context.addCookies([
      {
        name: "chat_auth",
        value: homeCookie.slice("chat_auth=".length),
        url: home,
      },
    ]);
    const cid = String(
      (await apps[1]!.instance.create.create({ title: "Client seam" })).id,
    );
    const connected = await fetch(home + "/api/backends", {
      method: "POST",
      headers: { cookie: homeCookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "B", url: remote, password: PASSWORD }),
    });
    expect(connected.status).toBe(200);
    const entry = join(worlds[0]!.root, "browser-client.ts");
    await writeFile(
      entry,
      `import * as client from ${JSON.stringify(join(ROOT, "web/backends/backend.ts"))}; Object.assign(window, {backendClient: client});`,
    );
    const bundle = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "iife",
    });
    expect(bundle.success).toBe(true);
    await page.addScriptTag({ content: await bundle.outputs[0]!.text() });
    const initial = await page.evaluate(async (remoteCid: string) => {
      const client = (globalThis as any).backendClient;
      const backend = new client.Backend("B");
      client.registerBackend(backend);
      (globalThis as any).remoteBackend = backend;
      const id = client.conversationId("B", remoteCid);
      const owner = client.backendFor(id);
      const home = await client.homeBackend.api("/api/version");
      const response = await owner.api(
        `/api/conversations/${encodeURIComponent(id)}`,
      );
      const conversation = await response.json();
      const form = new FormData();
      form.append(
        "file",
        new File(["Backend file"], "client.txt", { type: "text/plain" }),
      );
      form.append("owner", remoteCid);
      const uploaded = await (
        await owner.api("/api/attachments", { method: "POST", body: form })
      ).json();
      const url = client.resolveUrl(owner, uploaded.url);
      const contents = await (await owner.api(url)).text();
      const labelsRejected = [".", ".."].every((label) => {
        try {
          new client.Backend(label);
          return false;
        } catch {
          return true;
        }
      });
      const rejected =
        labelsRejected &&
        [
          (globalThis as any).location.origin + uploaded.url,
          "//example.com/api/file",
          "/api/../../password",
          "https://example.com/file",
        ].every((value) => {
          try {
            client.resolveUrl(owner, value);
            return false;
          } catch {
            return true;
          }
        });
      return {
        home: home.status,
        status: response.status,
        cid: conversation.id,
        url,
        contents,
        rejected,
        health: client.homeBackend.connectionHealth.snapshot().phase,
      };
    }, cid);
    expect(initial).toMatchObject({
      home: 200,
      status: 200,
      cid,
      contents: "Backend file",
      rejected: true,
      health: "connected",
    });
    expect(initial.url).toStartWith(
      `/api/backends/B/conversations/${cid}/attachments/`,
    );
    const keys = (await (
      await fetch(remote + "/api/backend-keys", {
        headers: { cookie: remoteCookie },
      })
    ).json()) as Array<{ id: string }>;
    expect(keys.length).toBe(1);
    expect(
      (
        await fetch(remote + `/api/backend-keys/${keys[0]!.id}`, {
          method: "DELETE",
          headers: { cookie: remoteCookie },
        })
      ).status,
    ).toBe(200);
    const revoked = await page.evaluate(async () => {
      const backend = (globalThis as any).remoteBackend;
      const response = await backend.api("/api/version");
      return {
        status: response.status,
        remote: backend.connectionHealth.snapshot().phase,
        home: (
          globalThis as any
        ).backendClient.homeBackend.connectionHealth.snapshot().phase,
      };
    });
    expect(revoked).toEqual({
      status: 424,
      remote: "auth-expired",
      home: "connected",
    });
    await servers[1]!.close();
    const unreachable = await page.evaluate(async () => {
      const client = (globalThis as any).backendClient;
      const backend = new client.Backend("B");
      const response = await backend.api("/api/version");
      return {
        status: response.status,
        remote: backend.connectionHealth.snapshot().phase,
        home: client.homeBackend.connectionHealth.snapshot().phase,
      };
    });
    expect(unreachable).toEqual({
      status: 502,
      remote: "reconnecting",
      home: "connected",
    });
    await context.clearCookies();
    await Promise.all([
      page.waitForEvent("load"),
      page
        .evaluate(async () => {
          await (globalThis as any).backendClient.homeBackend.api(
            "/api/version",
          );
        })
        .catch((error: Error) => {
          if (!error.message.includes("Execution context was destroyed"))
            throw error;
        }),
    ]);
    expect(await page.evaluate(() => "backendClient" in globalThis)).toBe(
      false,
    );
  } finally {
    await context.close();
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(apps.map((app) => app.instance.shutdown()));
    await Promise.all(apps.flatMap((app) => app.detached));
    await Promise.all(
      worlds.map(({ root }) =>
        retire(root, join(tmpdir(), "backend-client-trash")),
      ),
    );
  }
};

if (import.meta.main)
  await runBrowserTests([["backend-client", [test_backend_client]]]);
