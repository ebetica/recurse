import { afterAll, expect, test, spyOn } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Harness as DurableHarness,
  defineExtension,
  defineTool,
  hook,
  ToolTask,
  type Registry,
} from "@earendil-works/pi-durable";
import {
  Type,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { acquireSupervisorLock, LOCK_FD_ENV } from "../../src/launcher/lock";
import { SqliteWorker } from "../../src/agents/durable/sqlite_worker";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import { fauxHost, until } from "./fixtures/durable_host/host";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SupervisorLifecycle,
  type LifecycleDeps,
  type LifecycleNode,
} from "../../src/agents/supervisor/lifecycle";
import {
  RuntimeLogger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import {
  Cancelled,
  TaskSet,
  abortable,
  ignoringCancelled,
} from "../../src/utils/tasks";
import { AgentStore } from "../../src/agents/agent_store";

const NOW = 1_700_000_000.0;
const LEVELS: Record<number, string> = {
  20: "INFO",
  30: "WARNING",
  40: "ERROR",
};
const LIFECYCLE_EVENTS = new Set([
  "claude_code_login_import_failed",
  "codex_cli_login_import_failed",
  "store_import",
  "store_import_failed",
  "store_import_incomplete_no_marker",
  "projection_unestablished_no_mutations",
  "reconcile_agent_temp_startup_failed",
  "maintenance_job_failed",
]);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Json = Record<string, any>;

class Node implements LifecycleNode {
  turnTask: Promise<void> | null = null;
  pending: Json[];
  cancelled = 0;
  constructor(spec: Json = {}) {
    this.pending = (spec.pending ?? []).map((p: Json) => ({ ...p }));
    if (spec.task) this.turnTask = new Promise<void>(() => {});
  }
  pendingIntents(): Json[] {
    return this.pending;
  }
  cancelDrive(): Promise<void> | null {
    this.cancelled += 1;
    return this.turnTask;
  }
}

function events(records: RuntimeLogRecord[]): Json[] {
  const out: Json[] = [];
  for (const record of records) {
    const fields: Record<string, string> = {};
    for (const part of record.message.split(" ")) {
      const i = part.indexOf("=");
      if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1);
    }
    const event = fields.event;
    delete fields.event;
    if (!LIFECYCLE_EVENTS.has(event!)) continue;
    delete fields.seconds;
    delete fields.error_type;
    out.push([event, LEVELS[record.level], fields]);
  }
  return out;
}

interface Harness {
  life: SupervisorLifecycle;
  deps: LifecycleDeps;
  nodes: Map<string, Node>;
  records: RuntimeLogRecord[];
  calls: Json[];
}

function harness(overrides: Partial<LifecycleDeps> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-"));
  roots.push(root);
  const records: RuntimeLogRecord[] = [];
  const log = new RuntimeLogger("recurse.agents", {
    write: (r) => void records.push(r),
  });
  const nodes = new Map<string, Node>();
  const calls: Json[] = [];
  let projectionReady = true;
  const deps: LifecycleDeps = {
    paths: {
      dataDir: root,
      trashDir: join(root, "trash"),
      convDir: join(root, "conversations"),
    },
    conversations: {
      allConvs: () => [],
      load: () => null,
      projectionReady: () => projectionReady,
      noteProjectionStale: () => void (projectionReady = false),
      noteProjectionReady: () => void (projectionReady = true),
      refreshProjection: async () => ({}),
    },
    assertLegacyImported: async () => {},
    nodes: {
      nodeCids: () => [...nodes.keys()].sort(),
      existing: (cid) => nodes.get(cid) ?? null,
      node: (cid) => {
        let found = nodes.get(cid);
        if (found === undefined) nodes.set(cid, (found = new Node()));
        return found;
      },
    },
    reconciler: {
      reconcileScan: () => [],
      reconcile: () => {},
      queueStartupShellNotices: async () => {},
      recoverAtStartup: async () => {},
      watchOnce: async () => {},
    },
    logins: {
      importClaudeCodeLogin: async () => false,
      importCodexCliLogin: async () => false,
    },
    agentTemp: {
      migrateUploads: async () => {},
      reconcileAgentTempStartup: async () => {},
    },
    processes: {
      startupAllowsTempSweep: () => true,
      drainReaps: async () => void calls.push(["drainReaps"]),
      shutdownCleanup: async (grace) =>
        void calls.push(["shutdownCleanup", grace]),
    },
    shells: { retireFinishedRecords: async () => ({}) },
    agentStore: {
      flushAll: async () => void calls.push(["flushAll"]),
      dispose: async () => void calls.push(["dispose"]),
    },
    lease: {
      holderSnapshot: () => ({
        holder_site: "create",
        holder_conversation: "c1",
        holder_held_seconds: 4.5,
      }),
    },
    tasks: new TaskSet(
      ignoringCancelled((name, error) =>
        calls.push(["task_failed", name, String(error)]),
      ),
    ),
    joinTaskSets: [],
    shutdownController: new AbortController(),
    log,
    now: () => NOW,
    monotonic: () => 5,
    sleep: (_seconds, signal) => abortable(Bun.sleep(0), signal),
    ...overrides,
  };
  return { life: new SupervisorLifecycle(deps), deps, nodes, records, calls };
}

