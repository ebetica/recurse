// Project bounded Durable entries/documents into ConversationView rows.
// Hold the oldest entry for its predecessor; retries are page-stable.
// Storage generation identifies sessions across clear, not cache eviction.
// Keep provenance and model text; artifact IDs name real tasks or entries.
import type {
  Conversation,
  Harness,
  Cursor,
  EntryId,
  EntryRecord,
  InboxState,
  LiveState,
} from "@earendil-works/pi-durable";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { ReportDoc } from "./report";
import { ReplyTimesDoc } from "./reply_times";
import { ConversationView, LOST_STOP_REASON } from "../view/conversation";
import { splitPiUserText } from "../view/session_entries";
import { slowSpan } from "../../observability/slow_span";
import { displayToolContent } from "./display_content";
import {
  needsOlder,
  unavailable,
  ViewCache,
  ViewEntry,
  window,
} from "../view/reader";

type Rec = Record<string, unknown>;

export type ReplyTimes = Readonly<Record<string, number>>;

export type ProjectionEntry = Rec & { id: string; parentId: string | null };

const PAGE = 100;
/** New-entry pages one read follows before it reloads the newest page. */
const CATCH_UP_PAGES = 10;
const THINKING_MAX_CHARS = 8000;
const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

const record = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The summary text of a pi.compaction entry, unwrapped. */
export function compactionSummary(entry: EntryRecord): string {
  const summary = importedEntry(entry)?.summary;
  if (typeof summary === "string") return summary;
  const content = (entry.model?.[0] as Rec | undefined)?.content;
  const text = Array.isArray(content)
    ? content
        .map((part: Rec) => (part.type === "text" ? part.text : ""))
        .join("")
    : String(content ?? "");
  return text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)
    ? text.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length)
    : text;
}

/** An assistant message's full thinking, bounded; null when it has none. */
export function thinkingText(message: unknown): string | null {
  const content = record(message) ? message.content : null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part: Rec) => part?.type === "thinking")
    .map((part: Rec) => String(part.thinking ?? ""))
    .filter((part) => part.trim())
    .join("\n\n");
  if (!text) return null;
  const chars = [...text];
  return chars.length > THINKING_MAX_CHARS
    ? `${chars.slice(0, THINKING_MAX_CHARS - 1).join("")}…`
    : text;
}

