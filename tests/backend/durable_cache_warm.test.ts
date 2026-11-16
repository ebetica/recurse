import { expect, test } from "bun:test";
import { access, rm, writeFile } from "node:fs/promises";
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
import { RecurseUsageDoc } from "../../src/extensions/core/context/durable-compaction";
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

// Feature: #3266 Compact long idle Durable conversations inside their last prompt-cache window.
test("idle compaction shares cache deadlines, cancels stale work and records normal compaction", async () => {
  for (const mode of [
    "compact",
    "warming",
    "restart",
    "short",
    "off",
    "disabled",
    "threshold",
    "unknown",
    "note",
    "turn",
    "descendant",
    "waiting-short",
    "late",
    "model",
    "abort",
    "manual",
    "close",
  ]) {
    const { root, env } = appWorld();
    const config = new Config({ env });
    await config.setKeepPromptCacheWarm(mode === "warming");
    if (mode !== "off")
      await config.setCompactIdleConversations(
        true,
        mode === "threshold" ? 200000 : 120000,
      );
    let now = 0;
    const timers = new Map<() => void, number>();
    const clock: WarmingClock = {
      now: () => now,
      schedule(callback, delay) {
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
          contextWindow: 1000000,
          cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
        },
      ],
    });
    if (mode !== "unknown")
      faux.models[0].promptCache = { short: 300, long: 300 };
    const models = createModels();
    models.setProvider(faux.provider);
    const record: Record<string, unknown> = {
      id: "c1",
      backend: "durable",
      workdir: root,
      model: "faux/faux-1",
    };
    const records: Record<string, Record<string, unknown>> = { c1: record };
    let rowChanges = 0;
    const cacheMisses: Record<string, unknown>[] = [];
    const fallbacks: Record<string, unknown>[] = [];
    const bindings: ConstructorParameters<typeof DurableHost>[0] = {
      ...testDeps(
        config.paths.DATA_DIR,
        (cid) => records[cid] ?? null,
        () => Object.keys(records),
      ),
      config,
      models,
      warmingClock: clock,
      log: (event, fields) => {
        if (event === "durable_idle_compaction_cache_miss")
          cacheMisses.push(fields);
        if (event === "durable_compaction_summary_fallback")
          fallbacks.push(fields);
      },
      settings: () => [String(record.model), "off"],
      rowChanged: () => {
        rowChanges++;
      },
    };
    let host = new DurableHost(bindings);
    const summary = held(
      fauxAssistantMessage("## Goal\nContinue the task.\n## Progress\nDone."),
    );
    const turn = held(fauxAssistantMessage("new turn"));
    faux.setResponses([
      ...(mode === "warming" ? [turn.step] : []),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("done"),
      ...(mode === "warming" ? [fauxAssistantMessage("warm")] : []),
      summary.step,
    ]);
    try {
      if (mode === "warming") {
        records.child = { ...record, id: "child", parent: "c1" };
        await host.send("child", "Continue", "child-r1");
        await turn.started;
      }
      let opened = await host.open("c1");
      const idle = () =>
        !host.isRunning("c1") && host.metadata("c1").pending.length === 0;
      await host.send(
        "c1",
        mode === "short" || mode === "waiting-short"
          ? "Short context"
          : "Historical context.\n".repeat(30000),
        "r1",
      );
      await until(idle);
      await host.send("c1", "Recent context.\n".repeat(10000), "r2");
      await until(idle);
      const activityPath = join(host.storagePath("c1"), "..", "activity");
      const activityExists = () =>
        access(activityPath).then(
          () => true,
          () => false,
        );
      await until(async () => !(await activityExists()));
      if (mode === "warming") {
        advance(270000);
        await until(async () =>
          (
            await opened.conversation.entries({}, 100, undefined, context)
          ).items.some((entry) => entry.kind === "recurse.cache-warm"),
        );
        turn.release();
        await until(() => !host.cacheWarmBusy("c1") && timers.size === 1);
      }
      const compacts =
        mode === "compact" ||
        mode === "warming" ||
        mode === "restart" ||
        mode === "descendant";
      const before = faux.state.callCount;
      if (
        mode === "turn" ||
        mode === "descendant" ||
        mode === "waiting-short"
      ) {
        faux.setResponses([turn.step, summary.step]);
        const cid = mode === "turn" ? "c1" : "child";
        if (cid === "child")
          records.child = { ...record, id: cid, parent: "c1" };
        await host.send(cid, "Continue", "r3");
        await turn.started;
      }
      if (mode === "disabled") {
        await config.setCompactIdleConversations(false);
        host.reconcileCacheWarmers();
      }
      if (mode === "note")
        await host.send("c1", "New context without a turn", "note-r3", {
          note: true,
        });
      if (mode === "model") {
        record.model = "faux/other";
        host.invalidatePromptCache("c1");
      }
      if (mode === "abort") await host.stop("c1");
      if (mode === "manual") {
        await host.compact("c1");
        await summary.started;
        summary.release();
        await until(async () => !(await host.live("c1"))?.compactions?.length);
      }
      if (mode === "close") await host.close();
      if (compacts) {
        expect(timers.size).toBe(1);
        advance(269999);
        expect(faux.state.callCount).toBe(
          before + Number(mode === "descendant"),
        );
      }
      expect(timers.size).toBe(Number(compacts || mode === "late"));
      const changes = rowChanges;
      if (mode === "restart") {
        await host.close();
        const crash = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "fixtures/durable_cache_warm/crash.ts"),
            JSON.stringify(env),
            root,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [output, error, code] = await Promise.all([
          new Response(crash.stdout).text(),
          new Response(crash.stderr).text(),
          crash.exited,
        ]);
        expect({ error, code }).toEqual({ error: "", code: 0 });
        expect(JSON.parse(output)).toEqual({ marked: true });
        expect(cacheMisses).toEqual([]);
        expect(faux.state.callCount).toBe(before);
        host = new DurableHost(bindings);
        opened = await host.open("c1");
      } else advance(mode === "late" ? 300001 : compacts ? 1 : 270000);
      if (compacts) {
        await summary.started;
        expect(host.cacheWarmBusy("c1")).toBe(mode === "descendant");
        expect(await activityExists()).toBe(false);
        summary.release();
        await until(async () =>
          (
            await opened.conversation.entries({}, 100, undefined, context)
          ).items.some((e) => e.kind === "pi.compaction"),
        );
        const entries = (
          await opened.conversation.entries({}, 100, undefined, context)
        ).items;
        expect(
          entries.filter((entry) => entry.kind === "pi.compaction"),
        ).toHaveLength(1);
        expect(
          entries.filter((entry) => entry.kind === "recurse.cache-warm"),
        ).toHaveLength(Number(mode === "warming"));
        expect(faux.state.callCount).toBe(
          before + 1 + Number(mode === "descendant"),
        );
        expect(fallbacks).toEqual([]);
        const usage = await opened.harness.snapshot(
          RecurseUsageDoc,
          opened.conversation.id,
          context,
        );
        expect(usage!.models["faux/faux-1"]!.totalTokens).toBeGreaterThan(0);
        const view = await host.view("c1");
        expect(
          (view.blocks as Record<string, unknown>[]).some(
            (message) => message.role === "compaction",
          ),
        ).toBe(true);
        expect(rowChanges).toBe(changes);
        expect(cacheMisses).toEqual([{ cid: "c1", cache_read_tokens: 0 }]);
      } else
        expect(faux.state.callCount).toBe(
          before +
            Number(
              mode === "turn" || mode === "waiting-short" || mode === "manual",
            ),
        );
      const after = faux.state.callCount;
      advance(300000);
      expect(faux.state.callCount).toBe(after);
      expect(timers.size).toBe(0);
    } finally {
      summary.release();
      turn.release();
      await host.close();
      await config.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30000);
