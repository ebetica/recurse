// Gate startup mutations before awaits; scan projection, then reconcile.
// Ticks launch single-flight disk jobs; slow logs measure wall time, not CPU.
// Shutdown joins with bounds and sweeps groups despite failures.
// Dispose the store after bounded HTTP drain; retry state stays durable.
import { mkdir } from "node:fs/promises";
import { backgroundWork } from "../../observability/request_timing";
import { join } from "node:path";
import {
  ERROR,
  INFO,
  WARNING,
  logEvent,
  logException,
  type RuntimeLogger,
} from "../../observability/runtime_logging";
import { STOP_GRACE_MS } from "../../process_lifecycle";
import { HTTP_DRAIN_SECONDS } from "../../shutdown_budget";
import { retireAll } from "../../utils/trash";
import { Cancelled, checkAbort, type TaskSet } from "../../utils/tasks";
import type { ConversationRecord } from "../conversation_store";
import { fenced, type HolderSnapshot } from "../mutation_guard";

type Json = Record<string, unknown>;

/** Pre-log file-world queue directories, retired once at watcher startup. */
export const LEGACY_FILE_WORLD_DIRS = [
  "inbox",
  "model_requests",
  "mute_requests",
  "reap_requests",
  "rename_requests",
  "reparent_requests",
  "safety_requests",
  "spawn_requests",
];
/** The pre-migration on-disk process registry, retired once at startup. */
export const PROCESS_REGISTRY_RESIDUE_DIR = "process_registry";
/** The BTW side-question store that side conversations replaced. */
export const BTW_RESIDUE_DIR = "btw";
/** A tight local tick picks up queued sends near-instantly. */
export const WATCH_INTERVAL = 0.2;
/** Upper bound on the shutdown join. */
export const SHUTDOWN_JOIN_SECONDS = 3.0;
/** process_lifecycle.STOP_GRACE, in milliseconds. */
export const SHUTDOWN_STOP_GRACE_MS = STOP_GRACE_MS;

export interface LifecycleNode {
  readonly turnTask: Promise<void> | null;
  pendingIntents(): Json[];
  cancelDrive(): Promise<void> | null;
}

export interface LifecycleDeps {
  paths: { dataDir: string; trashDir: string; convDir: string };
  conversations: {
    allConvs(options?: { withPending?: boolean }): ConversationRecord[];
    load(
      cid: string,
      options?: { withPending?: boolean },
    ): ConversationRecord | null;
    projectionReady(): boolean;
    noteProjectionStale(): void;
    noteProjectionReady(): void;
    refreshProjection(): Promise<unknown>;
  };
  /** conversation_store.assertNoUnimportedLegacyState over the data dir. */
  assertLegacyImported(): Promise<void>;
  nodes: {
    nodeCids(): string[];
    existing(cid: string): LifecycleNode | null;
    node(cid: string): LifecycleNode;
  };
  /** Durable conversations (src/agents/durable/host.ts). */
  durable?: {
    runningCount(): number;
    /** Open every live Durable conversation so interrupted work resumes. */
    openLive(): Promise<void>;
    close(): Promise<void>;
  };
  // Automatic imports run detached, under the existing maintenance lifetime.
  switchover?: { run(signal: AbortSignal): Promise<void> };
  reconciler: {
    reconcileScan(options: {
      pendingCids?: Set<string> | null;
    }): ConversationRecord[];
    reconcile(options: {
      pendingCids?: Set<string> | null;
      convs?: ConversationRecord[] | null;
    }): void;
    queueStartupShellNotices(
      convs: ConversationRecord[],
      signal?: AbortSignal,
    ): Promise<void>;
    recoverAtStartup(signal?: AbortSignal): Promise<void>;
    watchOnce(signal?: AbortSignal): Promise<void>;
  };
  /** auth.anthropic.import_claude_code_login / codex.import_codex_cli_login. */
  logins: {
    importClaudeCodeLogin(): Promise<unknown>;
    importCodexCliLogin(): Promise<unknown>;
  };
  agentTemp: {
    migrateUploads(): Promise<void>;
    reconcileAgentTempStartup(options: {
      sweepOrphans?: boolean;
    }): Promise<void>;
  };
  processes: {
    startupAllowsTempSweep(): boolean;
    drainReaps(): Promise<void>;
    shutdownCleanup(graceMs: number): Promise<unknown>;
  };
  shells: { retireFinishedRecords(): Promise<unknown> };
  agentStore: {
    flushAll(): Promise<unknown>;
    dispose(): Promise<unknown>;
  };
  /** The lifecycle lease, for the shutdown holder log. */
  lease: { holderSnapshot(): HolderSnapshot };

