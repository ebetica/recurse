// The C library through bun:ffi: glibc libc.so.6 on Linux, libSystem on macOS.
// Spec: fcntl and ioctl are variadic, and Apple arm64 passes variadic
// arguments on the stack, so on macOS no call passes one: F_GETFD ignores its
// argument and FIOCLEX/FIONCLEX (sys/filio.h) replace F_SETFD.
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";

const { i32, u64, ptr } = FFIType;
const shared = {
  flock: { args: [i32, i32], returns: i32 },
  clock_gettime: { args: [i32, ptr], returns: i32 },
  execve: { args: [ptr, ptr, ptr], returns: i32 },
  getpgid: { args: [i32], returns: i32 },
  fcntl: { args: [i32, i32, i32], returns: i32 },
  strerror: { args: [i32], returns: ptr },
} as const;

const darwin =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        ...shared,
        __error: { args: [], returns: ptr },
        ioctl: { args: [i32, u64], returns: i32 },
      }).symbols
    : null;
const linux = darwin
  ? null
  : dlopen("libc.so.6", {
      ...shared,
      __errno_location: { args: [], returns: ptr },
    }).symbols;

/** Symbols with the same signature on both systems. */
export const libc = (darwin ?? linux)!;

/** The calling thread's errno after a failed call. */
export function errno(): number {
  const at = darwin ? darwin.__error() : linux!.__errno_location();
  return read.i32(at as Pointer, 0);
}

const F_GETFD = 1;
const F_SETFD = 2;
const FD_CLOEXEC = 1;
const FIOCLEX = 0x20006601n;
const FIONCLEX = 0x20006602n;

/** FD_CLOEXEC of `fd` as 0 or 1, or -1 with errno set. */
export function closeOnExecFlag(fd: number): number {
  const flags = libc.fcntl(fd, F_GETFD, 0);
  return flags < 0 ? flags : flags & FD_CLOEXEC;
}

/** Set or clear FD_CLOEXEC; 0, or -1 with errno set. */
export function setCloseOnExecFlag(fd: number, closeOnExec: boolean): number {
  if (darwin) return darwin.ioctl(fd, closeOnExec ? FIOCLEX : FIONCLEX);
  const flags = libc.fcntl(fd, F_GETFD, 0);
  if (flags < 0) return flags;
  const next = closeOnExec ? flags | FD_CLOEXEC : flags & ~FD_CLOEXEC;
  return next === flags ? 0 : libc.fcntl(fd, F_SETFD, next);
}

/** Process descriptors: macOS fd(4) or Linux procfs, without /dev/fd links. */
export const DESCRIPTOR_DIRECTORY = darwin ? "/dev/fd" : "/proc/self/fd";
