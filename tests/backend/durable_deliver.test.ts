import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(20_000);
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableHost } from "../../src/agents/durable/host.ts";
import type { DurableReport } from "../../src/agents/durable/report.ts";
import {
  openWorkerSqliteStorage,
  SqliteWorker,
} from "../../src/agents/durable/sqlite_worker.ts";
import { held, idle, testDeps, until } from "./fixtures/durable_host/host.ts";

type Rec = Record<string, unknown>;

const root = mkdtempSync(join(tmpdir(), "durable-deliver-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function world(dataDir = mkdtempSync(join(root, "data-"))) {
  const work = join(dataDir, "work");
  mkdirSync(work, { recursive: true });
  const records: Record<string, Rec> = {
    c1: { id: "c1", backend: "durable", workdir: work },
  };
  return { dataDir, records };
}

function hostOn(
  { dataDir, records }: ReturnType<typeof world>,
  responses: FauxResponseStep[],
  report?: (cid: string, report: DurableReport) => Promise<"done" | "retry">,
  log?: (event: string, fields: Rec) => void,
) {
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const host = new DurableHost({
    ...testDeps(
      dataDir,
      (cid) => records[cid] ?? null,
      () => Object.keys(records),
    ),
    models,
    ...(report === undefined ? {} : { report }),
    ...(log === undefined ? {} : { log }),
  });
  return { faux, host, models };
}

const heldAnswer = (text: string) => held(fauxAssistantMessage(text));

const blocks = async (host: DurableHost, cid = "c1") =>
  (await host.view(cid, { limit: 50 })).blocks as Rec[];

const userTexts = async (host: DurableHost) =>
  (await blocks(host)).filter((b) => b.role === "user").map((b) => b.text);

const assistantTexts = async (host: DurableHost) =>
  (await blocks(host))
    .filter((b) => b.role === "assistant" && b.text)
    .map((b) => b.text);

async function requestUsers(host: DurableHost): Promise<string[]> {
  const request = (await host.prompt("c1")).request as {
    context: { messages: Rec[] };
  };
  return request.context.messages
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Rec[]).map((p) => p.text).join(""),
    )
    .map((text) =>
      text.replace(/\n\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]$/, ""),
    );
}

test("view session identity follows Durable storage across clear", async () => {
  const { host } = hostOn(world(), [
    fauxAssistantMessage("before clear"),
    fauxAssistantMessage("after clear"),
  ]);
  try {
    await host.send("c1", "first", "r1");
    await until(idle(host));
    const before = await host.view("c1");
    expect((await host.view("c1")).session).toBe(before.session);
    await host.clear("c1");
    await until(() => host.metadata("c1").pending_actions.length === 0);
    const cleared = await host.view("c1");
    expect(cleared.session).not.toBe(before.session);
    expect(cleared.blocks).toEqual([]);
    await host.send("c1", "second", "r2");
    await until(idle(host));
    expect((await host.view("c1")).session).toBe(cleared.session);
    expect(await assistantTexts(host)).toEqual(["after clear"]);
  } finally {
    await host.close();
  }
});

