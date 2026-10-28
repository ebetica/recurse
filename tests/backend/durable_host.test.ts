import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { DurableHost } from "../../src/agents/durable/host.ts";
import {
  customProviderSync,
  durableModels,
} from "../../src/agents/durable/models.ts";
import { DurableViews } from "../../src/agents/durable/durable_rows.ts";
import { ReportDoc } from "../../src/agents/durable/report.ts";
import { deliverStop, withDurableStop } from "../../src/web/tree.ts";
import { HttpError } from "../../src/web/router.ts";
import {
  INFO,
  RuntimeLogger,
  WARNING,
} from "../../src/observability/runtime_logging.ts";
import {
  fauxHost,
  idle,
  lifecycle,
  testDeps,
  until,
} from "./fixtures/durable_host/host.ts";

const root = mkdtempSync(join(tmpdir(), "durable-host-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FAR = Date.now() + 365 * 24 * 3600 * 1000;

describe("durableModels", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });

  test("ignores stray provider keys in the server environment", async () => {
    const dir = mkdtempSync(join(root, "agent-"));
    writeFileSync(join(dir, "auth.json"), "{}");
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray";
    process.env.OPENAI_API_KEY = "sk-stray";
    const models = durableModels(dir);
    expect(await models.getAuth("anthropic")).toBeUndefined();
    expect(await models.getAuth("openai")).toBeUndefined();
    expect(await models.getAuth("openai-codex")).toBeUndefined();
  });

  test("each provider resolves only its own stored credential", async () => {
    const dir = mkdtempSync(join(root, "agent-"));
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "sk-ant-stored" },
        openai: { type: "api_key", key: "sk-openai-stored" },
        "openai-codex": {
          type: "oauth",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: FAR,
          accountId: "acct",
        },
      }),
    );
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray";
    process.env.OPENAI_API_KEY = "sk-stray";
    const models = durableModels(dir);
    expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe(
      "sk-ant-stored",
    );
    expect((await models.getAuth("openai"))?.auth.apiKey).toBe(
      "sk-openai-stored",
    );
    expect((await models.getAuth("openai-codex"))?.auth.apiKey).toBe(
      "codex-access",
    );
  });

  test("an Anthropic subscription resolves as OAuth, not an env key", async () => {
    const dir = mkdtempSync(join(root, "agent-"));
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "ant-access",
          refresh: "ant-refresh",
          expires: FAR,
        },
      }),
    );
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray";
    const auth = await durableModels(dir).getAuth("anthropic");
    expect(auth?.source).toBe("OAuth");
    expect(JSON.stringify(auth)).not.toContain("sk-ant-stray");
  });

  test("a custom provider uses its stored key, else its env_key; removing it restores a built-in it replaced", async () => {
    const dir = mkdtempSync(join(root, "agent-"));
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ stored: { type: "api_key", key: "stored-key" } }),
    );
    process.env.OPENAI_API_KEY = "sk-stray";
    const models = durableModels(dir);
    const spec = (models: string[]) => ({
      base_url: "http://127.0.0.1:9/v1",
      env_key: "CUSTOM_KEY",
      wire_api: "responses" as const,
      models: models.map((id) => ({ id })),
    });
    const sync = customProviderSync(models, (provider) =>
      provider === "stored" ? "env-stored" : `env-${provider}`,
    );
    sync({ stored: spec(["a"]), fromenv: spec(["b"]), openai: spec(["c"]) });
    expect((await models.getAuth("stored"))?.auth.apiKey).toBe("stored-key");
    expect((await models.getAuth("fromenv"))?.auth.apiKey).toBe("env-fromenv");
    expect(models.getModel("fromenv", "b")?.api).toBe("openai-responses");
    expect(models.getModel("openai", "gpt-5")).toBeUndefined();
    sync({ stored: spec(["a"]) });
    expect(models.getModel("fromenv", "b")).toBeUndefined();
    expect(models.getModel("openai", "c")).toBeUndefined();
    expect(models.getModel("openai", "gpt-5")).toBeDefined();
    expect(await models.getAuth("openai")).toBeUndefined();
  });
});

type Rec = Record<string, unknown>;

function hostFor(
  records: Record<string, Rec>,
  models: MutableModels,
  model = "faux/faux-1",
  safetyChanged?: (cid: string) => void,
  dataDir = mkdtempSync(join(root, "data-")),
  captureIdleMs?: number,
  harnessIdleMs?: number,
  wallClock?: () => number,
): DurableHost {
  return new DurableHost({
    ...testDeps(
      dataDir,
      (cid) => records[cid] ?? null,
      () => Object.keys(records),
      model,
    ),
    safetyChanged,
    models,
    captureIdleMs,
    harnessIdleMs,
    wallClock,
  });
}

function fauxModels() {
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

const rows = async (host: DurableHost, cid: string) =>
  ((await host.view(cid, { limit: 50 })).blocks as Rec[]).map((b) => [
    b.role,
    b.kind === "tool_call" ? `${String(b.name)}:${String(b.result)}` : b.text,
  ]);

function stopDeps(host: DurableHost, records: Record<string, Rec>) {
  const piPath = () => {
    throw new Error("a Durable stop reached the Pi path");
  };
  return withDurableStop(
    {
      loadConversation: (cid) => records[cid] ?? null,
      activeRunId: () => null,
      liveStatus: piPath,
      requestStopProcesses: piPath,
      requestStop: piPath,
      tokenHex: () => "0".repeat(32),
      nowSeconds: () => 1,
      log: new RuntimeLogger("test", { write: () => undefined } as never, 10),
    },
    {
      owns: (cid) => host.owns(records[cid]),
      stopStatus: (cid) => host.stopStatus(cid),
      stop: (cid, run) => host.stop(cid, run),
      stopProcesses: (cid) => host.stopProcesses(cid),
    },
  );
}

function groupAlive(pgid: number): boolean {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] !== "Z" && Number(fields[2]) === pgid) return true;
  }
  return false;
}

