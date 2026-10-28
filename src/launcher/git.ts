// Fail-soft launcher Git reads keep serving the current generation on errors.
// Setup clones URLs once, links local Git targets, leaves plain dirs untouched.
// Changed URL/failed or deleted clone requires operator repair, never
// repointing.
import { lstat, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { RECURSE_REPO_URL } from "../config";
import { gitEnv } from "../workdir_git";
import { logError, run, say, type RunResult } from "./system";

/** Token for GitHub clone/push; never stored in Git config. */
export const CRED_HELPER =
  '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f';

/** The directory at the launcher's own checkout root. */
export const HERE = join(import.meta.dir, "..", "..");

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** os.path.lexists: true for any entry, including a dangling link. */
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Full path to git; an actionable error when it is missing. */
export function gitBin(): string {
  const git = Bun.which("git");
  if (git === null) throw new Error("git executable not found on PATH");
  return git;
}

/** `git -C repo args...` under the scrubbed Git environment. */
export function git(repoDir: string, ...args: string[]): Promise<RunResult> {
  return run([gitBin(), "-C", repoDir, ...args], {
    env: gitEnv(process.env),
    timeoutSeconds: 120,
  });
}

export type GitRunner = typeof git;

/** The checkout's HEAD commit, or null on any error. */
export async function headSha(
  repoDir: string,
  runGit: GitRunner = git,
): Promise<string | null> {
  try {
    const result = await runGit(repoDir, "rev-parse", "HEAD");
    return result.returncode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Follow Recurse's default-on feature-flag spelling convention. */
export function selfDeployEnabledByEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = (env.RECURSE_SELF_DEPLOY ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_LOG",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
];

/** A merge/rebase/bisect owns HEAD; defer redeploy until it completes. */
export async function gitOperationInProgress(
  repoDir: string,
  runGit: GitRunner = git,
): Promise<boolean> {
  let result: RunResult;
  try {
    result = await runGit(repoDir, "rev-parse", "--absolute-git-dir");
  } catch {
    return true;
  }
  if (result.returncode !== 0) return true;
  const gitDir = result.stdout.trim();
  for (const marker of OPERATION_MARKERS)
    if (await exists(join(gitDir, marker))) return true;
  return false;
}

/** config.REPO_URL: CHAT_REPO_URL, else Recurse's own repository. */
export function repoUrl(): string {
  return process.env.CHAT_REPO_URL ?? RECURSE_REPO_URL;
}

// Serve the launcher's checkout, never the agent target clone.
// Return code dir/self-deploy choice without coupling UI to agent checkout
// HEAD.
export async function prepareCodeSource(
  dataDir: string,
  codeDir: string = HERE,
): Promise<[codeDir: string, headWatch: boolean]> {
  await prepareWorkingArea(join(dataDir, "repo"));
  return [codeDir, selfDeployEnabledByEnv()];
}

/**
 * Prepare the agents' working area once at launch. Never throws: failures
 * are logged and the server's fail-fast names the fix.
 */
export async function prepareWorkingArea(repoDir: string): Promise<void> {
  const target = repoUrl();
  if (target && (await isDirectory(target))) {
    await attachInPlaceWorktree(repoDir, target);
    return;
  }
  // Invariant: Never repoint a previously cloned target.
  if (await exists(join(repoDir, ".git"))) return;
  if (!target) {
    say(
      "[supervisor] no target configured; the server will fail fast " +
        "(run setup with a target)",
    );
    return;
  }
  try {
    // Invariant: A previous run may have left repo_dir populated without a .git
    // (a half-done clone); git clone refuses a non-empty directory, and the
    // directory is Recurse-owned, so clear it first.
    if (await isDirectory(repoDir))
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    say(`[supervisor] cloning target into ${repoDir}…`);
    // Invariant: `--` keeps a hostile-looking URL in the repository position.
    const result = await run(
      [
        gitBin(),
        "-c",
        `credential.helper=${CRED_HELPER}`,
        "clone",
        "--",
        target,
        repoDir,
      ],
      { env: gitEnv(process.env), timeoutSeconds: 24 * 3600 },
    );
    if (result.returncode === 0) {
      await git(repoDir, "config", "credential.helper", CRED_HELPER);
    } else {
      say(
        "[supervisor] clone failed " +
          `(return code ${result.returncode}); the server will fail fast ` +
          "— rerun setup with a reachable target",
      );
    }
  } catch (error) {
    logError("supervisor_clone_failed", error);
  }
}

// Attach the canonical detached worktree for a local Git target. The target's
// working tree and branches are never touched. Existing user config is kept.
// A plain directory
// (no .git) needs nothing: agents work in the target itself.
export async function attachInPlaceWorktree(
  repoDir: string,
  source: string,
): Promise<void> {
  if (!(await exists(join(source, ".git")))) return;
  if (await exists(join(repoDir, ".git"))) return;
  try {
    await git(source, "remote", "set-head", "origin", "--auto");
    const base = await git(
      source,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    );
    let baseRef: string;
    if (base.returncode === 0 && base.stdout.trim())
      baseRef = base.stdout.trim();
    else {
      const head = await git(source, "symbolic-ref", "--short", "HEAD");
      baseRef = head.stdout.trim() || "HEAD";
    }
    // Invariant: `git worktree add` refuses a non-empty directory; a leftover
    // repo_dir with no live worktree would wedge every launch. --force reuses a
    // stale registration without a repo-wide prune.
    if (await isDirectory(repoDir))
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    // Invariant: `--` keeps a hostile branch name in the commit position.
    await git(
      source,
      "worktree",
      "add",
      "--force",
      "--detach",
      repoDir,
      "--",
      baseRef,
    );
  } catch (error) {
    logError("supervisor_in_place_setup_failed", error);
  }
}

/**
 * A Recurse checkout: the guide, launcher, and split TypeScript agents and web
 * modules.
 */
export async function isRecurseCheckout(root: string): Promise<boolean> {
  return (
    (await isFile(join(root, "AGENTS.md"))) &&
    (await isFile(join(root, "src/local.ts"))) &&
    (await isFile(join(root, "src", "agents", "instance.ts"))) &&
    (await isFile(join(root, "src", "web", "app.ts")))
  );
}
