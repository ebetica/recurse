// Nonblocking 0600 data-dir flock survives child inheritance/supervisor exec.
// Live orphans exclude replacements; file pid bytes are only advisory.
// Cross-host exclusion needs server-side locks, not host-local mount options.
// File-server restart can break exclusion; direct imports bypass this gate.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { flockExclusive, TreeLifecycleBusy } from "../utils/flock";
import { pyResolve } from "../workdir_git";
import { setCloseOnExec } from "./system";

export const LOCK_FD_ENV = "RECURSE_DATA_DIR_LOCK_FD";
export const LOCK_NAME = ".recurse-supervisor.lock";

/** Publish possible live holders without changing kernel lock ownership. */
export function writeLockOwner(fd: number, ...pids: number[]): void {
  const payload = new TextEncoder().encode(`${pids.join(" ")}\n`);
  // Invariant: Overwrite before truncating so a killed writer never leaves the
  // owner record transiently empty.
  if (writeSync(fd, payload, 0, payload.length, 0) !== payload.length)
    throw new Error("short write while publishing data-directory lock owner");
  ftruncateSync(fd, payload.length);
  fsyncSync(fd);
}

/** The newest recorded pid that is still alive, else "unknown". */
export function lockOwner(fd: number): string {
  let values: string[] = [];
  try {
    const buffer = new Uint8Array(256);
    const count = readSync(fd, buffer, 0, 256, 0);
    values = new TextDecoder().decode(buffer.subarray(0, count)).split(/\s+/);
  } catch {
    values = [];
  }
  for (const value of values.reverse()) {
    if (!/^\d+$/.test(value)) continue;
    try {
      process.kill(Number(value), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") continue;
    }
    return value;
  }
  return "unknown";
}

/** A valid inherited lock descriptor for this data directory, if present. */
export function inheritedLockFd(dataDir: string): number | null {
  const raw = process.env[LOCK_FD_ENV];
  if (raw === undefined) return null;
  try {
    if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw new Error("not a descriptor");
    const fd = Number(raw);
    const opened = fstatSync(fd);
    const onDisk = statSync(join(dataDir, LOCK_NAME));
    if (opened.dev === onDisk.dev && opened.ino === onDisk.ino) return fd;
  } catch {
    // Invariant: Fall through: a stale or foreign descriptor is forgotten.
  }
  delete process.env[LOCK_FD_ENV];
  return null;
}

export interface SupervisorLock {
  readonly fd: number;
  /** Close the descriptor; the kernel lock drops with its last holder. */
  close(): void;
}

function held(fd: number): SupervisorLock {
  let open = true;
  return {
    fd,
    close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

async function tryLock(fd: number, path: string): Promise<void> {
  // Invariant: A zero timeout is exactly one LOCK_EX|LOCK_NB attempt.
  await flockExclusive(fd, path, { timeoutMs: 0, log: () => {} });
}

/** Hold exclusive ownership of `dataDir`; the error names a live owner. */
export async function acquireSupervisorLock(
  dataDir: string,
): Promise<SupervisorLock> {
  const lockPath = join(dataDir, LOCK_NAME);
  let fd: number;
  try {
    mkdirSync(dataDir, { recursive: true });
    const inherited = inheritedLockFd(dataDir);
    if (inherited !== null) {
      // Invariant: Reasserting flock on the same inherited open-file
      // description is idempotent and verifies that it still owns the kernel
      // lock.
      await tryLock(inherited, lockPath);
      return held(inherited);
    }
    fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
  } catch (error) {
    throw new Error(
      `cannot prepare Recurse data-directory lock for ${await pyResolve(dataDir)}: ${message(error)}`,
    );
  }
  try {
    // Invariant: the server family and a supervisor re-exec inherit the lock;
    // Bun opens files close-on-exec on macOS but not on Linux.
    setCloseOnExec(fd, false);
    await tryLock(fd, lockPath);
  } catch (error) {
    const owner = error instanceof TreeLifecycleBusy ? lockOwner(fd) : null;
    closeSync(fd);
    if (owner !== null)
      throw new Error(
        `another live Recurse server (pid ${owner}) owns data directory ${await pyResolve(dataDir)}`,
      );
    throw new Error(
      `cannot acquire Recurse data-directory lock for ${await pyResolve(dataDir)}: ${message(error)}`,
    );
  }
  process.env[LOCK_FD_ENV] = String(fd);
  writeLockOwner(fd, process.pid);
  return held(fd);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