async function shellGroup(host: DurableHost, cid: string): Promise<number> {
  const { harness } = await host.open(cid);
  let pgid: number | undefined;
  await until(async () => {
    const task = (await harness.inspect(context)).tasks.find(
      ({ record }) => record.kind === "recurse.shell",
    );
    pgid = (task?.record.input as { pgid?: number } | undefined)?.pgid;
    return pgid !== undefined;
  });
  return pgid!;
}

const untilAborted = (gate: Promise<void>, signal: AbortSignal | undefined) =>
  signal?.aborted
    ? Promise.resolve()
    : Promise.race([
        gate,
        new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve()),
        ),
      ]);

const heldAnswer =
  (gate: Promise<void>, text: string) =>
  async (_context: unknown, options?: { signal?: AbortSignal }) => {
    await untilAborted(gate, options?.signal);
    return fauxAssistantMessage(text);
  };

const startShell = () =>
  fauxAssistantMessage(
    fauxToolCall("bash", { command: "sleep 60", background: true }),
    { stopReason: "toolUse" },
  );

const record = (cid: string, workdir: string): Rec => ({
  id: cid,
  backend: "durable",
  workdir,
});

describe("DurableHost", () => {
  // Feature: #2538 view eviction is shared across conversations.
  test.each([1, 2])("cached views share budget %i", async (maxViews) => {
    const { faux, models } = fauxModels();
    faux.setResponses([fauxAssistantMessage("kept")]);
    const records: Record<string, Rec> = { c0: record("c0", root) };
    const host = hostFor(records, models);
    (host as unknown as { views: DurableViews }).views = new DurableViews({
      maxViews,
      idleTtl: 600,
    });
    try {
      await host.send("c0", "original", "r0");
      await until(async () => {
        const page = await host.view("c0");
        return (
          page.turn_status === "idle" &&
          (page.blocks as Rec[]).some(
            (block) => block.role === "assistant" && block.text === "kept",
          )
        );
      });
      const first = await host.view("c0", { limit: 1 });
      expect((first.blocks as Rec[]).length).toBe(1);
      expect((await host.view("c0", { limit: 1 })).instance_id).toBe(
        first.instance_id,
      );
      let newest!: Rec;
      for (let i = 1; i <= maxViews; i++) {
        const cid = `c${i}`;
        records[cid] = record(cid, root);
        newest = await host.view(cid);
      }
      expect((await host.view(`c${maxViews}`)).instance_id).toBe(
        newest.instance_id,
      );
      const revisited = await host.view("c0", { limit: 1 });
      expect(revisited.instance_id).not.toBe(first.instance_id);
      expect(revisited.session).toBe(first.session);
      expect(revisited.blocks).toEqual(first.blocks);
    } finally {
      await host.close();
    }
  });

  // Feature: #2308 live tool age must survive cached view reads.
  test("cached views refresh a running tool's persisted execution age", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "printf 'ready\\n'; sleep 60" }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("finished"),
    ]);
    const host = hostFor({ c1: record("c1", root) }, models);
    try {
      await host.send("c1", "Run the command", "r1");
      let first: Rec = {};
      let initial: Rec = {};
      await until(async () => {
        initial = await host.view("c1");
        first = (initial.blocks as Rec[]).find((block) => block.running) ?? {};
        return first.running === true && String(first.result).includes("ready");
      });
      const { harness, conversation } = await host.open("c1");
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const slot = live!.tools!.find((slot) => slot.status === "running")!;
      const task = await harness.getTask(slot.taskId!, context);
      expect(first.tool_started_at_ms).toBe(task!.startedAt);
      expect(typeof first.tool_started_at_ms).toBe("number");
      expect(typeof first.tool_elapsed_ms).toBe("number");
      const report = await harness.snapshot(
        ReportDoc,
        conversation.id,
        context,
      );
      expect(first.artifact_id).toBe(
        `d-${report!.generation}-${String(task!.id)}`,
      );
      let later: Rec = {};
      let page: Rec = {};
      await until(async () => {
        page = await host.view("c1");
        later = (page.blocks as Rec[]).find((block) => block.id === first.id)!;
        return Number(later.tool_elapsed_ms) > Number(first.tool_elapsed_ms);
      });
      expect(page.revision).toBe(initial.revision);
      expect(later.tool_started_at_ms).toBe(task!.startedAt);
      expect(later.artifact_id).toBe(first.artifact_id);
      expect(
        Number(later.tool_started_at_ms) + Number(later.tool_elapsed_ms),
      ).toBeLessThanOrEqual(Date.now());
      await host.stop("c1");
      await until(async () => (await host.view("c1")).turn_status === "idle");
      const settled = ((await host.view("c1")).blocks as Rec[]).find(
        (block) => block.id === first.id,
      )!;
      expect(settled.tool_started_at_ms).toBeUndefined();
      expect(settled.tool_elapsed_ms).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  // Regression: #2410 unavailable selections name the model and how to repair it.
  test("an unknown model fails the conversation with a clear error", async () => {
    const { models } = fauxModels();
    const host = hostFor(
      { c1: record("c1", root) },
      models,
      "meta/muse-spark-1.3-contributor",
    );
    try {
      await expect(host.send("c1", "hi", "r1")).rejects.toThrow(
        "Model meta/muse-spark-1.3-contributor is unavailable. Pick another effort level in the model picker, or fix its model in Settings > Effort ladder.",
      );
    } finally {
      await host.close();
    }
  });

  test("a Settings custom provider runs turns against its endpoint with its env_key; an edit applies to the next send", async () => {
    const seen: { path: string; auth: string | null; model: unknown }[] = [];
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "small", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { model?: unknown };
        seen.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          model: body.model,
        });
        return new Response(
          chunk({ role: "assistant", content: "custom reply" }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const settings = (path: string) => ({
      "local-llm": {
        base_url: `http://127.0.0.1:${server.port}${path}`,
        env_key: "LOCAL_LLM_KEY",
        wire_api: "completions",
        models: [{ id: "small", context_window: 100000 }],
      },
    });
    let providers = settings("/v1");
    const dataDir = mkdtempSync(join(root, "data-"));
    const records = { c1: record("c1", root) };
    const asked: string[] = [];
    const host = new DurableHost({
      ...testDeps(
        dataDir,
        (cid) => records[cid as "c1"] ?? null,
        () => Object.keys(records),
        "local-llm/small",
      ),
      customProviders: () => providers,
      customProviderEnvValue: (provider) => {
        asked.push(provider);
        return provider === "local-llm" ? "env-key-1" : undefined;
      },
    });
    try {
      await host.send("c1", "hello", "r1");
      await until(async () => (await rows(host, "c1")).length === 2);
      expect(await rows(host, "c1")).toEqual([
        ["user", "hello"],
        ["assistant", "custom reply"],
      ]);
      providers = settings("/v2");
      await until(idle(host));
      await host.send("c1", "again", "r2");
      await until(async () => (await rows(host, "c1")).length === 4);
      expect(seen).toEqual([
        {
          path: "/v1/chat/completions",
          auth: "Bearer env-key-1",
          model: "small",
        },
        {
          path: "/v2/chat/completions",
          auth: "Bearer env-key-1",
          model: "small",
        },
      ]);
      expect(new Set(asked)).toEqual(new Set(["local-llm"]));
    } finally {
      await host.close();
      server.stop(true);
    }
  });

  // Regression: #2626 slow opens include environment and storage detail fields.
  test.each([false, true])("open phase fields by speed", async (slow) => {
    let clock = 0;
    const { models } = fauxModels();
    const logged: unknown[][] = [];
    const deps = testDeps(
      mkdtempSync(join(root, "data-")),
      () => record("c1", root),
      () => ["c1"],
    );
    const host = new DurableHost({
      ...deps,
      models,
      openClock: () => (slow ? (clock += 1000) : clock),
      log: (...entry) => logged.push(entry),
    });
    try {
      await host.open("c1");
    } finally {
      await host.close();
    }
    const opens = logged.filter(([event]) => event === "durable_open");
    const [[, fields, level]] = opens as [string, Rec, number][];
    const phases =
      "runtime env search safety storage harness root track recover resume";
    const names = phases.split(" ").map((name) => `${name}_ms`);
    const details = slow
      ? [
          "env_settings_ms",
          "env_clear_ms",
          "env_dir_ms",
          "env_files_ms",
          "storage_migration_ms",
          "storage_metadata_ms",
          "storage_db_bytes",
          "storage_wal_bytes",
          "storage_stat_ms",
          "storage_native_ms",
          "storage_pragmas_ms",
          "storage_journal_mode_ms",
        ]
      : [];
    expect(opens).toHaveLength(1);
    expect(Object.keys(fields)).toEqual([
      "cid",
      ...names,
      ...details,
      "total_ms",
    ]);
    expect(fields.cid).toBe("c1");
    for (const name of [...names, ...details, "total_ms"]) {
      expect(Number.isFinite(fields[name])).toBe(true);
      expect(fields[name]).toBeGreaterThanOrEqual(0);
    }
    expect(level).toBe(slow ? WARNING : INFO);
  });

  test("a repeated request id is admitted once", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
    ]);
    const host = hostFor({ c1: record("c1", root) }, models);
    try {
      await host.send("c1", "hello", "op:operator::k1");
      await host.send("c1", "hello", "op:operator::k1");
      await until(
        async () =>
          (await host.view("c1", { limit: 50 })).turn_status === "idle",
      );
      expect(await rows(host, "c1")).toEqual([
        ["user", "hello"],
        ["assistant", "one"],
      ]);
      expect(faux.state.callCount).toBe(1);
    } finally {
      await host.close();
    }
  });

  test("a stop naming a stale run is refused with 409 and leaves the live run going", async () => {
    const { faux, models } = fauxModels();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    faux.setResponses([heldAnswer(held, "late")]);
    const records = { c1: record("c1", root) };
    const host = hostFor(records, models);
    const deps = stopDeps(host, records);
    try {
      await host.send("c1", "first", "r1");
      await until(async () => host.runningCount() === 1);
      const run = host.liveStatus("c1")[1]!;
      const stale = await deliverStop(deps, "c1", { run_id: "stale-run" }).then(
        () => 200,
        (error: HttpError) => error.status,
      );
      expect(stale).toBe(409);
      expect(host.liveStatus("c1")).toEqual(["running", run]);
      const unscoped = await deliverStop(deps, "c1", {}).then(
        () => 200,
        (error: HttpError) => error.status,
      );
      expect(unscoped).toBe(422);
      const exact = await deliverStop(deps, "c1", { run_id: run });
      expect(exact.status).toBe(200);
      await until(async () => host.runningCount() === 0);
    } finally {
      release();
      await host.close();
    }
  });

  // Feature: #2538 retirement hides the run before the Harness closes.
  test("retire stops the run, closes the Harness, retires its storage, and refuses sends", async () => {
    const { faux, models } = fauxModels();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    faux.setResponses([heldAnswer(held, "late")]);
    const records: Record<string, Rec> = { c1: record("c1", root) };
    const host = hostFor(records, models);
    const storage = join(host.storagePath("c1"), "..", "..");
    try {
      await host.send("c1", "first", "r1");
      await until(async () => host.runningCount() === 1);
      const { harness } = await host.open("c1");
      records.c1!.reap_deferred = true;
      expect(host.liveStatus("c1")).toEqual([null, null]);
      expect(host.metadata("c1")).toMatchObject({
        status: "idle",
        active_run: null,
      });
      expect(host.runningCount()).toBe(0);
      expect(host.runningConversations()).toEqual([]);
      expect(await host.send("c1", "after the stamp", "r2")).toBeNull();
      expect(await host.retire("c1", 5000)).toBe(true);
      expect(host.runningCount()).toBe(0);
      await expect(harness.inspect(context)).rejects.toThrow();
      expect(existsSync(storage)).toBe(false);
      expect(readdirSync(join(storage, "..", "..", "trash")).length).toBe(1);
      await expect(host.open("c1")).rejects.toThrow("being deleted");
      delete records.c1;
      expect(await host.send("c1", "after deletion", "r3")).toBeNull();
    } finally {
      release();
      await host.close();
    }
  });

  // Feature: #2538 retirement discards row state after failed closes.
  test("retire keeps the storage until the Harness closes, even when the abort fails", async () => {
    const { faux, models } = fauxModels();
    let restoreClose: (() => void) | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    faux.setResponses([heldAnswer(held, "late")]);
    const records: Record<string, Rec> = { c1: record("c1", root) };
    const host = hostFor(records, models);
    const storage = join(host.storagePath("c1"), "..", "..");
    try {
      await host.send("c1", "first", "r1");
      await until(async () => host.runningCount() === 1);
      const { harness } = await host.open("c1");
      records.c1!.reap_deferred = true;
      const close = harness.close.bind(harness);
      restoreClose = () => {
        harness.close = close;
      };
      harness.abortTask = async () => {
        throw new Error("abort failed");
      };
      harness.close = async () => {
        throw new Error("close failed");
      };
      expect(await host.retire("c1", 5000)).toBe(false);
      expect(existsSync(storage)).toBe(true);
      expect(
        (host as unknown as { liveRows: Map<string, unknown> }).liveRows.size,
      ).toBe(0);
      harness.close = close;
      expect(await host.retire("c1", 5000)).toBe(true);
      await expect(harness.inspect(context)).rejects.toThrow();
      expect(existsSync(storage)).toBe(false);
    } finally {
      restoreClose?.();
      release();
      await host.close();
    }
  });

  test("the view shows user, assistant, and tool rows", async () => {
    const work = mkdtempSync(join(root, "work-"));
    writeFileSync(join(work, "note.txt"), "durable note\n");
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText("Reading."),
          fauxToolCall("read", { path: "note.txt" }, { id: "t1" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("It says durable note."),
    ]);
    const host = hostFor({ c1: record("c1", work) }, models);
    try {
      await host.send("c1", "read note.txt", "r1");
      await until(async () => {
        const view = await host.view("c1", { limit: 50 });
        return (
          view.turn_status === "idle" && (view.blocks as Rec[]).length === 4
        );
      });
      const view = await rows(host, "c1");
      expect(view.slice(0, 2)).toEqual([
        ["user", "read note.txt"],
        ["assistant", "Reading."],
      ]);
      expect(view[2]![0]).toBe("tool");
      expect(String(view[2]![1])).toContain("durable note");
      expect(view[3]).toEqual(["assistant", "It says durable note."]);
    } finally {
      await host.close();
    }
  });

  test("status, queued input, thinking text, and the compaction summary", async () => {
    const { faux, models } = fauxModels();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    faux.setResponses([
      async (_context, options) => {
        await untilAborted(held, options?.signal);
        return fauxAssistantMessage([
          fauxThinking("**Plan** check the queue"),
          fauxText("first answer"),
        ]);
      },
      fauxAssistantMessage("second answer"),
      fauxAssistantMessage("summary of the work"),
    ]);
    const host = hostFor({ c1: record("c1", root) }, models);
    try {
      await host.send("c1", "first", "op:operator::k1");
      await until(async () => host.runningCount() === 1);
      const second = `second ${"x".repeat(100_000)}`;
      await host.send("c1", second, "op:operator::k2");
      await until(async () => host.metadata("c1").pending.length === 1);
      expect(host.metadata("c1")).toMatchObject({
        status: "running",
        pending: [{ id: "op:operator::k2", role: "user", content: second }],
      });
      release();
      await until(async () => host.metadata("c1").status === "idle");
      expect(host.metadata("c1")).toMatchObject({
        active_run: null,
        pending: [],
      });
      const blocks = (await host.view("c1")).blocks as Rec[];
      const reply = blocks.find((b) => b.text === "first answer")!;
      expect(reply.thinking_title).toBe("Plan");
      expect(await host.thinking("c1", reply.offset as number)).toEqual({
        text: "**Plan** check the queue",
        live: false,
      });
      const { harness, conversation } = await host.open("c1");
      await harness.waitForTask(
        await conversation.compact(undefined, context),
        context,
      );
      const marker = ((await host.view("c1")).blocks as Rec[]).find(
        (b) => b.role === "compaction",
      )!;
      expect(
        await host.markerSummary("c1", marker.offset as number),
      ).toMatchObject({ marker: "compact" });
      expect(
        String(
          (await host.markerSummary("c1", marker.offset as number))!.summary,
        ),
      ).toContain("summary of the work");
    } finally {
      await host.close();
    }
  });

  // Regression: #2519 Stop must see idle even while the run tracker is held. (also Feature #2538 row status agrees with /view despite held tracking.)
  test("stop processes stops a background shell's process group", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([startShell(), fauxAssistantMessage("started")]);
    const records = { c1: record("c1", root) };
    const host = hostFor(records, models);
    const { harness } = await host.open("c1");
    const snapshot = harness.snapshot.bind(harness);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let trackerHeld = false;
    harness.snapshot = new Proxy(snapshot, {
      async apply(target, thisArg, args) {
        const result = await Reflect.apply(target, thisArg, args);
        if (
          !trackerHeld &&
          args[0] === InboxDoc &&
          host.liveStatus("c1")[0] === "running"
        ) {
          trackerHeld = true;
          await held;
        }
        return result;
      },
    });
    try {
      await host.send("c1", "start a shell", "r1");
      const pgid = await shellGroup(host, "c1");
      await until(
        async () =>
          (await host.view("c1", { limit: 50 })).turn_status === "idle",
      );
      expect(trackerHeld).toBe(true);
      expect(host.liveStatus("c1")).toEqual([null, null]);
      expect(host.metadata("c1")).toMatchObject({
        status: "idle",
        active_run: null,
      });
      expect(host.runningCount()).toBe(0);
      expect(host.runningConversations()).toEqual([]);
      expect(groupAlive(pgid)).toBe(true);
      expect(host.shells("c1").items.map((i) => [i.command, i.mode])).toEqual([
        ["sleep 60", "background"],
      ]);
      const response = await deliverStop(stopDeps(host, records), "c1", {});
      expect(((await response.json()) as Rec).status).toBe("stopped_processes");
      await until(async () => !groupAlive(pgid));
      await until(async () => host.shells("c1").active_count === 0);
    } finally {
      release();
      harness.snapshot = snapshot;
      await host.close();
    }
  });

  // Regression: #2799 idle Harnesses release SQLite descriptors and reopen without losing replies or live shells.
  test("idle Harnesses close, reopen on send, and retain live shells", async () => {
    const { faux, models } = fauxModels();
    const dataDir = mkdtempSync(join(root, "idle-"));
    const records = { c1: record("c1", root), c2: record("c2", root) };
    const host = hostFor(
      records,
      models,
      undefined,
      undefined,
      dataDir,
      undefined,
      100,
    );
    const descriptors = () =>
      readdirSync("/proc/self/fd")
        .flatMap((fd) => {
          try {
            return [readlinkSync(`/proc/self/fd/${fd}`)];
          } catch {
            return [];
          }
        })
        .filter((path) =>
          path.startsWith(
            join(dataDir, "conversations", "c1", "durable", "session.sqlite"),
          ),
        );
    try {
      faux.setResponses([fauxAssistantMessage("first reply")]);
      await host.send("c1", "first", "r1");
      await until(idle(host));
      const first = await host.open("c1");
      expect(descriptors().length).toBeGreaterThanOrEqual(3);
      await first.harness.closed;
      await until(() => descriptors().length === 0);
      const failing = await host.open("c1");
      const close = failing.harness.close.bind(failing.harness);
      let attempted!: () => void;
      const failure = new Promise<void>((resolve) => (attempted = resolve));
      failing.harness.close = async () => {
        failing.harness.close = close;
        attempted();
        throw new Error("injected close failure");
      };
      await failure;
      faux.setResponses([fauxAssistantMessage("retry reply")]);
      await host.send("c1", "retry after failed close", "retry-close");
      await failing.harness.closed;
      await until(idle(host));
      expect(await rows(host, "c1")).toContainEqual([
        "assistant",
        "retry reply",
      ]);
      const retried = await host.open("c1");
      expect(retried.harness).not.toBe(failing.harness);
      await retried.harness.closed;
      await until(() => descriptors().length === 0);
      faux.setResponses([startShell(), fauxAssistantMessage("shell reply")]);
      await host.send("c1", "start shell", "r2");
      const pgid = await shellGroup(host, "c1");
      await until(idle(host));
      const reopened = await host.open("c1");
      expect(reopened.harness).not.toBe(first.harness);
      expect(await rows(host, "c1")).toContainEqual([
        "assistant",
        "first reply",
      ]);
      expect(await rows(host, "c1")).toContainEqual([
        "assistant",
        "shell reply",
      ]);
      const other = await host.open("c2");
      await other.harness.closed;
      expect((await host.open("c1")).harness).toBe(reopened.harness);
      expect(groupAlive(pgid)).toBe(true);
      expect(descriptors().length).toBeGreaterThanOrEqual(3);
      await host.stopProcesses("c1");
      await reopened.harness.closed;
      await until(() => descriptors().length === 0);
      expect(groupAlive(pgid)).toBe(false);
      faux.setResponses([fauxAssistantMessage("last reply")]);
      await host.send("c1", "last", "r3");
      await until(idle(host));
      expect(await rows(host, "c1")).toContainEqual([
        "assistant",
        "last reply",
      ]);
      const beforeClear = await host.open("c1");
      await host.clear("c1");
      await until(
        async () => (await host.open("c1")).harness !== beforeClear.harness,
      );
      const cleared = await host.open("c1");
      await cleared.harness.closed;
      await until(() => descriptors().length === 0);
    } finally {
      await host.close();
    }
  });

  test("retire stops the conversation's shell groups before closing its Harness", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([startShell(), fauxAssistantMessage("started")]);
    const records: Record<string, Rec> = { c1: record("c1", root) };
    let stops = true;
    const counts: [string | null, number][] = [];
    const host: DurableHost = new DurableHost({
      ...testDeps(
        mkdtempSync(join(root, "data-")),
        (cid) => records[cid] ?? null,
        () => Object.keys(records),
      ),
      models,
      stopGroup: async (group) => stops && lifecycle.stopGroup(group),
      rowChanged: (cid) =>
        counts.push([host.liveStatus(cid)[0], host.shells(cid).active_count]),
    });
    const storage = join(host.storagePath("c1"), "..", "..");
    try {
      await host.send("c1", "start a shell", "r1");
      const pgid = await shellGroup(host, "c1");
      expect(groupAlive(pgid)).toBe(true);
      await until(async () =>
        counts.some(([run, live]) => run === null && live === 1),
      );
      records.c1!.reap_deferred = true;
      stops = false;
      expect(await host.retire("c1")).toBe(false);
      expect(groupAlive(pgid)).toBe(true);
      expect(existsSync(storage)).toBe(true);
      expect(host.shells("c1").active_count).toBe(1);
      stops = true;
      expect(await host.retire("c1")).toBe(true);
      expect(groupAlive(pgid)).toBe(false);
      expect(existsSync(storage)).toBe(false);
      expect(counts.at(-1)![1]).toBe(0);
      expect(
        (host as unknown as { liveRows: Map<string, unknown> }).liveRows.size,
      ).toBe(0);
    } finally {
      await host.close();
    }
  });

  test("shutdown proves each shell group gone and reports one it cannot", async () => {
    const shutdown = async (stops: boolean) => {
      const { faux, models } = fauxModels();
      faux.setResponses([startShell(), fauxAssistantMessage("started")]);
      const records: Record<string, Rec> = { c1: record("c1", root) };
      const host = new DurableHost({
        ...testDeps(
          mkdtempSync(join(root, "data-")),
          (cid) => records[cid] ?? null,
          () => Object.keys(records),
        ),
        models,
        stopGroup: async (group) => stops && lifecycle.stopGroup(group),
      });
      await host.send("c1", "start a shell", "r1");
      const pgid = await shellGroup(host, "c1");
      expect(groupAlive(pgid)).toBe(true);
      const failed = await host.close().then(
        () => null,
        (error: unknown) => String(error),
      );
      return { failed, pgid };
    };
    const proven = await shutdown(true);
    expect(proven.failed).toBeNull();
    expect(groupAlive(proven.pgid)).toBe(false);
    const unproven = await shutdown(false);
    expect(unproven.failed).toContain("survived shutdown");
    expect(unproven.failed).toContain(`c1: ${unproven.pgid}`);
  }, 20_000);

  test("shells source the conversation's env file, not one the server process names", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: 'echo "probe=$DURABLE_PROBE"' }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const records = { c1: record("c1", root) };
    const dataDir = mkdtempSync(join(root, "data-"));
    const deps = testDeps(
      dataDir,
      (cid) => records[cid as "c1"] ?? null,
      () => Object.keys(records),
    );
    const own = (await deps.agentEnv()).RECURSE_AGENT_ENV_FILE;
    writeFileSync(own, "export DURABLE_PROBE=conversation\n");
    const server = mkdtempSync(join(root, "server-tmp-"));
    writeFileSync(join(server, "env.sh"), "export DURABLE_PROBE=server\n");
    const saved = {
      tmp: process.env.RECURSE_AGENT_TMPDIR,
      file: process.env.RECURSE_AGENT_ENV_FILE,
    };
    process.env.RECURSE_AGENT_TMPDIR = server;
    process.env.RECURSE_AGENT_ENV_FILE = join(server, "env.sh");
    const host = new DurableHost({ ...deps, models });
    try {
      await host.send("c1", "probe", "r1");
      await until(async () =>
        (await rows(host, "c1")).some(([, text]) => text === "done"),
      );
      const tool = (await rows(host, "c1")).find(([role]) => role === "tool");
      expect(String(tool?.[1])).toContain("probe=conversation");
    } finally {
      for (const [name, value] of [
        ["RECURSE_AGENT_TMPDIR", saved.tmp],
        ["RECURSE_AGENT_ENV_FILE", saved.file],
      ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      await host.close();
    }
  });

  test("wait ends on a background shell's exit, which posts exactly one notice", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: "sleep 0.5; echo shell-finished",
          background: true,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("saw it"),
      fauxAssistantMessage("unexpected"),
    ]);
    const host = hostFor({ c1: record("c1", root) }, models);
    try {
      await host.send("c1", "run and wait", "r1");
      await until(async () =>
        (await rows(host, "c1")).some(([, text]) => text === "saw it"),
      );
      await until(
        async () =>
          (await host.view("c1", { limit: 50 })).turn_status === "idle",
      );
      await until(async () =>
        ((await host.view("c1", { limit: 50 })).blocks as Rec[]).some(
          (block) => block.role === "shell-notice",
        ),
      );
      const view = await rows(host, "c1");
      expect(view.filter(([role]) => role === "user")).toEqual([
        ["user", "run and wait"],
      ]);
      const blocks = (await host.view("c1", { limit: 50 })).blocks as Rec[];
      const notices = blocks.filter((b) => b.role === "shell-notice");
      expect(notices.length).toBe(1);
      expect(String(notices[0]!.text)).toMatch(
        /^Background shell finished · `sleep 0\.5; echo shell-finished` · exit 0 · /,
      );
      expect(String((notices[0]!.meta as Rec).body)).toContain(
        "shell-finished",
      );
      const { conversation } = await host.open("c1");
      const { messages } = await conversation.context(context);
      expect(
        JSON.stringify(messages.filter((m) => m.role === "user")),
      ).toContain("exited 0 after");
      expect(
        view.some(([, text]) =>
          String(text).startsWith("wait:A backgrounded shell reported"),
        ),
      ).toBe(true);
      expect(faux.state.callCount).toBe(3);
    } finally {
      await host.close();
    }
  });

  test("the safety state is the recurse.safety document, not the record", async () => {
    const { models } = fauxModels();
    const records = { c1: { ...record("c1", root), safety_off: true } };
    const changed: string[] = [];
    const host = hostFor(records, models, "faux/faux-1", (cid) =>
      changed.push(cid),
    );
    try {
      const { conversation } = await host.open("c1");
      expect(host.metadata("c1")).toMatchObject({
        safety_off: false,
        safety_off_active: false,
      });
      const safety = new URL(
        "../../src/extensions/core/safety/durable.ts",
        import.meta.url,
      ).href;
      const { setSafetyReviewOff } = (await import(safety)) as {
        setSafetyReviewOff: (
          c: unknown,
          off: boolean,
          ctx: unknown,
        ) => Promise<void>;
      };
      await setSafetyReviewOff(conversation, true, context);
      await until(async () => host.metadata("c1").safety_off);
      expect(host.metadata("c1").safety_off_active).toBe(true);
      expect(host.safetyReviewOff("c1")).toBe(true);
      expect(changed).toEqual(["c1", "c1"]);
    } finally {
      await host.close();
    }
  });

  test("the inspector serves the request the provider received, including a read image, from its file once idle and after restarts, with earlier user messages byte-identical across a restart", async () => {
    const work = mkdtempSync(join(root, "work-"));
    writeFileSync(
      join(work, "pixel.png"),
      new Uint8Array(Buffer.from(PIXEL_PNG, "base64")),
    );
    const { faux, models } = fauxModels();
    const received: string[] = [];
    const answer =
      (message: ReturnType<typeof fauxAssistantMessage>) =>
      (request: unknown) => {
        received.push(JSON.stringify(request));
        return message;
      };
    faux.setResponses([
      answer(
        fauxAssistantMessage(fauxToolCall("read", { path: "pixel.png" }), {
          stopReason: "toolUse",
        }),
      ),
      answer(fauxAssistantMessage("a pixel")),
      answer(fauxAssistantMessage("a second answer")),
    ]);
    const records = { c1: record("c1", work) };
    const dataDir = mkdtempSync(join(root, "data-"));
    const file = join(
      dataDir,
      "conversations",
      "c1",
      "durable",
      "last-request.json",
    );
    const served = async (current: DurableHost) => {
      const prompt = await current.prompt("c1");
      const request = JSON.parse(received.at(-1)!) as { messages: Rec[] };
      expect(prompt.capture_status).toBe("captured");
      expect(prompt.backend).toBe("durable");
      expect(JSON.stringify((prompt.request as Rec).context)).toBe(
        received.at(-1)!,
      );
      expect(prompt.system_messages).toEqual(
        request.messages.filter((message) => message.role === "system"),
      );
      expect((prompt.system_messages as Rec[]).length).toBeGreaterThan(0);
      return request;
    };
    let host = hostFor(records, models, undefined, undefined, dataDir, 200);
    try {
      expect((await host.prompt("c1")).capture_status).toBe("unavailable");
      await host.send("c1", "look at pixel.png", "r1");
      await until(async () => received.length === 2);
      await until(
        async () =>
          (await host.view("c1", { limit: 50 })).turn_status === "idle",
      );
      const result = (await served(host)).messages.find(
        (message) => message.role === "toolResult",
      );
      expect(result?.content).toContainEqual(
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      );
      await until(async () => existsSync(file));
      renameSync(file, `${file}.aside`);
      await until(
        async () => (await host.prompt("c1")).capture_status === "unavailable",
      );
      renameSync(`${file}.aside`, file);
      await served(host);
    } finally {
      await host.close();
    }
    host = hostFor(
      records,
      models,
      undefined,
      undefined,
      dataDir,
      undefined,
      undefined,
      () => Date.now() + 10 * 60_000,
    );
    try {
      await served(host);
      await host.send("c1", "and again", "r2");
      await until(async () => received.length === 3);
      await until(
        async () =>
          (await host.view("c1", { limit: 50 })).turn_status === "idle",
      );
      const users = (at: number) =>
        (JSON.parse(received[at]!) as { messages: Rec[] }).messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message));
      expect(users(2).slice(0, -1)).toEqual(users(1));
      await served(host);
      await until(async () => !existsSync(file));
    } finally {
      await host.close();
    }
    host = hostFor(records, models, undefined, undefined, dataDir);
    try {
      expect((await host.prompt("c1")).capture_status).toBe("unavailable");
    } finally {
      await host.close();
    }
  });

  // Regression: #2431 an oversized request faulted every turn instead of replying.
  test("a request over 8 MiB replies and the inspector shows all of it", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([fauxAssistantMessage("still here")]);
    const host = hostFor({ c1: record("c1", root) }, models);
    const big = "x".repeat(9 * 1024 * 1024);
    try {
      await host.send("c1", big, "r1");
      await until(async () =>
        JSON.stringify((await host.view("c1", { limit: 50 })).blocks).includes(
          "still here",
        ),
      );
      const prompt = await host.prompt("c1");
      expect(prompt.capture_status).toBe("captured");
      expect((prompt.system_messages as Rec[]).length).toBeGreaterThan(0);
      expect(JSON.stringify((prompt.request as Rec).context)).toContain(big);
    } finally {
      await host.close();
    }
  });
});

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a server killed mid-generation resumes and finishes the turn on restart", async () => {
  const dataDir = mkdtempSync(join(root, "kill-"));
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/durable_host/kill_child.ts"),
      dataDir,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  try {
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("running")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`child exited: ${out}`);
      out += new TextDecoder().decode(value);
    }
    child.kill("SIGKILL");
    await child.exited;
  } finally {
    child.kill("SIGKILL");
  }
  const { faux, host } = fauxHost(dataDir);
  faux.setResponses([fauxAssistantMessage("resumed answer")]);
  try {
    await host.openLive();
    await until(async () => {
      const view = await host.view("c1", { limit: 50 });
      return view.turn_status === "idle" && (view.blocks as Rec[]).length >= 2;
    });
    expect(await rows(host, "c1")).toEqual([
      ["user", "hello"],
      ["assistant", "resumed answer"],
    ]);
    expect(faux.state.callCount).toBe(1);
  } finally {
    await host.close();
  }
}, 20_000);

