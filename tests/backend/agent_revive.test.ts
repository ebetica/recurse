import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstance } from "../../src/agents/instance";
import { Config } from "../../src/config";
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { addUpload } from "../../src/agents/runtime/attachments/publish";
import { retire } from "../../src/utils/trash";
import { readDownload } from "../../src/agents/runtime/attachments/preview";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  Harness,
  configure,
  createRegistry,
} from "@earendil-works/pi-durable";
import { EnvironmentDoc } from "../../src/extensions/core/environment/managed_tools";
import {
  safetyReviewOff,
  setSafetyReviewOff,
} from "../../src/extensions/core/safety/durable";
import {
  SqliteWorker,
  openWorkerSqliteStorage,
} from "../../src/agents/durable/sqlite_worker";
import { MAX_REVIVE_BYTES } from "../../src/agents/durable/import_archive";
import { createModels } from "@earendil-works/pi-ai";
import { ReviveDoc } from "../../src/agents/durable/revive_doc";
import { openShellHarness } from "../extensions/core/shells/fixtures/durable_harness";
import { RegistryStore } from "../../src/extensions/core/shells/persist";

const root = mkdtempSync(join(tmpdir(), "agent-revive-"));
const data = join(root, "data");
const target = join(root, "target");
mkdirSync(target, { recursive: true });
mkdirSync(join(data, "config"), { recursive: true });

const asked: string[] = [];
const bodies: string[] = [];
let release!: () => void;
const held = new Promise<void>((resolve) => (release = resolve));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const raw = await request.text();
    const body = JSON.parse(raw) as {
      messages: { role: string; content: unknown }[];
    };
    const last = [...body.messages].reverse().find((m) => m.role === "user");
    const text = JSON.stringify(last?.content ?? "");
    if (!text.includes("PERSIST-SCRATCH")) {
      asked.push(text);
      bodies.push(raw);
    }
    if (text.includes("HOLD"))
      await Promise.race([
        held,
        new Promise((r) => request.signal.addEventListener("abort", r)),
      ]);
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (
      text.includes("PERSIST-SCRATCH") &&
      body.messages.at(-1)?.role === "user"
    ) {
      const content = Array.isArray(last?.content)
        ? last.content
            .map((part: { text?: string }) => part.text ?? "")
            .join("\n")
        : String(last?.content);
      const directory = JSON.parse(
        content.match(/PERSIST-SCRATCH ("(?:[^"\\]|\\.)*")/)![1]!,
      );
      return new Response(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "persist-chdir",
              type: "function",
              function: {
                name: "chdir",
                arguments: JSON.stringify({ directory }),
              },
            },
            {
              index: 1,
              id: "persist-env",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command:
                    'printf "%s\\n" "$RECURSE_AGENT_TMPDIR" "$TMPDIR" "$TMP" "$TEMP" > "$RECURSE_AGENT_TMPDIR/paths.txt"',
                }),
              },
            },
          ],
        }) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return new Response(
      chunk({ role: "assistant", content: `ANSWER-${asked.length}` }) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
writeFileSync(
  join(data, "config/model-providers.json"),
  JSON.stringify({
    default: "recurse-test/scripted",
    providers: {
      "recurse-test": {
        base_url: `http://127.0.0.1:${server.port}/v1`,
        env_key: "RECURSE_TEST_KEY",
        wire_api: "completions",
        models: [{ id: "scripted", context_window: 100000 }],
      },
    },
  }),
);
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env))
  if (v !== undefined) env[k] = v;
for (const key of [
  "RECURSE_SELF_DEPLOY",
  "PI_CODING_AGENT_DIR",
  "RECURSE_SAFETY_DIR",
  "RECURSE_ISOLATED_DATA_DIR",
  "RECURSE_ISOLATED_ROOT",
  "RECURSE_TEMP_ROOT",
  "RECURSE_TEMP_IN_DATA_DIR",
])
  delete env[key];