test("supervisor_lifecycle: a maintenance job is single-flight and untracks itself", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  expect(h.life.launchMaintenanceJob("a", () => gate)).toBe(true);
  expect(h.life.launchMaintenanceJob("a", async () => {})).toBe(false);
  expect(
    h.life.launchMaintenanceJob("b", async () => {
      throw new RangeError("boom");
    }),
  ).toBe(true);
  expect(h.life.maintenanceJobs().sort()).toEqual(["a", "b"]);
  release();
  await h.life.settleMaintenanceJobs();
  expect(h.life.maintenanceJobs()).toEqual([]);
  expect(events(h.records)).toEqual([
    ["maintenance_job_failed", "ERROR", { job: "b" }],
  ]);
  expect(h.calls).toEqual([]);
  expect(h.life.launchMaintenanceJob("a", async () => {})).toBe(true);
  await h.life.settleMaintenanceJobs();
});

test("supervisor_lifecycle: the shutdown join is bounded and names the lease holder", async () => {
  const stuck = new TaskSet();
  stuck.spawn("create", () => new Promise<void>(() => {}));
  const h = harness({ joinTaskSets: [stuck], shutdownJoinSeconds: 0.05 });
  await h.life.shutdown();

  const timeout = h.records.find((r) =>
    r.message.includes("shutdown_join_timeout"),
  );
  expect(timeout?.message).toBe(
    "event=shutdown_join_timeout bound_seconds=0.050 holder_conversation=c1 holder_held_seconds=4.500 holder_site=create unfinished=1",
  );
});

test("supervisor_lifecycle: store flush and dispose failures log WARNING events", async () => {
  const h = harness();
  h.deps.agentStore.flushAll = async () => false;
  h.deps.agentStore.dispose = async () => {
    throw new Error("dispose");
  };
  await h.life.shutdown();
  const warned = (event: string) =>
    h.records.some((r) => r.level === 30 && r.message.includes(event));
  expect(warned("event=shutdown_store_flush_failed")).toBe(true);
  expect(warned("event=shutdown_store_dispose_failed")).toBe(true);
});

test("supervisor_lifecycle: a process exits by itself after instance shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-exit-"));
  roots.push(root);
  mkdirSync(join(root, "data"));
  const script = join(root, "child.ts");
  const app = join(import.meta.dir, "..", "..", "src", "web", "app.ts");
  writeFileSync(
    script,
    `const { buildApp, WebLogSink } = await import(${JSON.stringify(app)});
      const app = await buildApp({ env: process.env, sink: new WebLogSink() });
      app.instance.agentStore.enqueueMetadata("abc123", { title: "x" });
      await app.instance.shutdown();
      console.log("shutdown returned");`,
  );
  const child = Bun.spawn([process.execPath, script], {
    env: {
      PATH: process.env.PATH!,
      HOME: join(root, "home"),
      RECURSE_HOME: join(root, "settings"),
      CHAT_DATA_DIR: join(root, "data"),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain(
      "shutdown returned",
    );
    const store = new AgentStore(join(root, "data", "agents"));
    expect((await store.loadPersistedAgent("abc123"))[0]).toEqual({
      title: "x",
    });
    await store.dispose();
  } finally {
    child.kill("SIGKILL");
  }
});

