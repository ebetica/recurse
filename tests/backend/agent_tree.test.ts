import { afterAll, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTree,
  type AgentTreeDeps,
  type SpawnOutcome,
} from "../../src/agents/agent_tree";
import { AgentClosed, MailboxFull } from "../../src/agents/agent_store";
import { ParkedActions } from "../../src/agents/compaction";
import { ValueError, KeyError } from "../../src/agents/runtime/agent_node";
import { PiRPCError } from "../../src/agents/runtime/pi_protocol";
import {
  RuntimeLogger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { PiSessionRetirement } from "../../src/pi_session_retirement";
import { pyCompactJson } from "../../src/utils/py_compact_json";
import { buildWorld, counter } from "./fixtures/agent_node/world";

type Json = any;
const WALL = 1_700_000_000.0;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const BASE = {
  title: "T",
  model: "claude-opus-4-7",
  effort: "high",
  backend: "durable",
  created: WALL - 60,
  updated: WALL - 60,
  status: "idle",
};

function makeError(spec: [string, string]): Error {
  const [kind, text] = spec;
  switch (kind) {
    case "ValueError":
      return new ValueError(text);
    case "KeyError":
      return new KeyError(text);
    case "PiRPCError":
      return new PiRPCError(text);
    case "MailboxFull":
      return new MailboxFull(text);
    case "AgentClosed":
      return new AgentClosed(text);
    case "OSError":
      return Object.assign(new Error(text), { code: "EIO", name: "OSError" });
    default:
      return Object.assign(new Error(text), { name: kind });
  }
}

class FakeNode {
  constructor(
    readonly cid: string,
    readonly t: World,
  ) {}
  private step(kind: "clear" | "compact", fallback: unknown) {
    const list = (this.t.script[kind] ??= {})[this.cid] ?? [fallback];
    const step = list.length > 1 ? list.shift() : list[0];
    if (Array.isArray(step)) throw makeError(step as [string, string]);
    return step;
  }
  async clear(config: unknown) {
    this.t.calls.push(["clear", this.cid, config]);
    return this.step("clear", true);
  }
  async compact(config: unknown) {
    this.t.calls.push(["compact", this.cid, config]);
    this.step("compact", null);
    return { ok: true };
  }
}

type World = ReturnType<typeof setup>;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agent-tree-"));
  roots.push(root);
  mkdirSync(join(root, "agents"));
  const world = buildWorld({
    root,
    clock: { mono: 1000.0, wall: WALL },
    storeIds: counter("s", 3),
    sink: { write: () => {} },
    scheduler: null,
    defaultSpawnWorkdir: "/spawn",
  });
  const calls: Json[] = [];
  const logs: Json[] = [];
  const script: Json = {};
  const clock = { mono: 1000.0 };
  const nodes = new Map<string, FakeNode>();
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
  const outcomeDir = join(root, "spawn_outcomes");
  let tree!: AgentTree;
  const retirement = new PiSessionRetirement({
    sessions: { sessionDir: "/s" },
  } as never);
  const readOutcome = (cid: string): SpawnOutcome | null => {
    const path = join(outcomeDir, `${cid}.json`);
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || info.size > 8192) return null;
      const value = JSON.parse(readFileSync(path, "utf8"));
      return value && typeof value === "object" && value.id === cid
        ? value
        : null;
    } catch {
      return null;
    }
  };
  const t = {
    root,
    world,
    calls,
    logs,
    script,
    clock,
    nodes,
    outcomeDir,
    parked: null as unknown as ParkedActions,
    tree: null as unknown as AgentTree,
    deps: null as unknown as AgentTreeDeps,
  };
  const parked = new ParkedActions({
    load: (cid) => world.conversations.load(cid, { withPending: false }),
    requestRun: () => {},
    newActionId: () => "x",
    now: () => WALL,
  });
  const deps: AgentTreeDeps = {
    conversations: world.conversations,
    nodes: {
      existing: (cid: string) => (nodes.get(cid) ?? null) as never,
      retiring: (cid: string) => (script.retiring ?? []).includes(cid),
      uncertainIntents: (cid: string) => [
        ...((script.uncertain ?? {})[cid] ?? []),
      ],
    },
    agentStore: Object.assign(
      {
        submit: world.agentStore.submit.bind(world.agentStore),
        retire: world.agentStore.retire.bind(world.agentStore),
        close: world.agentStore.close.bind(world.agentStore),
        dbPaths: world.agentStore.dbPaths.bind(world.agentStore),
        forget: world.agentStore.forget.bind(world.agentStore),
      },
      { baseDir: join(root, "agents") },
    ),
    lifecycle: {
      guardAsync: async (_s: string, _c: unknown, fn: Json) =>
        fn({} as never, null),
      withLease: async (_t: unknown, fn: () => Promise<unknown>) => fn(),
    } as never,
    parked,
    durable: {
      owns: (conv) => conv?.backend === "durable",
      stop: async () => false,
      clear: async (cid) => {
        if (!world.conversations.load(cid) || !nodes.has(cid)) return null;
        if (!(await nodes.get(cid)!.clear({ cfg: cid }))) return null;
        await tree.clearConversationMetadata(cid);
        return { ok: true };
      },
      compact: async (cid) => {
        if (!world.conversations.load(cid) || !nodes.has(cid)) return null;
        await nodes.get(cid)!.compact({ cfg: cid });
        return { ok: true };
      },
    },
    prompts: {
      dropTurnSystemPrompt: async (conv: Json) =>
        void calls.push(["drop_prompt", conv.id]),
    },
    config: world.config,
    supervisor: {
      create: async (o) => {
        const kwargs: Json = {
          model: o.model ?? null,
          muted: o.muted,
          parent: o.parent ?? null,
          pinned: o.pinned,
          spawn_request_id: o.spawnRequestId,
          title: o.title,
        };
        if (o.level !== undefined) kwargs.level = o.level;
        if (o.workdir !== undefined) kwargs.workdir = o.workdir;
        calls.push(["create", o.cid, sortKeys(kwargs)]);
        const failure = (script.create_fail ?? {})[o.cid!];
        if (failure) throw makeError(failure);
        const conv: Json = { ...BASE, id: o.cid, title: o.title };
        if (o.parent != null) conv.parent = o.parent;
        await world.conversations.save(conv);
        return world.conversations.load(o.cid!, { withPending: false })!;
      },
      deliver: async (cid, content, o = {}) => {
        const kw: Json = {};
        if (o.origin !== undefined) kw.origin = o.origin;
        if (o.sender !== undefined) kw.sender = o.sender;
        if (o.source !== undefined) kw.source = o.source;
        if (o.start !== undefined) kw.start = o.start;
        calls.push(["deliver", cid, content, kw]);
        if (script.deliverHook) return script.deliverHook(cid, content);
        const s = (script.deliver ?? {})[cid];
        if (Array.isArray(s)) throw makeError(s as [string, string]);
        if (s === "none") return null;
        return `m-${cid}`;
      },
      requestRun: (cid) => void calls.push(["request_run", cid]),
    },
    spawnOutcomes: {
      read: async (cid) => readOutcome(cid),
      write: async (cid, status, o) => {
        mkdirSync(outcomeDir, { recursive: true });
        const existing = readOutcome(cid);
        if (
          existing !== null &&
          (existing.status === "accepted" || existing.status === "rejected")
        )
          return existing;
        const outcome: Json = { id: cid, status, parent: o.parent };
        if (o.code) outcome.code = o.code;
        if (o.message) outcome.message = o.message;
        const tmp = join(outcomeDir, `.${cid}.abcdef.tmp`);
        writeFileSync(tmp, pyCompactJson(outcome));
        renameSync(tmp, join(outcomeDir, `${cid}.json`));
        tree.markSpawnOutcomesDue();
        return outcome;
      },
    },
    sessions: {
      sessionReferences: (rows) => retirement.sessionReferences(rows),
    },
    spawnOutcomeDir: outcomeDir,
    logger: log,
    now: () => WALL,
    monotonic: () => clock.mono,
  };
  tree = new AgentTree(deps);
  t.parked = parked;
  t.tree = tree;
  t.deps = deps;
  return t;
}

