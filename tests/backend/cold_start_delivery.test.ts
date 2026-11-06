import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildApp } from "../../src/web/app";
import { publishLoopbackToken } from "../../src/web/request_auth";
import { appWorld } from "./web_app_support";
import { fauxHost, until } from "./fixtures/durable_host/host";

// Regression: #3148 cold-start delivery stays retryable until the conversation index is ready.
test("remote delivery retries startup admission without duplicating the message", async () => {
  const worlds = [appWorld(), appWorld()];
  const apps = await Promise.all(worlds.map(({ env }) => buildApp({ env })));
  const servers = await Promise.all(apps.map((app) => app.serve({ port: 0 })));
  const provider = fauxHost(join(worlds[1]!.root, "provider"));
  const deliveries: { id: string; status: number }[] = [];
  let locked: Database | undefined;
  let wakeProbes = 0;
  let uncertain = false;
  let refuseRetry = false;
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (locked && url.pathname === "/api/status") wakeProbes++;
      const body = request.body ? await request.text() : undefined;
      const deliver = url.pathname.endsWith("/deliver");
      if (deliver && refuseRetry)
        return Response.json(
          { detail: "conversation not found" },
          { status: 404 },
        );
      const response = await fetch(
        servers[1]!.url + url.pathname + url.search,
        {
          method: request.method,
          headers: request.headers,
          body,
        },
      ).catch(() => new Response(null, { status: 503 }));
      if (deliver) {
        deliveries.push({
          id: JSON.parse(body!).client_message_id,
          status: response.status,
        });
        if (
          locked &&
          deliveries.filter((row) => row.status === 503).length === 2
        ) {
          locked.exec("ROLLBACK");
          locked.close();
          locked = undefined;
          await until(
            () => apps[1]!.instance.lifecycle.readinessSnapshot().ready,
          );
        }
        if (uncertain && response.ok) {
          refuseRetry = true;
          await response.arrayBuffer();
          return Response.json({ ok: true });
        }
      }
      return response;
    },
  });
  const [home] = apps;
  try {
    await until(() =>
      apps.every((app) => app.instance.lifecycle.readinessSnapshot().ready),
    );
    const sender = String(
      (await home!.instance.create.create({ title: "Sender" })).id,
    );
    const receiver = String(
      (await apps[1]!.instance.create.create({ title: "Receiver" })).id,
    );
    await apps[1]!.instance.conversations.save({
      ...apps[1]!.instance.conversations.load(receiver)!,
      safety_off: true,
    });
    const connected = await fetch(servers[0]!.url + "/api/backends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "cold", url: gateway.url.origin }),
    });
    expect(connected.status).toBe(200);
    await until(() =>
      home!.connectedBackends.list().some((row) => row.state === "connected"),
    );
    await publishLoopbackToken(worlds[0]!.env.CHAT_DATA_DIR!, servers[0]!.port);
    const send = async (target: string, content: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../tools/subagent.ts"),
          "send",
          `${target}@cold`,
          content,
        ],
        {
          env: { ...worlds[0]!.env, RECURSE_AGENT_ID: sender },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      return out;
    };
    const dbPath = apps[1]!.instance.agentStore.dbPath(receiver);
    await servers[1]!.close();
    await apps[1]!.instance.shutdown();
    await Promise.all(apps[1]!.detached);
    locked = new Database(dbPath);
    locked.exec("BEGIN EXCLUSIVE");
    apps[1] = await buildApp({ env: worlds[1]!.env });
    const deps = apps[1]!.instance.durable.deps;
    const fauxDeps = provider.host.deps;
    Object.assign(deps, {
      models: fauxDeps.models,
      settings: fauxDeps.settings,
    });
    const agentEnv = deps.agentEnv;
    deps.agentEnv = async (...args) => {
      const env = { ...(await agentEnv(...args)) };
      delete env.RECURSE_MODEL_POLICY;
      return env;
    };
    provider.faux.setResponses([fauxAssistantMessage("cold start received")]);
    servers[1] = await apps[1]!.serve({ port: 0 });
    expect(apps[1]!.instance.conversations.projectionReady()).toBe(false);
    expect(apps[1]!.instance.conversations.load(receiver)).toBeNull();
    const early = await fetch(
      servers[1]!.url + `/api/conversations/${receiver}/deliver`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "not admitted yet",
          client_message_id: crypto.randomUUID(),
        }),
      },
    );
    expect(early.status).toBe(503);
    expect(early.headers.get("retry-after")).toBe("2");
    expect(await send(receiver, "deliver across cold start")).toBe(
      `Delivered to ${receiver}@cold.\n`,
    );
    expect(deliveries.map((row) => row.status)).toEqual([503, 503, 200]);
    expect(new Set(deliveries.map((row) => row.id)).size).toBe(1);
    expect(wakeProbes).toBe(1);
    await until(async () =>
      JSON.stringify(await apps[1]!.instance.durable.view(receiver)).includes(
        "cold start received",
      ),
    );
    const view = (await apps[1]!.instance.durable.view(receiver)).blocks as {
      role: string;
      text: string;
    }[];
    expect(
      view.filter(
        (row) =>
          row.role === "user" && row.text.includes("deliver across cold start"),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("not admitted yet");
    const missing = await fetch(
      servers[1]!.url + "/api/conversations/missing/deliver",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "missing" }),
      },
    );
    expect(missing.status).toBe(404);
    expect(await send("missing", "missing")).toBe(
      "Failed: missing not found on cold.\n",
    );
    await until(() => apps[1]!.instance.durable.runningCount() === 0);
    provider.faux.setResponses([fauxAssistantMessage("uncertain received")]);
    uncertain = true;
    const unconfirmed = await send(receiver, "admitted before refused retry");
    expect(unconfirmed).toContain(
      "Not confirmed: cold refused the retry (404);",
    );
    expect(unconfirmed).not.toContain("connection");
    expect(unconfirmed).toContain("the message may have arrived");
  } finally {
    locked?.exec("ROLLBACK");
    locked?.close();
    gateway.stop(true);
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(apps.map((app) => app.instance.shutdown()));
    await provider.host.close();
    await Promise.all(apps.flatMap((app) => app.detached));
    await Promise.all(
      worlds.map(({ root }) => rm(root, { recursive: true, force: true })),
    );
  }
}, 60_000);