test("supervisor_lifecycle: the root task sink ignores Cancelled (PR17 N2)", async () => {
  const failures: string[] = [];
  const tasks = new TaskSet(
    ignoringCancelled((name) => void failures.push(name)),
  );
  const controller = new AbortController();
  controller.abort();
  const late = tasks.spawn("late-report", async () => {}, controller.signal);
  await expect(late).rejects.toBeInstanceOf(Cancelled);
  const failed = tasks.spawn("broken", async () => {
    throw new RangeError("boom");
  });
  await expect(failed).rejects.toBeInstanceOf(RangeError);
  expect(failures).toEqual(["broken"]);
});

test("supervisor_lifecycle: the watcher retires residue before shutdown", async () => {
  const h = harness();
  const { dataDir } = h.deps.paths;
  mkdirSync(join(dataDir, "trash"));
  for (const name of ["inbox", "spawn_requests", "process_registry", "btw"])
    mkdirSync(join(dataDir, name));
  h.deps.sleep = async (_seconds, signal) => {
    await abortable(new Promise(() => {}), signal);
  };
  const watcher = h.life.startWatcher();
  while (
    ["inbox", "spawn_requests", "process_registry", "btw"].some((name) =>
      existsSync(join(dataDir, name)),
    )
  )
    await Bun.sleep(5);
  for (const name of ["inbox", "spawn_requests", "process_registry", "btw"])
    expect(existsSync(join(dataDir, name))).toBe(false);

  await h.life.shutdown();
  await expect(watcher).rejects.toBeInstanceOf(Cancelled);

  expect(events(h.records)).toEqual([
    ["store_import", "INFO", { complete: "1" }],
  ]);
  expect(
    h.records
      .filter((r) => r.message.includes("_retired"))
      .map((r) => r.message),
  ).toEqual([
    "event=file_world_residue_retired count=2",
    "event=process_registry_residue_retired count=1",
    "event=btw_residue_retired count=1",
  ]);
});

test("supervisor_lifecycle: a driver still writing after the join timeout lands whole rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-store-"));
  roots.push(dir);
  const store = new AgentStore(dir);
  const cid = "a".repeat(32);
  store.enqueueMetadata(cid, { turn: 0, text: "before" });
  expect(await store.flush(cid)).toBe(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stuck = new TaskSet();
  const late = stuck.spawn("stuck-driver", async () => {
    await gate;
    for (let turn = 1; turn <= 20; turn++)
      store.enqueueMetadata(cid, { turn, text: "x".repeat(4096 * turn) });
  });
  const h = harness({
    joinTaskSets: [stuck],
    shutdownJoinSeconds: 0.05,
    agentStore: {
      flushAll: async () => {
        release();
        await Bun.sleep(0);
        return await store.flushAll();
      },
      dispose: async () => true,
    },
  });
  await h.life.shutdown();
  expect(
    h.records.some((r) => r.message.includes("shutdown_join_timeout")),
  ).toBe(true);
  await late;
  const seen = (await store.loadPersistedAgent(cid))[0] as {
    turn: number;
    text: string;
  };
  expect(
    seen.text === "before" || seen.text === "x".repeat(4096 * seen.turn),
  ).toBe(true);
  expect(await store.close(cid)).toBe(true);
  expect(() => store.enqueueMetadata(cid, { turn: 99 })).toThrow();
  expect((await store.loadPersistedAgent(cid))[0]).toEqual({
    turn: 20,
    text: "x".repeat(4096 * 20),
  });
  await store.dispose();
});

test("supervisor_lifecycle: a job aborted before its first step still untracks", async () => {
  const h = harness();
  h.deps.shutdownController.abort(new Cancelled("shutdown"));
  let ran = false;
  expect(
    h.life.launchMaintenanceJob("early", async () => void (ran = true)),
  ).toBe(true);
  await h.life.settleMaintenanceJobs();
  expect(ran).toBe(false);
  expect(h.life.maintenanceJobs()).toEqual([]);
});

