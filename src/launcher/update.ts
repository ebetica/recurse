// Run the checkout's own install.sh --update or --check without a terminal in
// its own process group, stopped as a group on timeout or abort; name the
// update request and progress reports the supervisor and server exchange. The
// channel is what the checkout records, never RECURSE_VERSION/RECURSE_BRANCH.
import { join } from "node:path";
import { entrypointEnv } from "./build";
import type { RunResult } from "./system";

export interface UpdateRequest {
  readonly type: "update";
}

export interface UpdateReport {
  readonly type: "update-status";
  /** install.sh running, nothing newer, building, waiting for turns, etc. */
  readonly state:
    | "updating"
    | "current"
    | "building"
    | "waiting"
    | "restarting"
    | "failed";
  readonly detail: string | null;
}

/** install.sh exits 3 when the checkout follows no release tag or branch. */
export const NO_CHANNEL_EXIT = 3;

/** Seconds between SIGTERM and SIGKILL when the script's group is stopped. */
export const STOP_GRACE_SECONDS = 5;

/** Run `install.sh MODE` in `codeDir` with Git prompts off; timeout or
 * `signal` stops its group, and the result waits for its output to close. */
export async function runInstallScript(
  codeDir: string,
  mode: "--update" | "--check",
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  const env = entrypointEnv();
  delete env.RECURSE_VERSION;
  delete env.RECURSE_BRANCH;
  env.GIT_TERMINAL_PROMPT = "0";
  const child = Bun.spawn(
    [Bun.which("bash") ?? "/bin/bash", join(codeDir, "install.sh"), mode],
    {
      cwd: codeDir,
      env,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const kill = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, name);
    } catch {}
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    kill("SIGTERM");
    force ??= setTimeout(() => kill("SIGKILL"), STOP_GRACE_SECONDS * 1000);
  };
  const deadline = setTimeout(stop, timeoutSeconds * 1000);
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, returncode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // Invariant: A stopped group loses any member that closed its output.
    if (stopped) kill("SIGKILL");
    return { returncode, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    signal?.removeEventListener("abort", stop);
  }
}

/** The script's output without colour codes, at most its last 600 chars. */
export function scriptOutput(result: RunResult): string {
  return `${result.stdout}\n${result.stderr}`
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .slice(-600);
}
