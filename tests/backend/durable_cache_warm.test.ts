import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { buildInstance } from "../../src/agents/instance";
import { appWorld } from "./web_app_support";
import { Config } from "../../src/config";
import { DurableHost } from "../../src/agents/durable/host";
import { setSafetyReviewOff } from "../../src/extensions/core/safety/durable";
import { UsageDoc } from "../../node_modules/@earendil-works/pi-durable/dist/harness/usage.js";
import { testDeps, until, held } from "./fixtures/durable_host/host";
import type { WarmingClock } from "../../src/extensions/extra/cache-warm/cache-warm";

// Feature: #2979 Warm the exact last request only while real Durable work remains.
test("cache warming replays busy conversations, accounts usage and stops at idle or when disabled", async () => {
  for (const mode of [
    "shell",
    "idle",
    "off",
    "child",
    "interrupt",
    "model",
    "shutdown",
    "side",
    "limit",
  ]) {
    const { root, env } = appWorld();
    const config = new Config({ env });
    if (mode === "off") await config.setKeepPromptCacheWarm(false);
    let now = 0;
    const timers = new Map<() => void, number>();
    const clock: WarmingClock = {
      now: () => now,
      schedule: (callback, delay) => {
        timers.set(callback, now + delay);
        return () => {
          timers.delete(callback);
        };
      },
    };
    const advance = (ms: number) => {
      now += ms;
      for (const [callback, at] of [...timers])
        if (at <= now) {
          timers.delete(callback);
          callback();
        }
    };
    const faux = fauxProvider({
      tokensPerSecond: 100000,
      models: [
        {
          id: "faux-1",
          cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
        },
      ],
    });
    faux.models[0].promptCache = { short: 300, long: 300 };
    const models = createModels();
    models.setProvider(faux.provider);
    const records: Record<string, Record<string, unknown>> = {
      c1: {
        id: "c1",
        backend: "durable",
        workdir: root,
        status: "idle",
        model: "faux/faux-1",
        tmp_key: "20261031-cache-warm-model",
      },
    };
    const deps = testDeps(
      config.paths.DATA_DIR,
      (cid) => records[cid] ?? null,
      () => Object.keys(records),
    );
    const settings = (record: Record<string, unknown>): [string, string] => [
      String(record.model ?? "faux/faux-1"),
      "off",
    ];
    const instance =
      mode === "model"
        ? await buildInstance({ config, sink: { write: () => {} } })
        : null;
    if (instance) await instance.conversations.save(records.c1!);
    const bindings = { config, models, warmingClock: clock, settings };
    if (instance)
      Object.assign(instance.durable.deps, {
        ...bindings,
        agentEnv: deps.agentEnv,
        promptSnapshot: deps.promptSnapshot,
        titleSettings: undefined,
      });
    const host = instance?.durable ?? new DurableHost({ ...deps, ...bindings });
    const observed: { request: unknown; options: Record<string, unknown> }[] =
      [];
    const capture: FauxResponseStep = (request, options) => {
      const { signal, ...kept } = options ?? {};
      observed.push({
        request: JSON.parse(JSON.stringify(request)),
        options: JSON.parse(JSON.stringify(kept)),
      });
      return fauxAssistantMessage("done");
    };
    const shell = mode !== "idle" && mode !== "child";
    const child = held(fauxAssistantMessage("child finished"));
    const side = held(fauxAssistantMessage("side finished"));
    const warming = held(fauxAssistantMessage("warming finished"));
    let warmingSignal: AbortSignal | undefined;
    const holdWarm: FauxResponseStep = (request, options, state, model) => {
      warmingSignal = options?.signal;
      return warming.step(request, options, state, model);
    };
    faux.setResponses(
      shell
        ? [
            fauxAssistantMessage(
              fauxToolCall("bash", {
                command: `while [ ! -e '${join(root, "finished")}' ]; do sleep 0.01; done`,
                background: true,
              }),
              { stopReason: "toolUse" },
            ),
            capture,
            mode === "model" || mode === "shutdown" ? holdWarm : capture,
            capture,
          ]
        : mode === "child"
          ? [child.step, capture, capture]
          : [capture, capture],
    );
    try {
      if (mode === "child") {
        records.child = {
          id: "child",
          parent: "c1",
          backend: "durable",
          workdir: root,
        };
        await host.send("child", "Keep working", "child-r1");
        await child.started;
      }
      const opened = await host.open("c1");
      await setSafetyReviewOff(opened.conversation, true, context);
      await host.send(
        "c1",
        "Keep working on this context.\n".repeat(10000),
        "r1",
      );
      await until(
        () => !host.isRunning("c1") && host.metadata("c1").pending.length === 0,
      );
      if (shell) await until(() => host.liveRows.get("c1")!.shells.size === 1);
      const captured = await opened.captures.latest("c1");
      if (mode === "side") {
        records.side = {
          id: "side",
          side_of: "c1",
          backend: "durable",
          workdir: root,
        };
        await host.open("side");
        await host.stop("c1");
        faux.setResponses([
          (request, options, state, model) => {
            void capture(request, options, state, model);
            return side.step(request, options, state, model);
          },
          capture,
        ]);
        await host.send("side", "Keep inspecting", "side-r1");
        await side.started;
      }
      const before = faux.state.callCount;
      if (mode === "interrupt") await host.stop("c1");
      advance(mode === "limit" ? 3600001 : 270000);
      if (mode === "model" || mode === "shutdown") {
        await warming.started;
        if (instance)
          await instance.nodes
            .node("c1", instance.agentStore)
            .setModel("faux/other");
        else {
          const closing = host.close();
          expect(warmingSignal!.aborted).toBe(true);
          expect(timers.size).toBe(0);
          await closing;
          continue;
        }
        expect(warmingSignal!.aborted).toBe(true);
        expect(timers.size).toBe(0);
      }
      if (mode === "side") {
        await until(() => observed.length === 3);
        expect(observed[2]!.request).toEqual(observed[1]!.request);
        expect(observed[2]!.options.sessionId).toBe(
          observed[1]!.options.sessionId,
        );
        expect(observed[2]!.options.sessionId).toBe(
          observed[0]!.options.sessionId,
        );
        const sideOpened = await host.open("side");
        await until(async () =>
          (
            await sideOpened.conversation.entries({}, 100, undefined, context)
          ).items.some((e) => e.kind === "recurse.cache-warm"),
        );
      }
      if (mode === "shell" || mode === "child") {
        await until(() => observed.length === 2);
        await until(async () =>
          (
            await opened.conversation.entries({}, 100, undefined, context)
          ).items.some((e) => e.kind === "recurse.cache-warm"),
        );
        expect((await opened.captures.latest("c1"))!.json).toBe(captured!.json);
        expect(observed[1]!.request).toEqual(observed[0]!.request);
        expect(observed[1]!.options).toEqual({
          ...observed[0]!.options,
          maxTokens: 1,
          maxRetries: 0,
        });
        const entries = (
          await opened.conversation.entries({}, 100, undefined, context)
        ).items;
        const warm = entries.find((e) => e.kind === "recurse.cache-warm")!;
        expect(warm.data).toMatchObject({ usageType: "cache_warm" });
        const usage = await opened.harness.snapshot(
          UsageDoc,
          opened.conversation.id,
          context,
        );
        expect(usage!.models["faux/faux-1"]!.totalTokens).toBeGreaterThan(
          (warm.data as { usage: { totalTokens: number } }).usage.totalTokens,
        );
        const view = await host.view("c1");
        expect(
          (view.blocks as Record<string, unknown>[]).some(
            (b) => b.role === "usage",
          ),
        ).toBe(true);
      } else {
        expect(faux.state.callCount).toBe(
          before + Number(mode === "model" || mode === "side"),
        );
      }
      if (shell) {
        await writeFile(join(root, "finished"), "done");
        await until(() => host.liveRows.get("c1")!.shells.size === 0);
      }
      child.release();
      side.release();
      await until(
        () =>
          !host.cacheWarmBusy("c1") &&
          (mode !== "side" || !host.cacheWarmBusy("side")),
      );
      expect({ mode, activeTimers: timers.size }).toEqual({
        mode,
        activeTimers: 0,
      });
      const after = faux.state.callCount;
      advance(300000);
      expect(faux.state.callCount).toBe(after);
    } finally {
      child.release();
      side.release();
      warming.release();
      await (instance?.shutdown() ?? host.close());
      expect(timers.size).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30000);
