import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ServiceCreateRefusal,
  SpawnWorkdir,
  SupervisorCreate,
  type CreateDeps,
} from "../../src/agents/supervisor";
import { AgentTree } from "../../src/agents/agent_tree";
import {
  TreeLifecycle,
  TreeLifecycleBusy,
} from "../../src/agents/lifecycle/mutation_guard";
import { buildConversationsApp } from "./http_conversations_app";
import {
  RuntimeLogger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { Cancelled, TaskSet } from "../../src/utils/tasks";
import { buildWorld, counter } from "./fixtures/agent_node/world";
import { switchoverWorld, until } from "./fixtures/durable_host/host";
import { probeMetadataFlock } from "./fixtures/metadata_flock";

type Json = any;
const WALL = 1_700_000_000.0;
const roots: string[] = [];
const teardowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const teardown of teardowns.splice(0)) await teardown();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const BASE = {
  title: null,
  model: "claude-opus-4-7",
  effort: "high",
  backend: "durable",
  created: WALL - 60,
  updated: WALL - 60,
  status: "idle",
};

const GATED = new URL("./fixtures/agent_store/gated_worker.ts", import.meta.url)
  .href;

function setup(
  options: { lifecycleBusy?: () => boolean; storeWorkerUrl?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "supervisor-create-"));
  roots.push(root);
  const calls: Json[] = [];
  const guardModes: unknown[] = [];
  const world = buildWorld({
    root,
    clock: { mono: 1000.0, wall: WALL },
    storeIds: counter("s", 3),
    sink: { write: () => {} },
    scheduler: null,
    storeWorkerUrl: options.storeWorkerUrl,
  });
  const logs: Json[] = [];
  const log = new RuntimeLogger(
    "recurse.agents",
    {
      write: (record: RuntimeLogRecord) =>
        logs.push([
          record.level,
          record.message,
          record.conversation_id === "-" ? null : record.conversation_id,
        ]),
    } as never,
    10,
  );
  let keyN = 0;
  const bumps = { n: 0 };
  const sleeps: number[] = [];
  const deps: CreateDeps = {
    tasks: new TaskSet(() => {}),
    conversations: world.conversations,
    configActions: world.configActions,
    serviceBindings: world.serviceBindings,
    nodes: world.nodes,
    lifecycle: {
      guard: async (_site, _cid, fn, o) => {
        guardModes.push(o?.nonblocking);
        if (options.lifecycleBusy?.())
          throw new TreeLifecycleBusy("tree lifecycle is busy in this process");
        return fn({} as never, null);
      },
      guardAsync: async (_site, _cid, fn) => fn({} as never, null),
    } as CreateDeps["lifecycle"],
    config: world.config,
    importFinalized: () => true,
    spawnWorkdir: new SpawnWorkdir(root, async () => "/spawn"),
    drafts: {
      claimAttachmentDraft: async (token, cid) => {
        calls.push(["draft_claim", token, cid]);
        if (token === "draft-bad")
          throw Object.assign(new Error("attachment draft not found"), {
            name: "ValueError",
          });
      },
      transferAttachmentDraft: async (token, conv) => {
        calls.push(["draft_transfer", token, conv.id]);
        if (token === "draft-late")
          throw Object.assign(new Error("attachment draft transfer failed"), {
            name: "ValueError",
          });
      },
    },
    agentTemp: {
      safeRemoveTempKey: async () => true,
      newAgentTempKey: async () => `20240101-k${++keyN}`,
      ensureAgentTemp: async (conv, o = {}) => {
        calls.push(["ensure_temp", conv.id, conv.tmp_key, o.persist ?? true]);
        return "/tmp/none";
      },
    },
    bumpTreeTopology: () => void bumps.n++,
    log,
    deliverPlatformNote: async () => null,
    now: () => WALL,
    sleep: async (seconds, signal) => {
      sleeps.push(seconds);
      if (signal.aborted) throw new Cancelled();
    },
  };
  const create = new SupervisorCreate(deps);
  return {
    guardModes,
    root,
    world,
    create,
    calls,
    logs,
    bumps,
    deps,
    sleeps,
  };
}

