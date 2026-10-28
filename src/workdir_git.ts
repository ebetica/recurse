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
  backgroundTask?: (name: string, work: () => Promise<void>) => void;
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
    const found = Bun.which(argv[0]!, { PATH: env.PATH ?? "" });
    if (found === null) return null;
    proc = Bun.spawn([found, ...argv.slice(1)], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
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

interface PrValue {
  number: number;
  title: string;
  url: string;
  baseRefName?: string;
  state?: string;
}
export interface PrListRow {
  repo: string;
  number: number;
  url: string;
  title: string | null;
  body?: string | null;
  state: "open" | "merged" | "closed" | null;
  metadata: "ready" | "pending" | "unavailable";
  baseRefName?: string;
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
  private readonly ghPrCache = new Map<string, [number, PrValue | null]>();
  // At most eight 1 MiB patches; concurrent file opens share the same fetch.
  private readonly prPatches = new Map<
    string,
    [number, ReturnType<typeof runBounded>]
  >();
  private readonly prMetadata = new Map<string, [number, PrListRow]>();
  private readonly cwdPr = new Map<
    string,
    [number, PrValue | null, string | null]
  >();
  private readonly prRefreshing = new Set<string>();
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
          if (r.code !== 0 || r.truncated) return null;
          const match =
            /^(?:https:\/\/(?:[^/@\s]+@)?github\.com\/|ssh:\/\/(?:[^/@\s]+@)?github\.com\/|(?:[^@\s]+@)?github\.com:)([\w.-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?$/u.exec(
              r.text?.trim() ?? "",
            );
          return match &&
            ![match[1], match[2]].some((part) => part === "." || part === "..")
            ? `https://github.com/${match[1]}/${match[2]}`
            : null;
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
      const cached = this.ghPrCache.get(`${await pyResolve(wt)}\0${branch}`);
      const pr =
        cached && this.now() - cached[0] < GH_CACHE_TTL ? cached[1] : null;
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

  private async currentPr(
    wt: string,
    branch: string | null,
  ): Promise<PrValue | null> {
    if (
      !branch ||
      Bun.which("gh", { PATH: this.inputs.env.PATH ?? "" }) === null
    )
      return null;
    const key = `${await pyResolve(wt)}\0${branch}`;
    const hit = this.ghPrCache.get(key);
    if (hit && this.now() - hit[0] < GH_CACHE_TTL) return hit[1];
    let value: PrValue | null = null;
    try {
      const env = this.gitEnv();
      env.GH_PAGER ??= "cat";
      env.NO_COLOR ??= "1";
      const r = await runBounded(
        [
          "gh",
          "pr",
          "view",
          "--json",
          "number,title,url,state,baseRefName",
          "--",
          branch,
        ],
        wt,
        env,
        Number.MAX_SAFE_INTEGER,
        GH_TIMEOUT,
      );
      const stdout = r === null ? "" : decoder.decode(r.out);
      if (r !== null && r.code === 0 && pyStrip(stdout)) {
        const payload: unknown = JSON.parse(stdout);
        if (
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload)
        ) {
          const { number, title, url } = payload as Record<string, unknown>;
          if (
            typeof number === "number" &&
            Number.isInteger(number) &&
            typeof title === "string" &&
            typeof url === "string"
          )
            value = {
              number,
              title,
              url,
              ...("baseRefName" in payload &&
              typeof payload.baseRefName === "string"
                ? { baseRefName: payload.baseRefName }
                : {}),
              ...("state" in payload && typeof payload.state === "string"
                ? { state: payload.state }
                : {}),
            };
        }
      }
    } catch {
      value = null;
    }
    const now = this.now();
    for (const [k, [at]] of this.ghPrCache)
      if (now - at >= GH_CACHE_TTL) this.ghPrCache.delete(k);
    this.ghPrCache.set(key, [now, value]);
    return value;
  }

  // Cache-only pane read. GitHub queries run in owned background tasks, never
  // on the render path; unknown metadata is explicit and subsequent reads fill
  // it.
  pullRequests(
    wt: string | null,
    urls: readonly string[],
    knownBranch: string | null | undefined = undefined,
  ): { prs: PrListRow[]; refreshing: boolean } {
    const launch = (key: string, work: () => Promise<void>) => {
      if (this.prRefreshing.has(key) || this.prRefreshing.size >= 4) return;
      this.prRefreshing.add(key);
      const run = async () => {
        try {
          await work();
        } finally {
          this.prRefreshing.delete(key);
        }
      };
      if (this.inputs.backgroundTask)
        this.inputs.backgroundTask("refresh_pr_metadata", run);
      else void run().catch(() => {});
    };
    const cached = wt === null ? null : this.cwdPr.get(wt);
    const branchPr =
      knownBranch === undefined || cached?.[2] === knownBranch ? cached : null;
    if (
      wt !== null &&
      (!branchPr || this.now() - branchPr[0] >= GH_CACHE_TTL)
    ) {
      launch(`cwd:${wt}`, async () => {
        const branch =
          knownBranch === undefined ? await this.branchAt(wt) : knownBranch;
        const value = await this.currentPr(wt, branch);
        this.cwdPr.set(wt, [this.now(), value, branch]);
        while (this.cwdPr.size > 100)
          this.cwdPr.delete(this.cwdPr.keys().next().value!);
      });
    }
    const identities = new Map<
      string,
      NonNullable<ReturnType<typeof prIdentity>>
    >();
    for (const url of [
      ...urls.slice(-50),
      ...(branchPr?.[1] ? [branchPr[1].url] : []),
    ]) {
      const identity = prIdentity(url);
      if (identity) identities.set(identity.url, identity);
    }
    const prs = [...identities.values()].slice(-50).map((identity) => {
      const hit = this.prMetadata.get(identity.url);
      if (!hit || this.now() - hit[0] >= GH_CACHE_TTL)
        launch(identity.url, async () => {
          let row: PrListRow = {
            ...identity,
            title: null,
            state: null,
            metadata: "unavailable",
          };
          const result = await runBounded(
            [
              "gh",
              "pr",
              "view",
              String(identity.number),
              "--repo",
              identity.repo,
              "--json",
              "title,body,state,baseRefName",
            ],
            this.inputs.repoDir,
            this.gitEnv(),
            512 * 1024,
            GH_TIMEOUT,
          );
          try {
            const data: unknown =
              result?.code === 0 && !result.truncated
                ? JSON.parse(decoder.decode(result.out))
                : null;
            if (
              data &&
              typeof data === "object" &&
              "title" in data &&
              typeof data.title === "string" &&
              "state" in data
            ) {
              const state =
                data.state === "OPEN"
                  ? "open"
                  : data.state === "MERGED"
                    ? "merged"
                    : data.state === "CLOSED"
                      ? "closed"
                      : null;
              if (state)
                row = {
                  ...identity,
                  title: data.title,
                  body:
                    "body" in data && typeof data.body === "string"
                      ? data.body
                      : null,
                  ...("baseRefName" in data &&
                  typeof data.baseRefName === "string"
                    ? { baseRefName: data.baseRefName }
                    : {}),
                  state,
                  metadata: "ready",
                };
            }
          } catch {}
          this.prMetadata.set(identity.url, [this.now(), row]);
          while (this.prMetadata.size > 500)
            this.prMetadata.delete(this.prMetadata.keys().next().value!);
        });
      return (
        hit?.[1] ?? {
          ...identity,
          title: branchPr?.[1]?.url === identity.url ? branchPr[1].title : null,
          state: null,
          metadata: "pending" as const,
        }
      );
    });
    return {
      prs,
      refreshing:
        (wt !== null && this.prRefreshing.has(`cwd:${wt}`)) ||
        [...identities.keys()].some((url) => this.prRefreshing.has(url)),
    };
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
      const current = cached?.[2] === branch ? cached[1] : null;
      this.pullRequests(wt, [], branch);
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
      if (
        (await isFile(candidate)) &&
        (await stat(candidate)).size > MAX_FILE_CONTENT_BYTES
      )
        return [null, null, true, false];
      if (await isFile(candidate))
        newRaw = new Uint8Array(await readFile(candidate));
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

  // GitHub's PR patch, independent of checkout lifetime. No full-file reads.
  async pullRequestDiff(
    url: string,
    path: string | null = null,
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
      cached = [
        now,
        runBounded(
          [
            "gh",
            "pr",
            "diff",
            String(pr.number),
            "--repo",
            pr.repo,
            "--color",
            "never",
          ],
          this.inputs.dataDir,
          this.gitEnv(),
          MAX_DIFF_BYTES,
          DIFF_TIMEOUT,
        ),
      ];
      this.prPatches.set(pr.url, cached);
    }
    const result = await cached[1];
    if (!result || result.code !== 0) {
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
    return {
      available: true,
      truncated: result.truncated,
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