Object.assign(env, {
  CHAT_DATA_DIR: data,
  HOME: join(root, "home"),
  RECURSE_HOME: join(root, "settings"),
  CHAT_REPO_URL: target,
  PI_BG_SHELL: "0",
  RECURSE_TEST_KEY: "test-key",
});
const instance = await buildInstance({
  config: new Config({ env }),
  sink: { write: () => undefined },
});
afterAll(async () => {
  release();
  await instance.shutdown();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>, ms = 30_000) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(25);
  }
}
const idle = () => instance.durable.runningCount() === 0;
const transcript = async (cid: string) =>
  JSON.stringify(await instance.durable.transcript(cid, { limit: 50 }));
const refusal = (target: string) =>
  instance.revive.revive(target, null).then(
    () => "revived",
    (error: unknown) => String(error),
  );
const send = (cid: string, text: string) =>
  instance.delivery.deliver(cid, text, { source: "agent", sender: null });

await instance.start();
await until(() => instance.lifecycle.readinessSnapshot().ready);
const model = "recurse-test/scripted";

// Regression: #2857 persistent agent scratch and cwd survive restart while local scratch stays separate.
test("agent scratch and effective cwd survive restart and retire on reap", async () => {
  const config = new Config({
    env: {
      ...env,
      CHAT_DATA_DIR: join(root, "persistent-data"),
      RECURSE_TEMP_IN_DATA_DIR: "1",
    },
  });
  await mkdir(config.paths.CONFIG_DIR, { recursive: true });
  await cp(
    join(data, "config/model-providers.json"),
    join(config.paths.CONFIG_DIR, "model-providers.json"),
  );
  let current = await buildInstance({
    config,
    sink: { write: () => undefined },
  });
  let cid = "";
  let scratch = "";
  let local = "";
  try {
    await current.start();
    await until(() => current.lifecycle.readinessSnapshot().ready);
    const agent = await current.create.create({
      title: "persistent scratch",
      model,
    });
    cid = String(agent.id);
    scratch = await current.agentTemp.agentTempPath(agent);
    local = await current.agentTemp.agentRuntimePath(agent);
    const directory = join(scratch, "working");
    await mkdir(directory);
    await writeFile(join(scratch, "sentinel"), "scratch survives");
    await writeFile(join(directory, "sentinel"), "cwd survives");
    const opened = await current.durable.open(cid);
    await setSafetyReviewOff(opened.conversation, true, context);
    await current.delivery.deliver(
      cid,
      `PERSIST-SCRATCH ${JSON.stringify(directory)}`,
      { source: "agent", sender: null },
    );
    await until(
      () =>
        current.durable.runningCount() === 0 &&
        current.durable.metadata(cid).pending.length === 0,
    );
    expect(await readFile(join(scratch, "paths.txt"), "utf8")).toBe(
      `${scratch}\n${local}\n${local}\n${local}\n`,
    );
    expect(local).not.toBe(scratch);
    expect(await current.durable.effectiveCwd(cid)).toBe(directory);
    await current.shutdown();
    retire(local, config.paths.AGENT_RUNTIME_TRASH_DIR);
    current = await buildInstance({
      config: new Config({
        env: {
          ...env,
          CHAT_DATA_DIR: config.paths.DATA_DIR,
          RECURSE_TEMP_IN_DATA_DIR: "1",
        },
      }),
      sink: { write: () => undefined },
    });
    await current.start();
    await until(() => current.lifecycle.readinessSnapshot().ready);
    const restored = current.conversations.load(cid)!;
    expect(await current.agentTemp.agentTempPath(restored)).toBe(scratch);
    expect(await readFile(join(scratch, "sentinel"), "utf8")).toBe(
      "scratch survives",
    );
    expect(await readFile(join(directory, "sentinel"), "utf8")).toBe(
      "cwd survives",
    );
    expect(await current.durable.effectiveCwd(cid)).toBe(directory);
    await current.reap.requestReap(cid, null);
    await until(() => current.conversations.load(cid) === null);
    await until(() => !existsSync(scratch) && !existsSync(local));
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(local)).toBe(false);
  } finally {
    await current.shutdown();
  }
}, 60_000);

