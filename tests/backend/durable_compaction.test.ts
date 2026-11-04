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
  ProviderDoc,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DurableHost } from "../../src/agents/durable/host.ts";
import { Config } from "../../src/config.ts";
import {
  copyFork,
  forkPoint,
} from "../../src/agents/durable/side_conversations.ts";
import { serverCompactionSource } from "../../src/extensions/core/context/server-compaction.ts";
import {
  compactionLimit,
  RecurseUsageDoc,
} from "../../src/extensions/core/context/durable-compaction.ts";
import { CodexCheckpointDoc } from "../../src/extensions/extra/codex/compaction.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  type Recording,
  replayProvider,
} from "./fixtures/provider_replay/server.ts";
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

async function sendAtFill(
  host: DurableHost,
  window: number,
  label: string,
  fraction: number,
  requestId: string,
) {
  const { conversation } = await opened(host);
  const current = (await conversation.context(context)).messages.findLast(
    (message) => message.role === "assistant",
  );
  expect(current).toBeDefined();
  const needed =
    Math.ceil(compactionLimit(window) * fraction) -
    calculateContextTokens(current!.usage);
  expect(needed).toBeGreaterThan(0);
  await host.send("c1", `${label} ${tokens(needed)}`, requestId);
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

// Regression: #3099 mid-run compaction inputs account for actual tool overhead.
test("background compactions land mid-run with the Recurse summary; one note follows the run, once, also after a restart", async () => {
  const w = world();
  writeFileSync(join(w.work, "a.txt"), tokens(6_000));
  writeFileSync(join(w.work, "b.txt"), "small\n");
  writeFileSync(join(w.work, "c.txt"), tokens(30_000));
  const one = held(call("read", { path: "c.txt" }));
  const two = held(fauxAssistantMessage("done"));
  const cap = 60_000;
  const first = hostOn(
    w,
    [
      fauxAssistantMessage("hi"),
      call("read", { path: "a.txt" }),
      one.step,
      call("read", { path: "b.txt" }),
      two.step,
    ],
    { window: 1_000_000, cap },
  );
  try {
    await first.host.send("c1", "hello", "seed");
    await answered(first.host, "hi");
    await sendAtFill(first.host, cap, "go", 0.8, "r1");
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
    const spent = usage!.models["faux/faux-1"] as Rec;
    expect(
      Number(spent.input) + Number(spent.cacheRead) + Number(spent.cacheWrite),
    ).toBeGreaterThan(0);
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
    harness.observeCommits({
      end: () => {},
      advance: ({ changes }) => {
        for (const change of changes)
          if (
            change.type === "task" &&
            change.value.kind === "pi.generation" &&
            change.value.state.status === "terminal"
          )
            failed = change.value.state.outcome;
      },
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

// Regression: #2850 compaction reminders track fill steps independently of tool-description sizes.
test("fill reminders fire once per step, the highest crossed one, and again after a compaction", async () => {
  const w = world();
  writeFileSync(join(w.work, "b.txt"), "small\n");
  const turn = [call("read", { path: "b.txt" }), fauxAssistantMessage("ok")];
  const gate = heldSummary();
  const window = 64_000;
  const { host, summaries } = hostOn(
    w,
    [
      fauxAssistantMessage("hi"),
      ...turn,
      ...turn,
      ...turn,
      fauxAssistantMessage("ready"),
      ...turn,
    ],
    { window, summary: gate.summary },
  );
  const turnDone = (count: number) => async () =>
    (await idle(host)()) &&
    (await entries(host)).filter((e) => textOf(e) === "ok").length === count;
  try {
    await host.send("c1", "hello", "seed");
    await answered(host, "hi");
    await sendAtFill(host, window, "a", 0.55, "r1");
    await until(turnDone(1));
    await sendAtFill(host, window, "b", 0.6, "r2");
    await until(turnDone(2));
    await sendAtFill(host, window, "c", 0.95, "r3");
    await until(
      async () => (await ofKind(host, "pi.tool-result")).length === 3,
    );
    await until(() => summaries.length === 1);
    expect(await ofKind(host, "pi.compaction")).toHaveLength(0);
    gate.release();
    await until(turnDone(3));
    await until(async () => (await ofKind(host, "pi.compaction")).length > 0);
    await until(idle(host));
    await host.send("c1", "measure compacted context", "measure");
    await answered(host, "ready");
    await sendAtFill(host, window, "d", 0.55, "r4");
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

const sse = (...events: Rec[]) => ({
  ms: 0,
  data: Buffer.from(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
  ).toString("base64"),
});
const usage = {
  input_tokens: 100,
  output_tokens: 1,
  total_tokens: 101,
  input_tokens_details: { cached_tokens: 0 },
};
const codexReply = (text: string, reportedUsage = usage) => {
  const id = `msg_${text.replace(/\W/g, "_")}`;
  const done = { type: "message", id, role: "assistant", status: "completed" };
  return {
    transport: "sse" as const,
    path: "/backend-api/codex/responses",
    request: {},
    requestHeaders: {},
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: [
      sse(
        { type: "response.created", response: { id: "resp_t", output: [] } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...done, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: id,
          output_index: 0,
          content_index: 0,
          delta: text,
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            ...done,
            content: [{ type: "output_text", text, annotations: [] }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_t",
            status: "completed",
            output: [],
            usage: reportedUsage,
          },
        },
      ),
    ],
  };
};
const codexCompaction = (item?: Rec) => ({
  ...codexReply(""),
  requestHeaders: { "x-codex-beta-features": "remote_compaction_v2" },
  chunks: [
    sse(
      { type: "response.created", response: { id: "resp_c", output: [] } },
      ...(item
        ? [
            { type: "response.output_item.added", output_index: 0, item },
            {
              type: "response.compaction.compacting",
              item_id: item.id,
              output_index: 0,
            },
            { type: "response.output_item.done", output_index: 0, item },
          ]
        : []),
      {
        type: "response.completed",
        response: { id: "resp_c", status: "completed", output: [], usage },
      },
    ),
  ],
});

test("Codex compaction skips readable summaries, shows a server marker, chains across restarts and lazily summarizes unusable items", async () => {
  const w = world();
  mkdirSync(join(w.dataDir, "config"), { recursive: true });
  const legacySetting = join(
    w.dataDir,
    "config",
    "chatgpt-server-compaction.json",
  );
  writeFileSync(legacySetting, JSON.stringify({ enabled: false }));
  const first = {
    type: "compaction",
    id: "cmp_1",
    encrypted_content: "opaque-1",
  };
  const second = {
    type: "compaction",
    id: "cmp_2",
    encrypted_content: "opaque-2",
  };
  const third = {
    type: "compaction",
    id: "cmp_3",
    encrypted_content: "opaque-3",
  };
  const fourth = {
    type: "compaction",
    id: "cmp_4",
    encrypted_content: "opaque-4",
  };
  const replay = replayProvider({
    provenance: {
      date: "2026-10-30",
      model: "gpt-5.6-luna",
      pi: "1.3.0",
      scenario: "hand-written Codex compaction protocol",
    },
    model: {} as Recording["model"],
    exchanges: [
      codexReply("reply 0"),
      codexReply("reply 1"),
      codexReply("more reply"),
      codexCompaction(first),
      codexReply("reply 2", {
        ...usage,
        input_tokens: 100000,
        total_tokens: 100001,
      }),
      codexReply("warmed"),
      codexReply("reply 3"),
      codexReply("other model"),
      codexReply("other account"),
      codexReply("reply 4"),
      codexCompaction(second),
      codexReply("reply 6"),
      {
        ...codexReply(""),
        status: 400,
        headers: { "content-type": "application/json" },
        chunks: [
          {
            ms: 0,
            data: Buffer.from(
              JSON.stringify({
                error: {
                  message:
                    "The encrypted content for item cmp_2 could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
                  type: "invalid_request_error",
                },
              }),
            ).toString("base64"),
          },
        ],
      },
      codexReply("reply 8"),
      codexReply("reply 9"),
      {
        ...codexCompaction(),
        chunks: [
          sse({ type: "response.created", response: { id: "resp_c" } }),
          { ms: 0, data: "", drop: true as const },
        ],
      },
      codexReply("cold one"),
      codexCompaction(third),
      codexReply("cold two"),
      codexCompaction(fourth),
    ],
  });
  const builtin = builtinProviders().find((p) => p.id === "openai-codex")!;
  const catalog = builtin.getModels().find((m) => m.id === "gpt-5.6-luna")!;
  const baseUrl = `${replay.baseUrl}/backend-api`;
  const key = (account: string) =>
    `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.test`;
  let apiKey = key("test-account");
  const faux = fauxProvider({
    tokensPerSecond: 1_000_000,
    models: [{ id: "faux-1", contextWindow: 128_000 }],
  });
  const fauxRequests: string[] = [];
  const summaries: string[] = [];
  faux.setResponses(
    Array.from({ length: 16 }, () => (request: unknown) => {
      const prompt = JSON.stringify(request);
      if (prompt.includes("<conversation>")) {
        summaries.push(prompt);
        return fauxAssistantMessage("RECURSE SUMMARY");
      }
      fauxRequests.push(prompt);
      return fauxAssistantMessage("faux reply");
    }),
  );
  const fauxModel = faux.getModel("faux-1")!;
  const codex = {
    ...builtin,
    baseUrl,
    auth: {
      apiKey: {
        name: "Test",
        resolve: async () => ({ auth: { apiKey }, source: "test" }),
      },
    },
    getModels: () => [
      {
        ...catalog,
        baseUrl,
        promptCache: { short: 300, long: 300 },
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      },
      { ...catalog, id: "gpt-other", baseUrl },
    ],
    streamSimple: (
      m: Parameters<typeof builtin.streamSimple>[0],
      c: Parameters<typeof builtin.streamSimple>[1],
      o: Parameters<typeof builtin.streamSimple>[2],
    ) =>
      JSON.stringify(c).includes("<conversation>")
        ? faux.provider.streamSimple(fauxModel, c, o)
        : builtin.streamSimple({ ...m, baseUrl }, c, {
            ...o,
            apiKey,
            transport: "sse",
          }),
  };
  const models = createModels();
  models.setProvider(codex);
  models.setProvider(faux.provider);
  const busy = fauxProvider({
    provider: "warming-busy",
    tokensPerSecond: 100000,
  });
  const busyReply = held(fauxAssistantMessage("finished"));
  busy.setResponses([busyReply.step]);
  models.setProvider(busy.provider);
  let warmingNow = 0;
  const warmingTimers = new Map<() => void, number>();
  const warmingClock = {
    now: () => warmingNow,
    schedule(callback: () => void, delay: number) {
      warmingTimers.set(callback, warmingNow + delay);
      return () => {
        warmingTimers.delete(callback);
      };
    },
  };
  const config = new Config({
    env: { ...process.env, CHAT_DATA_DIR: w.dataDir },
  });
  let model = "openai-codex/gpt-5.6-luna";
  let effort = "off";
  const logs: string[] = [];
  const start = (state = w) =>
    new DurableHost({
      ...testDeps(
        state.dataDir,
        (cid) => state.records[cid] ?? null,
        () => Object.keys(state.records),
      ),
      config,
      settings: (conv) => [
        String(conv.model ?? model),
        conv.model ? "off" : effort,
      ],
      warmingClock,
      log: (event: string) => void logs.push(event),
      models,
    });
  let warmRequest: Rec | undefined;
  const requests = () =>
    replay.requests.filter((request) => request !== warmRequest);
  const inputWithoutTools = (n: number) =>
    (requests()[n + (n >= 2 ? 1 : 0)]!.input as Rec[]).filter(
      (item) => item.type !== "additional_tools",
    );
  const compacted = async (host: DurableHost, count: number) => {
    await host.compact("c1");
    await until(
      async () => (await ofKind(host, "pi.compaction")).length === count,
    );
    await until(async () => (await compactionsRunning(host)) === 0);
    await until(idle(host));
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let host = start();
  try {
    await host.send("c1", "the code word is PELICAN", "k0");
    await answered(host, "reply 0");
    await host.send("c1", `go ${tokens(21_000)}`, "k1");
    await answered(host, "reply 1");
    await host.send("c1", `more history ${tokens(21_000)}`, "more");
    await answered(host, "more reply");
    await compacted(host, 1);
    expect(summaries).toHaveLength(0);
    const rows = (await host.view("c1", { limit: 100 })).blocks as Rec[];
    expect(rows.filter((row) => row.role === "compaction").at(-1)?.text).toBe(
      "Conversation compacted on the server.",
    );
    expect(JSON.stringify(rows)).not.toContain("recurse-server-compaction");
    expect(JSON.stringify(rows)).toContain("PELICAN");
    expect(inputWithoutTools(2).at(-1)).toEqual({ type: "compaction_trigger" });
    const turn = requests()[2]!.input as Rec[];
    expect(turn[0]!.type).toBe("additional_tools");
    expect(inputWithoutTools(2).slice(0, -1)).toEqual(
      turn.slice(1, inputWithoutTools(2).length),
    );
    expect(JSON.stringify(inputWithoutTools(2))).toContain("PELICAN");
    expect(requests()[3]!.prompt_cache_key).toBe(
      requests()[0]!.prompt_cache_key,
    );
    w.records.child = {
      id: "child",
      parent: "c1",
      backend: "durable",
      workdir: w.work,
      model: "warming-busy/faux-1",
    };
    await host.send("child", "work", "warming-child");
    await busyReply.started;
    effort = "low";
    await host.send("c1", "next", "k2");
    await until(async () =>
      (await entries(host)).some((entry) => textOf(entry) === "reply 2"),
    );
    await until(() => !host.isRunning("c1"));
    expect(inputWithoutTools(3)[0]).toEqual(first);
    expect(JSON.stringify(inputWithoutTools(3))).not.toContain("<summary>");
    const request = (await host.prompt("c1")).request as {
      context: { messages: { role: string; content: Rec[] | string }[] };
    };
    const head = request.context.messages.find((m) => m.role === "user")!;
    const blocks = (head.content as Rec[]).map((b) => String(b.text));
    expect(blocks[0]).toContain("Conversation compacted on the server.");
    expect(blocks[0]).not.toContain("RECURSE SUMMARY");
    expect(summaries).toHaveLength(0);
    expect(
      JSON.parse(
        blocks
          .at(-1)!
          .match(
            /^<codex-compaction-item>(.*)<\/codex-compaction-item>$/s,
          )![1]!,
      ),
    ).toEqual(first);
    const beforeWarm = replay.requests.length;
    warmingNow += 270000;
    for (const [callback, at] of [...warmingTimers])
      if (at <= warmingNow) {
        warmingTimers.delete(callback);
        callback();
      }
    await until(() => replay.requests.length === beforeWarm + 1);
    warmRequest = replay.requests.at(-1)!;
    const source = requests().at(-1)!;
    expect(warmRequest.input).toEqual(source.input);
    expect(
      (warmRequest.input as Rec[]).find((item) => item.type === "compaction"),
    ).toEqual(first);
    expect(warmRequest.prompt_cache_key).toBe(source.prompt_cache_key);
    expect(warmRequest.reasoning).toEqual(source.reasoning);
    expect(warmRequest.reasoning).toMatchObject({ summary: "detailed" });
    busyReply.release();
    await until(() => !host.cacheWarmBusy("c1"));
    expect(warmingTimers.size).toBe(0);
    effort = "off";
    await host.close();
    host = start();
    await host.send("c1", "again", "k3");
    await answered(host, "reply 3");
    expect(inputWithoutTools(4)[0]).toEqual(first);
    model = "openai-codex/gpt-other";
    await host.send("c1", "on another Codex model", "k3b");
    await answered(host, "other model");
    model = "openai-codex/gpt-5.6-luna";
    apiKey = key("other-account");
    await host.send("c1", "from another account", "k3c");
    await answered(host, "other account");
    apiKey = key("test-account");
    for (const n of [5, 6]) {
      expect(JSON.stringify(inputWithoutTools(n))).toContain("<summary>");
      expect(JSON.stringify(inputWithoutTools(n))).not.toContain(
        '"type":"compaction"',
      );
    }
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("go word");
    model = "faux/faux-1";
    await host.send("c1", "from another model", "k4");
    await answered(host, "faux reply");
    expect(fauxRequests.at(-1)).toContain("RECURSE SUMMARY");
    expect(fauxRequests.at(-1)).not.toContain("codex-compaction-item");
    model = "openai-codex/gpt-5.6-luna";
    await host.send("c1", `more ${tokens(21_000)}`, "k5");
    await answered(host, "reply 4");
    await compacted(host, 2);
    expect(summaries).toHaveLength(1);
    expect(inputWithoutTools(8)[0]).toEqual(first);
    expect(inputWithoutTools(8).at(-1)).toEqual({ type: "compaction_trigger" });
    await host.send("c1", "after", "k6");
    await answered(host, "reply 6");
    expect(inputWithoutTools(9)[0]).toEqual(second);
    await host.send("c1", "rejected", "k7");
    await until(() => logs.includes("durable_codex_checkpoint_rejected"));
    await until(idle(host));
    expect(summaries).toHaveLength(1);
    expect(inputWithoutTools(10)[0]).toEqual(second);
    await host.send("c1", "retry", "k8");
    await answered(host, "reply 8");
    expect(summaries).toHaveLength(2);
    expect(summaries[1]).toContain("RECURSE SUMMARY");
    expect(summaries[1]).toContain("on another Codex model");
    expect(JSON.stringify(inputWithoutTools(11))).toContain("<summary>");
    expect(JSON.stringify(inputWithoutTools(11))).not.toContain(
      '"type":"compaction"',
    );
    await host.send("c1", `last ${tokens(21_000)}`, "k9");
    await answered(host, "reply 9");
    await compacted(host, 3);
    expect(logs).toContain("durable_provider_compaction_fallback");
    expect(summaries).toHaveLength(3);
    expect(textOf((await ofKind(host, "pi.compaction")).at(-1))).toContain(
      "RECURSE SUMMARY",
    );
    const { harness, conversation } = await opened(host);
    expect(
      (
        await harness.snapshot(CodexCheckpointDoc, conversation.id, context)
      )?.saved.map((entry) => entry.item.id),
    ).toEqual(["cmp_1"]);
    await host.send("c1", `cold one ${tokens(21_000)}`, "cold1");
    await answered(host, "cold one");
    await compacted(host, 4);
    await host.send("c1", `cold two ${tokens(21_000)}`, "cold2");
    await answered(host, "cold two");
    expect(
      (requests().at(-1)!.input as Rec[]).find(
        (item) => item.type === "compaction",
      ),
    ).toEqual(third);
    await compacted(host, 5);
    expect(summaries).toHaveLength(3);
    const sourceHead = (await ofKind(host, "pi.compaction")).at(-1)!;
    const sourceMarker = textOf(sourceHead).match(
      /<summary>\n([\s\S]*)\n<\/summary>/,
    )![1]!;
    const boundary = serverCompactionSource(sourceMarker)!;
    const live = await opened(host);
    const fork = await live.conversation.fork(
      (await forkPoint(live.conversation))!,
      { ownership: { kind: "ownerless" } },
      context,
    );
    const sessionId = (await live.harness.snapshot(
      ProviderDoc,
      fork.id,
      context,
    ))!.sessionId;
    model = "faux/faux-1";
    const promoted = start(world());
    try {
      const target = await opened(promoted);
      await copyFork(live.harness, fork, target.harness, sessionId, context);
      const copiedHead = (await target.conversation.context(context)).head!;
      const copiedMarker = textOf(copiedHead).match(
        /<summary>\n([\s\S]*)\n<\/summary>/,
      )![1]!;
      expect(serverCompactionSource(copiedMarker)).not.toEqual(boundary);
      const before = fauxRequests.length;
      await promoted.send("c1", "promoted fallback", "promoted");
      await until(() => fauxRequests.length > before);
      await until(idle(promoted));
      expect(summaries).toHaveLength(5);
      expect(summaries[3]).toContain("RECURSE SUMMARY");
      expect(summaries[4]).toContain("cold one");
      expect(fauxRequests.at(-1)).toContain("promoted fallback");
      expect(fauxRequests.at(-1)).toContain("RECURSE SUMMARY");
      expect(fauxRequests.at(-1)).not.toContain("recurse-server-compaction");
    } finally {
      await promoted.close();
    }
    replay.assertComplete();
    expect(await Bun.file(legacySetting).json()).toEqual({ enabled: false });
    await Bun.sleep(0);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    busyReply.release();
    await host.close();
    replay.server.stop(true);
  }
});
