// Build stamps publish only after pinned installs and frontend both succeed.
// Clean equal HEAD/pins skip builds; dirty inputs always rebuild.
// Stamp paths refer to checkout node_modules; patch files are build inputs.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { randomBytes } from "node:crypto";

export const PI_VERSION = "1.3.0";
export const STAMP_NAME = ".build-stamp.json";
/** Checkout-relative files each build publishes; sizes catch patched drift. */
export const ARTIFACT_PATHS = [
  "node_modules/@earendil-works/pi-coding-agent/package.json",
  "node_modules/@ff-labs/pi-fff/package.json",
  "node_modules/@ff-labs/pi-fff/src/index.ts",
] as const;
export const BUILD_INPUTS = [
  "web",
  ":(exclude)web/dist",
  ":(exclude)web/.recurse-dist-*",
  ":(exclude)web/.recurse-dist-backup-*",
  "web/index.html",
  "package.json",
  "bun.lock",
  "src/extensions",
  "src/auth/anthropic_oauth.ts",
  "scripts/patches",
  "src/launch_cli.ts",
  "scripts/ensure-rtk.sh",
] as const;

export type SourceState = [head: string, dirty: boolean];
export interface GitResult {
  readonly stdout: string;
  readonly returncode: number;
}
export type GitRunner = (root: string, ...args: string[]) => GitResult;
export interface ExpectedStamp {
  head: string;
  dirty: boolean;
  pi_version: string;
  frontend: "built";
  artifacts: Record<string, number>;
}
export interface StampRuntime {
  readonly git?: GitRunner;
  readonly sourceState?: (root: string) => SourceState | null;
}
export interface ExpectedOptions extends StampRuntime {
  readonly state?: SourceState | null;
}

function pythonPath(path: string): string {
  const prefix =
    path.startsWith("//") && !path.startsWith("///")
      ? "//"
      : path.startsWith("/")
        ? "/"
        : "";
  const body = path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return body ? `${prefix}${body}` : prefix || ".";
}

