// Trusted roots resolve asynchronously per run; action targets are rechecked.
import fs from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { protectedConfigDirs, protectedConfigPaths } from "./policy.ts";

export const WORKSPACE_ROOT_ENV = "RECURSE_WORKSPACE_ROOT";
export const WORKTREES_ROOT_ENV = "RECURSE_WORKTREES_ROOT";

export type TrustedPathScope = {
  workspace: string;
  worktrees?: string;
  tmp: string;
  agentTmp?: string;
  dataDir?: string;
  configDir?: string;
};

const FILE_SCOPED_TOOLS = new Set(["write", "edit"]);
const CREDENTIAL_DOTFILES = new Set([
  ".env",
  ".envrc",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
]);

async function realDirectory(
  value: string | undefined,
): Promise<string | undefined> {
  if (!value || !isAbsolute(value)) return undefined;
  try {
    const resolved = await realpath(value);
    return (await stat(resolved)).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Resolve existing targets and collect symlink hops. lstat distinguishes
// dangling links from nonexistent suffixes, so an unproven destination fails
// closed.
function collectSymlinkDestinations(
  path: string,
  destinations: string[],
  visited = new Set<string>(),
): boolean {
  const root = parse(path).root;
  let prefix = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    prefix = join(prefix, part);
    let symbolic = false;
    try {
      // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
      symbolic = fs.lstatSync(prefix).isSymbolicLink();
    } catch (error) {
      // Invariant: Only a missing prefix proves the remaining suffix
      // nonexistent.
      return isMissing(error);
    }
    if (!symbolic || visited.has(prefix)) continue;
    visited.add(prefix);
    try {
      // Invariant: Keep outside intermediate symlink hops even if realpath
      // returns inside. Resolve relative links from their physical parent, not
      // an alias's lexical depth.
      // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
      const physicalParent = fs.realpathSync.native(dirname(prefix));
      // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
      const linkTarget = fs.readlinkSync(prefix);
      // Invariant: Reject parent traversal rather than hiding symlink hops with
      // lexical collapse of `..`.
      if (linkTarget.split(/[\\/]/).includes("..")) return false;
      const immediate = resolve(physicalParent, linkTarget);
      destinations.push(immediate);
      if (!collectSymlinkDestinations(immediate, destinations, visited))
        return false;
      // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
      destinations.push(fs.realpathSync.native(prefix));
    } catch {
      // Invariant: A dangling symlink is not a new path.
      return false;
    }
  }
  return true;
}

function resolveTarget(
  cwd: string,
  value: string,
):
  | {
      lexical: string;
      real: string;
      symlinkDestinations: string[];
    }
  | undefined {
  if (!value || value.includes("\0")) return undefined;
  // Invariant: Explicit parent traversal remains reviewed; lexical resolution
  // can change symlink/`..` semantics.
  if (value.split(/[\\/]/).includes("..")) return undefined;

  const lexical = resolve(cwd, value);
  const symlinkDestinations: string[] = [];
  if (!collectSymlinkDestinations(lexical, symlinkDestinations))
    return undefined;

  let cursor = lexical;
  const suffix: string[] = [];
  while (true) {
    try {
      // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
      fs.lstatSync(cursor);
    } catch (error) {
      if (!isMissing(error)) return undefined;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      suffix.unshift(basename(cursor));
      cursor = parent;
      continue;
    }
    try {
      return {
        lexical,
        // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
        real: resolve(fs.realpathSync.native(cursor), ...suffix),
        symlinkDestinations,
      };
    } catch {
      return undefined;
    }
  }
}

// Match Pi Durable's tool-path spelling without rewriting the submitted path.
function piToolPath(path: string): string | undefined {
  let value = path
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/^@/, "");
  if (value === "~" || value.startsWith("~/"))
    value = homedir() + value.slice(1);
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function fileIdentity(path: string) {
  // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
  const { dev, ino } = fs.statSync(path, { bigint: true });
  return `${dev}:${ino}`;
}

// realpath cannot return a dangling link's destination. Follow its existing
// prefixes without losing the kernel's symlink-before-`..` ordering.
function missingDestination(path: string): string | undefined {
  let prefix = parse(path).root;
  let parts = path.slice(prefix.length).split(sep);
  let links = 0;
  while (parts.length) {
    const part = parts.shift()!;
    const candidate = resolve(prefix, part);
    try {
      // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        if (++links > 40) return undefined;
        // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
        let link = fs.readlinkSync(candidate);
        if (isAbsolute(link)) {
          prefix = parse(link).root;
          link = link.slice(prefix.length);
        }
        parts = [...link.split(sep), ...parts];
      } else prefix = candidate;
    } catch (error) {
      return isMissing(error) && !parts.includes("..")
        ? resolve(candidate, ...parts)
        : undefined;
    }
  }
  return prefix;
}

function realDestination(path: string): string | undefined {
  try {
    // oxlint-disable-next-line no-restricted-properties -- known: main-thread safety path-scope validation
    return fs.realpathSync(path);
  } catch (error) {
    return isMissing(error) ? missingDestination(path) : undefined;
  }
}

