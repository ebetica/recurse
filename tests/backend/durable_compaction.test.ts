import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  type EntryRecord,
  type Harness,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableHost } from "../../src/agents/durable/host.ts";
import { RecurseUsageDoc } from "../../src/extensions/core/context/durable-compaction.ts";
import { held, idle, testDeps, until } from "./fixtures/durable_host/host.ts";

setDefaultTimeout(30_000);
type Rec = Record<string, unknown>;

const root = mkdtempSync(join(tmpdir(), "durable-compaction-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tokens = (n: number) => "word ".repeat(Math.ceil((n * 4) / 5));

function world() {
  const dataDir = mkdtempSync(join(root, "data-"));
  const work = join(dataDir, "work");
  mkdirSync(work, { recursive: true });
  const records: Record<string, Rec> = {
    c1: { id: "c1", backend: "durable", workdir: work },
  };
  return { dataDir, work, records };
}

function hostOn(
  w: ReturnType<typeof world>,
  answers: FauxResponseStep[],
  options: {
    window?: number;
    cap?: number;
    summary?: (prompt: string) => AssistantMessage | Promise<AssistantMessage>;
  } = {},
) {
  const faux = fauxProvider({
    tokensPerSecond: 1_000_000,
    models: [{ id: "faux-1", contextWindow: options.window ?? 128_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const summaries: string[] = [];
  const queue = [...answers];
  const step: FauxResponseStep = async (request, streamOptions, state, m) => {
    const prompt = JSON.stringify(request);
    if (prompt.includes("<conversation>")) {
      summaries.push(prompt);
      return (
        options.summary ?? (() => fauxAssistantMessage("RECURSE SUMMARY"))
      )(prompt);
    }
    const next = queue.shift();
    if (next === undefined) throw new Error("no scripted answer left");
    return typeof next === "function"
      ? next(request, streamOptions, state, m)
      : next;
  };
  faux.setResponses(Array.from({ length: 64 }, () => step));
  const host = new DurableHost({
    ...testDeps(
      w.dataDir,
      (cid) => w.records[cid] ?? null,
      () => Object.keys(w.records),
    ),
    models,
    ...(options.cap === undefined
      ? {}
      : { maximumContextWindow: () => options.cap! }),
  });
  return { host, summaries };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1] = {}) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const opened = (host: DurableHost) =>
  (
    host as unknown as {
      open(
        cid: string,
      ): Promise<{ harness: Harness; conversation: Conversation }>;
    }
  ).open("c1");

async function entries(host: DurableHost): Promise<EntryRecord[]> {
  const { conversation } = await opened(host);
  const page = await conversation.entries({}, 500, undefined, context);
  return [...page.items].sort((a, b) => a.id - b.id);
}

const textOf = (entry: EntryRecord | undefined): string => {
  const content = (entry?.model?.[0] as Rec | undefined)?.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: Rec) => String(part.text ?? "")).join("\n")
      : "";
};

const ofKind = async (host: DurableHost, kind: string) =>
  (await entries(host)).filter((e) => e.kind === kind);

const compactionsRunning = async (host: DurableHost) => {
  const { harness, conversation } = await opened(host);
  return (
    (await harness.snapshot(LiveDoc, conversation.id, context))?.compactions
      ?.length ?? 0
  );
};

async function answered(host: DurableHost, text: string) {
  await until(async () =>
    (await entries(host)).some((e) => textOf(e) === text),
  );
  await until(idle(host));
}

function heldSummary() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const summary = async () => {
    await gate;
    return fauxAssistantMessage("RECURSE SUMMARY");
  };
  return { summary, release };
}

test("background compactions land mid-run with the Recurse summary; one note follows the run, once, also after a restart", async () => {
  const w = world();
  writeFileSync(join(w.work, "a.txt"), tokens(6_000));
  writeFileSync(join(w.work, "b.txt"), "small\n");
  writeFileSync(join(w.work, "c.txt"), tokens(30_000));
  const one = held(call("read", { path: "c.txt" }));
  const two = held(fauxAssistantMessage("done"));
  const first = hostOn(
    w,
    [
      fauxAssistantMessage("hi"),
      call("read", { path: "a.txt" }),
      one.step,
      call("read", { path: "b.txt" }),
      two.step,
    ],
    { window: 1_000_000, cap: 60_000 },
  );
  try {
    await first.host.send("c1", "hello", "seed");
    await answered(first.host, "hi");
    await first.host.send("c1", `go ${tokens(17_000)}`, "r1");
    await one.started;
    await until(async () => first.summaries.length === 1);
    await until(async () => (await compactionsRunning(first.host)) === 0);
    one.release();
    await two.started;
    await until(async () => first.summaries.length === 2);
    await until(async () => (await compactionsRunning(first.host)) === 0);
    two.release();
    await answered(first.host, "done");
    await until(
      async () => (await ofKind(first.host, "recurse.compacted")).length > 0,
    );
    expect(first.summaries[0]).toContain("## Important files");
    const all = await entries(first.host);
    const compactions = all.filter((e) => e.kind === "pi.compaction");
    const done = all.find((e) => textOf(e) === "done")!;
    expect(compactions.length).toBe(2);
    expect(compactions[0]!.byTaskId).toBeDefined();
    expect(compactions[0]!.id).toBeLessThan(done.id);
    expect((compactions[0]!.data as Rec).reason).toBe("threshold");
    expect(textOf(compactions[0])).toContain("RECURSE SUMMARY");
    expect(textOf(compactions[0])).toContain("## Historical Context");
    const { harness, conversation } = await opened(first.host);
    const usage = await harness.snapshot(
      RecurseUsageDoc,
      conversation.id,
      context,
    );
    expect((usage!.models["faux/faux-1"] as Rec).input).toBeGreaterThan(0);
    const notes = all.filter((e) => e.kind === "recurse.compacted");
    expect(notes.length).toBe(1);
    expect(notes[0]!.id).toBeGreaterThan(compactions[1]!.id);
    expect(notes[0]!.byTaskId).toBeUndefined();
    expect(
      JSON.stringify((await first.host.view("c1", { limit: 100 })).blocks),
    ).not.toContain("Your context was just compacted");
  } finally {
    await first.host.close();
  }
  const second = hostOn(w, []);
  try {
    await opened(second.host);
    await until(idle(second.host));
    expect((await ofKind(second.host, "recurse.compacted")).length).toBe(1);
  } finally {
    await second.host.close();
  }
});

test("after a Stop, the note comes before the queued input, so the next run's first request has it", async () => {
  const w = world();
  const busy = held(fauxAssistantMessage("stopped"));
  const requests: string[] = [];
  const { host, summaries } = hostOn(w, [
    fauxAssistantMessage("hi"),
    busy.step,
    (request) => {
      requests.push(JSON.stringify(request));
      return fauxAssistantMessage("answered");
    },
  ]);
  try {
    await host.send("c1", "hello", "seed");
    await answered(host, "hi");
    await host.send("c1", `go ${tokens(25_000)}`, "r1");
    await busy.started;
    await host.compact("c1");
    await until(async () => summaries.length === 1);
    await until(async () => (await compactionsRunning(host)) === 0);
    await host.send("c1", "follow-up", "r2");
    await until(async () => host.metadata("c1").pending.length === 1);
    expect(await host.stop("c1")).toBe(true);
    await answered(host, "answered");
    const all = await entries(host);
    const note = all.find((e) => e.kind === "recurse.compacted")!;
    const input = all.find((e) => textOf(e).includes("follow-up"))!;
    expect(note.byTaskId).toBeUndefined();
    expect(note.id).toBeLessThan(input.id);
    expect(requests.length).toBe(1);
    expect(requests[0]).toContain("Your context was just compacted");
  } finally {
    await host.close();
  }
});

// Regression: #2831 a retained user message follows the summary, outside compacted activity.
test("manual: nothing to compact says so; two requests at once start one compaction, read while Compacting; the summary precedes its first kept user and the notice is at the end", async () => {
  const w = world();
  const gate = heldSummary();
  const { host, summaries } = hostOn(
    w,
    Array.from({ length: 7 }, (_, n) => fauxAssistantMessage(`reply ${n}`)),
    { summary: gate.summary },
  );
  try {
    await host.send("c1", "hello", "seed");
    await answered(host, "reply 0");
    expect(await host.compact("c1")).toEqual({
      id: "c1",
      action: "compact",
      queued: false,
    });
    await until(async () =>
      JSON.stringify((await host.view("c1", { limit: 50 })).blocks).includes(
        "Nothing to compact yet.",
      ),
    );
    for (let n = 1; n < 7; n += 1) {
      await host.send("c1", `task ${n} ${tokens(8_000)}`, `r${n}`);
      await answered(host, `reply ${n}`);
    }
    await host.view("c1", { limit: 50 });
    await Promise.all([host.compact("c1"), host.compact("c1")]);
    expect(await compactionsRunning(host)).toBe(1);
    const during = (await host.view("c1", { limit: 50 })).blocks as Rec[];
    expect(during.filter((b) => b.text === "Compacting\u2026").length).toBe(1);
    gate.release();
    await until(async () => (await compactionsRunning(host)) === 0);
    expect(summaries.length).toBe(1);
    const [compaction] = await ofKind(host, "pi.compaction");
    const rows = (await host.view("c1", { limit: 50 })).blocks as Rec[];
    const at = (id: string) => rows.findIndex((b) => b.id === id);
    expect(rows[at(String(compaction!.head))]?.role).toBe("user");
    expect(at(String(compaction!.id))).toBe(at(String(compaction!.head)) - 1);
    const notice = rows.at(-1)!;
    expect(notice.role).toBe("compaction-notice");
    expect((notice.meta as Rec).summaryEntryId).toBe(String(compaction!.id));
    expect(rows.some((b) => b.text === "Compacting\u2026")).toBe(false);
  } finally {
    await host.close();
  }
});

test("an overflow compacts and the request is retried", async () => {
  const { host } = hostOn(world(), [
    fauxAssistantMessage("hi"),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
    }),
    fauxAssistantMessage("recovered"),
  ]);
  try {
    await host.send("c1", "hello", "seed");
    await answered(host, "hi");
    await host.send("c1", `go ${tokens(25_000)}`, "r1");
    await answered(host, "recovered");
    const [compaction] = await ofKind(host, "pi.compaction");
    expect((compaction!.data as Rec).reason).toBe("overflow");
    expect(textOf(compaction)).toContain("RECURSE SUMMARY");
  } finally {
    await host.close();
  }
});