// Regression: #2851 failed migration must fence writes and preserve legacy files.
test("a failed file migration keeps the instance unready until restart can recover", async () => {
  const config = new Config({
    env: {
      ...env,
      CHAT_DATA_DIR: join(root, "migration-data"),
      RECURSE_TEMP_ROOT: join(root, "migration-scratch"),
    },
  });
  const key = "20261024-migration";
  const cid = "migration";
  const first = await buildInstance({
    config,
    sink: { write: () => undefined },
  });
  const legacy = join(
    config.paths.AGENT_TEMP_INSTANCE_DIR,
    config.agentTempLeaf(key),
    "uploads",
  );
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  const file = await addUpload(
    legacy,
    cid,
    new TextEncoder().encode("legacy bytes"),
    "old.txt",
  );
  await first.conversations.save({
    id: cid,
    tmp_key: key,
    backend: "durable",
    workdir: target,
    model,
  });
  await mkdir(config.paths.AGENT_FILES_DIR, { recursive: true });
  const obstruction = join(
    config.paths.AGENT_FILES_DIR,
    config.agentTempLeaf(key),
  );
  await writeFile(obstruction, "blocked");
  try {
    await first.start();
    await expect(first.lifecycle.startWatcher()).rejects.toThrow();
    expect(first.lifecycle.readinessSnapshot().ready).toBe(false);
    expect(existsSync(join(legacy, `${file.id}.blob`))).toBe(true);
    expect(existsSync(join(config.paths.DATA_DIR, ".agent-files-v1"))).toBe(
      false,
    );
  } finally {
    await first.shutdown();
  }
  await unlink(obstruction);
  const second = await buildInstance({
    config,
    sink: { write: () => undefined },
  });
  try {
    await second.start();
    await until(() => second.lifecycle.readinessSnapshot().ready);
    const collection = second.agentTemp.uploadsDir(key);
    expect((await readDownload(collection, cid, String(file.id)))[1]).toEqual(
      new TextEncoder().encode("legacy bytes"),
    );
    expect(existsSync(legacy)).toBe(false);
  } finally {
    await second.shutdown();
  }
});

// Regression: #2851 reaping must retire persistent files as well as scratch.
test("a reaped agent loses its files and revives passive with history and takes a new turn", async () => {
  const parent = await instance.create.create({ title: "boss", model });
  const child = await instance.create.create({
    title: "Revive me please",
    parent: String(parent.id),
    model,
  });
  const cid = String(child.id);
  await send(cid, "first question");
  await until(() => asked.some((t) => t.includes("ANSWER-1")) && idle());
  await send(cid, "HOLD second");
  await until(() => asked.some((t) => t.includes("HOLD second")));
  await send(cid, "third, still queued");
  await until(() => instance.durable.metadata(cid).pending.length === 1);
  const file = await instance.reap.admitConversationUpload(
    cid,
    new TextEncoder().encode("reap me"),
    "reap.txt",
  );
  const collection = instance.agentTemp.uploadsDir(
    String(instance.conversations.load(cid)!.tmp_key),
  );
  expect(existsSync(join(collection, `${file.id}.blob`))).toBe(true);
  await instance.reap.requestReap(cid, null);
  await until(() => instance.conversations.load(cid) === null);
  expect(existsSync(collection)).toBe(false);
  expect(existsSync(join(data, "conversations", cid))).toBe(false);
  const [row] = await instance.durable.archive.search("rvvmplease", 0, 5);
  expect(row).toMatchObject({
    cid,
    reason: "reap",
    title: "Revive me please",
    parent: parent.id,
    parent_title: "boss",
    top_level: false,
    model,
  });
  expect(
    existsSync(join(data, "agent-archive", row!.archive_id, "session.sqlite")),
  ).toBe(true);
  await until(() =>
    asked.some((text) =>
      text.includes(`Revive the agent via subagent revive ${cid}.`),
    ),
  );
  await until(idle);
  await (await instance.durable.open(String(parent.id))).reporter?.kick();
  await until(idle);
  const before = asked.length;

  const revived = await instance.revive.revive(cid, String(parent.id));
  expect(revived).toMatchObject({
    id: cid,
    parent: parent.id,
    reason: "reap",
    notes: [],
  });
  await (await instance.durable.open(String(revived.id))).reporter?.kick();
  await until(idle);
  expect(asked.length).toBe(before);
  expect(idle()).toBe(true);
  const history = await transcript(cid);
  expect(history).toContain("first question");
  expect(history).toContain("ANSWER-1");
  expect(history).toContain("Revived from the agent archive");
  expect(history).toContain("third, still queued");
  expect(instance.durable.metadata(cid).pending).toEqual([]);
  expect(await instance.durable.archive.search("rvvmplease", 0, 5)).toEqual([]);
  expect(await refusal(row!.archive_id)).toContain(`already revived as ${cid}`);

  await send(cid, "after revive");
  const turn = () => asked.findIndex((t) => t.includes("after revive"));
  await until(() => turn() >= 0 && idle());
  const latest = bodies[turn()]!;
  expect(latest).toContain("first question");
  expect(latest).toContain("ANSWER-1");
  expect(await transcript(cid)).toContain(`ANSWER-${turn() + 1}`);
  expect(asked.filter((t) => t.includes("turn ended: aborted"))).toEqual([]);

  await instance.durable.clear(cid);
  await until(
    async () =>
      (await instance.durable.archive.search("rvvmplease", 0, 5)).length === 1,
  );
  const [cleared] = await instance.durable.archive.search("rvvmplease", 0, 5);
  expect(cleared).toMatchObject({ cid, reason: "clear" });
  expect(await transcript(cid)).not.toContain("first question");
  const copy = await instance.revive.revive(cleared!.archive_id, null);
  expect(copy.id).not.toBe(cid);
  expect(copy).toMatchObject({
    title: "Revive me please (before clear)",
    parent: null,
  });
  expect(await transcript(String(copy.id))).toContain("after revive");
  expect(instance.conversations.load(cid)).not.toBeNull();
}, 120_000);

