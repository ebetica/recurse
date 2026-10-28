import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { buildApp, WebLogSink } from "../../src/web/app";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import { appWorld } from "./web_app_support";
import { fauxHost, switchoverWorld, until } from "./fixtures/durable_host/host";

test("the operator safety route controls the next Durable bash review", async () => {
  const { root, env } = appWorld();
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const fixture = fauxHost(join(root, "faux"), "faux/faux-1", true);
  const deps = (app.instance.durable as unknown as { deps: DurableHostDeps })
    .deps;
  const fake = (fixture.host as unknown as { deps: DurableHostDeps }).deps;
  Object.assign(deps, {
    models: fake.models,
    settings: fake.settings,
    agentEnv: fake.agentEnv,
    promptSnapshot: fake.promptSnapshot,
  });
  const running = await app.serve({ port: 0 });
  const api = (path: string, body?: object) =>
    fetch(`${running.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await until(
      async () =>
        ((await (await api("/api/status")).json()) as { ready: boolean }).ready,
    );
    const created = await api("/api/conversations", {});
    expect(created.status).toBe(200);
    const cid = String(((await created.json()) as { id: string }).id);
    const host = app.instance.durable;
    const settled = () =>
      host.runningCount() === 0 && host.metadata(cid).pending.length === 0;
    const { faux } = fixture;
    for (const off of [true, false]) {
      faux.setResponses([fauxAssistantMessage("ack")]);
      const response = await api(`/api/conversations/${cid}/safety`, { off });
      expect(response.status).toBe(200);
      await until(settled);
      const before = faux.state.callCount;
      const file = join(fixture.work, String(off));
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash", { command: `touch ${file}` }),
          { stopReason: "toolUse" },
        ),
        ...(!off ? [fauxAssistantMessage("DENY: test refusal")] : []),
        fauxAssistantMessage("done"),
      ]);
      await host.send(cid, "create the file", `call-${off}`);
      await until(settled);
      expect(existsSync(file)).toBe(off);
      expect(faux.state.callCount - before).toBe(off ? 2 : 3);
    }
    const setter = host.setSafetyReviewOff.bind(host);
    const calls = faux.state.callCount;
    host.setSafetyReviewOff = async () => {
      throw new Error("safety commit failed");
    };
    const failed = await api(`/api/conversations/${cid}/safety`, { off: true });
    host.setSafetyReviewOff = setter;
    expect(failed.status).toBe(500);
    expect(host.safetyReviewOff(cid)).toBe(false);
    expect(app.instance.nodes.node(cid).pendingIntents()).toEqual([]);
    expect(faux.state.callCount).toBe(calls);
  } finally {
    await running.close();
    await app.instance.shutdown();
    await fixture.host.close();
    await Promise.all(app.detached);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

// Regression: #2217 safety toggle deadlocked minting imported conversation temp key
test("a safety toggle completes on the first open of an imported conversation with no temp key", async () => {
  const world = await switchoverWorld();
  try {
    await world.row("legacy", null, "recurse-test/scripted");
    await world.move.attempt(
      world.load("legacy")!,
      new AbortController().signal,
    );
    expect(world.load("legacy")).toMatchObject({ backend: "durable" });
    expect(world.load("legacy")!.tmp_key).toBeUndefined();
    const [conv] = await world.instance.nodes.node("legacy").setSafety(true);
    expect(conv.safety_off).toBe(true);
    expect(world.instance.durable.safetyReviewOff("legacy")).toBe(true);
    expect(typeof world.load("legacy")!.tmp_key).toBe("string");
  } finally {
    await world.close();
  }
});
