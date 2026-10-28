// Resolve Settings roots; validate opted-in strict isolation before launch.
// Prepare private Pi dir asynchronously; explicit HOME expands only ~/ or ~.
// Ignore close-on-exec descriptors: Bun internals cannot leak to child tools.

import {
  fstatSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  sep,
} from "node:path";
import type { BigIntStats } from "node:fs";
import { chmod, mkdir, stat as statAsync } from "node:fs/promises";
import { closeOnExecFlag, DESCRIPTOR_DIRECTORY } from "./utils/libc";

export type Environment = Readonly<Record<string, string | undefined>>;

export const ISOLATED_PATH_ENV = {
  CHAT_DATA_DIR: "data",
  RECURSE_ISOLATED_DATA_DIR: "data",
  RECURSE_TEMP_ROOT: "tmp",
  PI_BG_SHELL_STATE_DIR: "pi_bg_shell_state",
  RECURSE_HOME: "recurse-state-home",
  PI_CODING_AGENT_DIR: "recurse-state-home/pi-agent",
  CLAUDE_CONFIG_DIR: "claude-config",
  CHAT_REPO_URL: "target-repo",
  RECURSE_BIN_DIR: "bin",
} as const;

export const STRICT_ISOLATED_PATH_ENV = {
  ...ISOLATED_PATH_ENV,
  HOME: "home",
  XDG_CONFIG_HOME: "xdg-config",
  TMPDIR: "runtime-tmp",
  TMP: "runtime-tmp",
  TEMP: "runtime-tmp",
  RECURSE_AGENT_TMPDIR: "agent-tmp",
} as const;

export const ISOLATED_FORBIDDEN_ENV: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CHAT_AUTH_HASH",
  "CHAT_AUTH_SALT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "PI_AUTH_JSON",
  "RECURSE_SERVICE_PRINCIPALS_FILE",
  "RECURSE_SERVICE_TOKEN_FILE",
  "RECURSE_TAILSCALE_LOGIN",
]);

export const ISOLATED_CHILD_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  ...Object.keys(STRICT_ISOLATED_PATH_ENV),
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "PORT",
  "PYTHONPATH",
  "PYTHONUNBUFFERED",
  "RECURSE_BROWSER_VERSION",
  "RECURSE_DATA_DIR_LOCK_FD",
  "RECURSE_ENV_FILE",
  "RECURSE_FRONTEND_LIVE",
  "RECURSE_ISOLATED_ROOT",
  "RECURSE_SELF_DEPLOY",
  "RECURSE_SELF_DEPLOY_REEXEC_SHA",
  "RECURSE_USER",
  "TERM",
  "TZ",
]);

class PythonRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export class RootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootError";
  }
}

export interface Roots {
  state: string;
  piAgent: string;
}

/** Pi's persistent agent directory under RECURSE_HOME, prepared before use. */
export async function piAgentDir(
  roots: Roots,
  preparePiAgentDir: (roots: Roots) => Promise<void>,
): Promise<string> {
  await preparePiAgentDir(roots);
  return roots.piAgent;
}

const PYTHON_EDGE_WHITESPACE =
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
const FILE_TYPE_MASK = 0o170000n;
const REGULAR_FILE = 0o100000n;
const DIRECTORY = 0o040000n;
const CHARACTER_DEVICE = 0o020000n;

function envHas(env: Environment, name: string): boolean {
  return Object.hasOwn(env, name);
}

function envValue(env: Environment, name: string): string | undefined {
  return env[name];
}

function pythonTrim(value: string): string {
  return value.replace(PYTHON_EDGE_WHITESPACE, "");
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value);
}

