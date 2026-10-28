import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SupervisorReap,
  SupervisorCreate,
  SpawnWorkdir,
  type DoomedScan,
  type ReapDeps,
} from "../../src/agents/supervisor";
import { DeferredReaps } from "../../src/agents/retry_schedule";
import { TreeLifecycle } from "../../src/agents/mutation_guard";
import { flockExclusive } from "../../src/utils/flock";
import { until } from "./fixtures/durable_host/host";
import { buildConversationsApp } from "./http_conversations_app";
import {
  ProcessCleanupPending,
  TakenOverReapBlocked,
} from "../../src/agents/runtime/pi_protocol";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { ProcessLifecycle } from "../../src/process_lifecycle";
import {
  RuntimeLogger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { Cancelled, TaskSet } from "../../src/utils/tasks";
import { buildWorld, counter } from "./fixtures/agent_node/world";

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
function setup(spec: Json, overrides: Partial<ReapDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "supervisor-reap-"));
  roots.push(root);
  for (const name of ["msgs", "trash", "mute-locks", "title-locks"])
    mkdirSync(join(root, name), { recursive: true });
  const calls: Json[] = [];
  const legacy: string[] = [];
  const logs: Json[] = [];
  const world = buildWorld({
    root,
    clock: { mono: 1000.0, wall: WALL },
    storeIds: counter("s", 3),
    sink: { write: () => {} },
    scheduler: null,
  });
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
  const records: boolean[] = [...(spec.records ?? [])];
  const shells: boolean[] = [...(spec.shells ?? [])];
  const now = () => WALL;
  const deferred = new DeferredReaps({
    conversations: world.conversations,
    dropTurnSystemPrompt: async (conv) =>
      void calls.push(["drop_prompt", conv.id, false]),
    log,
    now,
  });
  const nodes = world.nodes;
  const sorted = (s: Set<string>) => [...s].sort();
  const scan = (cid: string): DoomedScan => [
    0,
    [cid, ...world.conversations.descendants(cid)],
    new Set(),
    new Set(),
  ];
  const deps: ReapDeps = {
    errors: { ProcessCleanupPending, TakenOverReapBlocked },
    conversations: world.conversations,
    nodes,
    lifecycle: { guardAsync: (_s, _c, fn) => fn({} as never, null) },
    tree: {
      doomedScan: scan,
      revalidateScan: (s) =>
        s === null ? null : [[...s[1]], new Set(s[2]), new Set(s[3])],
      takeoverReapBlocker: (doomed) => {
        for (const d of doomed) {
          const conv = world.conversations.load(d, { withPending: false });
          if (conv !== null && conv.pinned === true)
            return [d, typeof conv.title === "string" ? conv.title : null];
        }
        return null;
      },
    },
    deferred,
    processes: {
      drainReaps: async () => void calls.push(["drain"]),
      cleanupCurrentRecordsFor: async (cids) => {
        const ok = records.length ? records.shift()! : true;
        calls.push(["records", sorted(cids), ok]);
        return ok;
      },
      cleanupBackgroundRecordsFor: async (cids) => {
        const ok = shells.length ? shells.shift()! : true;
        calls.push(["shells", sorted(cids), ok]);
        return ok;
      },
      processRecordBlockersFor: async (cids) => {
        const rows = (spec.blockers ?? [])
          .filter((b: Json) => cids.has(b[0]))
          .map((b: Json) => ({
            cid: b[0],
            instanceId: b[1],
            recordId: b[2],
            pid: b[3],
            reason: b[4],
          }));
        calls.push(["blockers", sorted(cids), rows.length]);
        return rows;
      },
      stopIdleShellsFor: async () => [0, 0],
      hasRetainedShellsFor: () => false,
    },
    agentStore: {
      baseDir: world.agentStore.baseDir,
      dbPaths: (cid) => world.agentStore.dbPaths(cid),
      close: async (cid, timeout) => {
        if ((spec.close_fail ?? []).includes(cid)) {
          calls.push(["close", cid, false]);
          return false;
        }
        const ok = await world.agentStore.close(cid, timeout);
        calls.push(["close", cid, ok]);
        return ok;
      },
      forget: (cid) => world.agentStore.forget(cid),
    },
    agentTemp: {
      newAgentTempKey: async (cid) => {
        calls.push(["new_key", cid]);
        return `20240101-fix${cid}`;
      },
      retireMemberCollection: async (cid, key) => {
        const reason = (spec.collection_fail ?? {})[cid];
        calls.push(["collection", cid, key]);
        return reason !== undefined ? [false, reason] : [true, null];
      },
      cleanupAgentTemps: async (owners) =>
        void calls.push(["cleanup_temps", owners.map((o) => [...o])]),
      markTrashDrainDue: () => void calls.push(["drain_due"]),
      addConversationUpload: async () => ({}),
    },
    retireLegacySession: async (conv) => (legacy.push(String(conv.id)), false),
    archiveLiveRecord: (cid, _conv, paths, date, key) => {
      calls.push([
        "archive",
        cid,
        paths.map((p) => p.split("/").pop()),
        date,
        key,
      ]);
      return !(spec.archive_fail ?? []).includes(cid);
    },
    retireToolDetails: (cid) => void calls.push(["tool_details", cid]),
    dropTurnSystemPrompt: async (conv, dropCapture) =>
      void calls.push(["drop_prompt", conv.id, dropCapture]),
    viewCache: { drop: () => false },
    deliver: async (cid, content, o) => {
      calls.push(["deliver", cid, content, o]);
      return "m1";
    },
    deliverUpward: async (conv, content, o) => {
      calls.push(["upward", conv.id, content, o]);
      return true;
    },
    paths: {
      msgDir: join(root, "msgs"),
      trashDir: join(root, "trash"),
      muteLockDir: join(root, "mute-locks"),
      titleLockDir: join(root, "title-locks"),
      reviewerJournalRoot: join(root, "reviewer-journals"),
    },
    log,
    now,
    tasks: new TaskSet(() => {}),
    ...overrides,
  };
  return {
    root,
    world,
    deps,
    reap: new SupervisorReap(deps),
    deferred,
    calls,
    logs,
    legacy,
  };
}