async function killedWithShell(dataDir: string): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/durable_host/shell_child.ts"),
      dataDir,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  let pgid: number;
  try {
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`child exited: ${out}`);
      out += new TextDecoder().decode(value);
    }
    pgid = (JSON.parse(out) as { pgid: number }).pgid;
    child.kill("SIGKILL");
    await child.exited;
  } finally {
    child.kill("SIGKILL");
  }
  expect(groupAlive(pgid)).toBe(true);
  return pgid;
}

function restartedHost(
  dataDir: string,
  stops: { value: boolean },
  log: (event: string) => void = () => undefined,
) {
  const { faux, models } = fauxModels();
  const records: Record<string, Rec> = {
    c1: record("c1", join(dataDir, "work")),
  };
  const host = new DurableHost({
    ...testDeps(
      dataDir,
      (cid) => records[cid] ?? null,
      () => Object.keys(records),
    ),
    models,
    stopGroup: async (group) => stops.value && lifecycle.stopGroup(group),
    log,
  });
  return { faux, host, records };
}

test("a failed open after shell recovery leaves no group or storage lock", async () => {
  const dataDir = mkdtempSync(join(root, "kill-open-failure-"));
  const pgid = await killedWithShell(dataDir);
  let fail = true;
  const { host, faux } = restartedHost(dataDir, { value: true }, (event) => {
    if (event === "durable_open" && fail) throw new Error("open report failed");
  });
  faux.setResponses(
    Array.from({ length: 4 }, () => fauxAssistantMessage("resumed answer")),
  );
  try {
    const failed = await host.open("c1").catch((error: unknown) => error);
    expect(String(failed)).toContain("open report failed");
    expect(groupAlive(pgid)).toBe(false);
    fail = false;
    const opened = await host.open("c1");
    expect(opened.ready).toBe(true);
    expect(groupAlive(pgid)).toBe(false);
  } finally {
    await host.close();
  }
}, 20_000);