  tasks: TaskSet;
  /** Other task sets shutdown joins (create transactions, reports). */
  joinTaskSets: readonly TaskSet[];
  /** The instance shutdown controller; shutdown aborts it first. */
  shutdownController: AbortController;
  log: RuntimeLogger;
  /** time.time(), seconds. */
  now(): number;
  /** time.monotonic(), seconds. */
  monotonic(): number;
  /** Abortable sleep in seconds. */
  sleep(seconds: number, signal: AbortSignal): Promise<void>;
  /** Tests only: the shutdown join bound in seconds. */
  shutdownJoinSeconds?: number;
  /** Tests only: the longest wait for the HTTP drain, in seconds. */
  shutdownDrainSeconds?: number;
}

export interface Readiness {
  ready: boolean;
  active_agents: number | null;
}

/** Python str() for a marker's last intent id. */
function markerId(value: unknown): string {
  if (value === undefined || value === null) return "None";
  return typeof value === "string" ? value : String(value);
}

function rethrowCancelled(error: unknown): void {
  if (error instanceof Cancelled) throw error;
}

export class SupervisorLifecycle {
  /** Set once shutdown starts. */
  shuttingDown = false;
  /** Whether required legacy-state import finished; needed for readiness. */
  importFinal: boolean | null = null;
  /** The last inbox marker seen, per conversation. */
  readonly inboxSeen = new Map<string, string>();
  private watcherTask: Promise<void> | null = null;
  private inboxBaselined = false;
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(private readonly deps: LifecycleDeps) {}

  /** The instance shutdown signal. */
  get signal(): AbortSignal {
    return this.deps.shutdownController.signal;
  }

  /** Create the local conversation root. */
  async ensureStorageReady(): Promise<void> {
    await mkdir(this.deps.paths.convDir, { recursive: true });
  }

  /** Live conversations with a running turn. O(live), read-only. */
  activeAgentCount(): number {
    return this.deps.durable?.runningCount() ?? 0;
  }

  /** Ready for agent actions, plus the live activity count. */
  readinessSnapshot(): Readiness {
    if (this.importFinal !== true || !this.deps.conversations.projectionReady())
      return { ready: false, active_agents: null };
    return { ready: true, active_agents: this.activeAgentCount() };
  }

  private retireResidue(names: string[], event: string): number {
    const { dataDir, trashDir } = this.deps.paths;
    const retired = retireAll(
      names.map((name) => join(dataDir, name)),
      trashDir,
      (error) =>
        logException(this.deps.log, `${event}_retire_failed`, error, {
          level: WARNING,
        }),
    );
    if (retired)
      logEvent(this.deps.log, INFO, `${event}_retired`, {
        fields: { count: retired },
      });
    return retired;
  }

  /** Retire pre-log file-world residue through the trash; return the count. */
  retireFileWorldResidue(): number {
    return this.retireResidue(LEGACY_FILE_WORLD_DIRS, "file_world_residue");
  }

  /** Retire the pre-migration on-disk process registry; return the count. */
  retireProcessRegistryResidue(): number {
    return this.retireResidue(
      [PROCESS_REGISTRY_RESIDUE_DIR],
      "process_registry_residue",
    );
  }

