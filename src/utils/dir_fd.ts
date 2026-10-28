// Retained directory descriptors reject parent-path replacement; no fallback.
// Linux uses /proc/self/fd/N/name; macOS arm64 uses libSystem *at calls.
// macOS O_NONBLOCK prevents FIFO hangs; regular files/directories ignore it.
// Opening /dev/fd/N duplicates a descriptor into a FileHandle (fd(4)).
import {
  dlopen,
  FFIType,
  ptr,
  read,
  toArrayBuffer,
  type Pointer,
} from "bun:ffi";
import fs, { constants, type BigIntStats, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { constants as os } from "node:os";
import { errno } from "./libc";

const linux = process.platform === "linux";
const { i32, i64, ptr: pointer } = FFIType;
// Apple arm64 variadic openat reads mode on stack: fill x3-x7 first.
const mac =
  process.platform === "darwin" && process.arch === "arm64"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        openat: {
          args: [i32, pointer, i32, i64, i64, i64, i64, i64, i64],
          returns: i32,
        },
        fstatat: { args: [i32, pointer, pointer, i32], returns: i32 },
        mkdirat: { args: [i32, pointer, i32], returns: i32 },
        unlinkat: { args: [i32, pointer, i32], returns: i32 },
        renameat: { args: [i32, pointer, i32, pointer], returns: i32 },
        fdopendir: { args: [i32], returns: pointer },
        readdir: { args: [pointer], returns: pointer },
        closedir: { args: [pointer], returns: i32 },
        __error: { args: [], returns: pointer },
      }).symbols
    : null;
const O_CLOEXEC = 0x1000000;
const AT_SYMLINK_NOFOLLOW = 0x20;
const AT_REMOVEDIR = 0x80;
const STAT_SIZE = 144;
const DIRENT_NAMLEN = 18;
const DIRENT_NAME = 21;
const ACCESS = constants.O_WRONLY | constants.O_RDWR;
const ERRNO_NAMES = new Map<number, string>();
for (const [name, value] of Object.entries(os.errno))
  if (!ERRNO_NAMES.has(value)) ERRNO_NAMES.set(value, name);

function unsupported(fd: number): never {
  throw Object.assign(
    new Error("descriptor-relative file operations require Linux or macOS"),
    { code: "ENOTSUP", path: String(fd) },
  );
}

/** Linux only: the procfs path of `name` under directory `fd`. */
export function descriptorPath(fd: number, name?: string): string {
  if (!linux) unsupported(fd);
  const directory = `/proc/self/fd/${fd}`;
  return name === undefined ? directory : `${directory}/${name}`;
}

function cName(name: string): Uint8Array {
  if (name.includes("\0"))
    throw new TypeError("a path component must not contain NUL");
  return new TextEncoder().encode(`${name}\0`);
}

function failed(syscall: string, name: string): Error {
  const number = errno();
  const code = ERRNO_NAMES.get(number) ?? `E${number}`;
  return Object.assign(new Error(`${code}: ${syscall} '${name}'`), {
    code,
    errno: -number,
    syscall,
    path: name,
  });
}

function macOpen(fd: number, name: string, flags: number, mode = 0o666) {
  const raw = mac!.openat(
    fd,
    ptr(cName(name)),
    flags | O_CLOEXEC | constants.O_NONBLOCK,
    0,
    0,
    0,
    0,
    0,
    mode,
  );
  if (raw < 0) throw failed("open", name);
  return raw;
}

let BigIntStatsClass: (new (...values: bigint[]) => BigIntStats) | undefined;

function macLstat(fd: number, name: string, bigint: boolean) {
  const buffer = new Uint8Array(STAT_SIZE);
  if (mac!.fstatat(fd, ptr(cName(name)), ptr(buffer), AT_SYMLINK_NOFOLLOW) < 0)
    throw failed("lstat", name);
  const view = new DataView(buffer.buffer);
  const u64 = (at: number) => view.getBigUint64(at, true);
  const ns = (at: number) =>
    view.getBigInt64(at, true) * 1_000_000_000n +
    view.getBigInt64(at + 8, true);
  const fields = [
    BigInt(view.getInt32(0, true)),
    BigInt(view.getUint16(4, true)),
    BigInt(view.getUint16(6, true)),
    BigInt(view.getUint32(16, true)),
    BigInt(view.getUint32(20, true)),
    BigInt(view.getInt32(24, true)),
    BigInt(view.getInt32(112, true)),
    u64(8),
    u64(96),
    u64(104),
  ];
  const times = [ns(32), ns(48), ns(64), ns(80)];
  if (bigint) {
    BigIntStatsClass ??= fs.lstatSync("/", { bigint: true })
      .constructor as unknown as typeof BigIntStatsClass;
    return new BigIntStatsClass!(...fields, ...times);
  }
  const NumberStats = fs.Stats as unknown as new (...values: number[]) => Stats;
  return new NumberStats(
    ...fields.map(Number),
    ...times.map((value) => Number(value) / 1e6),
  );
}

function macOpenDirectory(fd: number): Pointer {
  const raw = macOpen(fd, ".", constants.O_RDONLY | constants.O_DIRECTORY);
  const directory = mac!.fdopendir(raw);
  if (!directory) {
    const error = failed("scandir", ".");
    fs.closeSync(raw);
    throw error;
  }
  return directory;
}