test("a revive never takes the id of a record that still exists", async () => {
  const conv = await instance.create.create({ title: "busy one", model });
  const cid = String(conv.id);
  const store = join(root, "fake-store");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "session.sqlite"), "");
  await instance.durable.archive.keep(store, {
    archive_id: `${cid}.in-flight`,
    cid,
    reason: "reap",
    title: "busy one",
    parent: null,
    parent_title: null,
    top_level: true,
    model,
    effort: null,
    level: null,
    workdir: null,
    created: null,
    archived: 1,
  });
  expect(await refusal(`${cid}.in-flight`)).toContain(
    `Agent ${cid} still exists (its deletion has not finished); try again shortly.`,
  );
  expect(instance.conversations.load(cid)?.revived_from).toBeUndefined();
});

test("a revive that fails before its note leaves the archive to a retry", async () => {
  const conv = await instance.create.create({ title: "Retry target", model });
  const cid = String(conv.id);
  await send(cid, "remember RETRY-7");
  await until(() => asked.some((t) => t.includes("RETRY-7")) && idle());
  await instance.durable.clear(cid);
  await until(
    async () =>
      (await instance.durable.archive.search("rtrytarget", 0, 5)).length === 1,
  );
  const [row] = await instance.durable.archive.search("rtrytarget", 0, 5);
  const deliver = instance.delivery.deliver;
  instance.delivery.deliver = () => Promise.reject(new Error("note lost"));
  try {
    expect(await refusal(row!.archive_id)).toContain("note lost");
    instance.delivery.deliver = () => Promise.resolve(null);
    expect(await refusal(row!.archive_id)).toContain("refused its revive note");
  } finally {
    instance.delivery.deliver = deliver;
  }
  expect(
    await instance.durable.archive.search("rtrytarget", 0, 5),
  ).toMatchObject([{ archive_id: row!.archive_id, revived_as: null }]);
  const copy = await instance.revive.revive(row!.archive_id, null);
  expect(copy.title).toBe("Retry target (before clear)");
  const history = await transcript(String(copy.id));
  expect(history).toContain("RETRY-7");
  expect(history.split("Revived from the agent archive")).toHaveLength(2);
  expect(await instance.durable.archive.search("rtrytarget", 0, 5)).toEqual([]);
  expect(await refusal(row!.archive_id)).toContain("already revived");
}, 60_000);