/** pi-recurse's compaction token wording (formatCompactionTokens). */
function tokensLabel(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 999_500) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value / 1_000_000)}m`;
}

const toolCalls = (message: Rec): Rec[] =>
  Array.isArray(message.content)
    ? message.content.filter((part: Rec) => part?.type === "toolCall")
    : [];

/**
 * Shell notice text marked by the shells extension; null for other input.
 */
function shellNotice(content: unknown): string | null {
  return Array.isArray(content) &&
    content.some((part: Rec) => part?.shellNotice === true)
    ? content
        .map((part: Rec) => (part?.type === "text" ? String(part.text) : ""))
        .join("")
    : null;
}

export interface RowState {
  /** Context size at the newest reply, for the compaction notice. */
  tokens: number | null;
  /** The newest tool round's call ids and their assistant entry id. */
  calls: Map<string, string>;
  /** The current turn's newest reply that thought, as a live overlay. */
  thinking: ProjectionEntry | null;
}

export const rowState = (): RowState => ({
  tokens: null,
  calls: new Map(),
  thinking: null,
});

const importedEntry = (entry: EntryRecord): Rec | null =>
  record(entry.data) && record(entry.data.piEntry) ? entry.data.piEntry : null;

/** The parent id of the entry after `entry`. */
const chainId = (entry: EntryRecord): string =>
  entry.kind === "pi.compaction" &&
  entry.head !== undefined &&
  !importedEntry(entry)
    ? `${String(entry.id)}:notice`
    : String(entry.id);

/**
 * Projection entries for `records` in id order, the first one a child of
 * `parentId`; updates `state`.
 */
export function projectionEntries(
  records: readonly EntryRecord[],
  state: RowState,
  parentId: string | null = null,
  artifactPrefix = "d",
  replyTimes: ReplyTimes = {},
): ProjectionEntry[] {
  const out: ProjectionEntry[] = [];
  for (const entry of records) {
    if (entry.kind === "recurse.pi-synthetic") continue;
    const id = String(entry.id);
    const base = { id, parentId, _offset: Number(entry.id) };
    parentId = id;
    const message = entry.model?.[0] as Rec | undefined;
    const imported = importedEntry(entry);
    const note =
      entry.kind === "pi.user" ? shellNotice(message?.content) : null;
    if (note !== null) {
      state.thinking = null;
      out.push({
        ...base,
        type: "custom_message",
        customType: "bg-shell",
        display: true,
        content: note,
      });
    } else if (
      message &&
      ["pi.user", "recurse.note", "pi.assistant", "pi.tool-result"].includes(
        entry.kind,
      )
    ) {
      if (message.role === "user") state.thinking = null;
      if (entry.kind === "pi.assistant") {
        // Invariant: Only the newest tool round can still be running.
        const calls = toolCalls(message);
        if (calls.length) state.calls.clear();
        for (const call of calls) state.calls.set(String(call.id), id);
        const usage = message.usage as Rec | undefined;
        if (typeof usage?.totalTokens === "number" && usage.totalTokens > 0)
          state.tokens = usage.totalTokens;
        if (thinkingText(message) !== null)
          state.thinking = {
            ...base,
            type: "message",
            message,
            hasThinking: true,
            ...(typeof message.timestamp === "number"
              ? { thinkingStartMs: message.timestamp }
              : {}),
          };
      }
      const finished =
        entry.kind === "pi.assistant"
          ? replyTimes[String(message.timestamp)]
          : undefined;
      out.push({
        ...imported,
        ...base,
        type: "message",
        message:
          entry.kind === "pi.tool-result" && !imported
            ? {
                ...message,
                content: displayToolContent(message.content, entry.data),
              }
            : (imported?.message ?? message),
        ...(finished === undefined
          ? {}
          : { timestamp: new Date(finished).toISOString() }),
        ...(entry.kind === "pi.tool-result" && entry.byTaskId !== undefined
          ? { artifactId: `${artifactPrefix}-${String(entry.byTaskId)}` }
          : entry.kind === "pi.tool-result" && !imported
            ? { artifactId: `${artifactPrefix}-r${String(entry.id)}` }
            : {}),
      });
    } else if (imported) {
      out.push({ ...imported, ...base });
    } else if (entry.kind === "pi.compaction" && entry.head !== undefined) {
      const pointId = String(entry.head);
      out.push({
        ...base,
        type: "compaction",
        summary: compactionSummary(entry),
        firstKeptEntryId: pointId,
      });
      out.push({
        id: `${id}:notice`,
        parentId: id,
        _offset: Number(entry.id),
        type: "custom_message",
        customType: "recurse.compaction-notice",
        display: true,
        content:
          state.tokens === null
            ? "Context compacted."
            : `Context compacted at ${tokensLabel(state.tokens)} tokens.`,
        details: { pointId },
      });
      parentId = `${id}:notice`;
    } else if (
      entry.kind === "recurse.compaction-notice" &&
      typeof (entry.data as Rec | undefined)?.text === "string"
    )
      out.push({
        ...base,
        type: "custom_message",
        customType: "recurse.compaction-notice",
        display: true,
        content: (entry.data as Rec).text,
      });
    else if (
      entry.kind === "recurse.task-failure" &&
      typeof (entry.data as Rec | undefined)?.text === "string"
    ) {
      const data = entry.data as Rec;
      out.push({
        ...base,
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: LOST_STOP_REASON,
          errorMessage: data.text,
          timestamp: typeof data.at === "number" ? data.at : 0,
        },
      });
    } else out.push({ ...base, type: "custom", customType: entry.kind });
  }
  return out;
}

// Project live replies, tools and compactions. Keep the newest thinking
// reply live while the run continues; newest is the newest ingested entry ID.
export function liveEntries(
  live: Readonly<LiveState> | undefined,
  newest: string | null,
  state: RowState,
  inbox?: Readonly<InboxState>,
): ProjectionEntry[] {
  const out: ProjectionEntry[] = [];
  if (live?.run && state.thinking) out.push(state.thinking);
  const message = live?.generation?.message as Rec | undefined;
  if (message && live?.run) {
    // Invariant: Thinking text may arrive only when the step ends: a thinking
    // block marks the step as started, as Pi's live thinking_start does.
    const thinking =
      Array.isArray(message.content) &&
      message.content.some((part: Rec) => part?.type === "thinking");
    out.push({
      id: `live:${String(live.run.taskId)}:${live.generation!.attempt}`,
      parentId: newest,
      type: "message",
      message,
      ...(thinking && typeof message.timestamp === "number"
        ? { thinkingStartMs: message.timestamp }
        : {}),
    });
  }
  for (const slot of live?.tools ?? []) {
    const owner = state.calls.get(slot.callId);
    if (slot.status !== "running" || owner === undefined) continue;
    const nested =
      slot.name === "codemode"
        ? (live?.nestedTools ?? []).filter(
            (call) => call.parentCallId === slot.callId,
          )
        : undefined;
    const details = nested
      ? {
          calls: nested.map((call) => ({
            name: call.name,
            args: JSON.stringify(call.arguments).slice(0, 300),
            status:
              call.status !== "done"
                ? "running"
                : call.summary?.isError
                  ? "error"
                  : "ok",
            durationMs: call.summary?.durationMs,
            error: call.summary?.error,
          })),
        }
      : slot.details;
    out.push({
      id: `live-tool:${slot.callId}`,
      parentId: null,
      type: "message",
      callEntryId: owner,
      toolRunning: true,
      message: {
        role: "toolResult",
        toolCallId: slot.callId,
        content: [{ type: "text", text: slot.output ?? "" }],

        ...(details !== undefined ? { details } : {}),
      },
    });
  }
  for (const item of inbox?.items ?? [])
    if (item.mode === "write" && item.entry.kind === "pi.compaction")
      out.push({
        id: `compaction-ready:${String(item.id)}`,
        parentId: newest,
        type: "custom",
        customType: "recurse.compact-ready",
      });
  for (const compaction of live?.compactions ?? [])
    out.push({
      id: `compacting:${String(compaction.taskId)}`,
      parentId: newest,
      type: "custom",
      customType: "recurse.compact-pending",
    });
  return out;
}

/** Queued inputs as the conversation's pending rows. */
export function pendingRows(
  inbox: Readonly<InboxState> | undefined,
  requestIds: ReadonlyMap<string, string>,
): Rec[] {
  const rows: Rec[] = [];
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write") continue;
    const content = item.content as unknown;
    if (shellNotice(content) !== null) continue;
    const [origin, sender, senderName, text] = splitPiUserText(
      Array.isArray(content)
        ? content
            .map((part: Rec) => (part.type === "text" ? part.text : ""))
            .join("")
        : String(content),
    );
    rows.push({
      id: requestIds.get(String(item.id)) ?? `durable-${String(item.id)}`,
      role: "user",
      content: text,
      ...(origin ? { origin } : {}),
      ...(sender ? { from: sender } : {}),
      ...(senderName ? { from_name: senderName } : {}),
      ...(item.mode === "steer" ? { steer: true } : {}),
    });
  }
  return rows;
}

export interface PageOptions {
  after?: string | null;
  before?: string | null;
  limit?: number;
  since?: number | null;
  instance?: string | null;
}

/** One Durable conversation's projection and its paging position. */
export class DurableRows {
  private newest: number | null = null;
  private older: Cursor | undefined;
  /** The oldest entry read so far, ingested when the page before it loads. */
  private held: EntryRecord | undefined;
  /** The parent id of the next new entry. */
  private tail: string | null = null;
  private readonly state = rowState();
  private replyTimes: () => Promise<ReplyTimes> = async () => ({});

  constructor(
    readonly cid: string,
    private readonly pageSize = PAGE,
    private readonly view = new ViewEntry(new ConversationView(cid, "durable")),
    private readonly artifactPrefix = "d",
  ) {}

  // Serve one /view page; the caller runs reads of one conversation one at a
  // time.
  async page(
    conversation: Conversation,
    context: Context,
    live: Readonly<LiveState> | undefined,
    envelope: Rec,
    options: PageOptions,
    replyTimes: () => Promise<ReplyTimes> = async () => ({}),
    files: PublishedFiles = async () => ({}),
    inbox?: Readonly<InboxState>,
  ): Promise<Rec> {
    this.replyTimes = replyTimes;
    await this.catchUp(conversation, context);
    const before = options.before ?? null;
    const limit = options.limit ?? 50;
    if (needsOlder(this.view, before, limit))
      await this.loadOlder(conversation, context);

    const callIds = this.view.unresolvedAttachments();
    const published = callIds.length ? await files(callIds) : {};
    const newest = this.newest === null ? null : String(this.newest);
    return slowSpan("view_projection", this.cid, () =>
      window(
        this.view,
        {
          cid: this.cid,
          sessionId: `${this.cid}:${this.artifactPrefix}`,
          sessionFile: null,
          sessionCwd: "",
          live: JSON.stringify(liveEntries(live, newest, this.state, inbox)),
          envelope: JSON.stringify(envelope),
          files: JSON.stringify(published),
          maxSessionBytes: 0,
        },
        { caughtUp: true, ...options, before, limit },
      ),
    );
  }

  /**
   * Entries of a newest-first page in id order, after the held entry when
   * there is one. While older pages remain, the oldest is held back.
   */
  private olderPage(items: readonly EntryRecord[], next: Cursor | undefined) {
    const records = [...items].reverse();
    if (this.held !== undefined) records.push(this.held);
    this.older = next;
    this.held = next === undefined ? undefined : records.shift();
    this.view.feed = { ...this.view.feed, oldest: next ? 1 : 0 };
    const parent = this.held === undefined ? null : chainId(this.held);
    return { records, parent };
  }

  private async catchUp(
    conversation: Conversation,
    context: Context,
  ): Promise<void> {
    if (this.newest === null) {
      const page = await conversation.entries(
        {},
        this.pageSize,
        undefined,
        context,
      );
      const { records, parent } = this.olderPage(page.items, page.next);
      this.ingest(records, parent, await this.finished(records));
      return;
    }
    const fresh: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (let pages = 0; ; pages += 1) {
      if (pages === CATCH_UP_PAGES) {
        this.view.reset("durable");
        this.newest = null;
        this.held = undefined;
        Object.assign(this.state, rowState());
        return this.catchUp(conversation, context);
      }
      const page = await conversation.entries(
        { minEntryId: (this.newest + 1) as EntryId },
        this.pageSize,
        cursor,
        context,
      );
      fresh.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    fresh.reverse();
    this.ingest(fresh, this.tail, await this.finished(fresh));
  }

  /** The reply times, read after `records` (their finish times commit
   * before them), when they hold a reply. */
  private async finished(records: readonly EntryRecord[]) {
    return records.some((entry) => entry.kind === "pi.assistant")
      ? this.replyTimes()
      : {};
  }

  private ingest(
    records: EntryRecord[],
    parentId: string | null,
    replyTimes: ReplyTimes,
  ): void {
    if (!records.length) return;
    slowSpan("view_projection", this.cid, () =>
      this.view.ingest(
        projectionEntries(
          records,
          this.state,
          parentId,
          this.artifactPrefix,
          replyTimes,
        ),
      ),
    );
    this.newest = Number(records.at(-1)!.id);
    this.tail = chainId(records.at(-1)!);
  }

  private async loadOlder(
    conversation: Conversation,
    context: Context,
  ): Promise<void> {
    const page = await conversation.entries(
      {},
      this.pageSize,
      this.older,
      context,
    );
    const { records, parent } = this.olderPage(page.items, page.next);
    this.view.prepend(
      projectionEntries(
        records,
        rowState(),
        parent,
        this.artifactPrefix,
        await this.finished(records),
      ),
    );
  }
}

export type PublishedFiles = (
  callIds: readonly string[],
) => Promise<Record<string, unknown[]>>;

export class DurableViews {
  private readonly cache: ViewCache;
  constructor(
    limits = { maxViews: 200, idleTtl: 600 },
    private readonly pageSize = PAGE,
  ) {
    this.cache = new ViewCache(
      (cid) => new ConversationView(cid, "durable"),
      limits,
    );
  }
  /** Paging state per cached projection; it goes when the projection does. */
  private readonly rows = new WeakMap<ViewEntry, DurableRows>();

  /** Read and project one /view page; task ages stay outside the cache lock. */
  async page(
    cid: string,
    harness: Harness,
    conversation: Conversation,
    context: Context,
    envelope: Rec,
    options: PageOptions,
    files?: PublishedFiles,
  ): Promise<Rec> {
    const generation = (await harness.snapshot(
      ReportDoc,
      conversation.id,
      context,
    ))!.generation;
    const live = await harness.snapshot(LiveDoc, conversation.id, context);
    const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
    const run = live?.run === undefined ? null : String(live.run.taskId);
    const artifactPrefix = `d-${generation}`;
    let page: Rec = unavailable();
    for await (const view of this.cache.acquire(cid)) {
      if (view === null) return page;
      let rows = this.rows.get(view);
      if (rows === undefined)
        this.rows.set(
          view,
          (rows = new DurableRows(cid, this.pageSize, view, artifactPrefix)),
        );
      page = await rows.page(
        conversation,
        context,
        live,
        {
          ...envelope,
          generation: 0,
          turn_status: run === null ? "idle" : "running",
          retry_notice: live?.generation?.retry?.error ?? null,
          active_run: run,
        },
        options,
        async () =>
          (await harness.snapshot(ReplyTimesDoc, conversation.id, context))
            ?.finished ?? {},
        files,
        inbox,
      );
      break;
    }
    const blocks = Map.groupBy(
      (page.blocks as Rec[] | undefined) ?? [],
      (block) => String(block.id).slice(String(block.id).indexOf("#") + 1),
    );
    await Promise.all(
      (live?.tools ?? []).map(async (slot) => {
        if (slot.taskId === undefined) return;
        const rows = blocks.get(slot.callId) ?? [];
        const task =
          slot.status === "running" && rows.some((row) => row.running)
            ? await harness.getTask(slot.taskId, context)
            : undefined;
        const started =
          task?.conversationId === conversation.id ? task.startedAt : undefined;
        for (const block of rows) {
          if (
            block.running &&
            typeof started === "number" &&
            Number.isFinite(started)
          ) {
            block.tool_started_at_ms = started;
            block.tool_elapsed_ms = Math.max(0, Date.now() - started);
          }
          if (!block.artifact_id)
            block.artifact_id = `${artifactPrefix}-${String(slot.taskId)}`;
        }
      }),
    );
    return page;
  }

  drop(cid: string): void {
    this.cache.drop(cid);
  }
}
