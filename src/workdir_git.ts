// Bounded async workdir Git/diff queries; lifecycle stays in tools/worktree.
// Fresh summaries; default and HEAD include separately capped untracked names.
// Concurrent summaries share Git work; pull request state belongs to PullRequests.
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { branchAt, gitText, pyStrip, PY_SPACE, type GitText } from "./git";
import type { PrValue } from "./pull_request";
import { anyAbortSignal, pyResolve } from "./utils";
import { selectedWork, type SelectedWork } from "./workdir_git_work";

type Env = Readonly<Record<string, string | undefined>>;

interface WorkdirGitInputs {
  repoUrl: string;
  repoDir: string;
  dataDir: string;
  /** The server's process environment (os.environ). */
  env: Env;
  lastBranchPr?(wt: string, branch: string | null): PrValue | null;
}

export const DIFF_REQUEST_TIMEOUT_MS = 10_000;
export const CANDIDATE_REQUEST_TIMEOUT_MS = 5_000;
const MAX_DIFF_BYTES = 1_000_000;
const MAX_DIFF_STAT_BYTES = 64 * 1024;
const MAX_NUMSTAT_BYTES = 512 * 1024;
const MAX_DIFF_FILES = 200;
const MAX_FILE_PATCH_BYTES = 200 * 1024;
const MAX_FILE_CONTENT_BYTES = 1_000_000;
const MAX_UNTRACKED_NAMES = 500;
const DIFF_TIMEOUT = 10.0;
const DIFF_TRUNCATION_MARK = "\n... [diff truncated at the 1 MiB server cap]\n";
const SHA_RE = /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/u;
// Python's unicode `\s` is str.isspace(), not JavaScript's `\s`.
const BASE_REF_RE = new RegExp(
  `^(?!-)[^${PY_SPACE}\\x00-\\x1f\\x7f]{1,256}$`,
  "u",
);
const AUTO_BASE_CHAIN = ["origin/main", "main", "master"];

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

const decoder = new TextDecoder("utf-8");

interface DiffFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  status: string;
}

interface DiffState {
  available: boolean;
  reason: string | null;
  base: string | null;
  baseSha: string | null;
  baseSource: string | null;
  /** The base label used when no ref is typed. */
  defaultBase: string | null;
  selectedWork?: SelectedWork | null;
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
  untrackedTruncated: boolean;
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
    defaultBase: null,
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
    untrackedTruncated: false,
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

export class WorkdirGit {
  private readonly inputs: WorkdirGitInputs;
  private readonly diffRuns = new Map<
    string,
    {
      promise: Promise<DiffState>;
      waiters: number;
      controller: AbortController;
    }
  >();

  constructor(inputs: WorkdirGitInputs) {
    this.inputs = inputs;
  }

  private gitText(
    args: string[],
    wt: string,
    limit: number,
    timeout = DIFF_TIMEOUT,
    signal?: AbortSignal,
  ): Promise<GitText> {
    return gitText(this.inputs.env, args, wt, limit, timeout, signal);
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
    const current = await this.gitText(
      ["remote", "get-url", "origin"],
      this.inputs.repoDir,
      4096,
      30.0,
    );
    if (current.text === null || current.code !== 0) return false;
    return (
      current.truncated ||
      pyStrip(current.text.replace(/\r\n?/gu, "\n")) !== this.inputs.repoUrl
    );
  }

  /** Directory a conversation spawned without an explicit workdir records. */
  async defaultSpawnWorkdir(): Promise<string> {
    if ((await this.isLocalSrc()) && !(await this.targetIsGitRepo()))
      return pyPathStr(this.inputs.repoUrl);
    return (await this.ready()) ? this.inputs.repoDir : this.inputs.dataDir;
  }

  private async gitCwd(
    candidate: unknown,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted || typeof candidate !== "string" || !candidate)
      return null;
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

  private async mergeBase(
    wt: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const base = await this.gitText(
      ["merge-base", "HEAD", ref],
      wt,
      256,
      5.0,
      signal,
    );
    return base.code === 0 && base.text && isSha(pyStrip(base.text))
      ? pyStrip(base.text).toLowerCase()
      : null;
  }

