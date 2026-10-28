// Server owns a group and inherits the data-dir lock even when orphaned.
// Stop with INT/bounded wait/KILL; separate cleanup covers Pi-owned groups.
// Failed cleanup forbids overlap; build/validate before supervisor exec.
// Exec preserves supervisor pid and lock descriptor.
import { join } from "node:path";
import type { Subprocess } from "bun";
import { returncode } from "../process_lifecycle";
import { checkoutBun, entrypointEnv, subprocessEnv } from "./build";
import { LOCK_FD_ENV, writeLockOwner } from "./lock";
import { SERVER_STOP_GRACE_SECONDS } from "../shutdown_budget";
import { detail, execReplacing, getpgid, logError, run, say } from "./system";

export const GRACE_SECONDS = SERVER_STOP_GRACE_SECONDS;
export const REEXEC_SHA_ENV = "RECURSE_SELF_DEPLOY_REEXEC_SHA";
/** The descriptor number the server child receives the lock on. */
export const CHILD_LOCK_FD = 3;

export interface ServerChild {
  readonly pid: number;
  /** The return code once exited (negative signal number), else null. */
  poll(): number | null;
  /** Wait at most `seconds`; the return code, or null on timeout. */
  wait(seconds: number): Promise<number | null>;
  /** Send a message over the server's IPC channel; best-effort. */
  send?(message: unknown): void;
}

/** Adapt a Bun subprocess to `ServerChild`. */
export function serverChild(proc: Subprocess): ServerChild {
  return {
    pid: proc.pid,
    poll: () => returncode(proc),
    send(message) {
      try {
        proc.send(message);
      } catch {}
    },
    async wait(seconds) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), seconds * 1000);
      });
      try {
        await Promise.race([proc.exited, timeout]);
      } finally {
        clearTimeout(timer);
      }
      return returncode(proc);
    },
  };
}

export interface SpawnOptions {
  readonly lockFd: number | null;
  readonly bun?: string;
  readonly spawn?: typeof Bun.spawn;
  /** Open an IPC channel to the server and receive its messages here. */
  readonly onMessage?: (message: unknown) => void;
}

/** Start `bun src/server.ts` from `codeDir` in its own session. */
export async function spawnServer(
  codeDir: string,
  host: string,
  port: number,
  dataDir: string,
  browserVersion: string | null,
  options: SpawnOptions,
): Promise<ServerChild> {
  const bun = options.bun ?? (await checkoutBun(codeDir));
  const env = subprocessEnv(true);
  env.CHAT_DATA_DIR = dataDir;
  // Invariant: The child serves the checkout's published frontend generation
  // from disk.
  env.RECURSE_FRONTEND_LIVE = "1";
  if (browserVersion) env.RECURSE_BROWSER_VERSION = browserVersion;
  const lockFd = options.lockFd;
  if (lockFd === null) delete env[LOCK_FD_ENV];
  else env[LOCK_FD_ENV] = String(CHILD_LOCK_FD);
  const proc = (options.spawn ?? Bun.spawn)(
    [bun, "src/server.ts", "--host", host, "--port", String(port)],
    {
      cwd: codeDir,
      env,
      detached: true,
      ...(options.onMessage
        ? { ipc: (message: unknown) => options.onMessage!(message) }
        : {}),
      // Invariant: An extra entry becomes child descriptor 3; Bun's types omit
      // numeric extra entries.
      stdio: (lockFd === null
        ? ["inherit", "inherit", "inherit"]
        : ["inherit", "inherit", "inherit", lockFd]) as unknown as [
        "inherit",
        "inherit",
        "inherit",
      ],
    },
  );
  // Invariant: Name the server as a live holder at once: if the supervisor
  // dies, a contending launch can still report the orphan's pid.
  if (lockFd !== null) writeLockOwner(lockFd, process.pid, proc.pid);
  return serverChild(proc);
}

/** Runs the served generation's lifecycle cleanup; argv[1] is the module. */
export const CLEANUP_SCRIPT = `
const { ProcessLifecycle } = await import(process.argv[1]);
const registry = { lifecycleRecords: async () => [[], true] };
const lifecycle = new ProcessLifecycle({ registry, shellStateDir: "" });
await lifecycle.startupCleanup();
const startupComplete = lifecycle.startupAllowsTempSweep();
const shutdownComplete = await lifecycle.shutdownCleanup(2000);
if (!startupComplete) throw new Error("prior process cleanup remains pending");
if (!shutdownComplete) throw new Error("cleanup process ownership remains pending");
`;

/** Clean tracked groups using the served code generation, in a fresh Bun. */
export async function reconcileServerProcesses(
  codeDir: string,
  deps: { run?: typeof run; bun?: string } = {},
): Promise<boolean> {
  const bun = deps.bun ?? (await checkoutBun(codeDir));
  let result;
  try {
    result = await (deps.run ?? run)(
      [
        bun,
        "--eval",
        CLEANUP_SCRIPT,
        join(codeDir, "src", "process_lifecycle.ts"),
      ],
      { cwd: codeDir, env: subprocessEnv(), timeoutSeconds: 30 },
    );
  } catch (error) {
    logError("supervisor_process_cleanup_deferred", error);
    return false;
  }
  if (result.returncode !== 0) {
    say(
      "[supervisor] process cleanup deferred to next start " +
        `(return code ${result.returncode})`,
    );
    return false;
  }
  return true;
}