  /** Retire the BTW side-question store; return the count. */
  retireBtwResidue(): number {
    return this.retireResidue([BTW_RESIDUE_DIR], "btw_residue");
  }

  /**
   * Start `run` as a detached job unless one of that name still runs.
   * Returns whether a job started. A failure is logged and contained.
   */
  launchMaintenanceJob(
    name: string,
    run: (signal: AbortSignal) => Promise<unknown>,
  ): boolean {
    if (this.shuttingDown || this.jobs.has(name)) return false;
    const untrack = () => {
      if (this.jobs.get(name) === task) this.jobs.delete(name);
    };
    const task: Promise<void> = this.deps.tasks.spawn(
      `maintenance:${name}`,
      async (signal) => {
        const started = this.deps.monotonic();
        try {
          await backgroundWork(name, () => run(signal));
        } catch (error) {
          rethrowCancelled(error);
          logException(this.deps.log, "maintenance_job_failed", error, {
            fields: { job: name },
          });
        } finally {
          untrack();
          const elapsedMs = (this.deps.monotonic() - started) * 1000;
          if (elapsedMs > 250)
            logEvent(this.deps.log, WARNING, "maintenance_job_slow", {
              fields: { job: name, elapsed_ms: Math.round(elapsedMs) },
            });
        }
      },
      this.signal,
    );
    this.jobs.set(name, task);
    // Invariant: A job aborted before its first step never reaches its own
    // finally.
    task.then(untrack, untrack);
    return true;
  }

  /** The names of running maintenance jobs (tests). */
  maintenanceJobs(): string[] {
    return [...this.jobs.keys()];
  }

