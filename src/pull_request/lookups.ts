// GitHub pull requests and origin links. One instance shares the lookup caches
// and GitHub CLI backoff across branch lookups, PR details, and PR patches.
import { createHash } from "node:crypto";
import { branchAt, gitText, pyStrip, type GitText } from "../git";
import { GitHubCli } from "./github";
import { prIdentity } from "./identity";
import { pullRequestFiles } from "./patch";

type Env = Readonly<Record<string, string | undefined>>;

interface PullRequestInputs {
  dataDir: string;
  /** The server's process environment (os.environ). */
  env: Env;
  /** Monotonic seconds; defaults to performance.now() / 1000. */
  now?: () => number;
  /** Log one event, e.g. each `gh` call and why it ran. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const MAX_DIFF_BYTES = 1_000_000;
const MAX_DIFF_FILES = 200;
const MAX_FILE_PATCH_BYTES = 200 * 1024;
const DIFF_TIMEOUT = 10.0;
const GH_CACHE_TTL = 20.0;
const BRANCH_PR_INTERVAL = 60.0;

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

export class PullRequests {
  private readonly now: () => number;
  private readonly cli: GitHubCli;
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
  private readonly githubBases = new Map<string, Promise<string | null>>();

  constructor(private readonly inputs: PullRequestInputs) {
    this.now = inputs.now ?? (() => performance.now() / 1000);
    this.cli = new GitHubCli(inputs, this.now);
  }

  private gitText(
    args: string[],
    wt: string,
    limit: number,
    timeout = DIFF_TIMEOUT,
  ): Promise<GitText> {
    return gitText(this.inputs.env, args, wt, limit, timeout);
  }

  // One bounded, coalesced origin lookup per checkout, not per poll/message.
  async githubRepoUrl(cwd: string): Promise<string | null> {
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

  /** Last cached PR for this checkout, only if its branch still matches. */
  lastBranchPr(wt: string, branch: string | null): PrValue | null {
    const cached = this.cwdPr.get(wt);
    return cached?.[1] === branch ? cached[0] : null;
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
    const branch = await branchAt(this.inputs.env, wt);
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
      const row = await this.cli.gh(
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
    const rows = await this.cli.gh(
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
        this.cli.gh(
          queue,
          ["pr", "diff", String(pr.number), ...repo, "--color", "never"],
          this.inputs.dataDir,
          "pull_request_diff",
          MAX_DIFF_BYTES,
          (r) => r,
          DIFF_TIMEOUT,
        ),
        this.cli.gh(
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
}
