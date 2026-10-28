import { afterAll, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Reconciler,
  resumeTailState,
  type ReconcileNode,
  type ReconcilerDeps,
} from "../../src/agents/reconciler";
import {
  RuntimeLogger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { buildWorld, counter } from "./fixtures/agent_node/world";

type Json = any;
const WALL = 1_700_000_000.0;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

class FakeNode implements ReconcileNode {
  turnTask: Promise<void> | null;
  constructor(readonly spec: Json) {
    this.turnTask = spec.turn ? new Promise<void>(() => {}) : null;
  }
  inboxMessages() {
    return (this.spec.inbox ?? []).map((m: Json) => ({ ...m }));
  }
  oldestSendable() {
    return this.spec.sendable ? { id: "x" } : null;
  }
  restoreUncertain(): string {
    throw new Error("unused");
  }
  restoreSendable(): string {
    throw new Error("unused");
  }
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reconciler-"));
  roots.push(root);
  mkdirSync(join(root, "agents"));
  return root;
}

function makeWorld(root: string) {
  return buildWorld({
    root,
    clock: { mono: 1000.0, wall: WALL },
    storeIds: counter("s", 3),
    sink: { write: () => {} },
    scheduler: null,
  });
}

function setup(options: { root?: string; fakeNodes?: Json } = {}) {
  const root = options.root ?? newRoot();
  const world = makeWorld(root);
  const calls: Json[] = [];
  const logs: Json[] = [];
  const script: Json = { deliver: {}, notices: {} };
  const clock = { mono: 1000.0 };
  const jobs: [string, (signal: AbortSignal) => Promise<unknown>][] = [];
  const log = new RuntimeLogger(
    "recurse.agents",
    {
      write: (record: RuntimeLogRecord) =>
        logs.push([record.level, record.message]),
    } as never,
    10,
  );
  const fakes = new Map<string, FakeNode>(
    Object.entries(options.fakeNodes ?? {}).map(([cid, spec]) => [
      cid,
      new FakeNode(spec),
    ]),
  );
  const nodes = options.fakeNodes
    ? {
        existing: (cid: string) => fakes.get(cid) ?? null,
        node: (cid: string) => fakes.get(cid) ?? new FakeNode({}),
      }
    : (world.nodes as never);
  let saveFail = false;
  const deps: ReconcilerDeps = {
    conversations: {
      load: (cid, o) => world.conversations.load(cid, o),
      allConvs: (o) => world.conversations.allConvs(o),
      save: (conv) => {
        if (saveFail) throw new Error("disk full");
        return world.conversations.save(conv);
      },
      readBoundedJsonObject: (p, m) =>
        world.conversations.readBoundedJsonObject(p, m),
    },
    nodes,
    agentStore: world.agentStore,
    supervisor: {
      deliver: async (cid, content, opts = {}) => {
        const kwargs: Json = {};
        const names: Record<string, string> = {
          messageId: "message_id",
          nextTurnOnly: "next_turn_only",
        };
        for (const [k, v] of Object.entries(opts)) kwargs[names[k] ?? k] = v;
        const sorted = Object.fromEntries(
          Object.entries(kwargs).sort(([a], [b]) => (a < b ? -1 : 1)),
        );
        calls.push(["deliver", cid, content, sorted]);
        const scripted = script.deliver[cid];
        if (Array.isArray(scripted))
          return scripted.length ? scripted.shift() : `m-${cid}`;
        return `m-${cid}-${calls.length}`;
      },
      requestRun: (cid) => void calls.push(["request_run", cid]),
      cancelInboxMessage: async (cid, mid) => {
        calls.push(["cancel", cid, mid]);
        return true;
      },
      launchMaintenanceJob: (name, run) => {
        jobs.push([name, run]);
        return true;
      },
      applyReaps: async () => void calls.push(["reaps"]),
      reconcileWatcherInboxes: async () => void calls.push(["inboxes"]),
    },
    tree: {
      markSpawnOutcomesDue: () => void calls.push(["due"]),
      applySpawns: async () => void calls.push(["spawns"]),
      processSpawnOutcomes: async () => void calls.push(["spawn_outcomes"]),
      processPlatformActions: () => void calls.push(["platform"]),
    },
    shells: {
      restartNotices: async (sid) =>
        (script.notices[sid as string] ?? []).map((n: Json) => ({ ...n })),
    },
    lifecycle: {
      startupCleanup: async () => {
        if (script.cleanupFail) throw new Error("registry unreadable");
        return script.cleanup ?? [];
      },
      runtimeShellCleanupNotice: async () => script.runtimeNotice ?? null,
      startupAllowsTempSweep: () => script.sweep ?? false,
    },
    drainTrash: async () => void calls.push(["trash"]),
    seedDeferredReaps: async () => void calls.push(["seed"]),
    countMetric: (key, n) => void calls.push(["metric", key, n]),
    spawnOutcomeDir: join(root, "spawn_outcomes"),
    tmpSuffix: () => "t00001",
    logger: log,
    monotonic: () => clock.mono,
  };
  const reconciler = new Reconciler(deps);
  return {
    root,
    world,
    calls,
    logs,
    script,
    clock,
    jobs,
    deps,
    reconciler,
    failSave: () => void (saveFail = true),
  };
}

function writeSession(path: string, lines: Json[]) {
  writeFileSync(
    path,
    lines
      .map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n")
      .join(""),
  );
}

test("spawn outcome receipts round-trip", async () => {
  const t = setup();
  await t.reconciler.writeSpawnOutcome("a", "accepted", { parent: "p" });
  await t.reconciler.writeSpawnOutcome("b", "rejected", {
    parent: null,
    code: "rejected",
    message: "no",
  });
  await expect(t.reconciler.readSpawnOutcome("a")).resolves.toEqual({
    id: "a",
    status: "accepted",
    parent: "p",
  });
  await expect(t.reconciler.readSpawnOutcome("b")).resolves.toEqual({
    id: "b",
    status: "rejected",
    parent: null,
    code: "rejected",
    message: "no",
  });
});

test("observeSpawnOutcome refreshes the marker mtime like Path.touch", async () => {
  const t = setup();
  await t.reconciler.observeSpawnOutcome("a");
  const path = join(t.deps.spawnOutcomeDir, "a.observed");
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path, old, old);
  const before = statSync(path).mtimeMs;
  await t.reconciler.observeSpawnOutcome("a");
  expect(statSync(path).mtimeMs).toBeGreaterThan(before);
});

test("a hardlinked or directory session reads as not interrupted", async () => {
  const root = newRoot();
  const path = join(root, "s.jsonl");
  writeSession(path, [
    { type: "session", id: "S" },
    { type: "message", id: "u", message: { role: "user" } },
  ]);
  linkSync(path, join(root, "twin.jsonl"));
  expect(await resumeTailState(path, "S")).toEqual([false, null, null]);
  expect(await resumeTailState(root, "S")).toEqual([false, null, null]);
});
