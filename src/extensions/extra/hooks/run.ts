// Run one hook file for one event in a fresh Bun child (child.ts) in its own
// process group, owned for crash cleanup before it gets its input and stopped
// once it reports, overruns its timeout (at most 60 s) or is stopped. No
// bunfig.toml, .env, BUN_* or NODE_* setting reaches it.
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";

const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));
/** Load time, and handler time for a file that sets no `timeout`. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** The longest handler time a file's `timeout` may ask for. */
const MAX_TIMEOUT_MS = 60_000;
/** How long past its timeout a child that cannot stop itself is given. */
const GRACE_MS = 2_000;

interface HookRunOptions {
  file: string;
  /** Omitted: load the file and report its events only. */
  event?: string;
  payload?: Record<string, unknown>;
  cwd: string;
  /** Passed through hookEnvironment. */
  env: Record<string, string>;
  agentId: string;
  /** Stops the hook, as a timeout does. */
  signal?: AbortSignal;
  own(proc: Subprocess): Promise<void>;
  release(proc: Subprocess): Promise<boolean>;
}

type Reply = {
  events?: string[];
  timeout?: number;
  result?: unknown;
  error?: string;
};

/** The child's environment: `base` without Bun and Node settings, and no
 * transpiler cache an agent could fill. */
function hookEnvironment(base: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(base).filter(([name]) => !/^(BUN|NODE)_/.test(name)),
  );
  return { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
}

/** A failed run; `events` when the file loaded before it failed, `broken`
 * when loading it threw. */
export class HookRunError extends Error {
  constructor(
    message: string,
    readonly events?: string[],
    readonly broken = false,
  ) {
    super(message);
  }
}

/** The events the file registered, and its handlers' combined result. */
export async function runHook(
  options: HookRunOptions,
): Promise<{ events: string[]; result?: unknown }> {
  let loaded: { events: string[]; timeout: number; at: number } | undefined;
  let outcome: Reply | undefined;
  let wake = () => {};
  const proc = Bun.spawn(
    [process.execPath, "--config=/dev/null", "--no-env-file", CHILD],
    {
      cwd: options.cwd,
      env: hookEnvironment(options.env),
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ipc: (reply: Reply) => {
        if (!loaded && Array.isArray(reply.events))
          loaded = {
            events: reply.events.filter((name) => typeof name === "string"),
            timeout:
              Number(reply.timeout) > 0
                ? Math.min(Number(reply.timeout), MAX_TIMEOUT_MS)
                : DEFAULT_TIMEOUT_MS,
            at: performance.now(),
          };
        else outcome ??= reply;
        wake();
      },
    },
  );
  const started = performance.now();
  const stop = () => wake();
  options.signal?.addEventListener("abort", stop);
  try {
    try {
      await options.own(proc);
    } catch (error) {
      proc.kill("SIGKILL");
      throw error;
    }
    proc.send({
      file: options.file,
      event: options.event,
      payload: options.payload,
      agentId: options.agentId,
      timeouts: { fallback: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS },
    });
    while (!outcome && proc.exitCode === null && proc.signalCode === null) {
      if (loaded && !options.event) break;
      if (options.signal?.aborted)
        throw new HookRunError("stopped", loaded?.events);
      const limit = loaded
        ? loaded.at + loaded.timeout + GRACE_MS
        : started + DEFAULT_TIMEOUT_MS + GRACE_MS;
      const left = limit - performance.now();
      if (left <= 0)
        throw new HookRunError(
          `timed out after ${(loaded?.timeout ?? DEFAULT_TIMEOUT_MS) / 1000} s`,
          loaded?.events,
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        proc.exited,
        new Promise<void>((done) => {
          wake = done;
          timer = setTimeout(done, left);
        }),
      ]);
      clearTimeout(timer);
    }
    if (outcome?.error !== undefined)
      throw new HookRunError(outcome.error, loaded?.events, !loaded);
    if (!loaded || (options.event && !outcome))
      throw new HookRunError(
        `exited with ${proc.signalCode ?? `code ${proc.exitCode}`} before finishing`,
        loaded?.events,
      );
    return { events: loaded.events, result: outcome?.result };
  } finally {
    options.signal?.removeEventListener("abort", stop);
    await options.release(proc);
  }
}