test("a failed blocking compaction fails the generation with its cause", async () => {
  const { host } = hostOn(world(), [fauxAssistantMessage("hi")], {
    window: 60_000,
    summary: () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
  });
  try {
    await host.send("c1", "hello", "seed");
    await answered(host, "hi");
    const { harness } = await opened(host);
    let failed: unknown;
    harness.subscribeCommits(({ changes }) => {
      for (const change of changes)
        if (
          change.type === "task" &&
          change.value.kind === "pi.generation" &&
          change.value.state.status === "terminal"
        )
          failed = change.value.state.outcome;
    });
    await host.send("c1", `go ${tokens(60_000)}`, "r1");
    await until(() => failed !== undefined);
    expect(failed).toMatchObject({
      status: "failed",
      error: { message: "Compaction failed: Summarization failed: boom" },
    });
  } finally {
    await host.close();
  }
});

test("when the Recurse summary fails, Durable's summarizer runs and the inspector keeps the turn's request", async () => {
  const { host, summaries } = hostOn(
    world(),
    [fauxAssistantMessage("hi"), fauxAssistantMessage("ok")],
    {
      summary: (prompt) =>
        prompt.includes("## Important files")
          ? fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "boom",
            })
          : fauxAssistantMessage("DURABLE SUMMARY"),
    },
  );
  try {
    await host.send("c1", "hello", "seed");
    await answered(host, "hi");
    await host.send("c1", `go ${tokens(25_000)}`, "r1");
    await answered(host, "ok");
    await host.compact("c1");
    await until(async () => (await ofKind(host, "pi.compaction")).length > 0);
    expect(summaries.length).toBe(2);
    expect(textOf((await ofKind(host, "pi.compaction"))[0])).toContain(
      "DURABLE SUMMARY",
    );
    const request = JSON.stringify((await host.prompt("c1")).request);
    expect(request).not.toContain("<conversation>");
    expect(request).toContain("go word");
  } finally {
    await host.close();
  }
});

