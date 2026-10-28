// Bounded PR identities observed from tools, copied upward without retaining
// text.
// Reap drains pending admissions before retiring the database. Failures stay
// pending for retry; persistent admission faults fail drain, never retirement.
import type { ConversationStore } from "./conversation_store";
import type { TaskSet } from "../utils/tasks";
import { prIdentity } from "../pull_request";

export const TOUCHED_PR_LIMIT = 50;
export function mergeTouchedPrs(
  old: unknown,
  urls: readonly string[],
): string[] {
  const kept = new Set<string>();
  for (const raw of [...(Array.isArray(old) ? old : []), ...urls]) {
    const pr = typeof raw === "string" ? prIdentity(raw) : null;
    if (!pr) continue;
    kept.delete(pr.url);
    kept.add(pr.url);
  }
  return [...kept].slice(-TOUCHED_PR_LIMIT);
}

export function toolPrs(event: Record<string, unknown>): string[] {
  if (
    event.type !== "tool_execution_start" &&
    event.type !== "tool_execution_end"
  )
    return [];
  const urls: string[] = [];
  const add = (url: string) => {
    urls.push(url);
    if (urls.length > TOUCHED_PR_LIMIT) urls.shift();
  };
  function scan(value: unknown, depth = 0): void {
    if (depth > 12) return;
    if (typeof value === "string") {
      for (const match of value.matchAll(
        /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\b/gu,
      ))
        add(match[0]);
      for (const match of value.matchAll(
        /\bgh\s+api\s+[^\n;&|]*?\brepos\/([\w.-]+\/[\w.-]+)\/pulls\/([1-9]\d*)\b/gu,
      ))
        add(`https://github.com/${match[1]}/pull/${match[2]}`);
      for (const match of value.matchAll(
        /\bgh\s+pr\s+(view|diff|merge|checkout|close|reopen|edit|review|checks|ready|comment|lock|unlock)\s+([^\n;&|]+)/gu,
      )) {
        const tokens =
          match[2]!
            .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu)
            ?.map((t) => t.replace(/["']/gu, "")) ?? [];
        const repoAt = tokens.findIndex(
          (t) =>
            t === "--repo" ||
            t === "-R" ||
            t.startsWith("--repo=") ||
            t.startsWith("-R"),
        );
        if (repoAt < 0) continue;
        const flag = tokens[repoAt]!;
        const attached = flag.startsWith("--repo=")
          ? flag.slice(7)
          : flag !== "-R" && flag.startsWith("-R")
            ? flag.slice(2)
            : null;
        const repo = attached ?? tokens[repoAt + 1];
        const rest = tokens.filter(
          (_, i) => i !== repoAt && (attached !== null || i !== repoAt + 1),
        );
        if (
          repo &&
          /^[\w.-]+\/[\w.-]+$/u.test(repo) &&
          /^[1-9]\d*$/u.test(rest[0] ?? "")
        )
          add(`https://github.com/${repo}/pull/${rest[0]}`);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) scan(item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) scan(item, depth + 1);
    }
  }
  scan(event.args);
  scan(event.result);
  return mergeTouchedPrs([], urls);
}

export class TouchedPrs {
  private readonly pending = new Map<string, string[]>();
  private running: Promise<void> | null = null;
  constructor(
    private readonly store: Pick<ConversationStore, "load" | "addTouchedPrs">,
    private readonly tasks: TaskSet,
  ) {}
  observe(cid: string, event: Record<string, unknown>): void {
    const urls = toolPrs(event);
    if (!urls.length) return;
    const seen = new Set<string>();
    while (!seen.has(cid)) {
      seen.add(cid);
      const record = this.store.load(cid, { withPending: false });
      if (!record) break;
      this.pending.set(cid, mergeTouchedPrs(this.pending.get(cid), urls));
      if (typeof record.parent !== "string") break;
      cid = record.parent;
    }
    this.start();
  }
  private start(): Promise<void> {
    if (this.running) return this.running;
    const task = this.tasks.spawn("record_touched_prs", async () => {
      for (const [cid, urls] of this.pending) {
        await this.store.addTouchedPrs(cid, urls);
        // Invariant: Observations arriving during the admission remain queued.
        if (this.pending.get(cid) === urls) this.pending.delete(cid);
      }
    });
    this.running = task;
    task.then(
      () => {
        this.running = null;
        if (this.pending.size) this.start();
      },
      () => {
        this.running = null;
      },
    );
    return task;
  }
  async drain(): Promise<void> {
    while (this.running || this.pending.size)
      await (this.running ?? this.start());
  }
}