  /** Await every launched maintenance job (tests and shutdown). */
  async settleMaintenanceJobs(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs.values()]);
  }

  /** Conversations due one reconciliation peek for new un-driven work. */
  dirtyInboxSnapshot(): Map<string, string> {
    const snapshot = new Map<string, string>();
    for (const cid of this.deps.nodes.nodeCids()) {
      const found = this.deps.nodes.existing(cid);
      const entries = found !== null ? found.pendingIntents() : [];
      const last = entries.at(-1);
      const marker = `rt:${entries.length}:${entries.length ? markerId(last?.id) : "-"}`;
      if (this.inboxSeen.get(cid) !== marker) snapshot.set(cid, marker);
    }
    return snapshot;
  }

  private owned(cid: string): boolean {
    return this.deps.nodes.node(cid).turnTask !== null;
  }

  /** Drive dirty queues; refresh warm/shell candidates from memory. */
  async reconcileWatcherInboxes(signal?: AbortSignal): Promise<void> {
    const { deps } = this;
    const snapshot = this.dirtyInboxSnapshot();
    // Invariant: Ownership before reconciliation: a task that finishes during
    // it is no proof that it consumed the row, so this tick keeps the
    // generation.
    const ownedBefore = new Set(
      [...snapshot.keys()].filter((cid) => this.owned(cid)),
    );
    const startup = !this.inboxBaselined;
    const pendingCids = new Set(snapshot.keys());
    const scanned = deps.reconciler.reconcileScan({ pendingCids });
    const pool = startup
      ? deps.conversations.allConvs({ withPending: false })
      : scanned;
    deps.reconciler.reconcile({ pendingCids, convs: scanned });
    if (startup) {
      await deps.reconciler.queueStartupShellNotices(pool, signal);
      if (signal) checkAbort(signal);
    }
    this.inboxBaselined = true;
    for (const [cid, generation] of snapshot)
      if (!ownedBefore.has(cid) && !this.owned(cid))
        this.inboxSeen.set(cid, generation);
    // Invariant: Named difference: reap does not pop the marker, so drop gone
    // nodes.
    if (this.inboxSeen.size > snapshot.size) {
      const live = new Set(deps.nodes.nodeCids());
      for (const cid of [...this.inboxSeen.keys()])
        if (!live.has(cid)) this.inboxSeen.delete(cid);
    }
  }

  /** Start the watcher as a detached task under the shutdown signal. */
  startWatcher(): Promise<void> {
    if (this.watcherTask === null) {
      // Invariant: Before the task's first microtask, so start()'s caller
      // already sees it.
      this.openLoadWindow();
      this.watcherTask = this.deps.tasks.spawn(
        "watcher",
        (signal) => this.watcher(signal),
        this.signal,
      );
    }
    return this.watcherTask;
  }

  // Close mutation gates before the first startup await. Open only after
  // projection scan, scratch repair and orphan sweep, so creates cannot race
  // it.
  private openLoadWindow(): void {
    this.importFinal = false;
    this.deps.conversations.noteProjectionStale();
  }

  /** The startup sequence, then the reconcile tick forever. */
  async watcher(signal: AbortSignal): Promise<void> {
    const { deps } = this;
    const { log, conversations } = deps;
    const step = async <T>(
      name: string,
      work: () => Promise<T>,
    ): Promise<T> => {
      const started = deps.monotonic();
      try {
        return await backgroundWork(`startup_${name}`, work);
      } finally {
        logEvent(log, INFO, "startup_readiness_step", {
          fields: {
            step: name,
            elapsed_ms: Math.round((deps.monotonic() - started) * 1000),
          },
        });
      }
    };
    this.openLoadWindow();
    for (const [importLogin, event] of [
      [
        () => deps.logins.importClaudeCodeLogin(),
        "claude_code_login_import_failed",
      ],
      [
        () => deps.logins.importCodexCliLogin(),
        "codex_cli_login_import_failed",
      ],
    ] as const) {
      try {
        await step(event.replace("_failed", ""), importLogin);
      } catch (error) {
        rethrowCancelled(error);
        logException(log, event, error, { level: WARNING });
      }
      checkAbort(signal);
    }
    this.retireFileWorldResidue();
    checkAbort(signal);
    this.retireProcessRegistryResidue();
    checkAbort(signal);
    this.retireBtwResidue();
    checkAbort(signal);
    try {
      await step("store_import", () => deps.assertLegacyImported());
    } catch (error) {
      rethrowCancelled(error);
      checkAbort(signal);
      logException(log, "store_import_failed", error, { level: WARNING });
      logEvent(log, INFO, "store_import", { fields: { complete: 0 } });
      logEvent(log, ERROR, "store_import_incomplete_no_marker", {
        fields: { complete: 0 },
      });
      return;
    }
    checkAbort(signal);
    this.importFinal = true;
    logEvent(log, INFO, "store_import", { fields: { complete: 1 } });
    const established = await step("projection", () =>
      conversations.refreshProjection(),
    );
    checkAbort(signal);
    if (established === null || established === undefined) {
      logEvent(log, ERROR, "projection_unestablished_no_mutations");
      return;
    }
    await step("migrate_agent_files", () =>
      fenced(() => deps.agentTemp.migrateUploads()),
    );
    checkAbort(signal);
    try {
      await step("agent_temp", () =>
        fenced(() =>
          deps.agentTemp.reconcileAgentTempStartup({
            sweepOrphans: deps.processes.startupAllowsTempSweep(),
          }),
        ),
      );
    } catch (error) {
      rethrowCancelled(error);
      logException(log, "reconcile_agent_temp_startup_failed", error);
    }
    checkAbort(signal);
    conversations.noteProjectionReady();
    this.launchMaintenanceJob("shell_records_startup", () =>
      deps.shells.retireFinishedRecords(),
    );
    await step("recover", () => deps.reconciler.recoverAtStartup(signal));
    // Invariant: Needs the loaded projection; a request opens its own at once.
    const durable = deps.durable;
    if (durable)
      this.launchMaintenanceJob("durable_open_live", () => durable.openLive());
    for (;;) {
      await deps.reconciler.watchOnce(signal);
      if (deps.switchover)
        this.launchMaintenanceJob("pi_switchover", (s) =>
          deps.switchover!.run(s),
        );
      await deps.sleep(WATCH_INTERVAL, signal);
    }
  }

  // Cancel/join all instance tasks within bounds, close runtimes and sweep
  // groups.
  // After bounded HTTP drain, flush/dispose the store for late writes.
  // Never throw; failures log, unacked intents remain for startup. Idempotent.
  async shutdown(drained: Promise<unknown> = Promise.resolve()): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const { deps } = this;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainEnded = Promise.race([
      drained.catch(() => undefined),
      new Promise<void>((resolve) => {
        const seconds = deps.shutdownDrainSeconds ?? HTTP_DRAIN_SECONDS;
        drainTimer = setTimeout(resolve, seconds * 1000);
      }),
    ]);
    const storeStep = async (event: string, step: () => Promise<unknown>) => {
      try {
        if ((await step()) === false)
          logEvent(deps.log, WARNING, event, { fields: { clean: false } });
      } catch (error) {
        logException(deps.log, event, error, { level: WARNING });
      }
    };
    const tasks: Promise<unknown>[] = [];
    if (this.watcherTask !== null) tasks.push(this.watcherTask);
    tasks.push(...this.jobs.values());
    const quietly = async (fn: () => unknown) => {
      try {
        await fn();
      } catch {
        // Invariant: shutdown() must never fail; each runner left resumable
        // state.
      }
    };
    // Invariant: The cancel phase stays synchronous: every abort lands before
    // any aborted task resumes.
    const guarded = (fn: () => void) => {
      try {
        fn();
      } catch {
        // Invariant: One failed cancel must not skip the closers below.
      }
    };
    guarded(() => deps.shutdownController.abort(new Cancelled("shutdown")));
    let cids: string[] = [];
    guarded(() => void (cids = deps.nodes.nodeCids()));
    for (const cid of cids)
      guarded(() => {
        const task = deps.nodes.existing(cid)?.cancelDrive() ?? null;
        if (task !== null) tasks.push(task);
      });
    for (const set of deps.joinTaskSets)
      guarded(() => void tasks.push(set.drain()));
    // Invariant: Durable Harnesses close inside the same bound: a run that
    // ignores its abort cannot hold up the closers below.
    const durable = deps.durable;
    if (durable) guarded(() => void tasks.push(durable.close()));
    await quietly(() => this.boundedJoin(tasks));
    await storeStep("shutdown_store_flush_failed", () =>
      deps.agentStore.flushAll(),
    );
    await quietly(async () => {
      await deps.processes.drainReaps();
      await deps.processes.shutdownCleanup(SHUTDOWN_STOP_GRACE_MS);
    });
    await drainEnded;
    clearTimeout(drainTimer);
    await storeStep("shutdown_store_dispose_failed", () =>
      deps.agentStore.dispose(),
    );
  }

  private async boundedJoin(tasks: Promise<unknown>[]): Promise<void> {
    let unfinished = tasks.length;
    const settled = Promise.allSettled(
      tasks.map((task) =>
        task.then(
          () => void (unfinished -= 1),
          () => void (unfinished -= 1),
        ),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      timer = setTimeout(
        () => resolve("timeout"),
        (this.deps.shutdownJoinSeconds ?? SHUTDOWN_JOIN_SECONDS) * 1000,
      );
    });
    const outcome = await Promise.race([settled, bound]);
    clearTimeout(timer);
    if (outcome === "timeout")
      logEvent(this.deps.log, WARNING, "shutdown_join_timeout", {
        fields: {
          unfinished,
          bound_seconds: this.deps.shutdownJoinSeconds ?? SHUTDOWN_JOIN_SECONDS,
          ...this.deps.lease.holderSnapshot(),
        },
      });
  }
}