test("CR1: an aborted create wait still completes the transaction", async () => {
  const t = setup();
  const ac = new AbortController();
  const pending = t.create.create({ cid: "ab1" }, ac.signal);
  ac.abort();
  await expect(pending).rejects.toBeInstanceOf(Cancelled);
  while (t.world.conversations.load("ab1")?.id !== "ab1") await Bun.sleep(5);
  expect(t.world.conversations.load("ab1")?.id).toBe("ab1");
});

test("new conversations and children use Durable", async () => {
  const t = setup();
  await t.world.conversations.save({ ...BASE, id: "p" });
  expect((await t.create.create({ cid: "ui" })).backend).toBe("durable");
  expect((await t.create.create({ cid: "child", parent: "p" })).backend).toBe(
    "durable",
  );
});

test("new conversations and spawns on a Settings custom provider use Durable", async () => {
  const t = setup();
  await t.world.config.models.upsertCustomProvider("local-llm", {
    base_url: "http://127.0.0.1:9/v1",
    env_key: "LOCAL_LLM_KEY",
    wire_api: "completions",
    models: [{ id: "small", context_window: 100000 }],
  });
  const tree = new AgentTree({
    conversations: t.world.conversations,
    config: t.world.config,
  } as never);
  const spawn = async (cid: string, req: Json) =>
    (
      await t.create.create(
        await tree.prepareSpawnInputs({ title: "K", ...req }, cid, null),
      )
    ).backend;
  const custom = { model: "local-llm/small" };
  expect(await spawn("k1", custom)).toBe("durable");
  expect(await spawn("k2", {})).toBe("durable");
  const created = await t.create.create({ cid: "c1", ...custom });
  expect([created.model, created.backend]).toEqual([
    "local-llm/small",
    "durable",
  ]);
});

