// Supervise crashes with capped backoff; HEAD-watch never fetches. Defer under
// Git operations; build/validate while the old generation serves. Settings'
// IPC update request runs install.sh --update first. At zero active turns, stop
// old server groups before re-exec; exit keeps the lock until cleanup is done.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCurrentGeneration } from "./build";
import { gitOperationInProgress, headSha, prepareCodeSource } from "./git";
import {
  execUpdatedSupervisor,
  prepareUpdateRuntime,
  reconcileServerProcesses,
  spawnServer,
  terminate,
  type ServerChild,
} from "./server_process";
import { inheritedLockFd } from "./lock";
import { logError, monotonic, say, type RunResult } from "./system";
import { runInstallScript, scriptOutput, type UpdateReport } from "./update";

export const HEAD_POLL_DEFAULT = 60;
export const LOOP_INTERVAL = 0.2;
export const BACKOFF_START = 1;
export const BACKOFF_MAX = 30;
export const HEALTHY_UPTIME = 30;
export const LOOP_ERROR_BACKOFF = 1;
export const QUIESCENCE_NOTICE = 30;
export const STATUS_TIMEOUT = 2;
export const UPDATE_TIMEOUT = 600;

export interface Stopping {
  flag: boolean;
}

export type AppStatus = [ready: boolean | null, activeAgents: number | null];

const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

