// libc launcher primitives plus bounded captured subprocesses.
// Exec preserves pid/terminal/inheritable descriptors; first mark descriptors
// above stderr close-on-exec except explicit survivors, notably the data lock.
import { readdir } from "node:fs/promises";
import { CString, ptr } from "bun:ffi";
import {
  formatRecord,
  logException,
  logger,
  type LogSink,
  type RuntimeLogRecord,
} from "../observability/runtime_logging";
import {
  closeOnExecFlag,
  DESCRIPTOR_DIRECTORY,
  errno,
  libc,
  setCloseOnExecFlag,
} from "../utils/libc";

/** An OSError-like failure carrying the libc errno name. */
export class SystemError extends Error {
  override name = "OSError";
  constructor(
    readonly call: string,
    readonly errno: number,
    readonly code: string,
  ) {
    super(`${call} failed: ${code}`);
  }
}

const ERRNO_NAMES: Record<number, string> = {
  1: "EPERM",
  2: "ENOENT",
  3: "ESRCH",
  9: "EBADF",
  13: "EACCES",
  22: "EINVAL",
};

function lastError(call: string): SystemError {
  const number = errno();
  let code = ERRNO_NAMES[number];
  if (!code) {
    const text = libc.strerror(number);
    code = text ? new CString(text).toString() : `errno ${number}`;
  }
  return new SystemError(call, number, code);
}

/** os.getpgid: the process group of `pid`; ESRCH when it is gone. */
export function getpgid(pid: number): number {
  const pgid = libc.getpgid(pid);
  if (pgid < 0) throw lastError("getpgid");
  return pgid;
}

/** Set or clear close-on-exec on one descriptor. */
export function setCloseOnExec(fd: number, closeOnExec: boolean): void {
  if (setCloseOnExecFlag(fd, closeOnExec) < 0) throw lastError("fcntl");
}

/** Whether a descriptor is marked close-on-exec. */
export function closeOnExec(fd: number): boolean {
  const flag = closeOnExecFlag(fd);
  if (flag < 0) throw lastError("fcntl");
  return flag !== 0;
}

function cArray(values: readonly string[], keep: unknown[]): BigUint64Array {
  const array = new BigUint64Array(values.length + 1);
  values.forEach((value, index) => {
    const bytes = new TextEncoder().encode(`${value}\0`);
    keep.push(bytes);
    array[index] = BigInt(ptr(bytes));
  });
  keep.push(array);
  return array;
}

// Exec executable/argv under exactly env; mark fds above 2 close-on-exec
// except explicit keepFds. Return only by throwing an exec error.
export async function execReplacing(
  executable: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  keepFds: readonly number[] = [],
): Promise<never> {
  let names: string[] = [];
  try {
    names = await readdir(DESCRIPTOR_DIRECTORY);
  } catch {
    // Invariant: Without the descriptor directory every inherited
    // descriptor keeps its current flag.
  }
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 2 || keepFds.includes(fd)) continue;
    try {
      setCloseOnExec(fd, true);
    } catch {}
  }
  for (const fd of keepFds) setCloseOnExec(fd, false);
  const keep: unknown[] = [];
  const path = new TextEncoder().encode(`${executable}\0`);
  const envp = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  libc.execve(ptr(path), ptr(cArray(argv, keep)), ptr(cArray(envp, keep)));
  throw lastError("execve");
}

export interface RunResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** subprocess.TimeoutExpired: the child outlived its budget and was killed. */
export class TimeoutExpired extends Error {
  override name = "TimeoutExpired";
  constructor(
    readonly argv: readonly string[],
    readonly timeoutSeconds: number,
  ) {
    super(`${argv[0]} timed out after ${timeoutSeconds}s`);
  }
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  /** Own and kill the command's process group when its deadline expires. */
  readonly killDescendants?: boolean;
}

// Captured subprocess deadline also bounds output pipes: a background
// grandchild holding a pipe open cannot extend the wait.
export async function run(
  argv: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: options.killDescendants ?? false,
  });
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const drain = async (reader: (typeof readers)[number]): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  };
  const finished = Promise.all([
    drain(readers[0]!),
    drain(readers[1]!),
    child.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), options.timeoutSeconds * 1000);
  });
  try {
    const result = await Promise.race([finished, deadline]);
    if (result === null) {
      if (options.killDescendants) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      } else child.kill("SIGKILL");
      finished.catch(() => {});
      await Promise.all(readers.map((reader) => reader.cancel()));
      await child.exited;
      throw new TimeoutExpired(argv, options.timeoutSeconds);
    }
    const [stdout, stderr, returncode] = result;
    return { returncode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Monotonic seconds, as Python's time.monotonic(). */
export function monotonic(): number {
  return performance.now() / 1000;
}

const stderrSink: LogSink = {
  write(record: RuntimeLogRecord): void {
    process.stderr.write(`${formatRecord(record)}\n`);
  },
};

/** The `recurse.supervisor` logger, written to stderr. */
export const LOG = logger("supervisor", stderrSink);

/** A low-volume operator notice. */
export function say(message: string): void {
  LOG.info(message);
}

/** A redacted exception diagnostic: event, type and safe frames. */
export function logError(event: string, error: unknown): void {
  logException(LOG, event, error);
}

/** The last 400 characters of a failed command's output. */
export function detail(result: RunResult): string {
  return (result.stderr || result.stdout).trim().slice(-400);
}