async function externalStore() {
  const conv = await instance.create.create({
    title: "External history",
    model,
  });
  await send(String(conv.id), "remember EXTERNAL-CODEWORD-9");
  await until(
    () => asked.some((t) => t.includes("EXTERNAL-CODEWORD-9")) && idle(),
  );
  await instance.durable.clear(String(conv.id));
  await until(
    async () => (await instance.durable.archive.get(String(conv.id))) !== null,
  );
  const entry = (await instance.durable.archive.get(String(conv.id)))!;
  const dir = join(root, `second-instance-${String(conv.id)}`);
  await cp(join(data, "agent-archive", entry!.archive_id), dir, {
    recursive: true,
  });
  return { dir, entry: entry! };
}

async function inspectStore(cid: string) {
  const worker = new SqliteWorker();
  const storage = await openWorkerSqliteStorage(
    worker,
    instance.durable.storagePath(cid),
  );
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  const conversation = await harness.root(context);
  try {
    return {
      agent: await harness.snapshot(AgentDoc, conversation.id, context),
      env: await harness.snapshot(EnvironmentDoc, conversation.id, context),
      off: await safetyReviewOff(harness, conversation, context),
      tasks: (await storage.scanTasks({}, 100, undefined, context)).items,
    };
  } finally {
    await harness.close(context);
    worker.close();
  }
}

test("external archive and bare Durable copies use new ids, sanitize, remain passive and preserve the source", async () => {
  const { dir, entry } = await externalStore();
  const worker = new SqliteWorker();
  const harness = await Harness.open(
    await openWorkerSqliteStorage(worker, join(dir, "session.sqlite")),
    { models: createModels(), registry: createRegistry() },
    context,
  );
  const conversation = await harness.root(context);
  await conversation.commit(async (tx) => {
    (await tx.doc(EnvironmentDoc, conversation.id)).overrides = {
      RECURSE_AGENT_ID: "foreign",
      PI_CODING_AGENT_DIR: "foreign",
      CHAT_DATA_DIR: "foreign",
      ORDINARY: "keep",
    };
    Object.assign(await tx.doc(ReviveDoc, conversation.id), {
      archive: "foreign.prior-revive",
      settled: true,
    });
  }, context);
  await setSafetyReviewOff(conversation, true, context);
  await harness.close(context);
  worker.close();
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({
      ...entry,
      model: "missing/model",
      level: null,
      workdir: join(root, "missing-cwd"),
    }),
  );
  const beforeSql = await readFile(join(dir, "session.sqlite"));
  const beforeMeta = await readFile(join(dir, "meta.json"));
  const count = asked.length;
  const result = await instance.revive.reviveFrom(dir, null);
  expect(result.id).not.toBe(entry.cid);
  expect(result.title).toBe("External history");
  expect(result.notes).toEqual(
    expect.arrayContaining([
      expect.stringContaining("model"),
      expect.stringContaining("working directory"),
    ]),
  );
  await (await instance.durable.open(String(result.id))).reporter?.kick();
  expect(instance.durable.metadata(String(result.id)).pending).toEqual([]);
  expect(asked.length).toBe(count);
  expect(await transcript(String(result.id))).toContain("EXTERNAL-CODEWORD-9");
  const state = await inspectStore(String(result.id));
  expect(state.env?.overrides).toEqual({ ORDINARY: "keep" });
  expect(state.off).toBe(false);
  expect(
    (await instance.durable.archive.get(String(result.archive_id)))
      ?.origin_path,
  ).toBe(dir);
  await send(String(result.id), "external follow-up");
  await until(
    () => asked.some((t) => t.includes("external follow-up")) && idle(),
  );
  expect(
    bodies[asked.findIndex((t) => t.includes("external follow-up"))],
  ).toContain("EXTERNAL-CODEWORD-9");
  const bare = await instance.revive.reviveFrom(
    join(dir, "session.sqlite"),
    null,
  );
  expect(bare.id).not.toBe(result.id);
  expect(bare.id).not.toBe(entry.cid);
  expect(bare.title).toBe("session.sqlite");
  expect(await transcript(String(bare.id))).toContain("EXTERNAL-CODEWORD-9");
  expect(await readFile(join(dir, "session.sqlite"))).toEqual(beforeSql);
  expect(await readFile(join(dir, "meta.json"))).toEqual(beforeMeta);
}, 60_000);

