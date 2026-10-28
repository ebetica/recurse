import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildApp, WebLogSink } from "../../src/web/app";
import { appWorld } from "./web_app_support";

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const TEXT =
  chunk({ role: "assistant", content: "scripted reply" }) +
  chunk({}, "stop") +
  "data: [DONE]\n\n";

const seen: string[] = [];
let provider: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as { model?: string };
      seen.push(String(body.model));
      return new Response(TEXT, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
});
afterAll(() => provider?.stop(true));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();
async function until(check: () => Promise<boolean>, ms = 60_000) {
  const deadline = performance.now() + ms;
  while (!(await check().catch(() => false))) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(50);
  }
}

test("an off-ladder model create runs its first turn on that model", async () => {
  const { root, env } = appWorld();
  const config = join(env.CHAT_DATA_DIR!, "config");
  mkdirSync(config, { recursive: true });
  const level = { model: "recurse-test/ladder", reasoning: "low" };
  writeFileSync(
    join(config, "effort-levels.json"),
    JSON.stringify({
      default_level: 3,
      levels: { 1: level, 2: level, 3: level, 4: level, 5: level },
      version: 1,
    }),
  );
  writeFileSync(
    join(config, "model-providers.json"),
    JSON.stringify({
      default: "recurse-test/ladder",
      providers: {
        "recurse-test": {
          base_url: `http://127.0.0.1:${provider.port}/v1`,
          env_key: "RECURSE_TEST_KEY",
          wire_api: "completions",
          models: [
            { id: "ladder", context_window: 100000 },
            { id: "offladder", context_window: 100000 },
          ],
        },
      },
    }),
  );
  env.RECURSE_TEST_KEY = "loopback-only";
  const app = await buildApp({
    env,
    sink: new WebLogSink(() => {}),
  });
  const running = await app.serve({ port: 0 });
  try {
    const api = (path: string, body?: object) =>
      fetch(`${running.url}${path}`, {
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        headers: { "content-type": "application/json" },
      });
    await until(async () => (await json(await api("/api/status"))).ready);
    const created = await api("/api/conversations", {
      model: "recurse-test/offladder",
    });
    expect(created.status).toBe(200);
    const cid = String((await json(created)).id);
    const stored = app.instance.conversations.load(cid)!;
    expect(stored.level ?? null).toBeNull();
    expect(stored.model).toBe("recurse-test/offladder");
    expect(stored.backend).toBe("durable");
    expect(app.instance.conversations.conversationSettings(stored)).toEqual([
      "recurse-test/offladder",
      String(stored.effort),
    ]);

    const sent = await api(`/api/conversations/${cid}/deliver`, {
      content: "hello",
    });
    expect(sent.status).toBe(200);
    expect((await json(sent)).ok).toBe(true);
    await until(
      async () => seen.includes("offladder") && seen.includes("ladder"),
    );
    expect(new Set(seen)).toEqual(new Set(["offladder", "ladder"]));
    const inspected = await json(await api(`/api/conversations/${cid}/prompt`));
    expect(inspected.request.model.modelId).toBe("offladder");
    expect(inspected.naming.request.model.modelId).toBe("ladder");
    await until(
      async () =>
        (await json(await api(`/api/conversations/${cid}`))).status === "idle",
    );
    const ladderCreated = await api("/api/conversations", { level: 3 });
    expect(ladderCreated.status).toBe(200);
    const ladderCid = String((await json(ladderCreated)).id);
    const deliver = async (model: string) => {
      expect(
        (
          await api(`/api/conversations/${ladderCid}/deliver`, {
            content: "hello",
          })
        ).status,
      ).toBe(200);
      await until(async () => {
        const prompt = await json(
          await api(`/api/conversations/${ladderCid}/prompt`),
        );
        const row = await json(await api(`/api/conversations/${ladderCid}`));
        return prompt.request?.model.modelId === model && row.status === "idle";
      });
    };
    await deliver("ladder");
    const changed = { model: "recurse-test/offladder", reasoning: "high" };
    expect(
      (
        await api("/api/settings/effort-levels", {
          levels: { 1: level, 2: level, 3: changed, 4: level, 5: level },
        })
      ).status,
    ).toBe(200);
    await deliver("offladder");
    expect(
      app.instance.conversations.load(ladderCid, {
        withPending: false,
        fields: ["id", "backend", "status", "missing"],
      }),
    ).toEqual({ id: ladderCid, backend: "durable", status: "idle" });
  } finally {
    await running.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
