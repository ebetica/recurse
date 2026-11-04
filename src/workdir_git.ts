// Bounded async workdir Git/diff queries; lifecycle stays in tools/worktree.
// Drain stdout fully, retaining limit+1; timeout kills child without blocking.
// Fresh summaries prevent working-tree edits hiding behind a HEAD cache.
// Scrub Git env; metadata caches belong to one WorkdirGit instance.
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isolatedSubprocessEnvironment } from "./local_roots";
import * as startupMetrics from "./observability/startup_metrics";
import { timed } from "./observability/request_timing";
import { slowSpan } from "./observability/slow_span";
import { prIdentity } from "./pull_request";
import { pullRequestFiles } from "./pull_request/patch";

// Python str.isspace() code points (str.strip() and unicode \s).
const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");
function pyStrip(text: string): string {
  return text.replace(PY_STRIP_RE, "");
}

type Env = Readonly<Record<string, string | undefined>>;

export interface WorkdirGitInputs {
  repoUrl: string;
  repoDir: string;
  dataDir: string;
  /** The server's process environment (os.environ). */
  env: Env;
  /** Monotonic seconds; defaults to performance.now() / 1000. */
  now?: () => number;
  /** Log one event, e.g. each `gh` call and why it ran. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Scrubbed subprocess environment for Git and its credential helper. */
export function gitEnv(environ: Env): Record<string, string> {
  const env = isolatedSubprocessEnvironment(environ);
  delete env.RECURSE_DATA_DIR_LOCK_FD;
  if (env.GITHUB_TOKEN) env.GH_TOKEN ??= env.GITHUB_TOKEN;
  return env;
}

function safeGitEnv(environ: Env): Record<string, string> {
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

export const DIFF_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_DIFF_BYTES = 1_000_000;
export const MAX_DIFF_STAT_BYTES = 64 * 1024;
export const MAX_NUMSTAT_BYTES = 512 * 1024;
export const MAX_DIFF_FILES = 200;
export const MAX_FILE_PATCH_BYTES = 200 * 1024;
export const MAX_FILE_CONTENT_BYTES = 1_000_000;
export const MAX_UNTRACKED_NAMES = 500;
const DIFF_TIMEOUT = 10.0;
const CANDIDATE_TIMEOUT = 5.0;
const GH_TIMEOUT = 4.0;
const GH_CACHE_TTL = 20.0;
const BRANCH_PR_INTERVAL = 60.0;
const DIFF_TRUNCATION_MARK = "\n... [diff truncated at the 1 MiB server cap]\n";
const SHA_RE = /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/u;
// Python's unicode `\s` is str.isspace(), not JavaScript's `\s`.
const BASE_REF_RE = new RegExp(
  `^(?!-)[^${PY_SPACE}\\x00-\\x1f\\x7f]{1,256}$`,
  "u",
);
const AUTO_BASE_CHAIN = ["origin/main", "main", "master"];
const WORKDIR_FILE_MAX_BYTES = 8 * 1024;

/** Python `str.splitlines()` without keepends. */
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/u);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isSha(text: string): boolean {
  return SHA_RE.test(text);
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
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

/** Python `Path.resolve()` (non-strict `os.path.realpath`). */
export async function pyResolve(
  path: string,
  cwd = process.cwd(),
): Promise<string> {
  const seen = new Map<string, string | null>();
  async function join1(base: string, rest: string): Promise<string> {
    let cur = isAbsolute(rest) ? "/" : base;
    for (const name of rest.split("/")) {
      if (!name || name === ".") continue;
      if (name === "..") {
        cur = dirname(cur);
        continue;
      }
      const next = cur === "/" ? `/${name}` : `${cur}/${name}`;
      if (seen.has(next)) {
        const known = seen.get(next);
        cur = known ?? next;
        continue;
      }
      let target: string;
      try {
        if (!(await lstat(next)).isSymbolicLink()) {
          cur = next;
          continue;
        }
        target = await readlink(next);
      } catch {
        cur = next;
        continue;
      }
      seen.set(next, null);
      cur = await join1(cur, target);
      seen.set(next, cur);
    }
    return cur;
  }
  return join1(resolve(cwd), path);
}

interface GitText {
  text: string | null;
  truncated: boolean;
  code: number;
}

/** Git -z emits numstat records, then stat\0, then the patch. */
function diffSections(result: GitText): {
  num: GitText;
  st: GitText;
  df: GitText;
} {
  if (result.text === null) return { num: result, st: result, df: result };
  const text = result.text;
  let offset = 0;
  for (;;) {
    const end = text.indexOf("\0", offset);
    if (
      end < 0 ||
      !/^(?:[0-9]+|-)\t(?:[0-9]+|-)\t/u.test(text.slice(offset, end))
    )
      break;
    offset = end + 1;
  }
  const separator = text.indexOf("\0", offset);
  const section = (text: string, limit: number, truncated = false): GitText => {
    const bytes = new TextEncoder().encode(text);
    return {
      text: decoder.decode(bytes.subarray(0, limit)),
      code: result.code,
      truncated: truncated || bytes.length > limit,
    };
  };
  return {
    num: section(
      text.slice(0, offset),
      MAX_NUMSTAT_BYTES,
      result.truncated && separator < 0,
    ),
    st: section(
      text.slice(offset, separator < 0 ? undefined : separator),
      MAX_DIFF_STAT_BYTES,
      result.truncated && separator < 0,
    ),
    df: section(
      separator < 0 ? "" : text.slice(separator + 1),
      MAX_DIFF_BYTES,
      result.truncated,
    ),
  };
}

/** Run one command with bounded kept stdout; null text when it cannot run. */
async function runBounded(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  limit: number,
  timeout: number,
  signal?: AbortSignal,
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
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
    );
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeout * 1000);
  const abort = (): void => {
    timedOut = true;
    proc.kill("SIGKILL");
  };
  signal?.addEventListener("abort", abort, { once: true });
  const kept: Uint8Array[] = [];
  let size = 0;
  let total = 0;
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (size <= limit) {
        kept.push(value);
        size += value.length;
      }
    }
    const code = await proc.exited;
    if (timedOut) return null;
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
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