async function seed(env: ReturnType<typeof setup>, spec: Json) {
  for (const row of spec.rows)
    await env.world.conversations.save({ ...BASE, ...row });
  for (const row of spec.rows) await env.world.agentStore.flush(row.id, 5);
  for (const name of spec.ledgers ?? [])
    writeFileSync(join(env.root, "msgs", name), "{}\n");
}

// Regression: #2460 deletion's lifecycle lease refused the next create.
test("delete then immediate HTTP create waits for the real reap lease", async () => {
  const env = setup({});
  await seed(env, { rows: [{ id: "old" }] });
  const lifecycle = new TreeLifecycle({
    dataDir: env.root,
    muteLockDir: env.deps.paths.muteLockDir,
    logger: env.deps.log,
  });
  env.deps.lifecycle = lifecycle;
  const create = new SupervisorCreate({
    ...env.deps,
    ...env.world,
    lifecycle,
    importFinalized: () => true,
    spawnWorkdir: new SpawnWorkdir(env.root, async () => env.root),
    drafts: {
      claimAttachmentDraft: async () => {},
      transferAttachmentDraft: async () => {},
    },
    agentTemp: { ...env.deps.agentTemp, ensureAgentTemp: async () => env.root },
    bumpTreeTopology: () => {},
    deliverPlatformNote: (cid, content) => env.deps.deliver(cid, content, {}),
    sleep: async () => {},
  });
  const attempted = Promise.withResolvers<void>();
  const app = await buildConversationsApp(join(env.root, "http"), {
    patch: (deps) => {
      deps.reap.requestReap = env.reap.requestReap.bind(env.reap);
      deps.create.create = (options) => {
        const work = create.create(options);
        attempted.resolve();
        return work;
      };
    },
  });
  const fd = await open(env.root, "r");
  const unlock = await flockExclusive(fd.fd, env.root);
  let reaping: Promise<void> | undefined;
  try {
    const base = `http://127.0.0.1:${app.running.port}/api/conversations`;
    const deleted = await fetch(`${base}/old`, { method: "DELETE" });
    expect(deleted.status).toBe(202);
    reaping = env.reap.applyReaps();
    await until(() => lifecycle.currentHolder()?.site === "supervisor.reap");
    const pending = fetch(base, { method: "POST" });
    await attempted.promise;
    unlock();
    expect((await pending).status).toBe(200);
    await reaping;
    await env.deps.tasks.drain();
    expect(env.world.conversations.load("old")).toBeNull();
    expect(env.logs.map((row) => row[1]).join("\n")).toMatch(
      /event=tree_lifecycle_queued .*holder_site=supervisor.reap .*waited_seconds=\d+\.\d+ waiter_kind=task waiter_site=create/,
    );
  } finally {
    unlock();
    await fd.close();
    await reaping;
    await app.running.close();
  }
});

