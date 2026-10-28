import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SpawnWorkdir,
  SupervisorCreate,
  type CreateDeps,
} from "../../src/agents/supervisor";
import { AgentTree } from "../../src/agents/agent_tree";
import {
  TreeLifecycle,
  TreeLifecycleBusy,
} from "../../src/agents/mutation_guard";
import { buildConversationsApp } from "./http_conversations_app";
import {
  RuntimeLogger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { Cancelled, TaskSet } from "../../src/utils/tasks";
import { buildWorld, counter } from "./fixtures/agent_node/world";
import { switchoverWorld, until } from "./fixtures/durable_host/host";

type Json = any;
const WALL = 1_700_000_000.0;
const roots: string[] = [];
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

function setup(options: { lifecycleBusy?: () => boolean } = {}) {
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
    nodes: world.nodes,
    lifecycle: {
      guard: async (_site, _cid, fn, o) => {
        guardModes.push(o?.nonblocking);
        if (options.lifecycleBusy?.())
          throw new TreeLifecycleBusy("tree lifecycle is busy in this process");
        return fn({} as never, null);
      },
      guardAsync: async (_site, _cid, fn) => fn({} as never, null),
      mutateExternalStorage: async (mutation, args) =>
        (mutation as (...a: unknown[]) => unknown)(
          ...(args as unknown[]),
        ) as never,
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
  const failSave = { armed: false };
  const conversations = world.conversations;
  const realSave = conversations.save.bind(conversations);
  conversations.save = async (conv, token) => {
    if (failSave.armed) {
      failSave.armed = false;
      throw Object.assign(new Error("scripted save failure"), {
        name: "OSError",
      });
    }
    return realSave(conv, token);
  };
  const realRollback =
    conversations.rollbackServiceConversation.bind(conversations);
  conversations.rollbackServiceConversation = async (conv) => {
    calls.push(["rollback", conv.id]);
    return realRollback(conv);
  };
  const create = new SupervisorCreate(deps);
  return {
    failSave,
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
  t.world.config.upsertCustomProvider("local-llm", {
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

// Feature: #2461 Take over must notify both recipients without waking idle agents.
test("Take over stores inspectable notes once, without waking idle recipients", async () => {
  const w = await switchoverWorld();
  try {
    const { create, durable, delivery, conversations } = w.instance;
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
    await conversations.withSafetyGuard("boss", async () => {
      await create.setPinned("held", true);
      await create.setPinned("held", true);
      expect(durable.metadata("boss").status).toBe("idle");
    });
    const note =
      "User has taken control of the agent, do not message Held agent (held).";
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
    await create.setPinned("held", false);
    expect(conversations.load("held")!.muted).toBe(false);
    const active = w.holdNextRequest({
      name: "read",
      args: { path: join(w.root, "data/config/model-providers.json") },
    });
    try {
      await delivery.deliver("held", "Keep working", { origin: "operator" });
      await active.started;
      expect(durable.metadata("held").status).toBe("running");
      await create.setPinned("held", true);
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
    await create.setPinned("boss", true);
    const parentNote =
      "User has taken control of the agent, do not message Boss (boss).";
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

test("pin HTTP route returns a retryable refusal while the lifecycle is held", async () => {
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
      deps.create.setPinned = t.create.setPinned.bind(t.create);
    },
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${app.running.port}/api/conversations/g/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: "Take-over change is busy. Try again shortly.",
    });
    expect(t.world.conversations.load("g")!.pinned).toBeFalsy();
  } finally {
    lifecycle.release();
    await app.running.close();
  }
});