const decoder = new TextDecoder("utf-8");

/** owner/repo of a GitHub remote URL, or null. */
function githubRepo(url: string): string | null {
  const match =
    /^(?:https:\/\/(?:[^/@\s]+@)?github\.com\/|ssh:\/\/(?:[^/@\s]+@)?github\.com\/|(?:[^@\s]+@)?github\.com:)([\w.-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?$/u.exec(
      url.trim(),
    );
  return match &&
    ![match[1], match[2]].some((part) => part === "." || part === "..")
    ? `${match[1]}/${match[2]}`
    : null;
}

interface Head {
  remote: string;
  /** owner/repo of the remote. */
  repo: string;
  /** The remote branch the local branch tracks. */
  branch: string;
}

export interface PrValue {
  number: number;
  title: string;
  url: string;
  baseRefName?: string;
  /** OPEN, MERGED or CLOSED, as `gh pr list` reports it. */
  state: string;
  /** Its status checks in one word; null when it has none. */
  checks: "pass" | "fail" | "pending" | null;
  /** When it was opened, in epoch seconds; only from `pullRequest`. */
  createdAt?: number;
}

const FAILED_CHECKS = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const PASSED_CHECKS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** One word for `gh pr view --json statusCheckRollup`. */
function checksSummary(rollup: unknown): PrValue["checks"] {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  const results = rollup.map((check: Record<string, unknown> | null) =>
    String(check?.conclusion || check?.state || check?.status || ""),
  );
  if (results.some((result) => FAILED_CHECKS.has(result))) return "fail";
  return results.every((result) => PASSED_CHECKS.has(result))
    ? "pass"
    : "pending";
}

function prValue(row: Record<string, unknown> | undefined): PrValue | null {
  const identity = typeof row?.url === "string" ? prIdentity(row.url) : null;
  const { title, state, baseRefName, statusCheckRollup, createdAt } = row ?? {};
  const opened = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (!identity || typeof title !== "string" || typeof state !== "string")
    return null;
  return {
    number: identity.number,
    title,
    url: identity.url,
    state,
    ...(typeof baseRefName === "string" ? { baseRefName } : {}),
    checks: checksSummary(statusCheckRollup),
    ...(Number.isFinite(opened) ? { createdAt: opened / 1000 } : {}),
  };
}

export interface DiffFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  status: string;
}

export interface DiffState {
  available: boolean;
  reason: string | null;
  base: string | null;
  baseSha: string | null;
  baseSource: string | null;
  headSha: string | null;
  branch: string | null;
  cwd: string | null;
  cwdSource: string;
  stat: string;
  diff: string;
  truncated: boolean;
  files: DiffFile[];
  moreFiles: number;
  untracked: string[];
  currentPr: PrValue | null;
  version: string | null;
}

export function unavailableDiff(
  reason: string,
  cwd: string | null = null,
  cwdSource = "stored",
): DiffState {
  return {
    available: false,
    reason,
    base: null,
    baseSha: null,
    baseSource: null,
    headSha: null,
    branch: null,
    cwd,
    cwdSource,
    stat: "",
    diff: "",
    truncated: false,
    files: [],
    moreFiles: 0,
    untracked: [],
    currentPr: null,
    version: null,
  };
}

/**
 * Syntax-check a user-supplied diff base ref (PATCH body or ?base=). Rejects
 * empties, overlong input, whitespace/control characters, and a leading `-`.
 */
export function cleanBaseRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ref = pyStrip(value);
  if (!BASE_REF_RE.test(ref)) return null;
  return ref;
}