// Regression: #2257 revived parent cwd missing falls back to valid instance directory
test("missing source and parent directories revive in the valid instance default", async () => {
  const { dir, entry } = await externalStore();
  const gone = join(root, "missing-source-cwd");
  const parent = await instance.create.create({
    model,
    workdir: join(root, "missing-parent-cwd"),
  });
  const worker = new SqliteWorker();
  const harness = await Harness.open(
    await openWorkerSqliteStorage(worker, join(dir, "session.sqlite")),
    { models: createModels(), registry: createRegistry() },
    context,
  );
  const source = await harness.root(context);
  await source.commit((tx) => configure(tx, source.id, { cwd: gone }), context);
  await harness.close(context);
  worker.close();
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ ...entry, workdir: gone }),
  );
  const revived = await instance.revive.reviveFrom(dir, String(parent.id));
  expect(revived.parent).toBe(String(parent.id));
  expect(revived.workdir).toBe(entry.workdir);
  expect((await stat(String(revived.workdir))).isDirectory()).toBe(true);
  expect((await inspectStore(String(revived.id))).agent?.cwd).toBe(
    entry.workdir!,
  );
  expect(revived.notes).toEqual(
    expect.arrayContaining([
      expect.stringContaining(gone),
      expect.stringContaining(String(entry.workdir)),
    ]),
  );
}, 60_000);

// Regression: #2565 real task kinds must not retain foreign process ownership.
test("external shell ownership never signals source processes and copied shells are aborted", async () => {
  const worker = new SqliteWorker();
  const sourceDir = join(root, "foreign-source");
  const stateDir = join(root, "foreign-shell-state");
  mkdirSync(sourceDir, { recursive: true });
  const sourcePath = join(sourceDir, "session.sqlite");
  const source = await openShellHarness(
    await openWorkerSqliteStorage(worker, sourcePath),
    {
      cwd: target,
      stateDir,
      config: {
        foregroundWaitMs: 60_000,
        logDir: join(root, "foreign-shell-logs"),
      },
    },
  );
  const pgids: number[] = [];
  try {
    await (
      await source.conversation.submit(
        {
          type: "input",
          content: `RUN ${JSON.stringify({ command: "sleep 120", background: true })}`,
        },
        context,
      )
    ).wait(context);
    const shell = (await source.harness.inspect(context)).tasks.find(
      ({ record }) => record.kind === "recurse.shell",
    )!.record;
    const store = new RegistryStore(
      stateDir,
      (shell.input as { key: string }).key,
    );
    await source.conversation.submit(
      {
        type: "input",
        content: `RUN ${JSON.stringify({ command: "sleep 120" })}`,
      },
      context,
    );
    await until(
      async () =>
        store.readAll().filter((record) => record.status === "running")
          .length === 2 &&
        (await source.harness.inspect(context)).tasks.some(
          ({ record }) => typeof record.memos?.["recurse.shell"] === "string",
        ),
    );
    const tool = (await source.harness.inspect(context)).tasks.find(
      ({ record }) => typeof record.memos?.["recurse.shell"] === "string",
    )!.record;
    pgids.push(...store.readAll().map((record) => record.pid!));
    for (const pgid of pgids) expect(process.kill(-pgid, 0)).toBe(true);
    const dir = join(root, "live-shell-export");
    mkdirSync(dir, { recursive: true });
    const db = await worker.openDatabase(sourcePath);
    try {
      await db.run("VACUUM INTO ?", join(dir, "session.sqlite"));
    } finally {
      await db.close();
    }
    const before = asked.length;
    const result = await instance.revive.reviveFrom(
      join(dir, "session.sqlite"),
      null,
    );
    const copyId = String(result.id);
    const copy = await instance.durable.open(copyId);
    await instance.durable.stopProcesses(copyId);
    await until(
      async () =>
        (await copy.harness.getTask(shell.id, context))?.state.status ===
        "terminal",
    );
    for (const pgid of pgids) {
      expect(process.kill(-pgid, 0)).toBe(true);
      const proc = await readFile(`/proc/${pgid}/stat`, "utf8");
      expect(proc.slice(proc.lastIndexOf(")") + 2).split(" ")[0]).not.toBe("Z");
    }
    for (const task of [shell, tool]) {
      const owned = await source.harness.getTask(task.id, context);
      expect(owned?.conversationId).toBe(source.conversation.id);
      expect(owned?.state.status).not.toBe("terminal");
    }
    expect(asked.length).toBe(before);
    const copied = await inspectStore(copyId);
    expect(
      copied.tasks.find((task) => task.id === shell.id)?.state,
    ).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
    expect(
      copied.tasks.find((task) => task.id === tool.id)?.memos?.[
        "recurse.shell"
      ],
    ).toBeUndefined();
  } finally {
    await source.shells.shutdown();
    await source.harness.close(context);
    for (const pgid of pgids) {
      let gone: unknown;
      try {
        process.kill(-pgid, 0);
      } catch (error) {
        gone = error;
      }
      expect(gone).toMatchObject({ code: "ESRCH" });
    }
    worker.close();
  }
}, 60_000);