// Feature: #2538 clear discards the old model error before reopening.
test("clear discards a previous model error before opening the replacement", async () => {
  const { dataDir, records } = world();
  const deps = testDeps(
    dataDir,
    (cid) => records[cid] ?? null,
    () => ["c1"],
  );
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("after clear")]);
  let selection = "faux/faux-1";
  let sawError = false;
  let opening = 0;
  let replacementHeld = false;
  const replacement = Promise.withResolvers<void>();
  const host = new DurableHost({
    ...deps,
    models,
    settings: () => [selection, "off"],
    log: (event) => {
      if (event === "durable_model_sync_failed") sawError = true;
    },
    agentEnv: async () => {
      if (++opening === 2) {
        replacementHeld = true;
        await replacement.promise;
      }
      return deps.agentEnv();
    },
  });
  const { harness, conversation } = await host.open("c1");
  const snapshot = harness.snapshot.bind(harness);
  let trackerHeld = false;
  const tracker = Promise.withResolvers<void>();
  let blockRotation = false;
  const rotation = Promise.withResolvers<void>();
  harness.snapshot = new Proxy(snapshot, {
    async apply(target, thisArg, args) {
      const result = await Reflect.apply(target, thisArg, args);
      if (sawError && args[0].definition.kind === "recurse.safety") {
        trackerHeld = true;
        await tracker.promise;
      }
      if (blockRotation && args[0] === LiveDoc) await rotation.promise;
      return result;
    },
  });
  try {
    selection = "missing/model";
    await conversation.submit(
      {
        type: "write",
        requestId: "trigger-model-sync",
        entry: { kind: "recurse.note", model: [] },
      },
      context,
    );
    await until(() => trackerHeld);
    blockRotation = true;
    await host.clear("c1");
    await host.send("c1", "held for fresh storage", "after-clear");
    expect(host.metadata("c1").pending[0]).toMatchObject({
      error: expect.stringContaining("missing/model"),
    });
    selection = "faux/faux-1";
    rotation.resolve();
    await until(() => replacementHeld);
    expect(host.metadata("c1").pending).toEqual([
      { id: "after-clear", role: "user", content: "held for fresh storage" },
    ]);
    replacement.resolve();
    await until(() => host.metadata("c1").pending_actions.length === 0);
    await until(idle(host));
    expect(await assistantTexts(host)).toEqual(["after clear"]);
  } finally {
    tracker.resolve();
    rotation.resolve();
    replacement.resolve();
    harness.snapshot = snapshot;
    await host.close();
  }
});

describe("Stop", () => {
  // Regression: #2326 Pi 1.2 display-only writes no longer promote queued input.
  test("stop aborts only the run; the oldest queued input starts the next, invisibly", async () => {
    const first = heldAnswer("late");
    const { host } = hostOn(world(), [
      first.step,
      fauxAssistantMessage("second answer"),
      fauxAssistantMessage("third answer"),
    ]);
    try {
      await host.send("c1", "first", "r1");
      await until(() => host.runningCount() === 1);
      await host.send("c1", "second", "r2");
      await host.send("c1", "third", "r3");
      expect(await host.stop("c1")).toBe(true);
      first.release();
      await until(async () =>
        (await assistantTexts(host)).includes("second answer"),
      );
      await until(idle(host));
      expect(await userTexts(host)).toEqual(["first", "second", "third"]);
      const { conversation } = await (
        host as unknown as {
          open(cid: string): Promise<{
            conversation: import("@earendil-works/pi-durable").Conversation;
          }>;
        }
      ).open("c1");
      const users = (
        await conversation.entries({}, 50, undefined, context)
      ).items.filter((e) => e.kind === "pi.user");
      const byText = (text: string) =>
        users.find((e) => JSON.stringify(e.model).includes(`"${text}"`))!;
      expect(byText("second").byTaskId).toBeUndefined();
      expect(byText("third").byTaskId).toBeDefined();
      const view = JSON.stringify(await host.view("c1", { limit: 50 }));
      expect(view).not.toContain("promote");
      expect(await requestUsers(host)).toEqual(["first", "second", "third"]);
      expect(JSON.stringify(await host.prompt("c1"))).not.toContain("promote");
      expect(await host.stop("c1")).toBe(false);
      expect(await userTexts(host)).toEqual(["first", "second", "third"]);
    } finally {
      await host.close();
    }
  });

  test("interrupt replacement stays behind older queued input", async () => {
    const first = heldAnswer("aborted");
    const next = heldAnswer("older answer");
    const { host, faux } = hostOn(world(), [
      first.step,
      next.step,
      fauxAssistantMessage("done"),
    ]);
    try {
      await host.send("c1", "first", "r1");
      await first.started;
      await host.send("c1", "older one", "r2");
      await host.send("c1", "older two", "r3");
      expect(await host.stop("c1")).toBe(true);
      await host.send("c1", "replacement", "r4");
      first.release();
      await next.started;
      expect(await requestUsers(host)).toEqual(["first", "older one"]);
      next.release();
      await until(idle(host));
      expect(faux.state.callCount).toBe(3);
      const ordered = ["first", "older one", "older two", "replacement"];
      expect(await userTexts(host)).toEqual(ordered);
      expect(await requestUsers(host)).toEqual(ordered);
    } finally {
      await host.close();
    }
  });

  test("a restart between the abort and the promotion still starts the queued input", async () => {
    const w = world();
    const first = heldAnswer("late");
    const a = hostOn(w, [first.step]);
    await a.host.send("c1", "first", "r1");
    await until(() => a.host.runningCount() === 1);
    await a.host.send("c1", "second", "r2");
    const conversationId = (await a.host.open("c1")).conversation.id;
    await a.host.close();
    first.release();
    const worker = new SqliteWorker();
    const raw = await Harness.open(
      await openWorkerSqliteStorage(
        worker,
        join(w.dataDir, "conversations", "c1", "durable", "session.sqlite"),
      ),
      { models: a.models, registry: createRegistry() },
      context,
    );
    const run = (await raw.snapshot(LiveDoc, conversationId, context))?.run;
    expect(run).toBeDefined();
    await raw.abortTask(run!.taskId, context);
    expect(
      (await raw.inspect(context)).submissions.map((s) => [
        s.requestId,
        s.status,
      ]),
    ).toEqual([
      ["r1", "placed"],
      ["r2", "queued"],
    ]);
    await raw.close(context);
    worker.close();
    const b = hostOn(w, [fauxAssistantMessage("second answer")]);
    try {
      await b.host.open("c1");
      await until(async () =>
        (await assistantTexts(b.host)).includes("second answer"),
      );
      expect(await userTexts(b.host)).toEqual(["first", "second"]);
    } finally {
      await b.host.close();
    }
  });
});