test("an unexpected failure parks the root once and re-raises", async () => {
  const spec = { rows: GROUP_TREE };
  const env = setup(spec);
  await seed(env, spec);
  env.deps.processes.drainReaps = async () => {
    throw new TypeError("drain broke");
  };
  await expect(env.reap.reap("a", null)).rejects.toThrow("drain broke");
  const row = env.world.conversations.load("a")!;
  expect(row.reap_deferred_reason).toBe("deletion failed (TypeError)");
  expect(env.deferred.snapshot().map(([c, r]) => [c, r.attempts])).toEqual([
    ["a", 1],
  ]);
  env.deps.processes.drainReaps = async () => {
    throw new Error("again");
  };
  await expect(env.reap.reap("a", null)).rejects.toThrow("again");
  expect(env.world.conversations.load("a")!.reap_deferred_reason).toBe(
    "deletion failed (Error)",
  );
});

test("a failed pinned-deletion notice is logged, the intent dropped", async () => {
  const rows = [{ id: "held", parent: "boss", pinned: true }, { id: "boss" }];
  const env = setup({ rows });
  await seed(env, { rows });
  env.deps.deliver = async () => {
    throw new Error("down");
  };
  env.deferred.queueDeferredReap("held", { requestedBy: "boss" });
  await env.reap.applyReaps();
  expect(env.deferred.snapshot()).toEqual([]);
  expect(env.logs.some((l) => l[1].includes("pinned_reap_notice_failed"))).toBe(
    true,
  );
});

test("member lock files are unlinked after retire", async () => {
  const spec = { rows: [{ id: "solo", parent: "boss" }, { id: "boss" }] };
  const env = setup(spec);
  await seed(env, spec);
  writeFileSync(join(env.root, "mute-locks", "solo.lock"), "");
  writeFileSync(join(env.root, "title-locks", "solo.lock"), "");
  expect(await env.reap.reap("solo", null)).toEqual(["solo"]);
  expect(existsSync(join(env.root, "mute-locks", "solo.lock"))).toBe(false);
  expect(existsSync(join(env.root, "title-locks", "solo.lock"))).toBe(false);
  expect(existsSync(join(env.world.agentStore.baseDir, "solo.sqlite"))).toBe(
    false,
  );
});

const PY = process.execPath;
const strays: number[] = [];
afterAll(() => {
  for (const pgid of strays)
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
});

async function groupMembers(pgid: number): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const raw = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = raw
        .slice(raw.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u);
      if (Number(fields[2]) === pgid) found.push(Number(name));
    } catch {}
  }
  return found;
}

function killProbe(pgid: number): string {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}

async function expectGroupGone(pgid: number): Promise<void> {
  let members = await groupMembers(pgid);
  for (let i = 0; i < 40 && members.length; i++) {
    await Bun.sleep(25);
    members = await groupMembers(pgid);
  }
  expect({ pgid, members }).toEqual({ pgid, members: [] });
  expect(killProbe(pgid)).toBe("ESRCH");
}

async function expectGroupAlive(pgid: number): Promise<void> {
  expect((await groupMembers(pgid)).length).toBeGreaterThan(0);
}