test("a deletion after a restart stops the shell group of a conversation this process never opened", async () => {
  const dataDir = mkdtempSync(join(root, "kill-reap-"));
  const pgid = await killedWithShell(dataDir);
  const stops = { value: false };
  const { host, records } = restartedHost(dataDir, stops);
  const storage = join(host.storagePath("c1"), "..", "..");
  try {
    records.c1!.reap_deferred = true;
    expect(await host.retire("c1")).toBe(false);
    expect(groupAlive(pgid)).toBe(true);
    expect(existsSync(storage)).toBe(true);
    stops.value = true;
    expect(await host.retire("c1")).toBe(true);
    expect(groupAlive(pgid)).toBe(false);
    expect(existsSync(storage)).toBe(false);
  } finally {
    await host.close();
  }
}, 20_000);

test("a restart whose recovery cannot stop an old group resumes no work until it can", async () => {
  const dataDir = mkdtempSync(join(root, "kill-fence-"));
  const pgid = await killedWithShell(dataDir);
  const stops = { value: false };
  const { faux, host } = restartedHost(dataDir, stops);
  faux.setResponses(
    Array.from({ length: 4 }, () => fauxAssistantMessage("resumed answer")),
  );
  try {
    await host.openLive();
    const failed = await host.open("c1").catch((error: unknown) => error);
    expect(String(failed)).toContain("survived");
    expect(faux.state.callCount).toBe(0);
    expect(groupAlive(pgid)).toBe(true);
    stops.value = true;
    await until(
      async () =>
        (await host.view("c1", { limit: 50 })).turn_status === "idle" &&
        (await rows(host, "c1")).at(-1)?.[1] === "resumed answer",
      10_000,
    );
    expect(groupAlive(pgid)).toBe(false);
  } finally {
    await host.close();
  }
}, 20_000);

test("a server killed with a running background shell stops its group on restart, posts one lost notice, and finishes the run", async () => {
  const dataDir = mkdtempSync(join(root, "kill-shell-"));
  const pgid = await killedWithShell(dataDir);
  const { faux, host } = fauxHost(dataDir);
  faux.setResponses(
    Array.from({ length: 4 }, () => fauxAssistantMessage("resumed answer")),
  );
  try {
    await host.openLive();
    await until(async () => {
      const view = await host.view("c1", { limit: 50 });
      return (
        view.turn_status === "idle" &&
        (await rows(host, "c1")).some(([, text]) =>
          String(text).includes("the server restarted"),
        ) &&
        (await rows(host, "c1")).at(-1)?.[1] === "resumed answer"
      );
    });
    expect(groupAlive(pgid)).toBe(false);
    const view = await rows(host, "c1");
    expect(
      view.filter(([, text]) => String(text).includes("the server restarted"))
        .length,
    ).toBe(1);
    expect(view.at(-1)).toEqual(["assistant", "resumed answer"]);
  } finally {
    await host.close();
  }
}, 20_000);