test("operator steers and multiple shell completions join one model request", async () => {
  const w = world();
  const gate = join(String(w.records.c1!.workdir), "finish-shells");
  const waiting = heldAnswer("waiting");
  const { host, faux } = hostOn(w, [
    fauxAssistantMessage(
      ["one", "two"].map((name) =>
        fauxToolCall("bash", {
          command: `while [ ! -e '${gate}' ]; do sleep 0.01; done; echo shell-${name}`,
          background: true,
        }),
      ),
      { stopReason: "toolUse" },
    ),
    waiting.step,
    fauxAssistantMessage("done"),
  ]);
  try {
    await host.setSafetyReviewOff("c1", true);
    await host.send("c1", "run shells", "r1");
    await waiting.started;
    await host.send("c1", "operator steer", "r2");
    writeFileSync(gate, "");
    const { harness } = await host.open("c1");
    await until(
      async () =>
        (await harness.inspect(context)).submissions.filter(
          (s) => s.status === "queued",
        ).length === 3,
    );
    waiting.release();
    await until(idle(host));
    expect(faux.state.callCount).toBe(3);
    const users = await requestUsers(host);
    expect(users.slice(0, 2)).toEqual(["run shells", "operator steer"]);
    const completions = users.slice(2);
    expect(completions).toHaveLength(2);
    expect(completions.every((text) => text.includes("exited 0"))).toBe(true);
    expect(completions.some((text) => text.includes("shell-one"))).toBe(true);
    expect(completions.some((text) => text.includes("shell-two"))).toBe(true);
  } finally {
    waiting.release();
    await host.close();
  }
});

test("cancel withdraws queued input; an edit is cancel plus a new send at the end", async () => {
  const first = heldAnswer("one");
  const { host } = hostOn(world(), [first.step, fauxAssistantMessage("two")]);
  try {
    await host.send("c1", "first", "r1");
    await until(() => host.runningCount() === 1);
    await host.send("c1", "second", "r2");
    await host.send("c1", "third", "r3");
    await until(() => host.metadata("c1").pending.length === 2);
    expect(await host.cancel("c1", "r2")).toBe(true);
    expect(await host.cancel("c1", "r2")).toBe(false);
    expect(await host.cancel("c1", "r3")).toBe(true);
    await host.send("c1", "third, edited", "r4");
    expect(await host.cancel("c1", "r1")).toBe(false);
    first.release();
    await until(async () => (await assistantTexts(host)).includes("two"));
    expect(await userTexts(host)).toEqual(["first", "third, edited"]);
  } finally {
    await host.close();
  }
});