function groupWorld(spec: Json) {
  const state = join(mkdtempSync(join(tmpdir(), "reap-groups-")), "state");
  roots.push(state);
  const life = new ProcessLifecycle({
    registry: new ShellRegistry({
      enabled: true,
      stateDir: state,
      processStartedMs: Date.now(),
    }),
    shellStateDir: state,
    termGraceMs: 200,
    killGraceMs: 500,
    baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
  });
  const env = setup(spec, { processes: life });
  const spawn = async (cid: string, argv?: string[]) => {
    const [proc] = await life.spawnTracked(
      argv ?? [PY, "-e", "setInterval(() => {}, 1000)"],
      "pi-rpc",
      { cid, spawn: { stdout: "ignore" } },
    );
    strays.push(proc.pid);
    return proc.pid;
  };
  return { ...env, life, spawn };
}

const GROUP_TREE = [
  { id: "a", parent: "boss" },
  { id: "a1", parent: "a" },
  { id: "b", parent: "boss" },
  { id: "b1", parent: "b" },
  { id: "boss" },
];

test("groups: concurrent subtree reaps stop every member group", async () => {
  const spec = { rows: GROUP_TREE };
  const env = groupWorld(spec);
  await seed(env, spec);
  const pgids = await Promise.all(
    ["a", "a1", "b", "b1"].map((c) => env.spawn(c)),
  );
  const [left, right] = await Promise.all([
    env.reap.reap("a", null),
    env.reap.reap("b", null),
  ]);
  expect([left, right]).toEqual([
    ["a", "a1"],
    ["b", "b1"],
  ]);
  for (const pgid of pgids) await expectGroupGone(pgid);
  expect(env.world.conversations.load("boss")).not.toBeNull();
  expect(env.life.rows.size).toBe(0);
});

test("groups: a pinned descendant refuses an agent reap and keeps its group", async () => {
  const rows = GROUP_TREE.map((r) =>
    r.id === "a1" ? { ...r, pinned: true } : r,
  );
  const spec = { rows };
  const env = groupWorld(spec);
  await seed(env, spec);
  const pgid = await env.spawn("a1");
  await expect(env.reap.reap("a", "boss")).rejects.toBeInstanceOf(
    TakenOverReapBlocked,
  );
  await expectGroupAlive(pgid);
  expect(env.world.conversations.load("a1")).not.toBeNull();
  expect(await env.reap.reap("a", null)).toEqual(["a", "a1"]);
  await expectGroupGone(pgid);
});

test("groups: late admissions after the fence are refused", async () => {
  const spec = { rows: GROUP_TREE };
  const env = groupWorld(spec);
  await seed(env, spec);
  const pgid = await env.spawn("b1");
  const node = env.world.nodes.node("b1");
  expect(await env.reap.reap("b", null)).toEqual(["b", "b1"]);
  await expectGroupGone(pgid);
  expect(node.tryAdmitFileOp()).toBe(false);
  await expect(
    env.reap.admitConversationUpload("b1", new Uint8Array([1]), "x.txt"),
  ).rejects.toThrow("attachment owner not found");
  expect(env.world.nodes.existing("b1")).toBeNull();
  expect(env.world.conversations.load("b1")).toBeNull();
  expect(existsSync(join(env.world.agentStore.baseDir, "b1.sqlite"))).toBe(
    false,
  );
});

test("groups: a reap cut off mid-way retries from the durable intent", async () => {
  const spec = { rows: GROUP_TREE };
  const env = groupWorld(spec);
  await seed(env, spec);
  const pgid = await env.spawn("a1");
  const controller = new AbortController();
  const drain = env.life.drainReaps.bind(env.life);
  env.life.drainReaps = async () => {
    controller.abort();
    await drain();
  };
  await expect(
    env.reap.reap("a", null, { signal: controller.signal }),
  ).rejects.toBeInstanceOf(Cancelled);
  env.life.drainReaps = drain;
  await expectGroupAlive(pgid);
  const flagged = ["a", "a1"].filter(
    (c) =>
      env.world.conversations.load(c, { withPending: false })?.reap_deferred,
  );
  expect(flagged).toEqual(["a", "a1"]);
  env.deferred.queueDeferredReap("a", { attempt: 0 });
  await env.reap.applyReaps();
  await expectGroupGone(pgid);
  expect(env.world.conversations.load("a")).toBeNull();
  expect(env.world.conversations.load("a1")).toBeNull();
  expect(env.deferred.snapshot()).toEqual([]);
});
