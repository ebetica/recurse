// Cross-process advisory file lock using flock(2) from ./libc, polled
// asynchronously: never park Bun's event loop on a contended descriptor. The
// caller owns the descriptor and closes it after unlocking. There is no
// lockfile emulation or FIFO guarantee.
import { constants } from "node:os";
import { errno, libc } from "./libc";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const { EINTR, EAGAIN } = constants.errno;

export class TreeLifecycleBusy extends Error {
  override name = "TreeLifecycleBusy";
}

export interface FlockOptions {
  /** Maximum elapsed time, including attempts. */
  timeoutMs?: number;
  // Receives the path, elapsed wait and outcome without exposing lock contents.
  log?: (event: {
    path: string;
    waitMs: number;
    outcome: "held" | "busy";
  }) => void;
}

/** Acquire an exclusive kernel flock; return an idempotent unlock function. */
export async function flockExclusive(
  fd: number,
  path: string,
  options: FlockOptions = {},
): Promise<() => void> {
  const start = performance.now();
  const timeout = options.timeoutMs ?? 5_000;
  if (Number.isNaN(timeout) || timeout < 0)
    throw new RangeError("invalid flock timeout");
  let delay = 5;
  let attempted = false;
  for (;;) {
    if (attempted && performance.now() - start >= timeout) {
      const elapsed = performance.now() - start;
      logWait(options, path, elapsed, "busy");
      throw new TreeLifecycleBusy(`tree lifecycle is busy: ${path}`);
    }
    attempted = true;
    if (libc.flock(fd, LOCK_EX | LOCK_NB) === 0) {
      logWait(options, path, performance.now() - start, "held");
      let released = false;
      return () => {
        if (released) return;
        if (libc.flock(fd, LOCK_UN) !== 0) throw flockError(path);
        released = true;
      };
    }
    const code = errno();
    if (code !== EAGAIN && code !== EINTR) throw flockError(path, code);
    const elapsed = performance.now() - start;
    if (elapsed >= timeout) {
      logWait(options, path, elapsed, "busy");
      throw new TreeLifecycleBusy(`tree lifecycle is busy: ${path}`);
    }
    await Bun.sleep(Math.min(delay, timeout - elapsed));
    delay = Math.min(delay * 2, 100);
  }
}

function logWait(
  options: FlockOptions,
  path: string,
  waitMs: number,
  outcome: "held" | "busy",
): void {
  // Invariant: Telemetry must never strand a successfully acquired kernel lock.
  try {
    if (options.log) options.log({ path, waitMs, outcome });
    else if (waitMs >= 5 || outcome === "busy")
      console.error("flock_wait", { path, waitMs, outcome });
  } catch {
    // Invariant: Logging is best-effort; exclusion must not depend on its sink.
  }
}

function flockError(path: string, code = errno()): Error {
  const error = new Error(`flock failed: ${path} (errno ${code})`);
  return error;
}