function sortKeys(o: Json): Json {
  return Object.fromEntries(
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

const seed = (t: World, conv: Json) =>
  t.world.conversations.save({ ...BASE, ...conv });

test("integral-float effort is accepted (named difference)", async () => {
  const t = setup();
  await seed(t, { id: "p" });
  const o = await t.tree.prepareSpawnInputs(
    JSON.parse('{"title": "K", "effort": 2.0}'),
    "kid",
    "p",
  );
  expect(o.level).toBe(2);
});

test("outcome scan stops at the row cap and warns", async () => {
  const t = setup();
  mkdirSync(t.outcomeDir, { recursive: true });
  for (let i = 0; i < 300; i++)
    writeFileSync(join(t.outcomeDir, `x${i}.json`), "{}");
  const [outcomes, observed, overflow] =
    await t.tree.boundedSpawnOutcomeEntries();
  expect([outcomes.length, observed.length, overflow]).toEqual([256, 0, true]);
  t.tree.markSpawnOutcomesDue();
  await t.tree.processSpawnOutcomes();
  expect(t.logs).toContainEqual([
    30,
    "spawn outcome scan reached its bounded row limit",
    null,
  ]);
  expect(readdirSync(t.outcomeDir).length).toBe(300 - 256);
});

test("recorded spawn: rejection retires its record and orphan database", async () => {
  const t = setup();
  await seed(t, { id: "p" });
  t.script.create_fail = { r1: ["RuntimeError", "boom"] };
  const item = t.tree.parkSpawnIntent("r1", {
    id: "r1",
    parent: "p",
    title: "R",
  });
  await t.tree.recordSpawnIntent(item);
  expect(typeof item.store_id).toBe("string");
  expect(await t.world.agentStore.flush("r1", 5)).toBe(true);
  const db = t.world.agentStore.dbPaths("r1");
  expect(db.length).toBeGreaterThan(0);
  await t.tree.applySpawns();
  expect(t.tree.pendingSpawns).toEqual([]);
  const agents = join(t.root, "agents");
  expect(readdirSync(agents).some((n) => n.startsWith("r1."))).toBe(false);
  const trash = readdirSync(join(agents, ".trash"));
  expect(trash.length).toBeGreaterThan(0);
  expect(t.logs.map((l: Json) => l[1])).not.toContain(
    "event=spawn_orphan_retire_incomplete",
  );
});