// Regression: #2778 Startup opens yield between phases and do not wait on their own focused join.
test("a focused open pauses startup before its next storage phase, including a same-agent join", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-priority-"));
  roots.push(root);
  const { host, records, work } = fauxHost(root);
  delete records.c1;
  for (const cid of ["b0", "b1", "b2", "b3", "focus"])
    records[cid] = { id: cid, backend: "durable", workdir: work };
  records.side = {
    id: "side",
    backend: "durable",
    workdir: work,
    side_of: "b0",
  };
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const deps = (host as unknown as { deps: DurableHostDeps }).deps;
  const agentEnv = deps.agentEnv;
  deps.agentEnv = async (conv, timing) => {
    if (conv.id === "b0") {
      started.resolve();
      await gate.promise;
    }
    return agentEnv(conv, timing);
  };
  const order: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const original = SqliteWorker.prototype.openDatabase;
  // test-check-allow: T3 Queues real database opens to expose focus ordering.
  const spy = spyOn(SqliteWorker.prototype, "openDatabase").mockImplementation(
    function (this: SqliteWorker, path, refused) {
      const cid = path.split("/conversations/")[1]!.split("/")[0]!;
      order.push(cid);
      const turn = queue.then(async () => {
        return original.call(this, path, refused);
      });
      queue = turn.catch(() => undefined);
      return turn;
    },
  );
  try {
    const background = host.openLive();
    await started.promise;

    const focus = host.open("focus");
    const joined = host.open("b0");
    const side = host.open("side").then(
      () => "",
      (error) => String(error),
    );
    gate.resolve();
    await focus;
    order.push("focus ready");
    await Promise.all([background, joined]);
    expect(await side).toContain(
      "the main conversation has nothing to fork yet",
    );
    expect(order).toEqual(["focus", "focus ready", "b0", "b1", "b2", "b3"]);
  } finally {
    gate.resolve();
    spy.mockRestore();
    await host.close();
  }
});

test("a focused open that never finishes delays background opens by one bounded wait, which is logged", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-focus-hang-"));
  roots.push(root);
  const { host, records, work } = fauxHost(root, undefined, false, 200);
  delete records.c1;
  for (const cid of ["b0", "b1", "focus"])
    records[cid] = { id: cid, backend: "durable", workdir: work };
  const hang = Promise.withResolvers<void>(),
    focusStarted = Promise.withResolvers<void>();
  const opened: string[] = [];
  const original = SqliteWorker.prototype.openDatabase;
  // test-check-allow: T3 Gates real database opens to expose native timeout.
  const spy = spyOn(SqliteWorker.prototype, "openDatabase").mockImplementation(
    async function (this: SqliteWorker, path) {
      const cid = path.startsWith(`${root}/conversations/`)
        ? path.split("/conversations/")[1]!.split("/")[0]!
        : null;
      if (cid) opened.push(cid);
      if (cid === "focus") {
        focusStarted.resolve();
        await hang.promise;
      }
      return original.call(this, path);
    },
  );
  const deps = (host as unknown as { deps: Pick<DurableHostDeps, "log"> }).deps;
  // test-check-allow: T3 Call-through observer of real bounded-wait warnings.
  const log = spyOn(deps, "log");
  try {
    const focus = host.open("focus");
    await focusStarted.promise;
    const background = host.openLive();
    const warned = () =>
      log.mock.calls.filter(
        ([event]) => event === "durable_focus_wait_bounded",
      );
    await until(() => opened.includes("b1") && warned().length === 2);
    expect(opened).toEqual(["focus", "b0", "b1"]);
    for (const [, fields, level] of warned()) {
      expect(fields.cids).toBe("focus");
      expect(level).toBe(30);
      expect(fields.waited_ms).toBeGreaterThanOrEqual(199);
    }
    hang.resolve();
    await focus;
    await background;
  } finally {
    hang.resolve();
    spy.mockRestore();
    log.mockRestore();
    await host.close();
  }
}, 30_000);