async function getJson(port: number, token: string): Promise<unknown> {
  if (/[\u0000\r\n]/.test(token)) throw new Error("invalid loopback token");

  // Invariant: Preserve operator NO_PROXY entries and add loopback, keeping
  // probe credentials away from HTTP(S)_PROXY. Probes run serially so scoped
  // process-env changes cannot overlap.
  const upper = process.env.NO_PROXY;
  const lower = process.env.no_proxy;
  const append = (value: string | undefined) =>
    [value, LOOPBACK_NO_PROXY].filter(Boolean).join(",");
  process.env.NO_PROXY = append(upper);
  process.env.no_proxy = append(lower);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { "x-loopback-token": token },
      redirect: "error",
      signal: AbortSignal.timeout(STATUS_TIMEOUT * 1000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    if (upper === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = upper;
    if (lower === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = lower;
  }
}

// Probe readiness/activity over authenticated loopback. Any missing auth,
// timeout, HTTP/redirect or malformed response means unknown, never idle.
export async function queryAppStatus(
  port: number,
  dataDir: string,
): Promise<AppStatus> {
  let token: string;
  try {
    const record = JSON.parse(
      await readFile(join(dataDir, "server.json"), "utf8"),
    );
    token = String(record?.token || "");
  } catch {
    return [null, null];
  }
  if (!token) return [null, null];
  let body: unknown;
  try {
    body = await getJson(port, token);
  } catch {
    return [null, null];
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return [null, null];
  const { ready, active_agents: active } = body as Record<string, unknown>;
  if (typeof ready !== "boolean") return [null, null];
  if (active === undefined || active === null) return [ready, null];
  if (typeof active !== "number" || !Number.isSafeInteger(active) || active < 0)
    return [null, null];
  return [ready, active];
}

// Deferred restarts pass when idle or their wait cap expires.
// Supervisor re-exec additionally requires known zero active turns.
export async function reloadGate(
  dataDir: string,
  port: number,
  pendingSince: number,
  cap: number,
  now: number = monotonic(),
  query: typeof queryAppStatus = queryAppStatus,
): Promise<[ready: boolean, inflight: number | null]> {
  const [, inflight] = await query(port, dataDir);
  return [inflight === 0 || now - pendingSince >= cap, inflight];
}

export interface Clock {
  readonly monotonic: () => number;
  readonly sleep: (seconds: number) => Promise<void>;
}

const REAL_CLOCK: Clock = {
  monotonic,
  sleep: (seconds) => Bun.sleep(seconds * 1000),
};

/** Sleep in short slices; true when a stop was requested meanwhile. */
export async function sleepInterruptible(
  seconds: number,
  stopping: Stopping,
  clock: Clock = REAL_CLOCK,
): Promise<boolean> {
  const deadline = clock.monotonic() + seconds;
  while (clock.monotonic() < deadline) {
    if (stopping.flag) return true;
    // Invariant: Clamp: the clock can pass the deadline between the check and
    // here.
    await clock.sleep(Math.max(0, Math.min(0.2, deadline - clock.monotonic())));
  }
  return stopping.flag;
}

export interface SupervisorDeps {
  prepareCodeSource: (dataDir: string) => Promise<[string, boolean]>;
  buildCurrentGeneration: (
    codeDir: string,
    options: { managedReady: boolean },
  ) => Promise<boolean>;
  spawnServer: (
    codeDir: string,
    host: string,
    port: number,
    dataDir: string,
    browserVersion: string | null,
    onMessage: (message: unknown) => void,
  ) => Promise<ServerChild>;
  terminate: (child: ServerChild, codeDir: string) => Promise<boolean>;
  reconcile: (codeDir: string) => Promise<boolean>;
  reloadGate: typeof reloadGate;
  headSha: (codeDir: string) => Promise<string | null>;
  gitOperationInProgress: (codeDir: string) => Promise<boolean>;
  prepareUpdateRuntime: (codeDir: string, sha: string) => Promise<boolean>;
  execUpdatedSupervisor: (codeDir: string, sha: string) => Promise<boolean>;
  /** Run the checkout's install.sh --update; `signal` stops its group. */
  runUpdate: (codeDir: string, signal: AbortSignal) => Promise<RunResult>;
  sleepInterruptible: (seconds: number, stopping: Stopping) => Promise<boolean>;
  sleep: (seconds: number) => Promise<void>;
  monotonic: () => number;
  /** Route SIGINT/SIGTERM to `stop`; returns the uninstaller. */
  onStopSignals: (stop: () => void) => () => void;
}

export function supervisorDeps(): SupervisorDeps {
  return {
    prepareCodeSource: (dataDir) => prepareCodeSource(dataDir),
    buildCurrentGeneration: (codeDir, options) =>
      buildCurrentGeneration(codeDir, options),
    spawnServer: (codeDir, host, port, dataDir, version, onMessage) =>
      spawnServer(codeDir, host, port, dataDir, version, {
        lockFd: inheritedLockFd(dataDir),
        onMessage,
      }),
    terminate: (child, codeDir) => terminate(child, codeDir),
    reconcile: (codeDir) => reconcileServerProcesses(codeDir),
    reloadGate,
    headSha: (codeDir) => headSha(codeDir),
    gitOperationInProgress: (codeDir) => gitOperationInProgress(codeDir),
    prepareUpdateRuntime: (codeDir, sha) => prepareUpdateRuntime(codeDir, sha),
    execUpdatedSupervisor: (codeDir, sha) =>
      execUpdatedSupervisor(codeDir, sha),
    runUpdate: (codeDir, signal) =>
      runInstallScript(codeDir, "--update", UPDATE_TIMEOUT, signal),
    sleepInterruptible: (seconds, stopping) =>
      sleepInterruptible(seconds, stopping),
    sleep: (seconds) => Bun.sleep(seconds * 1000),
    monotonic,
    onStopSignals(stop) {
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      };
    },
  };
}

/** Supervise one server and redeploy only when the checkout HEAD moves. */
export class Supervisor {
  codeDir = "";
  headWatch = false;
  poll = HEAD_POLL_DEFAULT;
  readonly stopping: Stopping = { flag: false };
  child!: ServerChild;
  watchedSha: string | null = null;
  browserVersion: string | null = null;
  started = 0;
  backoff = BACKOFF_START;
  nextCheck = 0;
  pendingReexecSha: string | null = null;
  pendingSince: number | null = null;
  lastWaitNotice = -Infinity;
  /** The running install.sh --update; HEAD is not watched meanwhile. */
  updating: Promise<void> | null = null;
  private readonly stopUpdate = new AbortController();
  /** The last update progress sent to the server, resent after a respawn. */
  lastReport: UpdateReport | null = null;
  private uninstallSignals: () => void = () => {};

  constructor(
    readonly host: string,
    readonly port: number,
    readonly dataDir: string,
    readonly deps: SupervisorDeps = supervisorDeps(),
  ) {}

  /** Prepare the working area and build, then start the first child. */
  async start(): Promise<void> {
    const deps = this.deps;
    say("recurse: preparing working repo (first run may clone)…");
    [this.codeDir, this.headWatch] = await deps.prepareCodeSource(this.dataDir);
    const configured = Number(
      process.env.RECURSE_UPDATE_POLL_SECONDS ?? HEAD_POLL_DEFAULT,
    );
    if (Number.isNaN(configured))
      throw new Error("RECURSE_UPDATE_POLL_SECONDS must be a number");
    this.poll = Math.max(0.2, configured);
    this.uninstallSignals = deps.onStopSignals(() => {
      this.stopping.flag = true;
    });
    const managedReady = process.env.RECURSE_MANAGED_BUILD_READY === "1";
    delete process.env.RECURSE_MANAGED_BUILD_READY;
    if (!(await deps.buildCurrentGeneration(this.codeDir, { managedReady }))) {
      this.uninstallSignals();
      throw new Error("the current source generation could not be built");
    }
    this.watchedSha = await deps.headSha(this.codeDir);
    this.browserVersion = this.watchedSha?.slice(0, 16) ?? null;
    say(
      `recurse supervisor (local backend) → http://${this.host}:${this.port}`,
    );
    say("  application checkout configured");
    say("  state directory configured");
    say("  agents' repository configured");
    if (this.headWatch)
      say(
        `  self-deploy: checking the checkout's HEAD every ${this.poll}s ` +
          "(any HEAD move → build/restart)",
      );
    else say("  self-deploy: OFF — crash restart remains active");
    say("recurse: starting server…");
    this.child = await this.spawnChild();
    this.started = deps.monotonic();
    this.backoff = BACKOFF_START;
    this.nextCheck = deps.monotonic() + this.poll;
  }

  private async spawnChild(): Promise<ServerChild> {
    const child = await this.deps.spawnServer(
      this.codeDir,
      this.host,
      this.port,
      this.dataDir,
      this.browserVersion,
      (message) => this.onServerMessage(message),
    );
    if (this.lastReport) child.send?.(this.lastReport);
    return child;
  }

  /** Send update progress to the server once per change. */
  report(state: UpdateReport["state"], detail: string | null = null): void {
    const last = this.lastReport;
    if (last?.state === state && last.detail === detail) return;
    this.lastReport = { type: "update-status", state, detail };
    this.child?.send?.(this.lastReport);
  }

  /** The server relays an operator's Settings "Update now". */
  onServerMessage(message: unknown): void {
    if ((message as { type?: unknown } | null)?.type !== "update") return;
    if (this.updating !== null || this.pendingReexecSha !== null) {
      if (this.lastReport) this.child?.send?.(this.lastReport);
      return;
    }
    this.lastReport = null;
    if (!this.headWatch) {
      this.report(
        "failed",
        "Self-deploy is off (RECURSE_SELF_DEPLOY), so Recurse cannot restart itself. Run `recurse update`, then restart Recurse.",
      );
      return;
    }
    this.updating = this.applyUpdate().finally(() => {
      this.updating = null;
    });
  }

  /** Run install.sh --update, then let the next tick see the moved HEAD. */
  async applyUpdate(): Promise<void> {
    const deps = this.deps;
    this.report("updating");
    say("[supervisor] updating the checkout (install.sh --update)…");
    const before = await deps.headSha(this.codeDir);
    let result: RunResult;
    try {
      result = await deps.runUpdate(this.codeDir, this.stopUpdate.signal);
    } catch (error) {
      logError("supervisor_update_failed", error);
      this.report(
        "failed",
        `install.sh --update did not finish (${error instanceof Error ? error.message : String(error)}); the checkout may be partly updated. Run \`recurse update\` in a terminal to see why.`,
      );
      return;
    }
    const output = scriptOutput(result);
    say(`[supervisor] install.sh --update exited ${result.returncode}`);
    if (result.returncode !== 0) {
      this.report("failed", output || `install.sh exited ${result.returncode}`);
      return;
    }
    if ((await deps.headSha(this.codeDir)) === before) {
      if (
        before &&
        this.browserVersion &&
        !before.startsWith(this.browserVersion)
      )
        this.report(
          "failed",
          `The checkout is already at ${before.slice(0, 7)}, but Recurse has not restarted into it. The terminal running recurse shows why; fix it, then restart Recurse.`,
        );
      else this.report("current", output || null);
      return;
    }
    this.nextCheck = 0;
  }

  async restartCrashedChild(rc: number): Promise<void> {
    const deps = this.deps;
    const cleanupComplete = await deps.reconcile(this.codeDir);
    const uptime = deps.monotonic() - this.started;
    this.backoff =
      uptime >= HEALTHY_UPTIME
        ? BACKOFF_START
        : Math.min(this.backoff * 2, BACKOFF_MAX);
    say(
      `[supervisor] server exited (code ${rc}) after ${uptime.toFixed(0)}s; ` +
        `restarting in ${this.backoff.toFixed(0)}s`,
    );
    if (
      (await deps.sleepInterruptible(this.backoff, this.stopping)) ||
      !cleanupComplete
    )
      return;
    if (this.pendingReexecSha !== null) {
      const [, inflight] = await deps.reloadGate(
        this.dataDir,
        this.port,
        this.pendingSince ?? deps.monotonic(),
        0,
      );
      if (inflight === 0) {
        const target = this.pendingReexecSha;
        this.pendingReexecSha = null;
        if (!(await deps.execUpdatedSupervisor(this.codeDir, target)))
          this.stopping.flag = true;
        return;
      }
    }
    this.started = deps.monotonic();
    try {
      this.child = await this.spawnChild();
    } catch (error) {
      say(
        `[supervisor] cannot restart the server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async pollHead(now: number): Promise<void> {
    const deps = this.deps;
    if (!(this.headWatch && now >= this.nextCheck) || this.updating !== null)
      return;
    this.nextCheck = now + this.poll;
    const current = await deps.headSha(this.codeDir);
    if (this.watchedSha === null) {
      this.watchedSha = current;
      return;
    }
    if (
      !(
        current &&
        current !== this.watchedSha &&
        !(await deps.gitOperationInProgress(this.codeDir))
      )
    )
      return;
    const previous = this.watchedSha;
    this.watchedSha = current;
    say(
      `[supervisor] checkout HEAD moved ${previous.slice(0, 7)} → ` +
        `${current.slice(0, 7)}; rebuilding`,
    );
    this.report("building", current.slice(0, 7));
    if (!(await deps.prepareUpdateRuntime(this.codeDir, current))) {
      this.pendingReexecSha = null;
      this.pendingSince = null;
      this.report(
        "failed",
        `Building ${current.slice(0, 7)} failed, so the current version keeps running. The terminal running recurse shows why; fix it, then restart Recurse.`,
      );
      return;
    }
    this.pendingReexecSha = current;
    this.pendingSince = now;
  }

  async fireUpdateIfReady(now: number): Promise<void> {
    const deps = this.deps;
    const target = this.pendingReexecSha;
    const pendingSince = this.pendingSince;
    if (target === null || pendingSince === null) return;
    const [, inflight] = await deps.reloadGate(
      this.dataDir,
      this.port,
      pendingSince,
      0,
      now,
    );
    // Invariant: A supervisor re-exec never interrupts or guesses about a
    // durable turn.
    if (inflight !== 0) {
      this.report("waiting", inflight === null ? null : String(inflight));
      if (now - this.lastWaitNotice >= QUIESCENCE_NOTICE) {
        const waiting = inflight === null ? "unknown" : String(inflight);
        say(
          `[supervisor] redeploy pending — waiting for ${waiting} running ` +
            "turn(s) to finish",
        );
        this.lastWaitNotice = now;
      }
      return;
    }
    this.report("restarting", target.slice(0, 7));
    if (!(await deps.terminate(this.child, this.codeDir))) return;
    this.pendingReexecSha = null;
    this.pendingSince = null;
    if (!(await deps.execUpdatedSupervisor(this.codeDir, target)))
      this.stopping.flag = true;
  }

  /** Drive ticks until stopped, then retain ownership until cleanup. */
  async run(): Promise<void> {
    const deps = this.deps;
    try {
      while (!this.stopping.flag) {
        try {
          const rc = this.child.poll();
          if (rc !== null) {
            await this.restartCrashedChild(rc);
            continue;
          }
          const now = deps.monotonic();
          await this.pollHead(now);
          await this.fireUpdateIfReady(now);
          if (await deps.sleepInterruptible(LOOP_INTERVAL, this.stopping))
            break;
        } catch (error) {
          logError("supervisor_loop_error", error);
          say("[supervisor] loop error; continuing after backoff");
          if (await deps.sleepInterruptible(LOOP_ERROR_BACKOFF, this.stopping))
            break;
        }
      }
    } finally {
      say("[supervisor] shutting down");
      // Invariant: A running install.sh group is stopped and reaped before
      // the data lock can pass to another launcher.
      this.stopUpdate.abort();
      await this.updating;
      await finishSupervisorShutdown(this.child, this.codeDir, deps);
      this.uninstallSignals();
    }
  }
}

/** Retain the supervisor/data lock until prior ownership is resolved. */
export async function finishSupervisorShutdown(
  child: ServerChild,
  codeDir: string,
  deps: Pick<SupervisorDeps, "terminate" | "reconcile" | "sleep">,
): Promise<void> {
  if (await deps.terminate(child, codeDir)) return;
  say(
    "[supervisor] retaining data-directory ownership until " +
      "prior process cleanup completes",
  );
  while (!(await deps.reconcile(codeDir))) await deps.sleep(1);
}