export interface TerminateDeps {
  readonly getpgid: (pid: number) => number;
  readonly killpg: (pgid: number, signal: NodeJS.Signals) => void;
  readonly reconcile: (codeDir: string) => Promise<boolean>;
}

export const TERMINATE_DEPS: TerminateDeps = {
  getpgid,
  killpg: (pgid, signal) => process.kill(-pgid, signal),
  reconcile: (codeDir) => reconcileServerProcesses(codeDir),
};

function isGone(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ESRCH";
}

// Stop server/group and verify lifecycle cleanup; false retains old generation.
// Never start an overlap if server survives or prior groups remain uncertain.
export async function terminate(
  child: ServerChild,
  codeDir: string,
  grace: number = GRACE_SECONDS,
  deps: TerminateDeps = TERMINATE_DEPS,
): Promise<boolean> {
  if (child.poll() !== null) return deps.reconcile(codeDir);
  let pgid: number;
  try {
    pgid = deps.getpgid(child.pid);
  } catch (error) {
    if (isGone(error)) return deps.reconcile(codeDir);
    throw error;
  }
  try {
    deps.killpg(pgid, "SIGINT");
  } catch (error) {
    if (isGone(error)) return deps.reconcile(codeDir);
    throw error;
  }
  const code = await child.wait(grace);
  if (code !== null) say(`[supervisor] server exited with code ${code}`);
  else {
    say(`[supervisor] server still running ${grace} s after SIGINT; SIGKILL`);
    try {
      deps.killpg(pgid, "SIGKILL");
    } catch (error) {
      if (!isGone(error)) throw error;
    }
    if ((await child.wait(grace)) === null) {
      say("[supervisor] server survived SIGKILL; replacement deferred");
      return false;
    }
  }
  return deps.reconcile(codeDir);
}

/** Probe the new supervisor and app before replacing the known-good process. */
export async function updatedRuntimeStarts(
  codeDir: string,
  deps: { run?: typeof run; bun?: string } = {},
): Promise<boolean> {
  const bun = deps.bun ?? (await checkoutBun(codeDir));
  const commands = [
    [bun, join(codeDir, "src/local.ts"), "--help"],
    // Invariant: Composes against a throwaway state root: read-only for the
    // data directory the running server still owns.
    [bun, "src/server.ts", "--check"],
  ];
  for (const command of commands) {
    let result;
    try {
      result = await (deps.run ?? run)(command, {
        cwd: codeDir,
        env: entrypointEnv(),
        timeoutSeconds: 60,
      });
    } catch (error) {
      logError("supervisor_runtime_validation_failed", error);
      return false;
    }
    if (result.returncode !== 0) {
      say(`[supervisor] updated runtime validation failed: ${detail(result)}`);
      return false;
    }
  }
  return true;
}

/** Build and validate a moved checkout once, without stopping service. */
export async function prepareUpdateRuntime(
  codeDir: string,
  targetSha: string,
  deps: {
    setup?: (codeDir: string) => Promise<boolean>;
    validate?: (codeDir: string) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  if (process.env[REEXEC_SHA_ENV] === targetSha) {
    say(
      `[supervisor] re-exec already attempted for ${targetSha.slice(0, 7)}; ` +
        "manual restart required",
    );
    return false;
  }
  process.env[REEXEC_SHA_ENV] = targetSha;
  const setup =
    deps.setup ??
    (async (dir: string) => {
      try {
        const result = await run(
          [
            await checkoutBun(dir),
            join(dir, "src/launch_cli.ts"),
            "build",
            dir,
          ],
          {
            cwd: dir,
            env: entrypointEnv(),
            timeoutSeconds: 2100,
            killDescendants: true,
          },
        );
        if (result.returncode !== 0)
          say(`[supervisor] updated checkout build failed: ${detail(result)}`);
        return result.returncode === 0;
      } catch (error) {
        logError("supervisor_updated_checkout_build_failed", error);
        return false;
      }
    });
  if (!(await setup(codeDir))) {
    say(
      `[supervisor] update ${targetSha.slice(0, 7)} needs a manual restart ` +
        "after its build is fixed; keeping the current server",
    );
    return false;
  }
  const validate = deps.validate ?? ((dir) => updatedRuntimeStarts(dir));
  if (!(await validate(codeDir))) {
    say(
      `[supervisor] update ${targetSha.slice(0, 7)} needs a manual restart ` +
        "after the updated runtime is fixed; keeping the current server",
    );
    return false;
  }
  return true;
}

export type Execve = (
  executable: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  keepFds: readonly number[],
) => Promise<never>;

/** Replace this supervisor with a generation whose preflight passed. */
export async function execUpdatedSupervisor(
  codeDir: string,
  targetSha: string,
  deps: { execve?: Execve; argv?: readonly string[] } = {},
): Promise<boolean> {
  const bun = await checkoutBun(codeDir);
  const argv = [
    bun,
    join(codeDir, "src/local.ts"),
    ...(deps.argv ?? process.argv.slice(2)),
  ];
  const env = entrypointEnv(true);
  const lock = Number(env[LOCK_FD_ENV]);
  say(`[supervisor] re-executing supervisor at ${targetSha.slice(0, 7)}`);
  try {
    await (deps.execve ?? execReplacing)(
      bun,
      argv,
      env,
      Number.isInteger(lock) && lock > 2 ? [lock] : [],
    );
  } catch (error) {
    logError("supervisor_reexec_failed", error);
    say("[supervisor] manual restart required");
    return false;
  }
  say(
    "[supervisor] supervisor re-exec returned unexpectedly; manual restart required",
  );
  return false;
}
