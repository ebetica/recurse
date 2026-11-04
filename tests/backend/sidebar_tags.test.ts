import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { buildApp, WebLogSink } from "../../src/web/app";
import { publishLoopbackToken } from "../../src/web/request_auth";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import type { RuntimeLogRecord } from "../../src/observability/runtime_logging";
import { appWorld } from "./web_app_support";
import { fauxHost, until } from "./fixtures/durable_host/host";

type Rec = Record<string, any>;

// Feature: #2940 sidebar tags: operator route, agent CLI, reply stamp, snooze expiry.
test("sidebar tags round-trip for the operator and agents, survive stale saves and restarts", async () => {
  const { root, env } = appWorld();
  const fixture = fauxHost(join(root, "faux"));
  const reply: FauxResponseFactory = async () => {
    fixture.faux.appendResponses([reply]);
    return fauxAssistantMessage("Done");
  };
  fixture.faux.setResponses([reply]);
  const logs: string[] = [];
  const logged = (event: string, cid: string) =>
    logs.filter((l) => l.includes(`event=${event}`) && l.includes(cid));
  const start = async () => {
    const sink = new WebLogSink(() => {});
    sink.write = (record: RuntimeLogRecord) => void logs.push(record.message);
    const app = await buildApp({ env, sink });
    const fake = (fixture.host as unknown as { deps: DurableHostDeps }).deps;
    Object.assign(
      (app.instance.durable as unknown as { deps: DurableHostDeps }).deps,
      {
        models: fake.models,
        settings: fake.settings,
        agentEnv: fake.agentEnv,
        promptSnapshot: fake.promptSnapshot,
        titleSettings: () => ["faux/faux-1", "off"],
      },
    );
    const running = await app.serve({ port: 0 });
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    return { app, running };
  };
  const stop = async ({ app, running }: Awaited<ReturnType<typeof start>>) => {
    await running.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
  };
  let server = await start();
  const post = (path: string, body: object, headers: Rec = {}) =>
    fetch(`${server.running.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const row = async (cid: string): Promise<Rec> =>
    (
      (await (await fetch(`${server.running.url}/api/tree`)).json()) as Rec[]
    ).find((r) => r.id === cid)!;
  const cli = async (caller: string, ...args: string[]) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../tools/subagent.ts"),
        ...args,
      ],
      {
        cwd: root,
        env: { ...env, RECURSE_AGENT_ID: caller },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  try {
    const token = await publishLoopbackToken(
      env.CHAT_DATA_DIR!,
      server.running.port,
    );
    const create = async () =>
      String(((await (await post("/api/conversations", {})).json()) as Rec).id);
    const cid = await create();
    const agent = await create();
    const conversations = server.app.instance.conversations;
    const stale = conversations.load(cid)!;

    const changed = await post("/api/sidebar/tags", {
      ids: [cid, "missing"],
      set: { archived: null, pinned: null },
    });
    expect(await changed.json()).toEqual({ missing: ["missing"] });
    const archived = (await row(cid)).tags.archived;
    expect(archived).toMatchObject({ by: "operator" });
    expect((await row(cid)).tags.pinned).toMatchObject({ by: "operator" });
    for (const headers of [
      { "x-recurse-agent": agent },
      { "x-loopback-token": token, "x-recurse-bundled-tool": "subagent" },
    ])
      expect(
        (
          await post(
            "/api/sidebar/tags",
            { ids: [cid], clear: ["archived"] },
            headers,
          )
        ).status,
      ).toBe(403);

    expect(await cli(agent, "tag", cid, "--add", "needs-review,ci")).toEqual({
      stdout: `Tags changed on ${cid}: +needs-review +ci\n`,
      stderr: "",
      code: 0,
    });
    expect((await row(cid)).tags["needs-review"]).toMatchObject({ by: agent });
    const refused = await cli(agent, "tag", cid, "--remove", "pinned");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("only the operator");
    expect((await cli(agent, "tag", cid, "--remove", "ci")).code).toBe(0);

    const store = (
      conversations as unknown as {
        agentStore: { flush(id: string, timeout?: number): Promise<boolean> };
      }
    ).agentStore;
    const flush = store.flush.bind(store);
    const flushes: boolean[] = [];
    let firstStamp: unknown;
    store.flush = async (id, timeout) => {
      if (id !== cid) return await flush(id, timeout);
      firstStamp ??= conversations.load(cid)!.replied_at;
      const ok = flushes.length > 0 && (await flush(id, timeout));
      flushes.push(ok);
      return ok;
    };
    expect(
      (await post(`/api/conversations/${cid}/deliver`, { content: "hello" }))
        .status,
    ).toBe(200);
    await until(() => logged("durable_report_delivered", cid).length > 0);
    store.flush = flush;
    expect(flushes).toEqual([false, true]);
    expect(logged("durable_report_failed", cid)).toHaveLength(1);
    const tagged = await row(cid);
    const run = String(conversations.load(cid)!.replied_run);
    expect(logged("durable_report_delivered", cid)[0]).toContain(run);
    expect(typeof firstStamp).toBe("number");
    expect(tagged.replied_at).toBe(firstStamp);
    expect(Object.keys(tagged.tags).sort()).toEqual([
      "archived",
      "needs-review",
      "pinned",
    ]);

    await conversations.save(stale);
    expect((await row(cid)).tags).toEqual(tagged.tags);
    expect((await row(cid)).replied_at).toBe(tagged.replied_at);

    const later = Date.now() / 1000 + 3600;
    await post("/api/sidebar/tags", { ids: [cid], set: { snoozed: later } });
    expect((await row(cid)).tags.snoozed).toMatchObject({ until: later });
    const served = (now: number) =>
      server.app.instance.treeView.serve(now).find((r) => r.id === cid)! as Rec;
    expect(Object.keys(served(later - 1).tags)).toContain("snoozed");
    expect(Object.keys(served(later).tags)).not.toContain("snoozed");
    expect(
      (await post("/api/sidebar/tags", { ids: [cid], set: { snoozed: null } }))
        .status,
    ).toBe(422);

    const before = await row(cid);
    await stop(server);
    server = await start();
    const after = await row(cid);
    expect(after.tags).toEqual(before.tags);
    expect(after.replied_at).toBe(before.replied_at);
  } finally {
    await stop(server);
    await fixture.host.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