test("legacy Pi JSONL imports recorded history and continues without modifying the session", async () => {
  const recorded = JSON.parse(
    await readFile(
      join(import.meta.dir, "fixtures/durable_rows/recorded.json"),
      "utf8",
    ),
  ) as { entries: { id: string; model?: unknown[] }[] };
  let parentId: string | null = null;
  const entries = recorded.entries.flatMap((entry) => {
    if (!entry.model?.[0]) return [];
    const id = `legacy-${entry.id}`;
    const row = {
      type: "message",
      id,
      parentId,
      timestamp: "2026-10-12T00:00:00Z",
      message: entry.model[0],
    };
    parentId = id;
    return [row];
  });
  const path = join(root, "legacy.jsonl");
  await writeFile(
    path,
    [{ type: "session", version: 3, id: "legacy", cwd: root }, ...entries]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const before = await readFile(path);
  const count = asked.length;
  const result = await instance.revive.reviveFrom(path, null);
  expect(result.id).not.toBe("legacy");
  expect((await inspectStore(String(result.id))).agent?.cwd).toBe(root);
  expect(asked.length).toBe(count);
  const history = await transcript(String(result.id));
  expect(history).toContain("notes.txt");
  await send(String(result.id), "legacy follow-up");
  await until(
    () => asked.some((t) => t.includes("legacy follow-up")) && idle(),
  );
  expect(
    bodies[asked.findIndex((t) => t.includes("legacy follow-up"))],
  ).toContain("notes.txt");
  expect(await readFile(path)).toEqual(before);
}, 60_000);

test("external admission refuses wrong shapes, links, oversize and unsupported schemas", async () => {
  const reject = (path: string) =>
    instance.revive.reviveFrom(path, null).then(
      () => "revived",
      (error: unknown) => String(error),
    );
  expect(await reject(join(root, "absent"))).toContain("does not exist");
  expect(await reject(target)).toContain("meta.json");
  const bad = join(root, "bad.jsonl");
  await writeFile(bad, "not a Pi session\n");
  expect(await reject(bad)).toContain("Pi v3");
  const link = join(root, "link.jsonl");
  await symlink(bad, link);
  expect(await reject(link)).toContain("not a link");
  const { dir } = await externalStore();
  const worker = new SqliteWorker();
  const db = await worker.openDatabase(join(dir, "session.sqlite"));
  await db.run("UPDATE durable_schema SET version = 999");
  await db.close();
  worker.close();
  expect(await reject(dir)).toContain("schema version 999");
  const huge = join(root, "huge.jsonl");
  const { open } = await import("node:fs/promises");
  const handle = await open(huge, "w");
  await handle.truncate(MAX_REVIVE_BYTES + 1);
  await handle.close();
  expect(await reject(huge)).toContain("256 MiB");
  expect((await stat(huge)).size).toBe(MAX_REVIVE_BYTES + 1);
}, 60_000);
