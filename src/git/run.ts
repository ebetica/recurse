// Run Git and gh asynchronously with bounded stdout and process-group cleanup.
// Git reads isolate system and global config but keep repo-local settings.
import { isolatedSubprocessEnvironment } from "../local_roots";
import { countStartupMetric, slowSpan, timed } from "../observability";

type Env = Readonly<Record<string, string | undefined>>;

/** Scrubbed subprocess environment for Git and its credential helper. */
export function gitEnv(environ: Env): Record<string, string> {
  const env = isolatedSubprocessEnvironment(environ);
  delete env.RECURSE_DATA_DIR_LOCK_FD;
  if (env.GITHUB_TOKEN) env.GH_TOKEN ??= env.GITHUB_TOKEN;
  return env;
}

export function safeGitEnv(environ: Env): Record<string, string> {
  const env = gitEnv(environ);
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  return env;
}

/** Run one command with bounded kept stdout and optional stdin bytes. */
export async function runBounded(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  limit: number,
  timeout: number,
  signal?: AbortSignal,
  stdin?: Uint8Array,
): Promise<{ out: Uint8Array; truncated: boolean; code: number } | null> {
  if (signal?.aborted) return null;
  let proc: import("bun").Subprocess<"ignore", "pipe", "ignore">;
  try {
    const github = argv[0] === "gh";
    const found = slowSpan(
      github ? "gh_executable_lookup" : "git_executable_lookup",
      undefined,
      () => Bun.which(argv[0]!, { PATH: env.PATH ?? "" }),
    );
    if (found === null) return null;
    proc = slowSpan(
      github ? "workdir_gh_spawn" : "workdir_git_spawn",
      undefined,
      () =>
        Bun.spawn([found, ...argv.slice(1)], {
          cwd,
          env,
          stdin: stdin ?? "ignore",
          stdout: "pipe",
          stderr: "ignore",
          detached: true,
        }),
    );
  } catch {
    return null;
  }
  const exited = proc.exited;
  const reader = proc.stdout.getReader();
  const stopped = Promise.withResolvers<null>();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    stopped.resolve(null);
    void reader.cancel().catch(() => {});
  };
  const timer = setTimeout(stop, timeout * 1000);
  signal?.addEventListener("abort", stop, { once: true });
  const kept: Uint8Array[] = [];
  let size = 0;
  let total = 0;
  const drainStdout = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (size <= limit) {
        kept.push(value);
        size += value.length;
      }
    }
  };
  try {
    const completed = Promise.all([drainStdout(), exited]);
    const result = await Promise.race([completed, stopped.promise]);
    if (result === null || stopping) return null;
    const [, code] = result;
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of kept) {
      all.set(chunk, at);
      at += chunk.length;
    }
    return {
      out: all.subarray(0, limit),
      truncated: total > limit,
      code,
    };
  } catch {
    stop();
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (stopping) await exited.catch(() => {});
  }
}

export interface GitText {
  text: string | null;
  truncated: boolean;
  code: number;
}

const decoder = new TextDecoder("utf-8");

export async function gitText(
  env: Env,
  args: string[],
  wt: string,
  limit: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<GitText> {
  countStartupMetric("git_subprocesses");
  if (args[0] === "diff") countStartupMetric("git_diff_subprocesses");
  const r = await timed(`git.${args[0]}`, () =>
    runBounded(
      ["git", "--no-replace-objects", "--no-optional-locks", ...args],
      wt,
      safeGitEnv(env),
      limit,
      timeout,
      signal,
    ),
  );
  if (r === null) return { text: null, truncated: true, code: 1 };
  return {
    text: decoder.decode(r.out),
    truncated: r.truncated,
    code: r.code,
  };
}
