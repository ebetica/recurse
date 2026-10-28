// Report settled runs as one message: the latest run's trigger and outcome.
// Advance the cursor only after parent admission/drop; a retry over the same
// runs reuses the key; a held report keeps the cursor (delivery.ts). Read
// stored submissions/entries; withdrawn or stale inputs report nothing.
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type CommitPublication,
  type Conversation,
  type EntryId,
  type Harness,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { ReportHolds } from "./report_holds.ts";

export const ReportDoc = defineDoc<{ generation: string; after: number }>({
  kind: "recurse.report",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ generation: "", after: -1 }),
});

/** Names this storage in report keys and view identities before any run. */
export async function ensureReportGeneration(
  harness: Harness,
  conversation: Conversation,
): Promise<void> {
  if (
    !(await harness.snapshot(ReportDoc, conversation.id, context))?.generation
  )
    await conversation.commit(async (tx) => {
      (await tx.doc(ReportDoc, conversation.id)).generation =
        randomBytes(4).toString("hex");
    }, context);
}

export interface DurableReport {
  /** "r-<child>-<storage generation>-<first submission id>": a client key. */
  key: string;
  /** Request id of the input that started the run. */
  requestId: string | undefined;
  /** Request ids of the other inputs the reported runs placed. */
  received: (string | undefined)[];
  /** How many earlier settled runs this report replaces. */
  earlier: number;
  /** An input after these runs is still unsettled (it will start a run). */
  queued: boolean;
  finalText: string | null;
  aborted: boolean;
  error: string | null;
}

export type ReportOutcome = "done" | "retry" | "hold";

export interface ReporterDeps {
  child: string;
  harness: Harness;
  conversation: Conversation;
  storage: SqliteStorage;
  deliver(report: DurableReport): Promise<ReportOutcome>;
  log(event: string, fields: Record<string, unknown>): void;
  /** Called after a pass that reported every settled run. */
  onCaughtUp?(): void;
  /** Where a held report waits and an unsent one counts as holding. */
  holds?: ReportHolds;
}

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 60_000;

type Settled = SubmissionRecord & { status: "done" | "unanswered" };

const settled = (record: SubmissionRecord): record is Settled =>
  record.status === "done" || record.status === "unanswered";

/** A run's error line: the model's or the task's detail, else the reason. */
function runError(record: Settled): string | null {
  if (record.status === "done" || record.reason === "aborted") return null;
  if (record.reason === "reset") return null;
  return typeof record.detail === "string" && record.detail.trim()
    ? record.detail
    : record.reason;
}

/** The text of an assistant message. */
function assistantText(message: unknown): string | null {
  const content = (message as { role?: string; content?: unknown } | undefined)
    ?.content;
  if (!Array.isArray(content))
    return typeof content === "string" ? content : null;
  const text = content
    .filter((part: Record<string, unknown>) => part.type === "text")
    .map((part: Record<string, unknown>) => String(part.text))
    .join("\n");
  return text || null;
}

/** Finds settled runs past the cursor and reports each once, in order. */
export class Reporter {
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delay = RETRY_FIRST_MS;
  private settledCommits = 0;
  private held: { key: string; since: number } | undefined;
  // False from each settling commit until a later pass reports every run.
  caughtUp = false;

  constructor(private readonly deps: ReporterDeps) {
    deps.holds?.watch(deps.child, this);
  }

  /**
   * True when the commit settled an input, so a pass has something to
   * report; call from the commit listener.
   */
  noteCommit(publication: CommitPublication): boolean {
    const due = publication.changes.some(
      (change) =>
        change.type === "submission" &&
        change.value.type === "input" &&
        settled(change.value),
    );
    if (due) {
      this.settledCommits += 1;
      this.caughtUp = false;
    }
    return due;
  }

