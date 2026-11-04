// Pull requests linked to a conversation, saved as small `prs` snapshots: its
// branch PR and PRs its tool calls created with `gh pr create`. Lookups run
// after each run, when the Changes pane opens and when a PR is created; reads
// never wait on GitHub and `prs_revision` marks snapshot changes.
import type {
  ConversationRecord,
  ConversationStore,
} from "./conversation_store";
import type { TaskSet } from "../utils/tasks";
import type { PrValue, WorkdirGit } from "../workdir_git";
import { prIdentity } from "../pull_request";

export interface LinkedPr {
  /** owner/repo, lower case. */
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
  checks: PrValue["checks"];
  source: "branch" | "created";
  /** When the PR was first linked, in epoch seconds. */
  detected_at: number;
  /** In an ancestor's list: the descendant conversation that linked it. */
  agent?: { id: string; title: string };
}

/** At most this many open created PRs are refreshed per lookup. */
const CREATED_REFRESH = 5;
/** Created PRs whose last check time is remembered, instance-wide. */
const CHECKED_LIMIT = 1000;

function linkedPrs(value: unknown): LinkedPr[] {
  return Array.isArray(value)
    ? value.filter(
        (pr): pr is LinkedPr =>
          !!pr &&
          typeof pr.url === "string" &&
          typeof pr.detected_at === "number",
      )
    : [];
}

/**
 * Titled snapshots of the conversation and its live descendants, once per URL
 * at its latest detection: its open branch PR first, then newest first.
 */
export function linkedPrList(
  record: ConversationRecord,
  descendants: ConversationRecord[] = [],
): LinkedPr[] {
  const shown = (prs: unknown) => linkedPrs(prs).filter((pr) => pr.title);
  const own = shown(record.prs);
  const theirs = descendants.flatMap((child) =>
    shown(child.prs).map((pr) => ({
      ...pr,
      agent: { id: String(child.id), title: String(child.title ?? "") },
    })),
  );
  const first = (pr: LinkedPr) =>
    !pr.agent && pr.source === "branch" && pr.state === "open" ? 1 : 0;
  const mine = new Set(own.map((pr) => pr.url));
  const latest = new Map<string, number>();
  for (const pr of [...own, ...theirs])
    latest.set(pr.url, Math.max(pr.detected_at, latest.get(pr.url) ?? 0));
  const seen = new Set<string>();
  return [...own, ...theirs.filter((pr) => !mine.has(pr.url))]
    .map((pr) => ({ ...pr, detected_at: latest.get(pr.url)! }))
    .sort((a, b) => first(b) - first(a) || b.detected_at - a.detected_at)
    .filter((pr) => !seen.has(pr.url) && !!seen.add(pr.url));
}

/**
 * The PR a successful bash `command` created: a `gh pr create` command's last
 * output line that is a PR URL, as `gh pr create` prints it.
 */
export function createdPrUrls(command: string, output: string): string[] {
  if (!/(?:^|[;&|(\n])\s*gh\s+pr\s+create\b/u.test(command)) return [];
  const urls = output
    .split("\n")
    .flatMap((line) => prIdentity(line.trim()) ?? []);
  return urls.length ? [urls.at(-1)!.url] : [];
}

export class ConversationPrs {
  private readonly running = new Set<string>();
  /** Conversations with a lookup requested while one ran, and its reason. */
  private readonly again = new Map<string, string>();
  /** When each recently looked-up created PR was checked, oldest first. */
  private readonly checked = new Map<string, number>();
  constructor(
    private readonly deps: {
      store: Pick<ConversationStore, "updatePrs" | "metadataSnapshot">;
      git: Pick<WorkdirGit, "branchPr" | "pullRequest">;
      /** The working directory the Changes pane shows, or null. */
      cwd(cid: string): Promise<string | null>;
      tasks: TaskSet;
      now(): number;
    },
  ) {}

  /**
   * Save PRs a tool call that started at `since` (epoch seconds) printed as
   * created, then look up their details.
   */
  recordCreated(cid: string, urls: string[], since: number): void {
    void this.deps.tasks.spawn("record_created_prs", async () => {
      await this.deps.store.updatePrs(cid, (value) => {
        const prs = linkedPrs(value);
        for (const url of urls) {
          const pr = prIdentity(url);
          if (
            pr &&
            !prs.some((old) => old.source === "created" && old.url === pr.url)
          )
            prs.push({
              ...pr,
              title: "",
              state: "open",
              checks: null,
              source: "created",
              detected_at: since,
            });
        }
        return prs;
      });
      this.refresh(cid, "pr_created");
    });
  }

  /** Look up and save the branch PR and open created PRs in the background;
   * `reason` is logged with any GitHub call. */
  refresh(cid: string, reason: string): void {
    if (this.running.has(cid)) return void this.again.set(cid, reason);
    this.running.add(cid);
    void this.deps.tasks.spawn("refresh_linked_prs", async () => {
      try {
        await this.lookUp(cid, reason);
      } finally {
        this.running.delete(cid);
        const next = this.again.get(cid);
        this.again.delete(cid);
        if (next !== undefined) this.refresh(cid, next);
      }
    });
  }

  private async lookUp(cid: string, reason: string): Promise<void> {
    const record = this.deps.store.metadataSnapshot(cid);
    if (!record) return;
    const cwd = await this.deps.cwd(cid);
    const branch =
      cwd === null ? null : await this.deps.git.branchPr(cwd, reason, cid);
    const open = linkedPrs(record.prs).filter(
      (pr) => pr.source === "created" && pr.state === "open",
    );
    // Invariant: Unchecked created PRs come first, then those checked least
    // recently, at most CREATED_REFRESH per lookup.
    const due = open
      .sort(
        (a, b) =>
          Number(!!a.title) - Number(!!b.title) ||
          (this.checked.get(a.url) ?? 0) - (this.checked.get(b.url) ?? 0),
      )
      .slice(0, CREATED_REFRESH)
      .map((pr) => pr.url);
    if (!branch && !due.length) return;
    const found = new Map<string, PrValue | null>();
    for (const url of due) {
      found.set(url, await this.deps.git.pullRequest(url, reason, cid));
      this.checked.delete(url);
      this.checked.set(url, this.deps.now());
      if (this.checked.size > CHECKED_LIMIT)
        this.checked.delete(this.checked.keys().next().value!);
    }
    const now = this.deps.now();
    const snapshot = (
      pr: PrValue,
      source: LinkedPr["source"],
      old: LinkedPr | undefined,
    ): LinkedPr => ({
      repo: prIdentity(pr.url)!.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      state: pr.state.toLowerCase() as LinkedPr["state"],
      checks: pr.checks,
      source,
      detected_at: old?.detected_at ?? now,
    });
    await this.deps.store.updatePrs(cid, (value) => {
      // Invariant: A created PR opened over a minute before the call that
      // printed it was not created by that call and is dropped unchecked.
      const prs = linkedPrs(value).flatMap((old) => {
        const pr = old.source === "created" && found.get(old.url);
        if (!pr) return [old];
        if (!old.title && !(pr.createdAt! >= old.detected_at - 60)) return [];
        return [snapshot(pr, "created", old)];
      });
      if (!branch) return prs;
      const old = prs.find((pr) => pr.source === "branch");
      return [
        ...prs.filter((pr) => pr.source !== "branch"),
        snapshot(branch, "branch", old?.url === branch.url ? old : undefined),
      ];
    });
  }
}