// Invariant: names are read one at a time and the stream closes on return,
// so a caller's entry budget bounds the work.
function* macDirectoryNames(directory: Pointer): Generator<string> {
  try {
    const errnoAt = mac!.__error() as Pointer;
    for (;;) {
      new Int32Array(toArrayBuffer(errnoAt, 0, 4))[0] = 0;
      const entry = mac!.readdir(directory);
      if (!entry) {
        if (read.i32(errnoAt, 0) !== 0) throw failed("scandir", ".");
        return;
      }
      const length = read.u16(entry, DIRENT_NAMLEN);
      const name = Buffer.from(
        new Uint8Array(toArrayBuffer(entry, DIRENT_NAME, length)),
      ).toString("utf8");
      if (name !== "." && name !== "..") yield name;
    }
  } finally {
    mac!.closedir(directory);
  }
}

function macCall(result: number, syscall: string, name: string): void {
  if (result < 0) throw failed(syscall, name);
}

/** lstat(2) of `name` in directory `fd`. */
export function lstatAt(fd: number, name: string): Promise<Stats>;
export function lstatAt(
  fd: number,
  name: string,
  options: { bigint: true },
): Promise<BigIntStats>;
export async function lstatAt(
  fd: number,
  name: string,
  options?: { bigint: true },
): Promise<Stats | BigIntStats> {
  if (mac) return macLstat(fd, name, options?.bigint === true);
  return options
    ? lstat(descriptorPath(fd, name), options)
    : lstat(descriptorPath(fd, name));
}

export function lstatAtSync(fd: number, name: string): Stats {
  if (mac) return macLstat(fd, name, false) as Stats;
  return fs.lstatSync(descriptorPath(fd, name));
}

/** open(2) of `name` in directory `fd`; the caller closes the handle. */
export async function openAt(
  fd: number,
  name: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  if (!mac) return open(descriptorPath(fd, name), flags, mode);
  const raw = macOpen(fd, name, flags, mode);
  try {
    return await open(`/dev/fd/${raw}`, flags & ACCESS);
  } finally {
    fs.closeSync(raw);
  }
}

export function openAtSync(
  fd: number,
  name: string,
  flags: number,
  mode?: number,
): number {
  if (mac) return macOpen(fd, name, flags, mode);
  return fs.openSync(descriptorPath(fd, name), flags, mode);
}

export async function mkdirAt(
  fd: number,
  name: string,
  mode: number,
): Promise<void> {
  if (mac)
    return macCall(mac.mkdirat(fd, ptr(cName(name)), mode), "mkdir", name);
  await mkdir(descriptorPath(fd, name), { mode });
}

export function mkdirAtSync(fd: number, name: string, mode: number): void {
  if (mac)
    return macCall(mac.mkdirat(fd, ptr(cName(name)), mode), "mkdir", name);
  fs.mkdirSync(descriptorPath(fd, name), { mode });
}

export async function unlinkAt(fd: number, name: string): Promise<void> {
  if (mac)
    return macCall(mac.unlinkat(fd, ptr(cName(name)), 0), "unlink", name);
  await unlink(descriptorPath(fd, name));
}

export function unlinkAtSync(fd: number, name: string): void {
  if (mac)
    return macCall(mac.unlinkat(fd, ptr(cName(name)), 0), "unlink", name);
  fs.unlinkSync(descriptorPath(fd, name));
}

export function rmdirAtSync(fd: number, name: string): void {
  if (mac)
    return macCall(
      mac.unlinkat(fd, ptr(cName(name)), AT_REMOVEDIR),
      "rmdir",
      name,
    );
  fs.rmdirSync(descriptorPath(fd, name));
}

/** rename(2) between two pinned directories. */
export async function renameAt(
  fromFd: number,
  from: string,
  toFd: number,
  to: string,
): Promise<void> {
  if (mac) return renameAtSync(fromFd, from, toFd, to);
  await rename(descriptorPath(fromFd, from), descriptorPath(toFd, to));
}

export function renameAtSync(
  fromFd: number,
  from: string,
  toFd: number,
  to: string,
): void {
  if (mac)
    return macCall(
      mac.renameat(fromFd, ptr(cName(from)), toFd, ptr(cName(to))),
      "rename",
      from,
    );
  fs.renameSync(descriptorPath(fromFd, from), descriptorPath(toFd, to));
}

/** Entry names of directory `fd`, without "." and "..". */
export async function readdirAt(fd: number): Promise<string[]> {
  if (mac) return [...macDirectoryNames(macOpenDirectory(fd))];
  return readdir(descriptorPath(fd));
}

export function readdirAtSync(fd: number): string[] {
  if (mac) return [...macDirectoryNames(macOpenDirectory(fd))];
  return fs.readdirSync(descriptorPath(fd));
}

/** Open directory `fd` for iteration; names are read lazily. */
export async function entriesAt(fd: number): Promise<AsyncIterable<string>> {
  if (mac) {
    const names = macDirectoryNames(macOpenDirectory(fd));
    return (async function* () {
      yield* names;
    })();
  }
  const directory = await opendir(descriptorPath(fd));
  return (async function* () {
    for await (const entry of directory) yield entry.name;
  })();
}