  /**
   * Typed refs select committed work; HEAD selects uncommitted edits.
   * Otherwise stop where HEAD meets the PR base, upstream or default branch.
   */
  private async resolveDiffBase(
    wt: string,
    override: string | null,
    knownBranch?: string | null,
    signal?: AbortSignal,
  ): Promise<[string | null, string | null, string, SelectedWork?]> {
    if (override) {
      const sha = await this.resolveRef(wt, override, signal);
      if (sha !== null) {
        if (override === "HEAD") return [sha, override, "override:HEAD"];
        const selected = await selectedWork(
          override,
          sha,
          await this.autoMainRef(wt, signal),
          (args, limit) => this.gitText(args, wt, limit, 5.0, signal),
        );
        return [
          selected?.base ?? null,
          override,
          `override:${override}`,
          selected?.work,
        ];
      }
    }
    const branch =
      knownBranch === undefined
        ? await branchAt(this.inputs.env, wt, signal)
        : knownBranch;
    if (branch) {
      const pr = this.inputs.lastBranchPr?.(wt, branch) ?? null;
      if (pr?.state === "OPEN" && pr.baseRefName) {
        for (const ref of [`origin/${pr.baseRefName}`, pr.baseRefName]) {
          if ((await this.resolveRef(wt, ref, signal)) === null) continue;
          const base = await this.mergeBase(wt, ref, signal);
          if (base !== null) return [base, ref, `pr:${pr.number}`];
        }
      }
      const tracked = await this.gitText(
        [
          "for-each-ref",
          "--format=%(upstream)%00%(upstream:short)%00%(upstream:remoteref)",
          `refs/heads/${branch}`,
        ],
        wt,
        1024,
        5.0,
        signal,
      );
      const [full, upstream, merge] = pyStrip(tracked.text ?? "").split("\0");
      if (tracked.code === 0 && full && merge !== `refs/heads/${branch}`) {
        const base = await this.mergeBase(wt, full, signal);
        if (base !== null) return [base, upstream!, `upstream:${upstream}`];
      }
    }
    const mainRef = await this.autoMainRef(wt, signal);
    if (mainRef !== null) {
      const [ref, sha] = mainRef;
      return [
        (await this.mergeBase(wt, sha, signal)) ?? sha,
        ref,
        `auto:${ref}`,
      ];
    }
    const head = await this.resolveRef(wt, "HEAD", signal);
    if (head !== null) return [head, "HEAD", "head"];
    return [null, null, "head"];
  }

  private async diffFiles(
    wt: string,
    num: GitText,
    signal?: AbortSignal,
    includeUntracked = false,
  ): Promise<[DiffFile[], number, string[], boolean]> {
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
    const more = Math.max(0, files.length - MAX_DIFF_FILES);
    if (!includeUntracked)
      return [files.slice(0, MAX_DIFF_FILES), more, [], false];
    const names = await this.gitText(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      wt,
      MAX_DIFF_STAT_BYTES,
      5.0,
      signal,
    );
    const untracked = (names.text ?? "").split("\0").filter(Boolean);
    return [files.slice(0, MAX_DIFF_FILES), more, untracked, names.truncated];
  }

