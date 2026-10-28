import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
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

export const WORKSPACE_ROOT_ENV = "RECURSE_WORKSPACE_ROOT";
export const WORKTREES_ROOT_ENV = "RECURSE_WORKTREES_ROOT";

export type TrustedPathScope = {
  workspace: string;
  worktrees?: string;
  tmp: string;
  agentTmp?: string;
  dataDir?: string;
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

function realDirectory(value: string | undefined): string | undefined {
  if (!value || !isAbsolute(value)) return undefined;
  try {
    const resolved = realpathSync.native(value);
    return statSync(resolved).isDirectory() ? resolved : undefined;
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
      symbolic = lstatSync(prefix).isSymbolicLink();
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
      const physicalParent = realpathSync.native(dirname(prefix));
      const linkTarget = readlinkSync(prefix);
      // Invariant: Reject parent traversal rather than hiding symlink hops with
      // lexical collapse of `..`.
      if (linkTarget.split(/[\\/]/).includes("..")) return false;
      const immediate = resolve(physicalParent, linkTarget);
      destinations.push(immediate);
      if (!collectSymlinkDestinations(immediate, destinations, visited))
        return false;
      destinations.push(realpathSync.native(prefix));
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
      lstatSync(cursor);
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
        real: resolve(realpathSync.native(cursor), ...suffix),
        symlinkDestinations,
      };
    } catch {
      return undefined;
    }
  }
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
export function loadTrustedPathScope(
  env: NodeJS.ProcessEnv,
): TrustedPathScope | undefined {
  const workspace = realDirectory(env[WORKSPACE_ROOT_ENV]);
  if (!workspace) return undefined;
  const worktrees = realDirectory(env[WORKTREES_ROOT_ENV]);
  if (env[WORKTREES_ROOT_ENV] && !worktrees) return undefined;
  const tmp = realDirectory("/tmp");
  if (!tmp) return undefined;
  const agentTmp = realDirectory(env.RECURSE_AGENT_TMPDIR);
  // Invariant: Unresolvable runner-owned CHAT_DATA_DIR disables the fast-path.
  const dataDir = realDirectory(env.CHAT_DATA_DIR);
  if (env.CHAT_DATA_DIR && !dataDir) return undefined;
  return {
    workspace,
    ...(worktrees ? { worktrees } : {}),
    tmp,
    ...(agentTmp ? { agentTmp } : {}),
    ...(dataDir ? { dataDir } : {}),
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
  const target = resolveTarget(cwd, path);
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
