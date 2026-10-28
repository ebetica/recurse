// Linux /proc process files, and the same text on macOS from libproc and sysctl
// so one parser serves both; a gone process is ENOENT, a forbidden one EPERM.
// Spec: macOS stat lines carry pid, (comm), state, ppid, pgid, sid and, as
// field 22, the per-boot unique process id (sys/proc_info.h, any user's).
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { opendir, readFile, readdir, stat } from "node:fs/promises";
import { errno } from "./libc";

export const PROC = "/proc";
export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
export type ProcFile = "stat" | "comm" | "environ";

const { i32, u32, u64, ptr: pointer } = FFIType;
const mac =
  process.platform === "darwin" && process.arch === "arm64"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        proc_pidinfo: { args: [i32, i32, u64, pointer, i32], returns: i32 },
        proc_listallpids: { args: [pointer, i32], returns: i32 },
        getsid: { args: [i32], returns: i32 },
        sysctl: {
          args: [pointer, u32, pointer, pointer, pointer, u64],
          returns: i32,
        },
        sysctlbyname: {
          args: [pointer, pointer, pointer, pointer, u64],
          returns: i32,
        },
      }).symbols
    : null;
/** Whether this host answers process identity (Linux, or macOS on arm64). */
export const HAS_PROCESS_TABLE = process.platform === "linux" || mac !== null;
/** Whether macOS answers /proc reads here instead of the filesystem. */
export const PROCESS_TABLE_EMULATED = mac !== null;
const PROC_PIDT_SHORTBSDINFO = 13;
const PROC_PIDUNIQIDENTIFIERINFO = 17;
const STATES = ["?", "R", "R", "S", "T", "Z"];
const ESRCH = 3;

function emulated(root: string): boolean {
  return mac !== null && root === PROC;
}

function failure(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code, path });
}

function lastFailure(path: string): Error {
  return failure(errno() === ESRCH ? "ENOENT" : "EPERM", path);
}

function macInfo(pid: number, flavor: number, size: number): DataView {
  const info = new Uint8Array(128);
  if (mac!.proc_pidinfo(pid, flavor, 0, ptr(info), info.length) < size)
    throw lastFailure(`${PROC}/${pid}/stat`);
  return new DataView(info.buffer);
}

function macStat(pid: number): { line: string; comm: string } {
  // Invariant: the unique id is read before and after the other fields, so a
  // pid reused mid-read is reported as unreadable, never as one process.
  const start = macInfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 24).getBigUint64(
    16,
    true,
  );
  const short = macInfo(pid, PROC_PIDT_SHORTBSDINFO, 64);
  const state = STATES[short.getUint32(12, true)] ?? "?";
  const sid = state === "Z" ? 0 : mac!.getsid(pid);
  if (sid < 0) throw lastFailure(`${PROC}/${pid}/stat`);
  const unique = macInfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 24);
  if (unique.getBigUint64(16, true) !== start)
    throw failure("EIO", `${PROC}/${pid}/stat`);
  const name = new Uint8Array(short.buffer, 16, 16);
  const end = name.indexOf(0);
  const comm = Buffer.from(name.subarray(0, end < 0 ? 16 : end)).toString(
    "utf8",
  );
  const fields = [state, short.getUint32(4, true), short.getUint32(8, true)];
  const line = `${pid} (${comm}) ${fields.join(" ")} ${sid} ${"0 ".repeat(13)}1 0 ${start}\n`;
  return { line, comm };
}

function sysctlBytes(mib: number[], size: number): Uint8Array | null {
  const name = new Int32Array(mib);
  const buffer = new Uint8Array(size);
  const length = new BigUint64Array([BigInt(size)]);
  if (mac!.sysctl(ptr(name), mib.length, ptr(buffer), ptr(length), null, 0) < 0)
    return null;
  return buffer.subarray(0, Number(length[0]));
}