function appendPath(path: string, child: string): string {
  const base = pythonPath(path);
  const part = pythonPath(child);
  if (base === ".") return part;
  const parent = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${parent}/${part}`;
}

const PYTHON_WHITESPACE = new Set(
  Array.from(
    "\u0009\u000a\u000b\u000c\u000d\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000",
  ),
);

function pythonStrip(value: string): string {
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;
  while (start < end && PYTHON_WHITESPACE.has(characters[start]!)) start += 1;
  while (end > start && PYTHON_WHITESPACE.has(characters[end - 1]!)) end -= 1;
  return characters.slice(start, end).join("");
}

function executable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory || process.cwd(), name);
    try {
      if (statSync(candidate).isFile()) {
        // Invariant: Access mode 1 is execute on POSIX; Python's shutil.which
        // uses the platform's executable test too. Windows accepts PATHEXT
        // candidates.
        if (process.platform === "win32") return candidate;
        if (fsConstants.X_OK !== undefined) {
          accessSync(candidate, fsConstants.X_OK);
        }
        return candidate;
      }
    } catch {}
  }
  return null;
}

function runProcess(
  command: string,
  args: readonly string[],
  timeout: number,
  cwd?: string,
): GitResult {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? "",
    returncode: result.status ?? -1,
  };
}

function runGit(root: string, ...args: string[]): GitResult {
  const git = executable("git") ?? "/usr/bin/git";
  return runProcess(git, ["-C", root, ...args], 30_000);
}

function isOperationalError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    typeof candidate.code === "string" ||
    candidate.name === "AbortError" ||
    candidate.name === "TimeoutError"
  );
}

function sourceStateFrom(root: string, git: GitRunner): SourceState | null {
  const head = git(root, "rev-parse", "HEAD");
  const dirty = git(root, "status", "--porcelain", "--", ...BUILD_INPUTS);
  const value = pythonStrip(head.stdout);
  if (head.returncode !== 0 || dirty.returncode !== 0 || !value) return null;
  return [value, dirty.stdout.length > 0];
}

/** Return checkout HEAD and whether any build input is dirty. */
export function sourceState(
  root: string,
  git: GitRunner = runGit,
): SourceState | null {
  try {
    return sourceStateFrom(root, git);
  } catch (error) {
    if (isOperationalError(error)) return null;
    throw error;
  }
}

/** Record cheap identity for each managed file that a build publishes. */
export function artifactState(root: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const relative of ARTIFACT_PATHS) {
    const path = appendPath(root, relative);
    try {
      const info = statSync(path);
      if (info.isFile()) found[relative] = info.size;
    } catch {
      // Invariant: Missing or unreadable artifacts count as absent.
    }
  }
  return found;
}

function currentSourceState(root: string, runtime: StampRuntime) {
  return runtime.sourceState === undefined
    ? sourceState(root, runtime.git)
    : runtime.sourceState(root);
}

/** Compute the payload a clean build would publish, or null if unknown. */
export function expected(
  root: string,
  options: ExpectedOptions = {},
): ExpectedStamp | null {
  const state =
    options.state == null ? currentSourceState(root, options) : options.state;
  if (state === null) return null;
  const [head, dirty] = state;
  return {
    head,
    dirty,
    pi_version: PI_VERSION,
    frontend: "built",
    artifacts: artifactState(root),
  };
}

/** Return the on-disk build stamp path. */
export function stampPath(root: string): string {
  return appendPath(appendPath(root, ".recurse"), STAMP_NAME);
}

function pythonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "boolean" && typeof right === "number") {
    return Number(left) === right;
  }
  if (typeof right === "boolean" && typeof left === "number") {
    return left === Number(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => pythonEqual(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) && pythonEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check that the stamp matches a clean source tree and built frontend. */
export function matches(root: string, runtime: StampRuntime = {}): boolean {
  const want = expected(root, runtime);
  if (want === null || want.dirty) return false;
  let found: unknown;
  try {
    found = JSON.parse(readFileSync(stampPath(root), "utf8"));
  } catch {
    return false;
  }
  if (!pythonEqual(found, want)) return false;
  try {
    if (!statSync(appendPath(root, "web/dist/app.js")).isFile()) return false;
    let brandFiles: string[];
    try {
      brandFiles = readdirSync(appendPath(root, "web/brand"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      brandFiles = [];
    }
    return brandFiles.every((name) =>
      statSync(appendPath(root, `web/dist/brand/${name}`)).isFile(),
    );
  } catch {
    return false;
  }
}

function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(",")}]`;
  if (isRecord(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${pythonJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameState(left: SourceState, right: SourceState): boolean {
  return left[0] === right[0] && pythonEqual(left[1], right[1]);
}

// Atomically publish a stamp only if the source generation is still current.
export function write(
  root: string,
  expectedState?: SourceState | null,
  runtime: StampRuntime = {},
): boolean {
  const current = currentSourceState(root, runtime);
  if (
    current === null ||
    (expectedState != null && !sameState(current, expectedState))
  ) {
    return false;
  }
  const payload = expected(root, { ...runtime, state: current });
  if (payload === null) return false;

  const build = appendPath(root, ".recurse");
  mkdirSync(build, { recursive: true });
  const destination = stampPath(root);
  let temporary: string | null = null;
  let descriptor: number | null = null;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = appendPath(
        build,
        `${STAMP_NAME}.${randomBytes(8).toString("hex")}`,
      );
      try {
        descriptor = openSync(candidate, "wx", 0o600);
        temporary = candidate;
        break;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          continue;
        }
        throw error;
      }
    }
    if (temporary === null || descriptor === null) {
      throw new Error("could not allocate a temporary build stamp");
    }
    writeFileSync(descriptor, `${pythonJson(payload)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, destination);
    temporary = null;
    return true;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (temporary !== null) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  }
}

if (import.meta.main) {
  const [action, root, ...extra] = process.argv.slice(2);
  if (
    (action !== "check" && action !== "write") ||
    root === undefined ||
    extra.length > 0
  ) {
    process.stderr.write("usage: bun build_stamp.ts (check|write) ROOT\n");
    process.exitCode = 2;
  } else if (action === "check") {
    process.exitCode = matches(root) ? 0 : 1;
  } else {
    process.exitCode = write(root) ? 0 : 1;
  }
}