// Regression: #2993 Returning control must notify both recipients once without waking idle agents.
test("Take over and release store inspectable notes once, without waking idle recipients", async () => {
  const w = await switchoverWorld();
  try {
    const { create, durable, delivery, conversations, nodes } = w.instance;
    await create.create({
      cid: "boss",
      title: "Boss",
      model: "recurse-test/scripted",
    });
    await create.create({
      cid: "held",
      title: "Held agent",
      parent: "boss",
      model: "recurse-test/scripted",
    });
    await conversations.withMuteGuard("held", async () => {});
    const node = nodes.node("held");
    const release = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const lock = node.withLock;
    const withLock = lock.bind(node);
    const held = withLock(() => release.promise);
    node.withLock = (work, token) => {
      const pending = withLock(work, token);
      queued.resolve();
      return pending;
    };
    await nodes.node("boss").withLock(async () => {
      const save = conversations.save;
      let checkedMute = false;
      conversations.save = async (conv, token) => {
        if (conv.id === "held" && conv.taken_over === true) {
          await expect(
            probeMetadataFlock(conversations.paths.muteLockDir, "held"),
          ).rejects.toBeInstanceOf(TreeLifecycleBusy);
          checkedMute = true;
        }
        return save.call(conversations, conv, token);
      };
      const takeover = create.setTakenOver("held", true);
      try {
        await Promise.race([
          queued.promise,
          takeover.then(() => {
            throw new Error("Take over skipped the held node lock");
          }),
        ]);
        await expect(
          probeMetadataFlock(conversations.paths.titleLockDir, "held"),
        ).rejects.toBeInstanceOf(TreeLifecycleBusy);
        await probeMetadataFlock(conversations.paths.muteLockDir, "held");
        release.resolve();
        await takeover;
        expect(checkedMute).toBe(true);
        expect(await conversations.agentStore.flush("held")).toBe(true);
        expect(await conversations.loadCanonicalMetadata("held")).toMatchObject(
          {
            taken_over: true,
            muted: true,
          },
        );
      } finally {
        release.resolve();
        await Promise.allSettled([held, takeover]);
        conversations.save = save;
        node.withLock = lock;
      }
      await create.setTakenOver("held", true);
      expect(durable.metadata("boss").status).toBe("idle");
    });
    await w.instance.createTasks.drain();
    const note =
      "User has taken control of Held agent (held); do not message it.";
    for (const cid of ["held", "boss"]) {
      await until(async () =>
        JSON.stringify(await durable.view(cid)).includes(note),
      );
      const view = await durable.view(cid);
      expect(
        (view.blocks as Json[]).filter((b) => String(b.text).includes(note)),
      ).toHaveLength(1);
      expect(durable.metadata(cid).status).toBe("idle");
      await delivery.deliver(cid, "Continue", { origin: "operator" });
      await until(() => durable.metadata(cid).status === "idle");
      expect(JSON.stringify(await durable.prompt(cid))).toContain(note);
      expect(JSON.stringify(await durable.prompt(cid))).toContain(
        "[recurse-origin: platform]",
      );
    }
    await create.setTakenOver("held", false);
    await create.setTakenOver("held", false);
    await w.instance.createTasks.drain();
    expect(conversations.load("held")!.muted).toBe(false);
    const releaseNote =
      "User has returned control of Held agent (held); you can message it again.";
    for (const cid of ["held", "boss"]) {
      const view = await durable.view(cid);
      expect(
        (view.blocks as Json[]).filter((b) =>
          String(b.text).includes(releaseNote),
        ),
      ).toHaveLength(1);
      expect(durable.metadata(cid).status).toBe("idle");
    }
    for (const cid of ["held", "boss"]) {
      await delivery.deliver(cid, "Continue after release", {
        origin: "operator",
      });
      await until(() => durable.metadata(cid).status === "idle");
      const prompt = JSON.stringify(await durable.prompt(cid));
      expect(prompt).toContain(releaseNote);
      expect(prompt.indexOf(note)).toBeLessThan(prompt.indexOf(releaseNote));
    }
    const active = w.holdNextRequest({
      name: "read",
      args: { path: join(w.root, "data/config/model-providers.json") },
    });
    try {
      await delivery.deliver("held", "Keep working", { origin: "operator" });
      await active.started;
      expect(durable.metadata("held").status).toBe("running");
      await create.setTakenOver("held", true);
      await until(
        async () =>
          ((await durable.view("boss")).blocks as Json[]).filter((b) =>
            String(b.text).includes(note),
          ).length === 2,
      );
      expect(durable.metadata("boss").status).toBe("idle");
    } finally {
      active.release();
    }
    await until(
      async () =>
        durable.metadata("held").status === "idle" &&
        ((await durable.view("held")).blocks as Json[]).filter((b) =>
          String(b.text).includes(note),
        ).length === 2,
    );
    const activeRequest = (await durable.prompt("held")).request as Json;
    expect(
      JSON.stringify(activeRequest.context.messages).split(note).length - 1,
    ).toBe(2);
    await create.setTakenOver("boss", true);
    const parentNote =
      "User has taken control of Boss (boss); do not message it.";
    await until(async () =>
      JSON.stringify(await durable.view("boss")).includes(parentNote),
    );
    expect(JSON.stringify(await durable.view("held"))).not.toContain(
      parentNote,
    );
  } finally {
    try {
      for (const cid of ["held", "boss"]) {
        if (w.instance.conversations.load(cid))
          await (await w.instance.durable.open(cid)).reporter?.kick();
      }
    } finally {
      await w.close();
    }
  }
});

