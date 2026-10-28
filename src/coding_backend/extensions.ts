// Resolve Recurse-controlled source/worktree roots trusted by pi-safety's
// file-review bypasses. Launch exports RECURSE_WORKSPACE_ROOT and
// RECURSE_WORKTREES_ROOT from explicit repo/worktrees/HOME/ready inputs.
import { stat, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Path.resolve(strict=True) that is a directory, else null. */
export async function resolvedDirectory(
  path: string | null | undefined,
): Promise<string | null> {
  if (path === null || path === undefined) return null;
  try {
    const resolved = await realpath(path === "" ? "." : path);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function expandUser(path: string, home: string | undefined): string {
  if (home === undefined || !(path === "~" || path.startsWith("~/")))
    return path;
  return home + path.slice(1);
}

export interface SafetyRootInputs {
  repoUrl: string;
  repoDir: string;
  worktrees: string;
  home?: string;
  /** workdir_git.ready() */
  workdirReady: () => Promise<boolean>;
}

/** The Recurse-controlled source root for file-review bypasses. */
export async function piSafetyWorkspaceRoot(
  inputs: SafetyRootInputs,
): Promise<string | null> {
  const target = expandUser(inputs.repoUrl, inputs.home);
  if (
    (await resolvedDirectory(target)) !== null &&
    (await exists(join(target, ".git")))
  )
    return resolvedDirectory(target);
  return (await inputs.workdirReady())
    ? resolvedDirectory(inputs.repoDir)
    : null;
}

/** The fixed managed-worktree root, never an active turn's cwd. */
export async function piSafetyWorktreesRoot(
  inputs: SafetyRootInputs,
): Promise<string | null> {
  return (await inputs.workdirReady())
    ? resolvedDirectory(inputs.worktrees)
    : null;
}