async function readBoundedJsonObject(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return null;
    if ((await stat(path)).size > WORKDIR_FILE_MAX_BYTES) return null;
    const handle = await open(path, "r");
    let raw: Uint8Array;
    try {
      const buf = new Uint8Array(WORKDIR_FILE_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      raw = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (raw.length > WORKDIR_FILE_MAX_BYTES) return null;
    const loaded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    return loaded !== null &&
      typeof loaded === "object" &&
      !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class WorkdirGit {
  private readonly inputs: WorkdirGitInputs;
  private readonly now: () => number;
  private defaultBranchValue: string | null = null;
  // At most eight 1 MiB patches; concurrent file opens share the same fetch.
  private readonly prPatches = new Map<
    string,
    [
      number,
      Promise<{ out: Uint8Array; truncated: boolean } | undefined>,
      Promise<string | undefined>,
    ]
  >();
  /** Each worktree's last branch PR lookup: [PR, branch]. */
  private readonly cwdPr = new Map<string, [PrValue | null, string | null]>();
  private readonly headPrs = new Map<string, [number, PrValue | null]>();
  private readonly headLookups = new Map<string, Promise<PrValue | null>>();
  private readonly ghQueues = new Map<string, Promise<unknown>>();
  private ghBackoff = { seconds: 0, until: 0 };
  private readonly githubBases = new Map<string, Promise<string | null>>();
  private readonly diffRuns = new Map<
    string,
    {
      promise: Promise<DiffState>;
      waiters: number;
      controller: AbortController;
    }
  >();

  // One bounded, coalesced origin lookup per checkout, not per poll/message.
  async githubRepoUrl(
    stored: string,
    workdirFile: string | null = null,
  ): Promise<string | null> {
    const state = workdirFile ? await readBoundedJsonObject(workdirFile) : null;
    const cwd =
      state?.version === 1 && typeof state.cwd === "string"
        ? state.cwd
        : stored;
    let hit = this.githubBases.get(cwd);
    if (!hit) {
      hit = this.gitText(["remote", "get-url", "origin"], cwd, 4096).then(
        (r) => {
          const repo =
            r.code !== 0 || r.truncated ? null : githubRepo(r.text ?? "");
          return repo && `https://github.com/${repo}`;
        },
      );
      this.githubBases.set(cwd, hit);
      if (this.githubBases.size > 100)
        this.githubBases.delete(this.githubBases.keys().next().value!);
    }
    return hit;
  }

  constructor(inputs: WorkdirGitInputs) {
    this.inputs = inputs;
    this.now = inputs.now ?? (() => performance.now() / 1000);
  }

  /** git_env(): a fresh scrubbed copy of the process environment. */
  gitEnv(): Record<string, string> {
    return gitEnv(this.inputs.env);
  }

  private async gitRun(
    args: string[],
    cwd: string,
    timeout = 30.0,
  ): Promise<{ stdout: string; code: number } | null> {
    startupMetrics.count("git_subprocesses");
    const r = await timed(`git.${args[0]}`, () =>
      runBounded(
        ["git", "--no-replace-objects", ...args],
        cwd,
        safeGitEnv(this.inputs.env),
        Number.MAX_SAFE_INTEGER,
        timeout,
      ),
    );
    if (r === null) return null;
    const stdout = decoder.decode(r.out).replace(/\r\n?/gu, "\n");
    return { stdout, code: r.code };
  }

  private async gitText(
    args: string[],
    wt: string,
    limit: number,
    timeout = DIFF_TIMEOUT,
    signal?: AbortSignal,
  ): Promise<GitText> {
    startupMetrics.count("git_subprocesses");
    if (args[0] === "diff") startupMetrics.count("git_diff_subprocesses");
    const r = await timed(`git.${args[0]}`, () =>
      runBounded(
        ["git", "--no-replace-objects", "--no-optional-locks", ...args],
        wt,
        safeGitEnv(this.inputs.env),
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

  private isLocalSrc(): Promise<boolean> {
    return isDir(this.inputs.repoUrl);
  }

  /** Whether the agents' target provides git at all. */
  async targetIsGitRepo(): Promise<boolean> {
    if (!(await this.isLocalSrc())) return true;
    return exists(join(this.inputs.repoUrl, ".git"));
  }

  /** Agents have a place to work (a canonical clone, or a non-git target). */
  async ready(): Promise<boolean> {
    if ((await this.isLocalSrc()) && !(await this.targetIsGitRepo()))
      return isDir(this.inputs.repoUrl);
    return exists(join(this.inputs.repoDir, ".git"));
  }

  /** Whether the existing clone is not the configured URL target. */
  async cloneTargetMismatch(): Promise<boolean> {
    if (await this.isLocalSrc()) return false;
    if (!(await exists(join(this.inputs.repoDir, ".git")))) return false;
    const current = await this.gitRun(
      ["remote", "get-url", "origin"],
      this.inputs.repoDir,
    );
    if (current === null || current.code !== 0) return false;
    return pyStrip(current.stdout) !== this.inputs.repoUrl;
  }

  /** origin/HEAD's branch, else "main"; cached once resolved. */
  async defaultBranch(): Promise<string> {
    if (this.defaultBranchValue === null && (await this.ready())) {
      if (await this.isLocalSrc()) {
        this.defaultBranchValue = removePrefix(
          await this.inplaceBase(this.inputs.repoUrl),
          "origin/",
        );
      } else {
        const r = await this.gitRun(
          ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
          this.inputs.repoDir,
        );
        this.defaultBranchValue =
          r !== null && r.code === 0 && pyStrip(r.stdout)
            ? removePrefix(pyStrip(r.stdout), "origin/")
            : "main";
      }
    }
    return this.defaultBranchValue || "main";
  }

  private async inplaceBase(src: string): Promise<string> {
    let r = await this.gitRun(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      src,
    );
    if (r !== null && r.code === 0 && pyStrip(r.stdout))
      return pyStrip(r.stdout);
    r = await this.gitRun(["symbolic-ref", "--short", "HEAD"], src);
    return (r !== null ? pyStrip(r.stdout) : "") || "HEAD";
  }

  /** Directory a conversation spawned without an explicit workdir records. */
  async defaultSpawnWorkdir(): Promise<string> {
    if ((await this.isLocalSrc()) && !(await this.targetIsGitRepo()))
      return pyPathStr(this.inputs.repoUrl);
    return (await this.ready()) ? this.inputs.repoDir : this.inputs.dataDir;
  }

  /** The branch checked out at `wt`, or null (missing or detached). */
  async branchAt(wt: string, signal?: AbortSignal): Promise<string | null> {
    if (!(await exists(wt))) return null;
    const r = await this.gitText(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      wt,
      256,
      10.0,
      signal,
    );
    const out = pyStrip(r.text ?? "");
    return r.code === 0 && out && out !== "HEAD" ? out : null;
  }

  private async gitCwd(
    candidate: unknown,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (typeof candidate !== "string" || !candidate) return null;
    if (candidate.includes("\0") || !(await isDir(candidate))) return null;
    const { text, code } = await this.gitText(
      ["rev-parse", "--is-inside-work-tree"],
      candidate,
      16,
      5.0,

      signal,
    );
    return code === 0 && pyStrip(text ?? "") === "true" ? candidate : null;
  }

  /** [directory, "persisted" | "stored"] for the Changes pane. */
  async resolveDiffCwd(
    stored: string,
    persisted: string | null = null,
    signal?: AbortSignal,
  ): Promise<[string, string]> {
    const seen = new Set<unknown>();
    for (const [candidate, source] of [
      [persisted, "persisted"],
      [stored, "stored"],
    ] as const) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const cwd = await this.gitCwd(candidate, signal);
      if (cwd !== null) return [pyPathStr(cwd), source];
    }
    return [pyPathStr(stored), "stored"];
  }

  private async resolveRef(
    wt: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const { text, code } = await this.gitText(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      wt,
      256,
      5.0,

      signal,
    );
    if (code === 0 && text && isSha(pyStrip(text)))
      return pyStrip(text).toLowerCase();
    return null;
  }

  private async autoMainRef(
    wt: string,
    signal?: AbortSignal,
  ): Promise<[string, string] | null> {
    const sym = await this.gitText(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      wt,
      256,
      5.0,

      signal,
    );
    const chain = [
      ...(sym.code === 0 && sym.text && pyStrip(sym.text)
        ? [pyStrip(sym.text)]
        : []),
      ...AUTO_BASE_CHAIN,
    ];
    const seen = new Set<string>();
    for (const ref of chain) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const sha = await this.resolveRef(wt, ref, signal);
      if (sha !== null) return [ref, sha];
    }
    return null;
  }

  private async resolveDiffBase(
    wt: string,
    override: string | null,
    knownBranch?: string | null,
    signal?: AbortSignal,
  ): Promise<[string | null, string | null, string]> {
    if (override) {
      const sha = await this.resolveRef(wt, override, signal);
      if (sha !== null) return [sha, override, `override:${override}`];
    }
    const branch =
      knownBranch === undefined ? await this.branchAt(wt, signal) : knownBranch;
    if (branch) {
      const cached = this.cwdPr.get(wt);
      const pr = cached?.[1] === branch ? cached[0] : null;
      if (pr?.state === "OPEN" && pr.baseRefName) {
        for (const ref of [`origin/${pr.baseRefName}`, pr.baseRefName]) {
          if ((await this.resolveRef(wt, ref, signal)) === null) continue;
          const base = await this.gitText(
            ["merge-base", "HEAD", ref],
            wt,
            256,
            5.0,

            signal,
          );
          if (base.code === 0 && base.text && isSha(pyStrip(base.text)))
            return [pyStrip(base.text).toLowerCase(), ref, `pr:${pr.number}`];
        }
      }
      const name = await this.gitText(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        wt,
        256,
        5.0,

        signal,
      );
      const upstream = pyStrip(name.text ?? "");
      if (
        name.code === 0 &&
        name.text &&
        upstream !== "" &&
        upstream !== "@{u}"
      ) {
        const base = await this.gitText(
          ["merge-base", "HEAD", "@{u}"],
          wt,
          256,
          5.0,

          signal,
        );
        if (base.code === 0 && base.text && isSha(pyStrip(base.text)))
          return [
            pyStrip(base.text).toLowerCase(),
            upstream,
            `upstream:${upstream}`,
          ];
      }
    }
    const mainRef = await this.autoMainRef(wt, signal);
    if (mainRef !== null) {
      const [ref, sha] = mainRef;
      return [sha, ref, `auto:${ref}`];
    }
    const head = await this.resolveRef(wt, "HEAD", signal);
    if (head !== null) return [head, "HEAD", "head"];
    return [null, null, "head"];
  }

  /**
   * `wt`'s PR from its upstream branch and repository, or null (detached, no
   * GitHub upstream or PR, or a closed default-branch PR).
   */
  async branchPr(
    wt: string,
    reason: string,
    queue = wt,
  ): Promise<PrValue | null> {
    const branch = await this.branchAt(wt);
    const head = branch ? await this.upstreamHead(wt, branch) : null;
    let value = head
      ? await this.cachedPr(`${head.repo.toLowerCase()}\0${head.branch}`, () =>
          this.lookupHeadPr(wt, head, reason, queue),
        )
      : null;
    if (head && value && value.state !== "OPEN") {
      const main = await this.gitText(
        ["symbolic-ref", "--short", `refs/remotes/${head.remote}/HEAD`],
        wt,
        256,
        5.0,
      );
      const name = pyStrip(main.text ?? "");
      if (main.code !== 0 || name === `${head.remote}/${head.branch}`)
        value = null;
    }
    this.cwdPr.delete(wt);
    this.cwdPr.set(wt, [value, branch]);
    while (this.cwdPr.size > 100)
      this.cwdPr.delete(this.cwdPr.keys().next().value!);
    return value;
  }

  private async upstreamHead(wt: string, branch: string): Promise<Head | null> {
    const ref = await this.gitText(
      [
        "for-each-ref",
        "--format=%(upstream:remotename)%00%(upstream:remoteref)",
      ].concat([`refs/heads/${branch}`]),
      wt,
      1024,
      5.0,
    );
    const [remote, merge] = pyStrip(ref.text ?? "").split("\0");
    if (ref.code !== 0 || !remote || remote.startsWith("-")) return null;
    if (!merge?.startsWith("refs/heads/")) return null;
    const url = await this.gitText(["remote", "get-url", remote], wt, 4096);
    const repo = url.code === 0 ? githubRepo(url.text ?? "") : null;
    return repo
      ? { remote, repo, branch: merge.slice("refs/heads/".length) }
      : null;
  }

  /** The PR at `url` (canonical), or null when GitHub has none. */
  pullRequest(url: string, reason: string, queue = url) {
    const pr = prIdentity(url);
    if (!pr) return Promise.resolve(null);
    return this.cachedPr(pr.url, async () => {
      const row = await this.gh(
        queue,
        ["pr", "view", String(pr.number), "--repo", pr.repo, "--json"].concat([
          "number,title,url,state,baseRefName,statusCheckRollup,createdAt",
        ]),
        this.inputs.dataDir,
        reason,
        512 * 1024,
        (r) => (r.truncated ? undefined : JSON.parse(decoder.decode(r.out))),
      );
      return row === undefined ? undefined : prValue(row);
    });
  }

  // Invariant: One lookup per repository branch or PR URL a minute, shared by
  // worktrees and callers; a merged or closed PR is final. Capacity evicts
  // only attempts older than a minute, final PRs only past 2,000 entries.
  private cachedPr(
    key: string,
    find: () => Promise<PrValue | null | undefined>,
  ): Promise<PrValue | null> {
    const hit = this.headPrs.get(key);
    if (
      hit &&
      (this.now() - hit[0] < BRANCH_PR_INTERVAL ||
        (hit[1] !== null && hit[1].state !== "OPEN"))
    )
      return Promise.resolve(hit[1]);
    let lookup = this.headLookups.get(key);
    if (!lookup) {
      lookup = find()
        .catch(() => undefined)
        .then((found) => {
          const value = found === undefined ? (hit?.[1] ?? null) : found;
          const now = this.now();
          this.headPrs.delete(key);
          this.headPrs.set(key, [now, value]);
          for (const [old, [at, pr]] of this.headPrs) {
            if (this.headPrs.size <= 200 || now - at < BRANCH_PR_INTERVAL)
              break;
            if (pr?.state === "OPEN" || !pr || this.headPrs.size > 2000)
              this.headPrs.delete(old);
          }
          return value;
        })
        .finally(() => this.headLookups.delete(key));
      this.headLookups.set(key, lookup);
    }
    return lookup;
  }

  /** The PR, null for none, or undefined when GitHub gave no valid answer. */
  private async lookupHeadPr(
    wt: string,
    head: Head,
    reason: string,
    queue: string,
  ): Promise<PrValue | null | undefined> {
    const rows = await this.gh(
      queue,
      ["pr", "list", "--repo", head.repo, "--head", head.branch]
        .concat(["--state", "all", "--limit", "5", "--json"])
        .concat([
          "number,title,url,state,baseRefName,statusCheckRollup,headRepository,headRepositoryOwner",
        ]),
      wt,
      reason,
      512 * 1024,
      (r) => {
        const rows: unknown = r.truncated
          ? null
          : JSON.parse(decoder.decode(r.out));
        return Array.isArray(rows) ? rows : undefined;
      },
    );
    if (rows === undefined) return undefined;
    const ours = rows.filter(
      (pr) =>
        `${pr?.headRepositoryOwner?.login}/${pr?.headRepository?.name}`.toLowerCase() ===
        head.repo.toLowerCase(),
    );
    return prValue(ours.find((pr) => pr.state === "OPEN") ?? ours[0]);
  }

  // One logged `gh` call at a time per `queue` (a conversation); `parse`
  // rejects invalid output. Failures back all calls off, doubling from a
  // minute to 15, or until GitHub's latest exhausted rate-limit reset.
  private gh<T>(
    queue: string,
    args: string[],
    cwd: string,
    reason: string,
    limit: number,
    parse: (r: { out: Uint8Array; truncated: boolean }) => T | undefined,
    timeout = GH_TIMEOUT,
  ): Promise<T | undefined> {
    const queued = this.now();
    const run = (this.ghQueues.get(queue) ?? Promise.resolve()).then(
      async () => {
        if (this.now() < this.ghBackoff.until) {
          this.inputs.log?.("gh_call_skipped", { reason, backoff: true });
          return undefined;
        }
        const r = await this.ghLogged(
          args,
          cwd,
          reason,
          limit,
          timeout,
          queued,
        );
        let value: T | undefined;
        try {
          value = r?.code === 0 ? parse(r) : undefined;
        } catch {}
        if (value !== undefined) {
          this.ghBackoff.seconds = 0;
          return value;
        }
        const seconds = Math.min(Math.max(60, this.ghBackoff.seconds * 2), 900);
        this.ghBackoff = {
          seconds,
          until: Math.max(this.ghBackoff.until, this.now() + seconds),
        };
        if (r === null) return undefined;
        const limits = await this.ghLogged(
          ["api", "rate_limit"],
          cwd,
          `${reason}_failed`,
          64 * 1024,
          GH_TIMEOUT,
          this.now(),
        );
        try {
          const resources = JSON.parse(decoder.decode(limits!.out)).resources;
          for (const { remaining, reset } of Object.values(resources) as {
            remaining?: unknown;
            reset?: unknown;
          }[])
            if (remaining === 0 && typeof reset === "number")
              this.ghBackoff.until = Math.max(
                this.ghBackoff.until,
                this.now() + reset - Date.now() / 1000,
              );
        } catch {}
        return undefined;
      },
    );
    const tail = run.catch(() => undefined);
    this.ghQueues.set(queue, tail);
    void tail.then(() => {
      if (this.ghQueues.get(queue) === tail) this.ghQueues.delete(queue);
    });
    return run;
  }

  private async ghLogged(
    args: string[],
    cwd: string,
    reason: string,
    limit: number,
    timeout: number,
    queued: number,
  ): ReturnType<typeof runBounded> {
    const env = this.gitEnv();
    env.GH_PAGER ??= "cat";
    env.NO_COLOR ??= "1";
    const started = this.now();
    const r = await runBounded(["gh", ...args], cwd, env, limit, timeout);
    this.inputs.log?.("gh_call", {
      reason,
      command: `gh ${args.slice(0, 2).join(" ")}`,
      exit: r?.code ?? null,
      waited_ms: Math.round((started - queued) * 1000),
      ms: Math.round((this.now() - started) * 1000),
    });
    return r;
  }

  private async diffFiles(
    wt: string,
    num: GitText,
    signal?: AbortSignal,
  ): Promise<[DiffFile[], number, boolean, string[]]> {
    const files: DiffFile[] = [];
    if (num.text !== null && (num.code === 0 || num.code === 1)) {
      for (const rec of num.text.split("\0")) {
        const parts = rec.split("\t");
        if (parts.length < 3) continue;
        const [add, dele] = parts as [string, string];
        const path = parts.slice(2).join("\t");
        if (!path) continue;
        files.push({
          path,
          additions: /^[0-9]+$/u.test(add) ? Number.parseInt(add, 10) : null,
          deletions: /^[0-9]+$/u.test(dele) ? Number.parseInt(dele, 10) : null,
          status: "modified",
        });
      }
    }
    const names = await this.gitText(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      wt,
      MAX_DIFF_STAT_BYTES,
      5.0,
      signal,
    );
    const untracked = (names.text ?? "").split("\0").filter((p) => p);
    for (const path of untracked)
      files.push({
        path,
        additions: null,
        deletions: null,
        status: "untracked",
      });
    const more = Math.max(0, files.length - MAX_DIFF_FILES);
    return [files.slice(0, MAX_DIFF_FILES), more, num.truncated, untracked];
  }

  // Identical requests share one walk; it is killed once every caller that
  // brought a signal has gone, since a slow repo would otherwise keep one
  // full-tree git diff per abandoned conversation switch running.
  worktreeDiff(
    wt: string,
    baseOverride: string | null = null,
    cwdSource = "stored",
    signal?: AbortSignal,
  ): Promise<DiffState> {
    const key = JSON.stringify([wt, baseOverride, cwdSource]);
    let run = this.diffRuns.get(key);
    if (!run) {
      const controller = new AbortController();
      const fresh = {
        controller,
        waiters: 0,
        promise: this.computeWorktreeDiff(
          wt,
          baseOverride,
          cwdSource,
          controller.signal,
        ).finally(() => {
          if (this.diffRuns.get(key) === fresh) this.diffRuns.delete(key);
        }),
      };
      run = fresh;
      this.diffRuns.set(key, run);
    }
    const joined = run;
    joined.waiters++;
    if (signal) {
      const leave = (): void => {
        if (--joined.waiters > 0) return;
        if (this.diffRuns.get(key) === joined) this.diffRuns.delete(key);
        joined.controller.abort();
      };
      if (signal.aborted) leave();
      else {
        signal.addEventListener("abort", leave, { once: true });
        void joined.promise.finally(() =>
          signal.removeEventListener("abort", leave),
        );
      }
    }
    return joined.promise;
  }

  private async computeWorktreeDiff(
    wt: string,
    baseOverride: string | null,
    cwdSource: string,
    signal: AbortSignal,
  ): Promise<DiffState> {
    const caller = signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (caller.aborted) abort();
    else caller.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, DIFF_REQUEST_TIMEOUT_MS);
    signal = controller.signal;
    const cwd = pyPathStr(wt);
    try {
      const inside = await this.gitText(
        ["rev-parse", "--is-inside-work-tree"],
        wt,
        16,
        5.0,
        signal,
      );
      if (inside.code !== 0 || pyStrip(inside.text ?? "") !== "true")
        return unavailableDiff("not-a-git-repo", cwd, cwdSource);
      const [branch, head] = await Promise.all([
        this.branchAt(wt, signal),
        this.gitText(["rev-parse", "--verify", "HEAD"], wt, 256, 5.0, signal),
      ]);
      const [base, label, source] = await this.resolveDiffBase(
        wt,
        baseOverride,
        branch,
        signal,
      );
      if (base === null || signal.aborted)
        return unavailableDiff("diff-failed", cwd, cwdSource);
      const headSha =
        head.text && isSha(pyStrip(head.text))
          ? pyStrip(head.text).toLowerCase()
          : null;
      const { num, st, df } = diffSections(
        await this.gitText(
          [
            "diff",
            "--numstat",
            "--stat",
            "--patch",
            "--no-renames",
            "-z",
            base,
            "--",
          ],
          wt,
          MAX_NUMSTAT_BYTES + MAX_DIFF_STAT_BYTES + MAX_DIFF_BYTES + 2,
          DIFF_TIMEOUT,
          signal,
        ),
      );
      if (
        st.text === null ||
        df.text === null ||
        (st.code !== 0 && st.code !== 1) ||
        (df.code !== 0 && df.code !== 1)
      )
        return unavailableDiff("diff-failed", cwd, cwdSource);
      const [files, more, numstatTruncated, untracked] = await this.diffFiles(
        wt,
        num,
        signal,
      );
      if (signal.aborted) return unavailableDiff("diff-failed", cwd, cwdSource);
      const untrackedCapped = untracked.slice(0, MAX_UNTRACKED_NAMES);
      const truncated =
        st.truncated ||
        df.truncated ||
        numstatTruncated ||
        more > 0 ||
        untracked.length > untrackedCapped.length;
      let statText = st.text;
      let diff = df.text;
      if (st.truncated)
        statText += "\n... [stat truncated at the 64 KiB server cap]\n";
      if (df.truncated) diff += DIFF_TRUNCATION_MARK;
      const cached = this.cwdPr.get(wt);
      const current = cached?.[1] === branch ? cached[0] : null;
      if (
        !pyStrip(diff) &&
        !untrackedCapped.length &&
        current === null &&
        !truncated
      )
        return unavailableDiff("clean", cwd, cwdSource);
      const version = createHash("sha256")
        .update(
          [
            base,
            headSha ?? "",
            statText,
            diff,
            untrackedCapped.join("\0"),
          ].join("\0"),
          "utf8",
        )
        .digest("hex")
        .slice(0, 24);
      return {
        available: true,
        reason: null,
        base: label,
        baseSha: base,
        baseSource: source,
        headSha,
        branch,
        cwd,
        cwdSource,
        stat: statText,
        diff,
        truncated,
        files,
        moreFiles: more,
        untracked: untrackedCapped,
        currentPr: current,
        version,
      };
    } catch {
      return unavailableDiff("diff-failed", cwd, cwdSource);
    } finally {
      clearTimeout(deadline);
      caller.removeEventListener("abort", abort);
    }
  }

  private async fileContents(
    wt: string,
    root: string,
    rel: string,
    base: string,
  ): Promise<[string | null, string | null, boolean, boolean]> {
    const old = await this.gitText(
      ["show", `${base}:${rel}`],
      wt,
      MAX_FILE_CONTENT_BYTES,
      5.0,
    );
    let oldText = old.text;
    let oldOver = old.truncated;
    if (old.code !== 0 || oldText === null) {
      oldText = "";
      oldOver = false;
    }
    const candidate = join(root, rel);
    let newRaw = new Uint8Array(0);
    try {
      const info = await stat(candidate);
      if (info.isFile() && info.size > MAX_FILE_CONTENT_BYTES)
        return [null, null, true, false];
      if (info.isFile()) newRaw = new Uint8Array(await readFile(candidate));
    } catch {
      newRaw = new Uint8Array(0);
    }
    const newText = decoder.decode(newRaw);
    if (oldText.includes("\0") || newText.includes("\0"))
      return [null, null, false, true];
    if (oldOver || newRaw.length > MAX_FILE_CONTENT_BYTES)
      return [null, null, true, false];
    return [oldText, newText, false, false];
  }

  // GitHub's PR patch and description, independent of checkout lifetime. No
  // full-file reads.
  async pullRequestDiff(
    url: string,
    path: string | null = null,
    queue = url,
  ): Promise<Record<string, unknown>> {
    const pr = prIdentity(url);
    if (!pr) return { available: false, reason: "invalid-pull-request" };
    const now = this.now();
    for (const [key, [at]] of this.prPatches)
      if (now - at >= GH_CACHE_TTL) this.prPatches.delete(key);
    let cached = this.prPatches.get(pr.url);
    if (!cached) {
      if (this.prPatches.size >= 8)
        this.prPatches.delete(this.prPatches.keys().next().value!);
      const repo = ["--repo", pr.repo];
      cached = [
        now,
        this.gh(
          queue,
          ["pr", "diff", String(pr.number), ...repo, "--color", "never"],
          this.inputs.dataDir,
          "pull_request_diff",
          MAX_DIFF_BYTES,
          (r) => r,
          DIFF_TIMEOUT,
        ),
        this.gh(
          queue,
          ["pr", "view", String(pr.number), ...repo, "--json", "body"],
          this.inputs.dataDir,
          "pull_request_description",
          512 * 1024,
          (r) => {
            const body: unknown = r.truncated
              ? null
              : JSON.parse(decoder.decode(r.out))?.body;
            return typeof body === "string" ? body : undefined;
          },
        ),
      ];
      this.prPatches.set(pr.url, cached);
    }
    const result = await cached[1];
    if (!result) {
      this.prPatches.delete(pr.url);
      return { available: false, reason: "pull-request-unavailable", path };
    }
    const patch = decoder.decode(result.out);
    const files = pullRequestFiles(patch);
    if (path !== null) {
      const file = files.find((file) => file.path === path);
      if (!file) return { available: false, reason: "no-such-file", path };
      const bytes = new TextEncoder().encode(file.patch);
      return {
        available: true,
        path,
        patch: decoder.decode(bytes.subarray(0, MAX_FILE_PATCH_BYTES)),
        truncated: result.truncated || bytes.length > MAX_FILE_PATCH_BYTES,
      };
    }
    const body = await cached[2];
    return {
      available: true,
      truncated: result.truncated,
      body: body ?? null,
      files: files
        .slice(0, MAX_DIFF_FILES)
        .map(({ patch: _patch, ...file }) => file),
      moreFiles: Math.max(0, files.length - MAX_DIFF_FILES),
      target: {
        kind: "pr",
        id: pr.url,
        number: pr.number,
        url: pr.url,
        repoIdentity: pr.repo,
      },
      version: pr.url + ":" + createHash("sha256").update(patch).digest("hex"),
    };
  }

  /** One file's patch for lazy per-file loading (200 KiB cap). */
  async diffFile(
    wt: string,
    path: unknown,
    baseOverride: string | null = null,
    includeContents = false,
  ): Promise<Record<string, unknown>> {
    if (typeof path !== "string" || !path || Array.from(path).length > 4096)
      return {
        available: false,
        reason: "bad-path",
        path: typeof path === "string" ? path : "",
      };
    if (path.includes("\0") || wt.includes("\0"))
      return { available: false, reason: "path-outside-repo", path };
    const root = await pyResolve(wt);
    const full = await pyResolve(isAbsolute(path) ? path : `${root}/${path}`);
    let relS: string;
    if (full === root) relS = ".";
    else if (full.startsWith(root === "/" ? "/" : `${root}/`))
      relS = full.slice(root === "/" ? 1 : root.length + 1);
    else return { available: false, reason: "path-outside-repo", path };
    try {
      const tracked = await this.gitText(
        ["ls-files", "--error-unmatch", "--", relS],
        wt,
        4096,
        5.0,
      );
      const isTracked =
        tracked.code === 0 && Boolean(pyStrip(tracked.text ?? ""));
      const [base, label, source] = await this.resolveDiffBase(
        wt,
        baseOverride,
      );
      if (base === null)
        return { available: false, reason: "diff-failed", path: relS };
      const fullPath = relS === "." ? root : join(root, relS);
      if (!isTracked && !(await isFile(fullPath)))
        return { available: false, reason: "no-such-file", path: relS };
      const args = isTracked
        ? ["diff", base, "--", relS]
        : ["diff", "--no-index", "--", "/dev/null", fullPath];
      const p = await this.gitText(args, wt, MAX_FILE_PATCH_BYTES);
      if (p.text === null || (p.code !== 0 && p.code !== 1))
        return { available: false, reason: "diff-failed", path: relS };
      let patch = p.text;
      if (p.truncated)
        patch += "\n... [file patch truncated at the 200 KiB server cap]\n";
      const out: Record<string, unknown> = {
        available: true,
        reason: null,
        path: relS,
        patch,
        truncated: p.truncated,
        base: label,
        baseSha: base,
        baseSource: source,
        cwd: pyPathStr(wt),
      };
      if (includeContents) {
        const [oldContent, newContent, over, binary] = await this.fileContents(
          wt,
          root,
          relS,
          base,
        );
        Object.assign(out, {
          oldContent,
          newContent,
          contentsTruncated: over,
          contentsBinary: binary,
        });
      }
      return out;
    } catch {
      return { available: false, reason: "diff-failed", path: relS };
    }
  }

  // Bounded fuzzy-finder input: branches, recent commits, tags. Never throws.
  async diffCandidates(wt: string): Promise<Record<string, string[]>> {
    if (wt.includes("\0") || !(await isDir(wt)))
      return { branches: [], commits: [], tags: [] };
    let branches: string[];
    try {
      const out = await this.gitText(
        [
          "for-each-ref",
          "--format=%(refname:short) %(refname)",
          "--sort=-committerdate",
          "--count=100",
          "refs/heads",
          "refs/remotes",
        ],
        wt,
        64 * 1024,
        CANDIDATE_TIMEOUT,
      );
      // Invariant: Git 2.55 shortens refs/remotes/<remote>/HEAD to "<remote>".
      // Keep Git 2.39's spelling: the first of "<remote>/HEAD" and
      // "remotes/<remote>/HEAD" that no other ref shares, else the full ref.
      branches = [];
      for (const line of splitlines(out.text ?? "")) {
        if (!pyStrip(line)) continue;
        if (branches.length >= 100) break;
        const [short = "", full = ""] = line.split(" ");
        const remoteHead = /^refs\/remotes\/([^/]+)\/HEAD$/u.exec(full);
        if (!remoteHead || short !== remoteHead[1]) {
          branches.push(short);
          continue;
        }
        // Invariant: Git resolves a name X as refs/X, refs/tags/X,
        // refs/heads/X, refs/remotes/X or refs/remotes/X/HEAD.
        const rivals = (name: string) =>
          ["", "tags/", "heads/", "remotes/"]
            .map((prefix) => `refs/${prefix}${name}`)
            .concat(`refs/remotes/${name}/HEAD`)
            .filter((ref) => ref !== full);
        const names = [`${short}/HEAD`, `remotes/${short}/HEAD`];
        const found = await this.gitText(
          ["for-each-ref", "--format=%(refname)", ...names.flatMap(rivals)],
          wt,
          4096,
          CANDIDATE_TIMEOUT,
        );
        const taken =
          found.code === 0 && found.text !== null
            ? new Set(splitlines(found.text))
            : null;
        branches.push(
          names.find(
            (name) => taken && !rivals(name).some((ref) => taken.has(ref)),
          ) ?? full,
        );
      }
    } catch {
      branches = [];
    }
    let deduped: string[];
    try {
      const refs = ["HEAD"];
      const mainRef = await this.autoMainRef(wt);
      if (mainRef !== null) refs.push(mainRef[0]);
      const commits: string[] = [];
      for (const ref of refs) {
        const out = await this.gitText(
          ["log", "--format=%h %s", "-n", "30", ref, "--"],
          wt,
          64 * 1024,
          CANDIDATE_TIMEOUT,
        );
        if (out.text !== null && out.code === 0)
          commits.push(...splitlines(out.text).filter((l) => pyStrip(l)));
      }
      deduped = [...new Set(commits)].slice(0, 60);
    } catch {
      deduped = [];
    }
    let tags: string[];
    try {
      const out = await this.gitText(
        ["tag", "--list", "--sort=-creatordate"],
        wt,
        64 * 1024,
        CANDIDATE_TIMEOUT,
      );
      tags = splitlines(out.text ?? "")
        .filter((l) => pyStrip(l))
        .slice(0, 50);
    } catch {
      tags = [];
    }
    return { branches, commits: deduped, tags };
  }
}

function removePrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** `str(Path(p))`: collapse repeated and trailing slashes and "." parts. */
function pyPathStr(p: string): string {
  if (!p) return ".";
  const lead =
    p.startsWith("//") && !p.startsWith("///")
      ? "//"
      : p.startsWith("/")
        ? "/"
        : "";
  const parts = p.split("/").filter((s) => s && s !== ".");
  return lead + parts.join("/") || (lead ? lead : ".");
}