describe("clear", () => {
  test("input queued before a clear runs first; later input waits, visibly, and starts the fresh conversation", async () => {
    const w = world();
    const first = heldAnswer("one");
    const seen: string[] = [];
    const answer =
      (text: string): FauxResponseStep =>
      (ctx) => {
        const last = ctx.messages.at(-1) as Rec;
        seen.push(String(last.content));
        return fauxAssistantMessage(text);
      };
    const { host } = hostOn(w, [first.step, answer("two"), answer("three")]);
    try {
      await host.send("c1", "first", "r1");
      await until(() => host.runningCount() === 1);
      await first.started;
      await host.send("c1", "second", "r2");
      expect(await host.clear("c1")).toEqual({
        id: "c1",
        action: "clear",
        queued: true,
      });
      await host.send("c1", "after clear", "r3");
      await until(() => host.metadata("c1").pending.length === 2);
      const waiting = host.metadata("c1");
      expect(waiting.pending_actions).toEqual(["clear"]);
      expect(waiting.pending.map((row) => row.id)).toEqual(["r2", "r3"]);
      expect((await host.view("c1", { limit: 50 })).pending_actions).toEqual([
        "clear",
      ]);
      first.release();
      await until(async () => (await assistantTexts(host)).includes("three"));
      expect(seen).toEqual([
        expect.stringContaining("second"),
        expect.stringContaining("after clear"),
      ]);
      expect(await userTexts(host)).toEqual(["after clear"]);
      expect(host.metadata("c1").pending_actions).toEqual([]);
      expect(
        existsSync(join(w.dataDir, "conversations", "c1", "clear.json")),
      ).toBe(false);
      expect(readdirSync(join(w.dataDir, "trash")).length).toBe(1);
    } finally {
      await host.close();
    }
  });

  test("a clear and the input it holds survive a restart", async () => {
    const w = world();
    const first = heldAnswer("one");
    const a = hostOn(w, [first.step]);
    await a.host.send("c1", "first", "r1");
    await until(() => a.host.runningCount() === 1);
    await a.host.clear("c1");
    await a.host.send("c1", "after clear", "r2");
    await a.host.close();
    first.release();
    const b = hostOn(w, [
      fauxAssistantMessage("one, resumed"),
      fauxAssistantMessage("fresh"),
    ]);
    try {
      expect(b.host.metadata("c1").pending_actions).toEqual([]);
      await b.host.open("c1");
      await until(async () => (await assistantTexts(b.host)).includes("fresh"));
      expect(await userTexts(b.host)).toEqual(["after clear"]);
      expect(b.host.metadata("c1").pending_actions).toEqual([]);
    } finally {
      await b.host.close();
    }
  });

  test("the first send after a restart is held by the clear the old server left pending", async () => {
    const w = world();
    const first = heldAnswer("one");
    const a = hostOn(w, [first.step]);
    await a.host.send("c1", "first", "r1");
    await until(() => a.host.runningCount() === 1);
    await a.host.clear("c1");
    await a.host.close();
    first.release();
    const b = hostOn(w, [
      fauxAssistantMessage("one, resumed"),
      fauxAssistantMessage("fresh"),
    ]);
    try {
      await b.host.send("c1", "after restart", "r2");
      await until(async () => (await assistantTexts(b.host)).includes("fresh"));
      expect(await userTexts(b.host)).toEqual(["after restart"]);
    } finally {
      await b.host.close();
    }
  });

  test("concurrent rotation checks replace the storage once", async () => {
    const w = world();
    const { host } = hostOn(w, [fauxAssistantMessage("fresh")]);
    type Internals = {
      clears: Map<string, unknown>;
      maybeRotate(cid: string): Promise<void>;
    };
    const internals = host as unknown as Internals;
    try {
      await host.open("c1");
      internals.clears.set("c1", {
        held: [{ requestId: "r1", content: "held", note: false }],
        rotated: false,
      });
      await Promise.all([1, 2, 3].map(() => internals.maybeRotate("c1")));
      await until(async () => (await assistantTexts(host)).includes("fresh"));
      expect(await userTexts(host)).toEqual(["held"]);
      expect(readdirSync(join(w.dataDir, "trash")).length).toBe(1);
    } finally {
      await host.close();
    }
  });

  test("a note queued during a run is placed after a Stop, and a clear then proceeds", async () => {
    const first = heldAnswer("one");
    const { host } = hostOn(world(), [first.step]);
    try {
      await host.send("c1", "first", "r1");
      await until(() => host.runningCount() === 1);
      await host.send("c1", "a note", "n1", { note: true });
      expect(await host.stop("c1")).toBe(true);
      first.release();
      await until(async () => (await userTexts(host)).includes("a note"));
      await host.clear("c1");
      await until(() => host.metadata("c1").pending_actions.length === 0);
      expect(await userTexts(host)).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("model changes apply when no run is going (D2)", () => {
  function modelHost(w: ReturnType<typeof world>, steps: FauxResponseStep[]) {
    const faux = fauxProvider({
      tokensPerSecond: 20_000,
      models: [
        { id: "faux-1", reasoning: true },
        { id: "faux-2", reasoning: true },
      ],
    });
    const [seen, logs]: string[][] = [[], []];
    faux.setResponses(
      steps.map((step) => (request, options, state, model) => {
        seen.push(`${model.id}/${options?.reasoning ?? "off"}`);
        return typeof step === "function"
          ? step(request, options, state, model)
          : step;
      }),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    const settings = { value: ["faux/faux-1", "low"] as [string, string] };
    const host = new DurableHost({
      ...testDeps(
        w.dataDir,
        (cid) => w.records[cid] ?? null,
        () => Object.keys(w.records),
      ),
      settings: () => settings.value,
      models,
      log: (event: string) => void logs.push(event),
    });
    return { host, seen, settings, logs };
  }

  // Regression: #2184 idle model/effort changes were not applied to next Durable run (also #2410 pending model errors show guidance, not an error class.)
  test("a change during a run leaves that run on its model; the next send or Stop promotion uses it", async () => {
    const [first, fourth] = [heldAnswer("one"), heldAnswer("four")];
    const [seventh, eighth] = [heldAnswer("seven"), heldAnswer("eight")];
    const { host, seen, settings, logs } = modelHost(world(), [
      first.step,
      fauxAssistantMessage("two"),
      fauxAssistantMessage("three"),
      fourth.step,
      fauxAssistantMessage("five"),
      seventh.step,
      eighth.step,
      fauxAssistantMessage("nine"),
    ]);
    try {
      await host.send("c1", "first", "r1");
      await first.started;
      settings.value = ["faux/faux-2", "high"];
      await host.send("c1", "second", "r2");
      first.release();
      await until(idle(host));
      await host.send("c1", "third", "r3");
      await until(() => seen.length === 3);
      await until(idle(host));
      await host.send("c1", "fourth", "r4");
      await fourth.started;
      await host.send("c1", "fifth", "r5");
      settings.value = ["faux/faux-1", "medium"];
      expect(await host.stop("c1")).toBe(true);
      fourth.release();
      await until(async () => (await assistantTexts(host)).includes("five"));
      const models =
        "faux-1/low faux-1/low faux-2/high faux-2/high faux-1/medium";
      expect(seen.join(" ")).toBe(models);
      await until(idle(host));
      settings.value = ["meta/muse-1", "off"];
      const refused = await host.send("c1", "sixth", "r6").catch((e) => e);
      expect(String(refused)).toContain(
        "Model meta/muse-1 is unavailable. Pick another effort level in the model picker, or fix its model in Settings > Effort ladder.",
      );
      expect(seen).toHaveLength(5);
      settings.value = ["faux/faux-1", "medium"];
      await host.send("c1", "seventh", "r7");
      await seventh.started;
      const earlierSyncFailures = logs.filter((e) =>
        e.endsWith("sync_failed"),
      ).length;
      settings.value = ["meta/muse-1", "off"];
      await host.send("c1", "eighth", "r8");
      await host.send("c1", "withdrawn", "r8b");
      expect(await host.stop("c1")).toBe(true);
      seventh.release();
      await until(() =>
        host
          .metadata("c1")
          .pending.some((row) => row.id === "r8" && row.error !== undefined),
      );
      const { id, error } = host.metadata("c1").pending[0]!;
      expect(id).toBe("r8");
      expect(error).toBe(
        "Model meta/muse-1 is unavailable. Pick another effort level in the model picker, or fix its model in Settings > Effort ladder.",
      );
      expect(await host.cancel("c1", "r8b")).toBe(true);
      await until(() => host.metadata("c1").pending.length === 1);
      settings.value = ["faux/faux-1", "medium"];
      await host.send("c1", "ninth", "r9");
      await eighth.started;
      const [row] = host.metadata("c1").pending;
      expect(`${row?.id} ${row?.error}`).toBe("r9 undefined");
      eighth.release();
      await until(async () => (await assistantTexts(host)).includes("nine"));
      expect(host.metadata("c1").pending).toEqual([]);
      expect(seen.join(" ")).toBe(
        `${models} faux-1/medium faux-1/medium faux-1/medium`,
      );
      expect(logs.filter((e) => e.endsWith("sync_failed"))).toHaveLength(
        earlierSyncFailures + 1,
      );
    } finally {
      await host.close();
    }
  });

  // Regression: #2184 idle model/effort changes were not applied to next Durable run
  test("a clear starts its fresh conversation on the current model, and a restart applies a later change", async () => {
    const w = world();
    const first = heldAnswer("one");
    const { host, seen, settings } = modelHost(w, [
      first.step,
      fauxAssistantMessage("two"),
    ]);
    try {
      await host.send("c1", "first", "r1");
      await first.started;
      await host.clear("c1");
      await host.send("c1", "held by the clear", "r2");
      settings.value = ["faux/faux-2", "high"];
      first.release();
      await until(async () => (await assistantTexts(host)).includes("two"));
      expect(seen).toEqual(["faux-1/low", "faux-2/high"]);
    } finally {
      await host.close();
    }
    const again = modelHost(w, [fauxAssistantMessage("three")]);
    again.settings.value = ["faux/faux-1", "medium"];
    try {
      await again.host.send("c1", "after restart", "r3");
      await until(() => again.seen.length === 1);
      expect(again.seen).toEqual(["faux-1/medium"]);
    } finally {
      await again.host.close();
    }
  });
});

test("a stamped message shows its origin and sender, and its queued row shows only the message", async () => {
  const first = heldAnswer("one");
  const { host } = hostOn(world(), [first.step, fauxAssistantMessage("two")]);
  const stamped = (text: string) =>
    `[recurse-origin: agent]\n[recurse-from: p1]\n[recurse-from-name: Parent]\n${text}`;
  try {
    await host.send("c1", stamped("hi there"), "r1");
    await until(() => host.runningCount() === 1);
    await host.send("c1", stamped("and more"), "r2");
    await until(() => host.metadata("c1").pending.length === 1);
    expect(host.metadata("c1").pending[0]!.content).toBe("and more");
    const [row] = await blocks(host);
    expect([row!.origin, row!.sender, row!.sender_name]).toEqual([
      "agent",
      "p1",
      "Parent",
    ]);
    first.release();
  } finally {
    await host.close();
  }
});

test("a next-turn-only note is written without a run and reaches the next request", async () => {
  const { host, faux } = hostOn(world(), [fauxAssistantMessage("ok")]);
  try {
    await host.send("c1", "a note", "n1", { note: true });
    await until(idle(host));
    expect(host.runningCount()).toBe(0);
    expect(faux.state.callCount).toBe(0);
    expect(await userTexts(host)).toEqual(["a note"]);
    await host.send("c1", "a question", "r1");
    await until(async () => (await assistantTexts(host)).includes("ok"));
    expect(await requestUsers(host)).toEqual(["a note", "a question"]);
  } finally {
    await host.close();
  }
});

describe("reports", () => {
  test("each settled run is reported once, with its text, its trigger, and a stop", async () => {
    const reports: DurableReport[] = [];
    const first = heldAnswer("one");
    const { host } = hostOn(
      world(),
      [first.step, fauxAssistantMessage("two"), fauxAssistantMessage("three")],
      async (_cid, report) => {
        reports.push(report);
        return "done";
      },
    );
    try {
      await host.send("c1", "first", "op:operator::k1");
      await until(() => host.runningCount() === 1);
      await host.send("c1", "second", "op:agent:p1:k2");
      first.release();
      await until(() => reports.length === 1);
      await host.send("c1", "third", "op:operator::k3");
      await until(() => reports.length === 2);
      await (await host.open("c1")).reporter?.kick();
      await until(idle(host));
      expect(
        reports.map(({ key, ...rest }) => [key.split("-").length, rest]),
      ).toEqual([
        [
          4,
          {
            requestId: "op:operator::k1",
            received: ["op:agent:p1:k2"],
            earlier: 0,
            queued: false,
            finalText: "two",
            aborted: false,
            error: null,
          },
        ],
        [
          4,
          {
            requestId: "op:operator::k3",
            received: [],
            earlier: 0,
            queued: false,
            finalText: "three",
            aborted: false,
            error: null,
          },
        ],
      ]);
    } finally {
      await host.close();
    }
  });

  test("a crash after the parent admitted a report delivers it again under the same key", async () => {
    const w = world();
    const delivered: DurableReport[] = [];
    const a = hostOn(w, [fauxAssistantMessage("one")], async (_cid, report) => {
      delivered.push(report);
      return new Promise<never>(() => undefined);
    });
    await a.host.send("c1", "first", "op:operator::k1");
    await until(() => delivered.length === 1);
    await a.host.close();
    const again: DurableReport[] = [];
    const b = hostOn(w, [], async (_cid, report) => {
      again.push(report);
      return "done";
    });
    await b.host.open("c1");
    await until(() => again.length === 1);
    expect(again).toEqual(delivered);
    await b.host.close();
    const parent = hostOn(world(), [fauxAssistantMessage("noted")]);
    try {
      for (const report of [...delivered, ...again])
        await parent.host.send(
          "c1",
          String(report.finalText),
          `op:agent:child:${report.key}`,
        );
      await until(async () =>
        (await assistantTexts(parent.host)).includes("noted"),
      );
      expect(await userTexts(parent.host)).toEqual(["one"]);
    } finally {
      await parent.host.close();
    }
    const later: DurableReport[] = [];
    const c = hostOn(w, [], async (_cid, report) => {
      later.push(report);
      return "done";
    });
    try {
      await (await c.host.open("c1")).reporter?.kick();
      await until(idle(c.host));
      expect(later).toEqual([]);
    } finally {
      await c.host.close();
    }
  });

  test("a refused report is retried until the parent admits it; admission and delivery are logged once", async () => {
    const outcomes: ("retry" | "done")[] = ["retry", "done"];
    const keys: string[] = [];
    const logs: [string, Rec][] = [];
    const { host } = hostOn(
      world(),
      [fauxAssistantMessage("one")],
      async (_cid, report) => {
        keys.push(report.key);
        return outcomes.shift() ?? "done";
      },
      (event, fields) => logs.push([event, fields]),
    );
    try {
      await host.send("c1", "first", "op:operator::k1");
      await until(() => keys.length === 2, 4000);
      expect(keys[0]).toBe(keys[1]!);
      await until(() =>
        logs.some(([event]) => event === "durable_report_delivered"),
      );
      expect(
        logs.filter(([event]) => event.startsWith("durable_send_admitted")),
      ).toEqual([
        [
          "durable_send_admitted",
          {
            cid: "c1",
            request_id: "op:operator::k1",
            submission: expect.any(Number),
          },
        ],
      ]);
      expect(
        logs.filter(([event]) => event === "durable_report_delivered"),
      ).toEqual([["durable_report_delivered", { cid: "c1", key: keys[0]! }]]);
    } finally {
      await host.close();
    }
  });
});
