import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServers } from "../../src/extensions/extra/mcp/mcp";
import { ProcessLifecycle } from "../../src/process_lifecycle";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { registerMcpServerRoutes } from "../../src/web/settings";
import { buildAuthApp } from "./http_auth_app";

// Feature: #2625 Settings must expose safe failures, without credentials or repeated failure logs.
test("authenticated MCP status reports real failures without leaking secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-status-routes-"));
  const secret = "private-mcp-status-token";
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        disabled: { command: "unused", enabled: false, env: { TOKEN: secret } },
        broken: {
          command: process.execPath,
          args: [
            join(import.meta.dir, "fixtures/mcp_probe_server.mjs"),
            "--exit-17",
            `--attempts=${join(root, "attempts")}`,
          ],
          env: { TOKEN: secret },
        },
        closed: { url: `http://127.0.0.1:0/mcp?token=${secret}` },
      },
    }),
  );
  const lifecycle = new ProcessLifecycle({
    registry: new ShellRegistry({
      enabled: true,
      stateDir: root,
      processStartedMs: Date.now(),
    }),
    shellStateDir: root,
  });
  const transitions: [string, string, string | undefined][] = [];
  const servers = new McpServers({
    configPath: join(root, "mcp.json"),
    scope: async () => ({ cwd: root, env: { PATH: process.env.PATH ?? "" } }),
    own: async (proc) =>
      void (await lifecycle.registerProcess(proc, "mcp", "status-test")),
    release: async (proc) =>
      (await lifecycle.cleanupProcessObject(proc)) !== false,
    report: () => {},
    status: (server, state, reason) => {
      transitions.push([server, state, reason]);
    },
  });
  const app = await buildAuthApp(join(root, "http"), {
    extraRoutes: (router) =>
      registerMcpServerRoutes(router, {
        piAgentDir: async () => root,
        mutateExternalStorage: (work) => work(),
      }),
  });
  try {
    const url = new URL("/api/settings/mcp-servers/status", app.running.url)
      .href;
    expect((await fetch(url)).status).toBe(401);
    const headers = { cookie: `chat_auth=${await app.operator.makeToken()}` };
    for (const forbidden of [
      { type: "sse" },
      { toolExposure: { echo: "direct" } },
      { exposure: "direct" },
    ]) {
      const response = await fetch(
        new URL("/api/settings/mcp-servers", app.running.url).href,
        {
          method: "PUT",
          headers: {
            ...headers,
            "content-type": "application/json",
            origin: new URL(app.running.url).origin,
          },
          body: JSON.stringify({
            text: JSON.stringify({
              mcpServers: {
                refused: { url: "http://localhost/", ...forbidden },
              },
            }),
          }),
        },
      );
      expect(response.status).toBe(400);
    }
    const initial = await fetch(url, { headers });
    expect(initial.status).toBe(200);
    expect(((await initial.json()) as { servers: unknown[] }).servers).toEqual([
      { name: "disabled", state: "disabled", checkedAt: null },
      { name: "broken", state: "not-used", checkedAt: null },
      { name: "closed", state: "not-used", checkedAt: null, signedIn: false },
    ]);
    await servers.tools();
    await servers.tools();
    expect(await readFile(join(root, "attempts"), "utf8")).toBe("start\n");
    await servers.close();
    await servers.tools();
    expect(await readFile(join(root, "attempts"), "utf8")).toBe(
      "start\nstart\n",
    );
    expect(
      transitions.toSorted(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      ["broken", "failed", "exited with code 17"],
      ["closed", "failed", "connection refused"],
    ]);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    const text = await response.text();
    const visible = text + JSON.stringify(transitions);
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain("secret-looking-stderr");
    expect(visible).not.toContain("http://");
    const statuses = JSON.parse(text).servers;
    expect(statuses[0]).toEqual({
      name: "disabled",
      state: "disabled",
      checkedAt: null,
    });
    expect(statuses[1]).toMatchObject({
      name: "broken",
      state: "failed",
      reason: "exited with code 17",
    });
    expect(statuses[2]).toMatchObject({
      name: "closed",
      state: "failed",
      reason: "connection refused",
    });
    for (const status of statuses.slice(1)) {
      expect(status.checkedAt).toBeNumber();
      expect(status).not.toHaveProperty("retryAt");
    }
  } finally {
    await servers.close();
    await app.running.close();
    await rm(root, { recursive: true, force: true });
  }
});