function configTarget(configDir: string, target: string) {
  let identity: string | undefined;
  let destination: string | undefined;
  let unknown = false;
  try {
    identity = fileIdentity(target);
  } catch (error) {
    if (isMissing(error)) destination = missingDestination(target);
    if (!destination) unknown = true;
  }
  for (const dir of protectedConfigDirs(configDir)) {
    // Inside the directory itself, or reached through a link.
    const real = realDestination(target) ?? destination;
    if (
      contained(dir, target) ||
      (real && contained(realDestination(dir) ?? dir, real))
    )
      return { path: dir, unknown: false };
    if (!real) unknown = true;
  }
  for (const path of protectedConfigPaths(configDir)) {
    if (target === path) return { path, unknown: false };
    try {
      // Both symlinks and hard links can grant access to the same live file.
      if (fileIdentity(path) === identity) return { path, unknown: false };
    } catch (error) {
      const missing = isMissing(error) ? missingDestination(path) : undefined;
      if (!missing) unknown = true;
      else if (missing === destination) return { path, unknown: false };
    }
  }
  return { path: undefined, unknown };
}

/** Trusted evidence when a file tool resolves to an operator configuration. */
export function protectedFileTarget(
  configDir: string,
  cwd: string,
  path: unknown,
): string | undefined {
  const value = typeof path === "string" ? piToolPath(path) : undefined;
  return value ? configTarget(configDir, resolve(cwd, value)).path : undefined;
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  );
}

function relativeParts(root: string, target: string): string[] {
  const child = relative(root, target);
  return child ? child.split(sep).filter(Boolean) : [];
}

function credentialDotfile(part: string): boolean {
  return CREDENTIAL_DOTFILES.has(part) || part.startsWith(".env.");
}

function isProtectedDataPath(
  dataDir: string | undefined,
  target: string,
): boolean {
  if (!dataDir || !contained(dataDir, target)) return false;
  const checkout = relativeParts(dataDir, target)[0];
  return checkout !== "repo" && checkout !== "worktrees";
}

// Always review Git internals and credential dotfiles. Carve `.recurse-data*`
// out of allowed roots except exact repo/worktrees subtrees; component
// boundaries prevent aliases such as repo-evil from exposing conversation
// state.
function isCarvedOut(parts: readonly string[]): boolean {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === ".git" || credentialDotfile(part)) return true;
    if (part.startsWith(".recurse-data")) {
      const child = parts[index + 1];
      if (child !== "repo" && child !== "worktrees") return true;
    }
  }
  return false;
}

/** Resolve the runner-provided roots once, before any model action runs. */
export async function loadTrustedPathScope(
  env: NodeJS.ProcessEnv,
  configDir?: string,
): Promise<TrustedPathScope | undefined> {
  const [workspace, worktrees, tmp, agentTmp, dataDir] = await Promise.all([
    realDirectory(env[WORKSPACE_ROOT_ENV]),
    realDirectory(env[WORKTREES_ROOT_ENV]),
    realDirectory("/tmp"),
    realDirectory(env.RECURSE_AGENT_TMPDIR),
    realDirectory(env.CHAT_DATA_DIR),
  ]);
  if (!workspace) return undefined;
  if (env[WORKTREES_ROOT_ENV] && !worktrees) return undefined;
  if (!tmp) return undefined;
  // Invariant: Unresolvable runner-owned CHAT_DATA_DIR disables the fast-path.
  if (env.CHAT_DATA_DIR && !dataDir) return undefined;
  return {
    workspace,
    ...(worktrees ? { worktrees } : {}),
    tmp,
    ...(agentTmp ? { agentTmp } : {}),
    ...(dataDir ? { dataDir } : {}),
    ...(configDir ? { configDir } : {}),
  };
}

// Allow only proven lexical and real targets under the same trusted root. A
// resolvable workspace is required even for /tmp or private scratch; symlink
// escapes and outside aliases remain reviewed.
export function allowedByPathScope(
  toolName: string,
  input: unknown,
  cwd: string,
  scope: TrustedPathScope | undefined,
): boolean {
  if (!FILE_SCOPED_TOOLS.has(toolName)) return false;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string") return false;

  if (!scope) return false;
  const value = piToolPath(path);
  const target = value ? resolveTarget(cwd, value) : undefined;
  if (!target) return false;

  // Invariant: Protect the exact state root even below /tmp or with a custom
  // name; only canonical checkout subtrees bypass review.
  if (
    [target.lexical, target.real, ...target.symlinkDestinations].some(
      (candidate) => isProtectedDataPath(scope.dataDir, candidate),
    )
  )
    return false;

  const candidates = [
    target.lexical,
    target.real,
    ...target.symlinkDestinations,
  ];
  // Recheck configuration links as well as the action, including links made
  // after the first call in the run. An unresolved link can't prove safety.
  if (scope.configDir) {
    const config = configTarget(scope.configDir, target.lexical);
    if (config.path || config.unknown) return false;
  }
  const worktreesRoot = scope.worktrees;
  if (
    worktreesRoot &&
    candidates.some((candidate) => {
      if (!contained(worktreesRoot, candidate)) return false;
      const first = relativeParts(worktreesRoot, candidate)[0];
      return (
        first === ".managed" || first === ".markers" || first === "TO_REAP"
      );
    })
  )
    return false;

  const roots = [
    scope.workspace,
    scope.worktrees,
    scope.tmp,
    scope.agentTmp,
  ].filter((root): root is string => root !== undefined);
  for (const root of new Set(roots)) {
    if (!contained(root, target.lexical) || !contained(root, target.real))
      continue;
    if (
      target.symlinkDestinations.some(
        (destination) => !contained(root, destination),
      )
    )
      continue;
    if (isCarvedOut(relativeParts(root, target.lexical))) return false;
    if (isCarvedOut(relativeParts(root, target.real))) return false;
    if (
      target.symlinkDestinations.some((destination) =>
        isCarvedOut(relativeParts(root, destination)),
      )
    )
      return false;
    return true;
  }
  return false;
}