  // Report what settled; one pass at a time, and one more after a kick during
  // it.
  kick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.closed);
      } catch (error) {
        // Invariant: A pass the close overtook resumes on the next open.
        if (this.closed) return;
        this.retryLater();
        throw error;
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.deps.holds?.unwatch(this.deps.child, this);
  }

  /** After the conversation's state changed: it may no longer hold reports. */
  recheck(): void {
    this.deps.holds?.release(this.deps.child);
  }

  private retryLater(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.kick(), this.delay);
    this.delay = Math.min(this.delay * 2, RETRY_MAX_MS);
  }

  private async advance(after: number): Promise<void> {
    const { conversation } = this.deps;
    await conversation.commit(async (tx) => {
      (await tx.doc(ReportDoc, conversation.id)).after = after;
    }, context);
  }

  private async entry(
    id: number,
  ): Promise<{ byTask: boolean; text: string | null }> {
    const at = id as EntryId;
    const page = await this.deps.conversation.entries(
      { minEntryId: at, maxEntryId: at },
      1,
      undefined,
      context,
    );
    const entry = page.items[0];
    return {
      byTask: entry?.byTaskId !== undefined,
      text: assistantText(entry?.model?.[0]),
    };
  }

  private async pass(): Promise<void> {
    const { harness, conversation, storage } = this.deps;
    const seen = this.settledCommits;
    const doc = await harness.snapshot(ReportDoc, conversation.id, context);
    const generation = doc?.generation ?? "";
    const after = doc?.after ?? -1;

    const inputs: SubmissionRecord[] = [];
    let at = after;
    let blocked = false;
    for (let more = true; more && !blocked; ) {
      const page = await storage.scanSubmissions(
        { conversationId: conversation.id },
        100,
        { after: at },
        context,
      );
      more = page.next !== undefined;
      for (const record of page.items) {
        if (record.type === "write") {
          if (!blocked) at = Number(record.id);
          continue;
        }
        inputs.push(record);
        if (!settled(record)) {
          blocked = true;
          break;
        }
        at = Number(record.id);
      }
    }
    this.caughtUp = false;
    const placedByTask = async (record: SubmissionRecord | undefined) =>
      record?.entry !== undefined &&
      (await this.entry(Number(record.entry))).byTask;
    const runs: Settled[][] = [];
    let complete = true;
    for (let i = 0; i < inputs.length; ) {
      if (!settled(inputs[i]!)) break;
      let end = i + 1;
      while (end < inputs.length && (await placedByTask(inputs[end]))) end += 1;
      const run = inputs.slice(i, end);
      if (!run.every(settled)) {
        complete = false;
        break;
      }
      runs.push(run);
      i = end;
    }
    if (this.closed) return;
    // Invariant: Only the latest reported run's text reaches the parent; the
    // earlier ones are counted, and their key is never used again.
    const reported = runs.filter((run) => run[0]!.entry !== undefined);
    const latest = reported.at(-1);
    if (latest !== undefined) {
      const [first, last] = [latest[0]!, latest.at(-1)!];
      const key = `r-${this.deps.child}-${generation}-${Number(first.id)}`;
      let outcome: ReportOutcome;
      try {
        outcome = await this.deps.deliver({
          key,
          requestId: first.requestId,
          received: reported
            .flat()
            .filter((input) => input !== first && input.entry !== undefined)
            .map((input) => input.requestId),
          earlier: reported.length - 1,
          queued: blocked,
          finalText:
            last.status === "done"
              ? (await this.entry(Number(last.answer))).text
              : null,
          aborted: last.status === "unanswered" && last.reason === "aborted",
          error: runError(last),
        });
      } catch (error) {
        this.deps.log("durable_report_failed", {
          cid: this.deps.child,
          error: String(error),
        });
        outcome = "retry";
      }
      if (outcome === "retry") return this.retryLater();
      if (outcome === "hold") {
        this.deps.holds?.hold(this);
        if (this.held?.key !== key) {
          this.held = { key, since: Date.now() };
          this.deps.log("durable_report_held", { cid: this.deps.child, key });
        }
        return;
      }
      const held = this.held && { held_ms: Date.now() - this.held.since };
      this.held = undefined;
      this.deps.log("durable_report_delivered", {
        cid: this.deps.child,
        key,
        ...held,
      });
    }
    this.delay = RETRY_FIRST_MS;
    const end = complete ? at : Number(runs.at(-1)?.at(-1)?.id ?? after);
    if (end > after && !this.closed) await this.advance(end);
    this.caughtUp = !this.closed && seen === this.settledCommits;
    if (!this.caughtUp) return;
    this.deps.onCaughtUp?.();
    this.recheck();
  }
}
