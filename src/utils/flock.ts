// Cross-process flock(2), asynchronously polled; caller owns the descriptor.
// Nonblocking attempts never wait for contention on Bun's event loop.
// No lockfile emulation or FIFO guarantee; caller closes after unlocking.
// Wall spans cover native attempts/unlocks, not asynchronous retry waits.
import { constants } from "node:os";
import { errno, libc } from "./libc";
import { slowSpan } from "../observability/slow_span";

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
    const [result, code] = slowSpan("file_lock_try", undefined, () => {
      const result = libc.flock(fd, LOCK_EX | LOCK_NB);
      return [result, result === 0 ? 0 : errno()] as const;
    });
    if (result === 0) {
      logWait(options, path, performance.now() - start, "held");
      let released = false;
      return () => {
        if (released) return;
        slowSpan("file_lock_release", undefined, () => {
          if (libc.flock(fd, LOCK_UN) !== 0) throw flockError(path);
        });
        released = true;
      };
    }
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