// KERN_PROCARGS2: argc, the executable path, padding, argv, then environ.
function macEnviron(pid: number): string {
  const max = sysctlBytes([1, 8], 4);
  const args =
    max &&
    sysctlBytes([1, 49, pid], new DataView(max.buffer).getInt32(0, true));
  if (!args) throw lastFailure(`${PROC}/${pid}/environ`);
  const strings = Buffer.from(args.subarray(4)).toString("latin1").split("\0");
  let index = 1;
  while (index < strings.length && strings[index] === "") index++;
  const argc = new DataView(args.buffer).getInt32(0, true);
  const rest = strings.slice(index + argc);
  // Spec: XNU omits other callers' view of a restricted (CS_RESTRICT, e.g.
  // SIP-protected /bin) process's environment by ending the buffer after argv.
  if (!rest[0]) throw failure("EPERM", `${PROC}/${pid}/environ`);
  const environ: string[] = [];
  for (const value of rest) {
    if (!value) break;
    environ.push(value);
  }
  return environ.map((value) => `${value}\0`).join("");
}

function macText(pid: number, file: ProcFile): string {
  if (file === "environ") return macEnviron(pid);
  const { line, comm } = macStat(pid);
  return file === "stat" ? line : `${comm}\n`;
}

function macIds(): string[] {
  const count = mac!.proc_listallpids(null, 0);
  if (count <= 0) throw failure("EIO", PROC);
  const pids = new Int32Array(count + 64);
  const found = mac!.proc_listallpids(ptr(pids), pids.byteLength);
  if (found <= 0 || found >= pids.length) throw failure("EIO", PROC);
  return Array.from(
    pids.subarray(0, found).filter((pid) => pid > 0),
    String,
  );
}

/** Text of `<root>/<pid>/<file>`; macOS answers the default root itself. */
export async function procText(
  pid: number | string,
  file: ProcFile,
  root = PROC,
  encoding: "utf8" | "latin1" = "utf8",
): Promise<string> {
  if (emulated(root)) return macText(Number(pid), file);
  return readFile(`${root}/${pid}/${file}`, encoding);
}

export function procTextSync(
  pid: number | string,
  file: ProcFile,
  root = PROC,
): string {
  if (emulated(root)) return macText(Number(pid), file);
  return readFileSync(`${root}/${pid}/${file}`, "utf8");
}

/** Entry names of `root`; on macOS, every pid above 0, as in procfs. */
export async function procIds(root = PROC): Promise<string[]> {
  return emulated(root) ? macIds() : readdir(root);
}

export function procIdsSync(root = PROC): string[] {
  return emulated(root) ? macIds() : readdirSync(root);
}

/** Names under `root`, streamed on Linux; on macOS, every pid. */
export async function procEntries(root = PROC): Promise<AsyncIterable<string>> {
  if (emulated(root)) {
    const ids = macIds();
    return (async function* () {
      yield* ids;
    })();
  }
  const directory = await opendir(root);
  return (async function* () {
    for await (const entry of directory) yield entry.name;
  })();
}

/** Resolve when `<root>` (or `<root>/<pid>`) exists; reject like stat(2). */
export async function procEntry(root = PROC, pid?: number): Promise<void> {
  if (!emulated(root)) {
    await stat(pid === undefined ? root : `${root}/${pid}`);
    return;
  }
  if (pid !== undefined) macStat(pid);
}

export function procEntryExists(pid: number | string, root = PROC): boolean {
  if (!emulated(root)) return existsSync(`${root}/${pid}`);
  try {
    macStat(Number(pid));
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ENOENT";
  }
}

/** The kernel boot id: Linux boot_id, macOS kern.bootsessionuuid. */
export function bootIdTextSync(path = BOOT_ID_PATH): string {
  if (!mac || path !== BOOT_ID_PATH) return readFileSync(path, "utf8");
  const name = new TextEncoder().encode("kern.bootsessionuuid\0");
  const buffer = new Uint8Array(64);
  const length = new BigUint64Array([64n]);
  if (mac.sysctlbyname(ptr(name), ptr(buffer), ptr(length), null, 0) < 0)
    throw failure("ENOENT", path);
  const end = buffer.indexOf(0);
  return Buffer.from(
    buffer.subarray(0, end < 0 ? Number(length[0]) : end),
  ).toString("utf8");
}

export async function bootIdText(path = BOOT_ID_PATH): Promise<string> {
  if (!mac || path !== BOOT_ID_PATH) return readFile(path, "utf8");
  return bootIdTextSync(path);
}