function expandUser(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function absolute(value: string, name: string, home: string): string {
  if (!pythonTrim(value)) throw new RootError(`${name} must not be empty`);
  if (
    [...value].some((char) => {
      const code = char.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new RootError(`${name} must not contain control characters`);
  }
  const expanded = expandUser(value, home);
  if (!isAbsolutePath(expanded)) {
    throw new RootError(`${name} must be an absolute path`);
  }
  return normalize(expanded);
}

function pythonQuotedPath(value: string): string {
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

function pythonSymlinkLoop(path: string): string {
  return `Symlink loop from ${pythonQuotedPath(path)}`;
}

function isSymlinkLoop(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ELOOP"
  );
}

function pythonOSError(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return String(error);
  }
  const code = String(error.code);
  const errnoByCode: Record<string, number> = {
    EACCES: 13,
    EBADF: 9,
    EEXIST: 17,
    EIO: 5,
    ELOOP: 40,
    EMFILE: 24,
    ENAMETOOLONG: 36,
    ENFILE: 23,
    ENOENT: 2,
    ENOMEM: 12,
    ENOSPC: 28,
    ENOTDIR: 20,
    EPERM: 1,
    EROFS: 30,
  };
  const messageByCode: Record<string, string> = {
    EACCES: "Permission denied",
    EBADF: "Bad file descriptor",
    EEXIST: "File exists",
    EIO: "Input/output error",
    ELOOP: "Too many levels of symbolic links",
    EMFILE: "Too many open files",
    ENAMETOOLONG: "File name too long",
    ENFILE: "Too many open files in system",
    ENOENT: "No such file or directory",
    ENOMEM: "Cannot allocate memory",
    ENOSPC: "No space left on device",
    ENOTDIR: "Not a directory",
    EPERM: "Operation not permitted",
    EROFS: "Read-only file system",
  };
  const errno = errnoByCode[code];
  const message = messageByCode[code];
  const path = "path" in error ? error.path : undefined;
  if (
    errno === undefined ||
    message === undefined ||
    typeof path !== "string"
  ) {
    return String(error);
  }
  return `[Errno ${errno}] ${message}: ${pythonQuotedPath(path)}`;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function appendRawPath(base: string, suffix: string): string {
  if (!suffix) return base;
  return base.endsWith(sep) ? `${base}${suffix}` : `${base}${sep}${suffix}`;
}

// Python Path.resolve(strict=False), resolving links before later `..` parts.
function resolveConfiguredPath(
  path: string,
  name: string,
  linkDepth = 0,
  diagnosticPath = path,
): string {
  if (linkDepth > 40) {
    throw new PythonRuntimeError(pythonSymlinkLoop(diagnosticPath));
  }
  const root = parse(path).root;
  if (!root) throw new RootError(`${name} must be an absolute path`);
  let resolved = root;
  const parts = path.slice(root.length).split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const candidate = join(resolved, part);
    try {
      resolved = realpathSync(candidate);
    } catch (error) {
      if (!isMissingPath(error)) {
        if (isSymlinkLoop(error)) {
          throw new PythonRuntimeError(pythonSymlinkLoop(diagnosticPath));
        }
        throw new RootError(`unsafe ${name} ${path}: ${pythonOSError(error)}`);
      }
      let target: string | null = null;
      try {
        if (lstatSync(candidate).isSymbolicLink()) {
          target = readlinkSync(candidate);
        }
      } catch (linkError) {
        if (!isMissingPath(linkError)) {
          throw new RootError(
            `unsafe ${name} ${path}: ${pythonOSError(linkError)}`,
          );
        }
      }
      if (target !== null) {
        const targetPath = isAbsolutePath(target)
          ? target
          : appendRawPath(resolved, target);
        return resolveConfiguredPath(
          appendRawPath(targetPath, parts.slice(index + 1).join(sep)),
          name,
          linkDepth + 1,
          diagnosticPath,
        );
      }
      resolved = candidate;
    }
  }
  return resolved;
}

function resolveConfiguredRoot(path: string, name: string): string {
  try {
    return resolveConfiguredPath(path, name);
  } catch (error) {
    if (error instanceof PythonRuntimeError) {
      throw new RootError(`unsafe ${name} ${path}: ${error.message}`);
    }
    throw error;
  }
}

function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return (
    remainder === "" ||
    (remainder !== ".." &&
      !remainder.startsWith(`..${sep}`) &&
      !isAbsolutePath(remainder))
  );
}

function defaultState(home: string, env: Environment): string {
  const xdg = envValue(env, "XDG_CONFIG_HOME");
  const base = xdg && isAbsolutePath(xdg) ? xdg : join(home, ".config");
  return absolute(join(base, "recurse"), "Recurse state root", home);
}

/** Resolve the settings and Pi roots without creating either directory. */
export function resolveRoots(environ: Environment = process.env): Roots {
  const envHome = envValue(environ, "HOME");
  const home = absolute(envHome || homedir(), "HOME", envHome || homedir());
  let state = envHas(environ, "RECURSE_HOME")
    ? absolute(envValue(environ, "RECURSE_HOME") ?? "", "RECURSE_HOME", home)
    : defaultState(home, environ);
  state = resolveConfiguredRoot(state, "RECURSE_HOME");
  if (state === parse(state).root) {
    throw new RootError("RECURSE_HOME must not be the filesystem root");
  }

  let piAgent = envHas(environ, "PI_CODING_AGENT_DIR")
    ? absolute(
        envValue(environ, "PI_CODING_AGENT_DIR") ?? "",
        "PI_CODING_AGENT_DIR",
        home,
      )
    : join(state, "pi-agent");
  piAgent = resolveConfiguredRoot(piAgent, "PI_CODING_AGENT_DIR");
  if (piAgent === state || !contains(state, piAgent)) {
    throw new RootError(
      "PI_CODING_AGENT_DIR must be a descendant of RECURSE_HOME",
    );
  }
  return { state, piAgent };
}

/** The persistent state environment for Pi processes. */
export function piRuntimeEnvironment(roots: Roots): Record<string, string> {
  return {
    RECURSE_HOME: roots.state,
    PI_CODING_AGENT_DIR: roots.piAgent,
    RTK_DB_PATH: join(roots.state, "rtk/history.db"),
    RTK_TEE_DIR: join(roots.state, "rtk/tee"),
    RTK_TELEMETRY_DISABLED: "1",
    RTK_NO_TOML: "1",
  };
}

export function stateHome(environ: Environment = process.env): string {
  return resolveRoots(environ).state;
}

/** Validate a CLI-supplied path before it is used by an isolated launch. */
export function validateIsolatedPath(
  value: string,
  name: string,
  environ: Environment = process.env,
): void {
  const declared = envValue(environ, "RECURSE_ISOLATED_ROOT");
  if (declared === undefined) return;
  const home = envValue(environ, "HOME") || homedir();
  const root = absolute(declared, "RECURSE_ISOLATED_ROOT", home);
  const path = absolute(value, name, home);
  if (path !== root && !contains(root, path)) {
    throw new RootError(
      `isolated launch path ${name} escapes RECURSE_ISOLATED_ROOT`,
    );
  }
}

function fileMode(mode: bigint): bigint {
  return mode & 0o7777n;
}

function isRegularFile(mode: bigint): boolean {
  return (mode & FILE_TYPE_MASK) === REGULAR_FILE;
}

function descriptorNames(): string[] {
  try {
    return readdirSync(DESCRIPTOR_DIRECTORY);
  } catch (error) {
    throw new RootError(
      `cannot verify isolated file descriptors: ${pythonOSError(error)}`,
    );
  }
}

function validLockDescriptor(
  fdValue: string | undefined,
  env: Environment,
): number | null {
  if (
    fdValue === undefined ||
    !/^[\t-\r\x1c-\x20]*[+-]?\d+[\t-\r\x1c-\x20]*$/.test(fdValue)
  ) {
    return null;
  }
  const fd = Number(fdValue.trim());
  const chatDataDir = envValue(env, "CHAT_DATA_DIR");
  if (!Number.isSafeInteger(fd) || fd < 0 || !chatDataDir) return null;
  try {
    const opened = fstatSync(fd, { bigint: true });
    const onDisk = lstatSync(join(chatDataDir, ".recurse-supervisor.lock"), {
      bigint: true,
    });
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    return isRegularFile(opened.mode) &&
      opened.uid === BigInt(uid) &&
      opened.nlink === 1n &&
      fileMode(opened.mode) === 0o600n &&
      opened.dev === onDisk.dev &&
      opened.ino === onDisk.ino
      ? fd
      : null;
  } catch {
    return null;
  }
}

function inheritedDescriptorNames(allowedFd: number | null): string[] {
  const result: string[] = [];
  let urandom: BigIntStats | null = null;
  try {
    urandom = statSync("/dev/urandom", { bigint: true });
  } catch {
    // Invariant: If unavailable, no descriptor can match the process-local
    // exception.
  }
  for (const raw of descriptorNames()) {
    if (!/^\d+$/.test(raw)) continue;
    const fd = Number(raw);
    if (fd <= 2 || fd === allowedFd) continue;
    let opened;
    try {
      opened = fstatSync(fd, { bigint: true });
    } catch {
      continue;
    }
    if (
      urandom !== null &&
      (opened.mode & FILE_TYPE_MASK) === CHARACTER_DEVICE &&
      opened.rdev === urandom.rdev
    ) {
      continue;
    }
    if (closeOnExecFlag(fd) === 1) continue;
    result.push(`fd:${fd}`);
  }
  return result;
}

// Validate the private root, every declared path, and inherited secrets/fds.
export function validateIsolatedEnvironment(environ: Environment): void {
  const declared = envValue(environ, "RECURSE_ISOLATED_ROOT");
  if (declared === undefined) return;
  if (!pythonTrim(declared)) {
    throw new RootError("RECURSE_ISOLATED_ROOT must not be empty");
  }
  const root = normalize(declared);
  if (!isAbsolutePath(root) || root === parse(root).root) {
    throw new RootError(
      "RECURSE_ISOLATED_ROOT must be an absolute private directory",
    );
  }
  let resolvedRoot: string;
  let rootInfo;
  try {
    resolvedRoot = realpathSync(root);
    rootInfo = lstatSync(root, { bigint: true });
  } catch (error) {
    throw new RootError(
      `unsafe RECURSE_ISOLATED_ROOT: ${pythonOSError(error)}`,
    );
  }
  const uid = process.getuid?.();
  if (
    resolvedRoot !== root ||
    (rootInfo.mode & FILE_TYPE_MASK) !== DIRECTORY ||
    uid === undefined ||
    rootInfo.uid !== BigInt(uid) ||
    (fileMode(rootInfo.mode) & 0o077n) !== 0n ||
    (fileMode(rootInfo.mode) & 0o700n) === 0n
  ) {
    throw new RootError(
      "RECURSE_ISOLATED_ROOT must be a real user-owned directory no one else can reach",
    );
  }

  for (const name of Object.keys(STRICT_ISOLATED_PATH_ENV)) {
    const raw = envValue(environ, name);
    if (!raw) {
      throw new RootError(
        `isolated launch requires explicit scratch path ${name}`,
      );
    }
    if (!isAbsolutePath(raw)) {
      throw new RootError(`isolated launch path ${name} must be absolute`);
    }
    const resolved = resolveConfiguredPath(raw, name);
    if (resolved !== root && !contains(root, resolved)) {
      throw new RootError(
        `isolated launch path ${name} escapes RECURSE_ISOLATED_ROOT`,
      );
    }
  }
  const envFile = envValue(environ, "RECURSE_ENV_FILE");
  if (envFile) {
    if (!isAbsolutePath(envFile)) {
      throw new RootError(
        "isolated launch path RECURSE_ENV_FILE escapes RECURSE_ISOLATED_ROOT",
      );
    }
    const resolved = resolveConfiguredPath(envFile, "RECURSE_ENV_FILE");
    if (resolved !== root && !contains(root, resolved)) {
      throw new RootError(
        "isolated launch path RECURSE_ENV_FILE escapes RECURSE_ISOLATED_ROOT",
      );
    }
  }

  const forbidden = [...ISOLATED_FORBIDDEN_ENV]
    .filter((name) => envHas(environ, name))
    .sort();
  const inheritedFds = Object.keys(environ)
    .filter((name) => name.endsWith("_FD"))
    .sort();
  const lockName = "RECURSE_DATA_DIR_LOCK_FD";
  const allowedFd = inheritedFds.includes(lockName)
    ? validLockDescriptor(envValue(environ, lockName), environ)
    : null;
  if (allowedFd !== null)
    inheritedFds.splice(inheritedFds.indexOf(lockName), 1);
  const unnamedFds = inheritedDescriptorNames(allowedFd);
  if (forbidden.length || inheritedFds.length || unnamedFds.length) {
    throw new RootError(
      `isolated launch inherited credentials or file descriptors: ${[
        ...forbidden,
        ...inheritedFds,
        ...unnamedFds,
      ].join(", ")}`,
    );
  }
}

let warnedCodeHome = false;

function warnUnusedCodeHome(environ: Environment): void {
  if (envHas(environ, "RECURSE_CODE_HOME") && !warnedCodeHome) {
    console.error(
      "RECURSE_CODE_HOME is no longer used; tools build under " +
        "<checkout>/.recurse",
    );
    warnedCodeHome = true;
  }
}

/** Check launch isolation before resolving configured persistent roots. */
export function validateLaunchEnvironment(environ: Environment): void {
  warnUnusedCodeHome(environ);
  validateIsolatedEnvironment(environ);
  resolveRoots(environ);
}

/** Return a minimal child environment for a strict isolated launch. */
export function isolatedSubprocessEnvironment(
  environ: Environment = process.env,
): Record<string, string> {
  if (!envHas(environ, "RECURSE_ISOLATED_ROOT")) {
    return Object.fromEntries(
      Object.entries(environ).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  }
  return Object.fromEntries(
    Object.entries(environ).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && ISOLATED_CHILD_ENV_ALLOWLIST.has(entry[0]),
    ),
  );
}

const REPORTED_PERMISSIVE_ROOTS = new Set<string>();

async function exists(path: string): Promise<boolean> {
  try {
    await statAsync(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a directory tree; a fresh private leaf is made 0700. */
async function ensureDir(path: string, privateLeaf: boolean): Promise<void> {
  const existed = await exists(path);
  await mkdir(path, { recursive: true });
  if (privateLeaf && !existed) {
    // Invariant: Permissions are advisory for existing installations; a fresh
    // private leaf is restricted even when the umask is looser than 077.
    await chmod(path, 0o700).catch(() => undefined);
  }
}

/** Require a root to be ours while leaving its mode advisory. */
async function checkOwned(path: string): Promise<void> {
  let info: BigIntStats;
  try {
    info = await statAsync(path, { bigint: true });
  } catch (error) {
    throw new RootError(`unsafe Recurse root ${path}: ${errorText(error)}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== BigInt(uid))
    throw new RootError(`Recurse root is not owned by uid ${uid}: ${path}`);
  const mode = Number(info.mode & 0o7777n);
  const identity = `${info.dev}:${info.ino}`;
  if (mode & 0o077 && !REPORTED_PERMISSIVE_ROOTS.has(identity)) {
    REPORTED_PERMISSIVE_ROOTS.add(identity);
    process.stderr.write(
      `[recurse] warning: ${path} is mode ${mode.toString(8).padStart(4, "0")}; group or other can ` +
        `reach stored credentials below it (chmod 0700 to restrict)\n`,
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Create and validate the private Pi directory (prepare_pi_agent_dir). */
export async function preparePiAgentDir(roots: Roots): Promise<void> {
  try {
    await ensureDir(roots.state, true);
    await ensureDir(roots.piAgent, true);
    await checkOwned(roots.piAgent);
  } catch (error) {
    if (error instanceof RootError) throw error;
    // Invariant: Python wraps only OSError: an error with an errno code.
    if (typeof (error as NodeJS.ErrnoException)?.code !== "string") throw error;
    throw new RootError(
      `unsafe PI_CODING_AGENT_DIR ${roots.piAgent}: ${errorText(error)}`,
    );
  }
}
