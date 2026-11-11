import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { setSafetyReviewOff } from "../../src/extensions/core/safety/durable";
import { buildApp, WebLogSink } from "../../src/web/app";
import { apiSchema, type AgentStatus } from "../../src/web/api_v1/schema";
import { held } from "./fixtures/durable_host/host";
import { seedPiModelList } from "./pi_model_list_fixture";
import { appWorld } from "./web_app_support";
import snapshot from "./fixtures/api_v1/revisions/8.json";

// Regression: #3024 idle polling waits through early timer wakeups.
test("v1 discovery and agent reads", async () => {
  const { root, env } = appWorld({ password: true });
  seedPiModelList(join(root, "data", "config"));
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const reply = fauxAssistantMessage("done");
  const active = held(reply);
  const faux = fauxProvider();
  faux.setResponses([active.step, reply]);
  const models = createModels();
  models.setProvider(faux.provider);
  const deps = (
    app.instance.durable as unknown as {
      deps: { models: typeof models; settings: () => string[] };
    }
  ).deps;
  deps.models = models;
  deps.settings = () => ["faux/faux-1", "off"];
  const running = await app.serve({ port: 0 });
  let stopProxy: (() => void) | undefined;
  const deadline = Date.now() + 30_000;
  const until = async (condition: () => boolean | Promise<boolean>) => {
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("condition timed out");
      await Bun.sleep(20);
    }
  };
  try {
    await until(
      () =>
        app.instance.lifecycle.readinessSnapshot().ready &&
        app.instance.treeView.ready(),
    );
    const parent = String(
      (await app.instance.create.create({ title: "Parent" })).id,
    );
    const child = String(
      (
        await app.instance.create.create({
          title: "Child",
          parent,
          muted: true,
        })
      ).id,
    );
    const token = (
      await Bun.file(join(env.CHAT_DATA_DIR!, "server.json")).json()
    ).token as string;
    await Bun.write(
      join(env.CHAT_DATA_DIR!, "server.json"),
      JSON.stringify({ port: Number(new URL(running.url).port), token }),
    );
    const get = (path: string) =>
      fetch(`${running.url}${path}`, {
        headers: { "x-loopback-token": token },
      });
    const check = async (path: string, schema: TSchema) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(Value.Check(schema, body)).toBe(true);
      return body;
    };
    const schema = await check(
      "/api/v1/schema",
      apiSchema.routes["GET /api/v1/schema"].response,
    );
    expect(schema).toEqual(snapshot);
    await check(
      "/api/v1/version",
      apiSchema.routes["GET /api/v1/version"].response,
    );
    const list = (await check(
      `/api/v1/agents?root=${parent}`,
      apiSchema.routes["GET /api/v1/agents"].response,
    )) as { agents: { id: string }[] };
    expect(new Set(list.agents.map((a) => a.id))).toEqual(
      new Set([parent, child]),
    );
    const cold = (await check(
      `/api/v1/agents/${child}`,
      apiSchema.routes["GET /api/v1/agents/{id}"].response,
    )) as AgentStatus;
    expect(cold.context).toBeNull();
    expect(app.instance.durable.opened.has(child)).toBe(false);
    const idle = () =>
      check(
        `/api/v1/agents/${parent}/idle`,
        apiSchema.routes["GET /api/v1/agents/{id}/idle"].response,
      );
    expect(await idle()).toEqual({ idle: true, busy: [] });
    let clock: string | undefined;
    const cli = (...args: string[]) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          ...(clock ? ["--preload", clock] : []),
          join(import.meta.dir, "../../tools/subagent.ts"),
          ...args,
        ],
        env: {
          ...process.env,
          CHAT_DATA_DIR: env.CHAT_DATA_DIR,
          RECURSE_AGENT_ID: parent,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const result = async (proc: ReturnType<typeof cli>) => ({
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      code: await proc.exited,
    });
    const subtree = await result(cli("status", parent, "--subtree", "--json"));
    expect(subtree.code).toBe(0);
    expect(JSON.parse(subtree.stdout)).toEqual(
      await (await get(`/api/v1/agents?root=${parent}`)).json(),
    );
    const single = await result(cli("status", child, "--json"));
    expect(JSON.parse(single.stdout)).toEqual(
      await (await get(`/api/v1/agents/${child}`)).json(),
    );
    expect((await result(cli("status"))).stdout).toContain(`${parent} idle`);
    const all = await result(cli("status", "--json"));
    expect(JSON.parse(all.stdout)).toEqual(
      await (await get("/api/v1/agents")).json(),
    );
    const multiple = await result(cli("status", parent, child, "--json"));
    expect(
      multiple.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id),
    ).toEqual([parent, child]);
    expect((await result(cli("status", "--subtree"))).code).toBe(2);
    expect((await result(cli("status", `${parent}@remote`))).code).not.toBe(0);
    expect((await result(cli("idle"))).code).toBe(0);
    expect((await result(cli("idle", "--wait", "0"))).code).toBe(2);
    expect((await result(cli("compact"))).code).toBe(2);
    expect((await result(cli("compact", child, parent))).code).toBe(2);
    const missingCompact = await result(cli("compact", "missing"));
    expect(missingCompact.code).not.toBe(0);
    expect(missingCompact.stderr).toContain("conversation not found");
    const missingCli = await result(cli("idle", "missing"));
    expect(missingCli.code).not.toBe(0);
    expect(missingCli.stderr).toContain("agent not found");
    app.instance.treeView.invalidate();
    const unavailable = await get(`/api/v1/agents/${parent}/idle`);
    const unavailableCli = await result(cli("idle"));
    expect(unavailableCli.code).not.toBe(0);
    expect(unavailableCli.stderr).toContain("tree is not ready");
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("2");
    expect(await unavailable.json()).toEqual({
      detail: "tree is not ready",
      code: "not_ready",
    });
    await check(
      `/api/v1/agents/${child}`,
      apiSchema.routes["GET /api/v1/agents/{id}"].response,
    );
    await app.instance.conversations.refreshProjection();
    await until(() => app.instance.treeView.ready());
    await app.instance.delivery.deliver(
      child,
      `work ${"word ".repeat(20_000)}`,
      { origin: "operator" },
    );
    await active.started;
    expect(await idle()).toEqual({
      idle: false,
      busy: [{ id: child, reason: "running" }],
    });
    await app.instance.delivery.deliver(
      child,
      `queued ${"word ".repeat(20_000)}`,
      {
        origin: "agent",
        sender: parent,
      },
    );
    await until(() => app.instance.durable.metadata(child).pending.length > 0);
    expect(await idle()).toEqual({
      idle: false,
      busy: [
        { id: child, reason: "running" },
        { id: child, reason: "queued" },
      ],
    });
    const busyCli = await result(cli("idle"));
    expect(busyCli.code).toBe(1);
    expect(busyCli.stdout).toBe(`${child} running\n${child} queued\n`);
    const timed = await result(cli("idle", parent, "--wait", "1"));
    expect(timed.code).toBe(1);
    expect(timed.stdout).toBe(busyCli.stdout);
    const timingAgent = String(
      (await app.instance.create.create({ title: "Timing" })).id,
    );
    const calls: number[] = [];
    let delay = true;
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        calls.push(performance.now());
        const response = await fetch(
          new URL(request.url).pathname.replace(/^/, running.url),
          {
            headers: { "x-loopback-token": token },
          },
        );
        if (delay) await Bun.sleep(1500);
        return response;
      },
    });
    stopProxy = () => proxy.stop(true);
    await Bun.write(
      join(env.CHAT_DATA_DIR!, "server.json"),
      JSON.stringify({ port: proxy.port, token }),
    );
    const delayed = await result(cli("idle", timingAgent, "--wait", "1"));
    expect(delayed.code).toBe(1);
    expect(delayed.stderr).toContain("Timed out");
    delay = false;
    calls.length = 0;
    const polled = await result(cli("idle", parent, "--wait", "6"));
    expect(polled.code).toBe(1);
    expect(polled.stdout).toBe(busyCli.stdout);
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(4900);
    clock = join(root, "slow-clock.ts");
    await Bun.write(
      clock,
      `const now = performance.now.bind(performance);
const start = now();
performance.now = () => start + (now() - start) / 2;
`,
    );
    calls.length = 0;
    const earlyWake = await result(cli("idle", parent, "--wait", "1"));
    expect(calls).toHaveLength(1);
    expect(earlyWake.code).toBe(1);
    expect(earlyWake.stderr).toContain("Timed out");
    expect(earlyWake.stdout).toBe(busyCli.stdout);
    clock = undefined;
    stopProxy();
    stopProxy = undefined;
    await Bun.write(
      join(env.CHAT_DATA_DIR!, "server.json"),
      JSON.stringify({ port: Number(new URL(running.url).port), token }),
    );
    const waiting = cli("idle", "--wait", "10");
    expect(
      await Promise.race([
        waiting.exited.then(() => "exited"),
        Bun.sleep(300).then(() => "waiting"),
      ]),
    ).toBe("waiting");
    active.release();
    expect((await result(waiting)).code).toBe(0);
    const usageStatus = (await check(
      `/api/v1/agents/${child}`,
      apiSchema.routes["GET /api/v1/agents/{id}"].response,
    )) as AgentStatus;
    expect(usageStatus.context).not.toBeNull();
    expect(usageStatus.context!.tokens).toBeGreaterThan(0);
    const ui = (await app.instance.reads.readContextUsage(child))!;
    const { session, ...occupancy } = usageStatus.context!;
    expect({ tokens: ui.used_tokens, window: ui.context_window }).toEqual(
      occupancy,
    );
    const contextView = await app.instance.reads.readViewWindow(child, {
      limit: 1,
    });
    expect(contextView.status).toBe("ready");
    expect(typeof session).toBe("string");
    expect(contextView.session).toBe(session);
    expect(
      JSON.parse((await result(cli("status", child, "--json"))).stdout).context,
    ).toEqual(usageStatus.context);
    expect((await result(cli("status", child))).stdout).toContain(
      `context=${ui.used_tokens}/${ui.context_window ?? "unknown"}`,
    );
    expect(usageStatus.status).toBe("idle");
    const childConversation = (await app.instance.durable.open(child))
      .conversation;
    const compactions = async () =>
      (
        await childConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)
      ).items.filter((entry) => entry.kind === "pi.compaction");
    faux.setResponses([fauxAssistantMessage("Idle summary")]);
    const compacted = await result(cli("compact", child));
    expect(compacted.code).toBe(0);
    const compactResult = JSON.parse(compacted.stdout);
    expect(
      Value.Check(
        apiSchema.routes["POST /api/v1/agents/{id}/compact"].response,
        compactResult,
      ),
    ).toBe(true);
    expect(compactResult).toEqual({
      id: child,
      action: "compact",
      queued: false,
    });
    await until(async () => (await compactions()).length === 1);
    expect(
      JSON.parse((await result(cli("status", child, "--json"))).stdout).context,
    ).toBeNull();
    expect(
      JSON.stringify(
        await app.instance.durable.transcript(child, { limit: 50 }),
      ),
    ).toContain("work");
    const compactingTurn = held(fauxAssistantMessage("After compaction"));
    faux.setResponses([
      compactingTurn.step,
      fauxAssistantMessage("Running summary"),
    ]);
    await app.instance.delivery.deliver(
      child,
      `keep working ${"word ".repeat(20_000)}`,
      { origin: "operator" },
    );
    await compactingTurn.started;
    try {
      const queuedCompact = await result(cli("compact", child));
      expect(queuedCompact.code).toBe(0);
      expect(JSON.parse(queuedCompact.stdout)).toEqual({
        id: child,
        action: "compact",
        queued: true,
      });
      expect(
        JSON.parse((await result(cli("status", child, "--json"))).stdout)
          .status,
      ).toBe("running");
    } finally {
      compactingTurn.release();
      await childConversation.waitForIdle(BACKGROUND_CONTEXT);
    }
    await until(async () => (await compactions()).length === 2);
    expect(
      JSON.parse((await result(cli("status", child, "--json"))).stdout).context,
    ).toBeNull();
    const childHandle = await app.instance.durable.opened.get(child)!;
    await childHandle.close();
    app.instance.durable.opened.delete(child);
    expect(
      ((await (await get(`/api/v1/agents/${child}`)).json()) as AgentStatus)
        .context,
    ).toBeNull();
    expect(app.instance.durable.opened.has(child)).toBe(false);
    expect(app.instance.durable.liveRows.has(child)).toBe(false);

    const shellAgent = String(
      (await app.instance.create.create({ title: "Shell" })).id,
    );
    const opened = await app.instance.durable.open(shellAgent);
    await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "sleep 60", background: true }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started"),
    ]);
    await app.instance.delivery.deliver(shellAgent, "start shell", {
      origin: "operator",
    });
    await until(
      () =>
        app.instance.durable.shells(shellAgent).items.length > 0 &&
        app.instance.durable.metadata(shellAgent).status === "idle",
    );
    expect(
      await check(
        `/api/v1/agents/${shellAgent}/idle`,
        apiSchema.routes["GET /api/v1/agents/{id}/idle"].response,
      ),
    ).toEqual({ idle: false, busy: [{ id: shellAgent, reason: "shell" }] });
    const missing = await get("/api/v1/agents/missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      detail: "agent not found",
      code: "not_found",
    });
  } finally {
    stopProxy?.();
    active.release();
    await running.close();
    await app.instance.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