test("a tool ignoring abort cannot hold shutdown; the existing lock still excludes replacement storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-budget-"));
  roots.push(root);
  const savedFd = process.env[LOCK_FD_ENV];
  const lock = await acquireSupervisorLock(root);
  const { host, faux } = fauxHost(root);
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    lateReady = Promise.withResolvers<void>(),
    lateGate = Promise.withResolvers<void>(),
    cleanupReached = Promise.withResolvers<void>(),
    cleanupGate = Promise.withResolvers<void>();

  let unscan = () => {};
  let toolSignal: AbortSignal | undefined;
  const original = DurableHarness.open;
  // test-check-allow: T3 Installs a stuck tool, then opens the real Harness.
  const spy = spyOn(DurableHarness, "open").mockImplementation(
    (storage, options, ctx) => {
      (options.registry as unknown as Registry).install(
        defineExtension({
          name: "non-cooperative",
          hooks: [
            hook(ToolTask, {
              beforeTool: async (call) => {
                if (
                  call.name === "bash" &&
                  call.arguments.command === "sleep 0.1"
                ) {
                  lateReady.resolve();
                  await lateGate.promise;
                }
                return undefined;
              },
            }),
          ],
          tools: [
            defineTool({
              name: "stuck",
              description: "Test-only pending read",
              parameters: Type.Object({}),
              execute: async (_args, _api, ctx) => {
                toolSignal = ctx.abortSignal;
                started.resolve();
                await release.promise;
                return { output: [{ type: "text", text: "released" }] };
              },
            }),
          ],
        }),
      );
      return original.call(DurableHarness, storage, options, ctx);
    },
  );
  const probe = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/durable_host/lock_probe.ts"),
        root,
      ],
      {
        env: { ...process.env, [LOCK_FD_ENV]: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    };
  };
  try {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "sleep 300", background: true }),
          fauxToolCall("bash", {
            command: "sleep 0.1",
            background: true,
          }),
          fauxToolCall("stuck", {}),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    await host.send("c1", "wait", "r1");
    await started.promise;
    const opened = await host.open("c1");
    let pgid: number | undefined;
    for (let attempt = 0; attempt < 100 && pgid === undefined; attempt++) {
      const shell = (await opened.harness.inspect(context)).tasks.find(
        ({ record }) => record.kind === "recurse.shell",
      );
      pgid = (shell?.record.input as { pgid?: number } | undefined)?.pgid;
      if (pgid === undefined) await Bun.sleep(10);
    }
    expect(pgid).toBeDefined();
    const members = () =>
      readdirSync("/proc").filter((pid) => {
        if (!/^\d+$/.test(pid)) return false;
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return fields[0] !== "Z" && Number(fields[2]) === pgid;
        } catch {
          return false;
        }
      });
    expect(members().length).toBeGreaterThan(0);
    await lateReady.promise;
    const originalInspect = opened.harness.inspect;
    // test-check-allow: T3 Delays real inspection during native shutdown.
    const scan = spyOn(opened.harness, "inspect").mockImplementation(
      async (ctx) => {
        const snapshot = await originalInspect.call(opened.harness, ctx);
        cleanupReached.resolve();
        await cleanupGate.promise;
        return snapshot;
      },
    );
    unscan = () => scan.mockRestore();
    const h = harness({ durable: host, shutdownJoinSeconds: 0.05 });
    await h.life.shutdown();

    expect(
      h.records.some((record) =>
        record.message.includes("shutdown_join_timeout"),
      ),
    ).toBe(true);
    await cleanupReached.promise;
    await opened.shells.shutdown();
    expect(members()).toEqual([]);
    lateGate.resolve();
    let messages = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      messages = JSON.stringify(
        (await opened.conversation.context(context)).messages,
      );
      if (messages.includes("Shells are shutting down")) break;
      await Bun.sleep(10);
    }
    expect(messages).toContain(
      "Shells are shutting down; no new commands can start.",
    );

    cleanupGate.resolve();
    unscan();
    for (let attempt = 0; attempt < 150 && !toolSignal?.aborted; attempt++)
      await Bun.sleep(10);
    expect(toolSignal?.aborted).toBe(true);
    const denied = await probe();
    expect(denied.code).toBe(23);
    expect(denied.error).toContain("another live Recurse server");
    expect(denied.out).not.toContain("storage opened");
    release.resolve();
    await host.close();
    lock.close();
    spy.mockRestore();
    expect((await probe()).out).toContain("storage opened");
  } finally {
    lateGate.resolve();
    cleanupGate.resolve();
    release.resolve();
    unscan();
    spy.mockRestore();

    await host.close();
    lock.close();
    if (savedFd === undefined) delete process.env[LOCK_FD_ENV];
    else process.env[LOCK_FD_ENV] = savedFd;
  }
}, 30_000);