// Regression: #2850 compaction reminders account for the always-offered codemode prompt.
test("fill reminders fire once per step, the highest crossed one, and again after a compaction", async () => {
  const w = world();
  writeFileSync(join(w.work, "b.txt"), "small\n");
  const turn = [call("read", { path: "b.txt" }), fauxAssistantMessage("ok")];
  const gate = heldSummary();
  const { host, summaries } = hostOn(
    w,
    [fauxAssistantMessage("hi"), ...turn, ...turn, ...turn, ...turn],
    { window: 64_000, summary: gate.summary },
  );
  const turnDone = (count: number) => async () =>
    (await idle(host)()) &&
    (await entries(host)).filter((e) => textOf(e) === "ok").length === count;
  try {
    await host.send("c1", "hello", "seed");
    await answered(host, "hi");
    await host.send("c1", `a ${tokens(12_000)}`, "r1");
    await until(turnDone(1));
    await host.send("c1", `b ${tokens(2_000)}`, "r2");
    await until(turnDone(2));
    await host.send("c1", `c ${tokens(20_000)}`, "r3");
    await until(
      async () => (await ofKind(host, "pi.tool-result")).length === 3,
    );
    await until(() => summaries.length === 1);
    expect(await ofKind(host, "pi.compaction")).toHaveLength(0);
    gate.release();
    await until(turnDone(3));
    await until(async () => (await ofKind(host, "pi.compaction")).length > 0);
    await until(idle(host));
    await host.send("c1", `d ${tokens(2_000)}`, "r4");
    await until(turnDone(4));
    expect(
      (await ofKind(host, "pi.tool-result")).map(
        (e) => /\[context (\d+)% used;[^\]]*\]/.exec(textOf(e))?.[1] ?? null,
      ),
    ).toEqual(["50", null, "90", "50"]);
  } finally {
    gate.release();
    await host.close();
  }
});