  // Identical requests share one walk; it is killed once every caller that
  // brought a signal has gone, since a slow repo would otherwise keep one
  // full-tree git diff per abandoned conversation switch running.
  worktreeDiff(
    wt: string,
    baseOverride: string | null = null,
    cwdSource = "stored",
    signal?: AbortSignal,
    includeUntracked = true,
  ): Promise<DiffState> {
    includeUntracked &&= baseOverride === null || baseOverride === "HEAD";
    const key = JSON.stringify([wt, baseOverride, cwdSource, includeUntracked]);
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
          includeUntracked,
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
    includeUntracked: boolean,
  ): Promise<DiffState> {
    signal = anyAbortSignal([
      signal,
      AbortSignal.timeout(DIFF_REQUEST_TIMEOUT_MS),
    ]);
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
        branchAt(this.inputs.env, wt, signal),
        this.gitText(["rev-parse", "--verify", "HEAD"], wt, 256, 5.0, signal),
      ]);
      const [base, label, source, work] = await this.resolveDiffBase(
        wt,
        baseOverride,
        branch,
        signal,
      );
      if (base === null || signal.aborted)
        return unavailableDiff("diff-failed", cwd, cwdSource);
      const defaultBase = !source.startsWith("override:")
        ? label
        : baseOverride === "HEAD"
          ? null
          : (await this.resolveDiffBase(wt, null, branch, signal))[1];
      const headSha =
        work?.headSha ??
        (head.text && isSha(pyStrip(head.text))
          ? pyStrip(head.text).toLowerCase()
          : null);
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
            ...(work ? [work.headSha] : []),
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
      const [files, more, untracked, namesTruncated] = await this.diffFiles(
        wt,
        num,
        signal,
        includeUntracked,
      );
      if (signal.aborted) return unavailableDiff("diff-failed", cwd, cwdSource);
      const untrackedCapped = untracked.slice(0, MAX_UNTRACKED_NAMES);
      const untrackedTruncated =
        namesTruncated || untracked.length > untrackedCapped.length;
      const truncated =
        st.truncated || df.truncated || num.truncated || more > 0;
      let statText = st.text;
      let diff = df.text;
      if (st.truncated)
        statText += "\n... [stat truncated at the 64 KiB server cap]\n";
      if (df.truncated) diff += DIFF_TRUNCATION_MARK;
      const current = this.inputs.lastBranchPr?.(wt, branch) ?? null;
      if (
        !pyStrip(diff) &&
        !untrackedCapped.length &&
        current === null &&
        !truncated &&
        !untrackedTruncated
      )
        return {
          ...unavailableDiff("clean", cwd, cwdSource),
          base: label,
          baseSha: base,
          baseSource: source,
          defaultBase,
          selectedWork: work,
          headSha,
          branch,
        };
      const version = createHash("sha256")
        .update(
          [
            base,
            headSha ?? "",
            statText,
            diff,
            untrackedCapped.join("\0"),
            String(untrackedTruncated),
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
        defaultBase,
        selectedWork: work,
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
        untrackedTruncated,
        currentPr: current,
        version,
      };
    } catch {
      return unavailableDiff("diff-failed", cwd, cwdSource);
    }
  }

  private async fileContents(
    wt: string,
    root: string,
    rel: string,
    base: string,
    head?: string,
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
    let newRaw: Uint8Array = new Uint8Array(0);
    try {
      if (head) {
        const content = await this.gitText(
          ["show", `${head}:${rel}`],
          wt,
          MAX_FILE_CONTENT_BYTES,
          5.0,
        );
        if (content.truncated) return [null, null, true, false];
        newRaw = new TextEncoder().encode(
          content.code === 0 ? (content.text ?? "") : "",
        );
      } else {
        const info = await stat(candidate);
        if (info.isFile() && info.size > MAX_FILE_CONTENT_BYTES)
          return [null, null, true, false];
        if (info.isFile()) {
          const handle = await open(
            candidate,
            constants.O_RDONLY | constants.O_NONBLOCK,
          );
          try {
            if ((await handle.stat()).isFile()) {
              const buf = new Uint8Array(MAX_FILE_CONTENT_BYTES + 1);
              let offset = 0;
              while (offset < buf.length) {
                const { bytesRead } = await handle.read(
                  buf,
                  offset,
                  buf.length - offset,
                  offset,
                );
                if (!bytesRead) break;
                offset += bytesRead;
              }
              newRaw = buf.subarray(0, offset);
            }
          } finally {
            await handle.close();
          }
        }
      }
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

  /** One file's patch for lazy per-file loading (200 KiB cap). */
  async diffFile(
    wt: string,
    path: unknown,
    baseOverride: string | null = null,
    includeContents = false,
    snapshot: string | null = null,
  ): Promise<Record<string, unknown>> {
    if (typeof path !== "string" || !path || Array.from(path).length > 4096)
      return {
        available: false,
        reason: "bad-path",
        path: typeof path === "string" ? path : "",
      };
    if (path.includes("\0") || wt.includes("\0"))
      return { available: false, reason: "path-outside-repo", path };
    const pinned = snapshot?.split("..");
    if (pinned && (pinned.length !== 2 || !pinned.every(isSha)))
      return { available: false, reason: "bad-snapshot", path };
    const [base, label, source, work] = pinned
      ? ([
          pinned[0]!,
          baseOverride,
          "snapshot",
          { headSha: pinned[1]! },
        ] as const)
      : await this.resolveDiffBase(
          wt,
          baseOverride,
          undefined,
          AbortSignal.timeout(DIFF_REQUEST_TIMEOUT_MS),
        );
    if (base === null) return { available: false, reason: "diff-failed", path };
    const root = await pyResolve(wt);
    const full = work
      ? resolve(root, path)
      : await pyResolve(isAbsolute(path) ? path : `${root}/${path}`);
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
      const fullPath = relS === "." ? root : join(root, relS);
      if (!work && !isTracked && !(await isFile(fullPath)))
        return { available: false, reason: "no-such-file", path: relS };
      const args =
        work || isTracked
          ? ["diff", base, ...(work ? [work.headSha] : []), "--", relS]
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
          work?.headSha,
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
  async diffCandidates(
    wt: string,
    signal = AbortSignal.timeout(CANDIDATE_REQUEST_TIMEOUT_MS),
  ): Promise<Record<string, string[]>> {
    const timeout = CANDIDATE_REQUEST_TIMEOUT_MS / 1000;
    if (signal.aborted || wt.includes("\0") || !(await isDir(wt)))
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
        timeout,
        signal,
      );
      // Invariant: Git 2.55 shortens refs/remotes/<remote>/HEAD to "<remote>".
      // Keep Git 2.39's spelling: the first of "<remote>/HEAD" and
      // "remotes/<remote>/HEAD" that no other ref shares, else the full ref.
      branches = [];
      for (const line of splitlines(out.text ?? "")) {
        if (!pyStrip(line)) continue;
        if (signal.aborted || branches.length >= 100) break;
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
          timeout,
          signal,
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
      const mainRef = await this.autoMainRef(wt, signal);
      if (mainRef !== null) refs.push(mainRef[0]);
      const commits: string[] = [];
      for (const ref of refs) {
        const out = await this.gitText(
          ["log", "--format=%h %s", "-n", "30", ref, "--"],
          wt,
          64 * 1024,
          timeout,
          signal,
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
        timeout,
        signal,
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
