// Artifact Git commands run asynchronously with bounded output and deadlines.
import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { slowSpan, timed } from "../../observability";
import * as startupMetrics from "../../observability";
import {
  ArtifactCorrupt,
  ArtifactError,
  ArtifactLimit,
  errorCode,
  type ResolvedContext,
} from "./layout";

export const GIT_OUTPUT_MAX = 2 * 1024 * 1024;
export const GIT_NAME = "recurse-artifacts";
export const GIT_EMAIL = "recurse-artifacts@localhost";
export type GitResult = {
  readonly returncode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

function gitDate(ctx: ResolvedContext): string {
  return ctx
    .now()
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z");
}

function gitEnv(ctx: ResolvedContext): Record<string, string> {
  const date = gitDate(ctx);
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_NOGLOBAL: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: GIT_NAME,
    GIT_AUTHOR_EMAIL: GIT_EMAIL,
    GIT_COMMITTER_NAME: GIT_NAME,
    GIT_COMMITTER_EMAIL: GIT_EMAIL,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

function killProcessGroup(pid: number): void {
  try {
    // Invariant: Bun's detached child is the group leader. A negative pid kills
    // Git and any helper it started, not just the immediate Git process.
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") return;
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onLimit: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > limit) {
        onLimit();
        throw new ArtifactLimit("artifact Git output exceeds the limit");
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function spawnGit(
  ctx: ResolvedContext,
  argv: readonly string[],
  limit = GIT_OUTPUT_MAX,
  env: Readonly<Record<string, string>> = {},
): Promise<GitResult> {
  const controller = new AbortController();
  let timedOut = false;
  let tooLarge = false;
  startupMetrics.count("artifact_git_subprocesses");
  const child = slowSpan("artifact_git_spawn", undefined, () =>
    Bun.spawn(["git", ...argv], {
      cwd: "/",
      env: { ...gitEnv(ctx), ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      signal: controller.signal,
    }),
  );
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    killProcessGroup(child.pid);
  }, ctx.gitTimeoutMs);
  const cancel = () => {
    tooLarge = true;
    controller.abort();
    killProcessGroup(child.pid);
  };
  try {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr)
      throw new ArtifactCorrupt("artifact Git operation failed");
    const [out, err, returncode] = await Promise.all([
      readBounded(stdout, limit, cancel),
      readBounded(stderr, limit, cancel),
      child.exited,
    ]);
    if (timedOut) throw new ArtifactCorrupt("artifact Git operation timed out");
    return { returncode, stdout: out, stderr: err };
  } catch (error) {
    killProcessGroup(child.pid);
    controller.abort();
    try {
      await child.exited;
    } catch {
      // Invariant: The bounded runner's public errors do not depend on the
      // child status.
    }
    if (error instanceof ArtifactError) throw error;
    if (timedOut) throw new ArtifactCorrupt("artifact Git operation timed out");
    if (tooLarge)
      throw new ArtifactLimit("artifact Git output exceeds the limit");
    throw new ArtifactCorrupt("artifact Git operation failed");
  } finally {
    clearTimeout(timer);
    // Invariant: A Git command that leaves a descendant behind is not allowed
    // to leak it.
    if (child.exitCode === null) killProcessGroup(child.pid);
  }
}

export function decode(bytes: Uint8Array): string {
  // Invariant: Python UTF-8 decoding preserves a leading U+FEFF instead of
  // stripping it.
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
    bytes,
  );
}

export function decodeStrict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}

export function git(...args: Parameters<typeof runGit>): Promise<GitResult> {
  return timed("artifact_git", () => runGit(...args));
}

async function runGit(
  ctx: ResolvedContext,
  repo: string,
  args: readonly string[],
  options: {
    check?: boolean;
    limit?: number;
    env?: Readonly<Record<string, string>>;
  } = {},
): Promise<GitResult> {
  try {
    const info = await lstat(repo);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ArtifactCorrupt("artifact repository is unavailable");
    }
    const gitDir = await stat(join(repo, ".git"));
    if (!gitDir.isDirectory()) {
      throw new ArtifactCorrupt("artifact repository is unavailable");
    }
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactCorrupt("artifact repository is unavailable");
  }
  let result: GitResult;
  try {
    result = await timed(`artifact_git_${args[0]!.replaceAll("-", "_")}`, () =>
      spawnGit(
        ctx,
        ["-C", repo, "--no-pager", ...args],
        options.limit ?? GIT_OUTPUT_MAX,
        options.env,
      ),
    );
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactCorrupt("artifact Git operation failed");
  }
  if ((options.check ?? true) && result.returncode !== 0) {
    throw new ArtifactCorrupt("artifact Git operation failed");
  }
  return result;
}