test("take-over HTTP route returns a retryable refusal while the lifecycle is held", async () => {
  const t = setup();
  await t.world.conversations.save({ ...BASE, id: "g" });
  const lifecycle = new TreeLifecycle({
    dataDir: t.root,
    muteLockDir: join(t.root, "locks"),
    logger: t.deps.log,
  });
  t.deps.lifecycle = lifecycle;
  lifecycle.reserve(lifecycle.newToken(), "test_hold", null);
  const app = await buildConversationsApp(join(t.root, "http"), {
    patch: (deps) => {
      deps.create.setTakenOver = t.create.setTakenOver.bind(t.create);
    },
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${app.running.port}/api/conversations/g/take-over`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taken_over: true }),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: "Take-over change is busy. Try again shortly.",
    });
    expect(t.world.conversations.load("g")!.taken_over).toBeFalsy();
  } finally {
    lifecycle.release();
    await app.running.close();
  }
});

async function stalledServiceCreate(externalKey: string) {
  const t = setup({ storeWorkerUrl: GATED });
  const lifecycle = new TreeLifecycle({
    dataDir: t.root,
    muteLockDir: join(t.root, "locks"),
    logger: t.deps.log,
  });
  t.deps.lifecycle = lifecycle;
  const agents = join(t.root, "agents");
  const started: { pending?: Promise<unknown> } = {};
  teardowns.push(async () => {
    await rm(join(agents, "stall-next"), { force: true });
    const holds = (await readdir(agents)).filter((name) =>
      name.endsWith(".sqlite.hold"),
    );
    for (const name of holds) await rm(join(agents, name), { force: true });
    await started.pending;
    for (const name of holds)
      await until(
        () =>
          t.world.agentStore.status(name.slice(0, -".sqlite.hold".length))
            .in_flight === false,
      );
  });
  await mkdir(agents, { recursive: true });
  await writeFile(join(agents, "stall-next"), "");
  const service = (key: string) =>
    t.create.createOrRejoinServiceConversation({
      title: null,
      servicePrincipal: "alpha",
      externalKey: key,
      allowedModels: null,
      ownedLimit: null,
    });
  const pending = service(externalKey).catch((error: unknown) => error);
  started.pending = pending;
  let hold = "";
  await until(async () => {
    hold =
      (await readdir(agents)).find((name) => name.endsWith(".sqlite.hold")) ??
      "";
    return hold !== "";
  });
  const database = join(agents, hold.slice(0, -".hold".length));
  const cid = hold.slice(0, -".sqlite.hold".length);
  return {
    t,
    lifecycle,
    service,
    pending,
    cid,
    database,
    hold: join(agents, hold),
  };
}

async function stalledLeaves(root: string, cid: string) {
  const dir = join(root, "external-keys");
  const external = await Promise.all(
    (await readdir(dir)).map(async (name) =>
      JSON.parse(await readFile(join(dir, name), "utf8")),
    ),
  );
  return {
    service: JSON.parse(
      await readFile(join(root, "service-bindings", `${cid}.json`), "utf8"),
    ),
    external: external.filter((record) => record.conversation_id === cid),
  };
}

// Regression: #3662 A first commit that never settled kept the creation lease, so every later create and reap waited behind it.
test("a stalled first service commit releases the creation lease and keeps its files and bindings", async () => {
  const { t, lifecycle, service, pending, cid, hold } =
    await stalledServiceCreate("stalled");
  const { agentStore, conversations } = t.world;
  expect(await pending).toBeInstanceOf(ServiceCreateRefusal);
  expect(lifecycle.currentHolder()).toBeNull();
  expect((await service("unrelated")).created).toBe(true);
  expect(conversations.load(cid)).toBeNull();
  expect(existsSync(hold)).toBe(true);
  const held = await stalledLeaves(t.root, cid);
  expect(held.service).toEqual({
    principal: "alpha",
    create_token: "20240101-k1",
  });
  expect(held.external).toEqual([
    {
      principal: "alpha",
      external_key: "stalled",
      conversation_id: cid,
      create_token: "20240101-k1",
    },
  ]);
  await rm(hold);
  await until(() => agentStore.status(cid).in_flight === false);
  expect((await agentStore.loadPersistedAgent(cid))[0]).toMatchObject({
    id: cid,
  });
  expect(conversations.load(cid)).toBeNull();
  expect(await stalledLeaves(t.root, cid)).toEqual(held);
});

// Regression: #3662 A first commit SQLite refused left the conversation published, bound and without a stored row.
test("a first service commit that SQLite refuses rolls back its row and bindings", async () => {
  const { t, pending, cid, database, hold } =
    await stalledServiceCreate("refused");
  const { agentStore, conversations, serviceBindings } = t.world;
  const planted = new Database(database);
  try {
    planted.run("CREATE TABLE agent (cid TEXT PRIMARY KEY);");
    await rm(hold);
    expect(await pending).toBeInstanceOf(ServiceCreateRefusal);
    expect(
      planted
        .query("SELECT name FROM sqlite_master WHERE name = 'intents';")
        .values(),
    ).toEqual([["intents"]]);
  } finally {
    planted.close();
  }
  expect(existsSync(database)).toBe(false);
  expect((await agentStore.loadPersistedAgent(cid))[0]).toBeNull();
  expect(conversations.load(cid)).toBeNull();
  expect(await serviceBindings.serviceOwnedConversationCount("alpha")).toBe(0);
  expect(
    await serviceBindings.lookupExternalKey("alpha", "refused"),
  ).toBeNull();
});
