// Project bounded Durable entries/documents; hold oldest for its predecessor.
// Retries are page-stable; successful tasks fence captured live generations.
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
import type { Context } from "@earendil-works/chord/context";
import {
  SERVER_COMPACTION_MARKER,
  serverCompactionSource,
} from "../../extensions/core/context/server-compaction";
import { ReportDoc } from "./report";
import { ReplyTimesDoc } from "./reply_times";
import { LOST_STOP_REASON, thinkingInfo } from "../view";
import { ConversationView } from "../view/conversation";
import { splitPiUserText } from "../view/session_entries";
import { slowSpan } from "../../observability/slow-span";
import { displayToolContent } from "./display_content";
import {
  needsOlder,
  unavailable,
  ViewCache,
  ViewEntry,
  window,
} from "../view/reader";

type Rec = Record<string, unknown>;

export type ViewConversation = Pick<Conversation, "id" | "entries">;
export type ViewSession = Pick<Harness, "snapshot" | "getTask">;

type ReplyTimes = Readonly<Record<string, number>>;

type ProjectionEntry = Rec & { id: string; parentId: string | null };

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
  const unwrapped =
    text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)
      ? text.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length)
      : text;
  return serverCompactionSource(unwrapped) === undefined
    ? unwrapped
    : SERVER_COMPACTION_MARKER;
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

interface RowState {
  /** Context size at the newest reply, for the compaction notice. */
  tokens: number | null;
  /** The newest tool round's call ids and their assistant entry id. */
  calls: Map<string, string>;
  /** Newest readable thought and newest unavailable fallback. */
  thinking: ProjectionEntry | null;
  unavailableThinking: ProjectionEntry | null;
  /** Highest successfully completed generation task id. */
  completedGeneration: number;
}

export const rowState = (): RowState => ({
  tokens: null,
  calls: new Map(),
  thinking: null,
  unavailableThinking: null,
  completedGeneration: 0,
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

// Pi preserves the request's message timestamp when it appends the reply.
export function thinkingKey(task: unknown, message: Rec): string | undefined {
  return task != null && typeof message.timestamp === "number"
    ? `${String(task)}:${message.timestamp}`
    : undefined;
}

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
      const key =
        entry.kind === "pi.assistant"
          ? thinkingKey(entry.byTaskId, message)
          : undefined;
      if (entry.kind === "pi.assistant") {
        if (
          entry.byTaskId !== undefined &&
          ["stop", "length", "toolUse"].includes(String(message.stopReason))
        )
          state.completedGeneration = Math.max(
            state.completedGeneration,
            Number(entry.byTaskId),
          );
        // Invariant: Only the newest tool round can still be running.
        const calls = toolCalls(message);
        if (calls.length) state.calls.clear();
        for (const call of calls) state.calls.set(String(call.id), id);
        const usage = message.usage as Rec | undefined;
        if (typeof usage?.totalTokens === "number" && usage.totalTokens > 0)
          state.tokens = usage.totalTokens;
        const thinking = thinkingInfo(message);
        if (thinking.hasThinking)
          state[thinking.title === null ? "unavailableThinking" : "thinking"] =
            {
              ...base,
              type: "message",
              message,
              hasThinking: true,
              thinkingKey: key,
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
        thinkingKey: key,
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
    } else if (entry.kind === "recurse.cache-warm" && record(entry.data)) {
      out.push({
        ...base,
        type: "custom",
        customType: "recurse.usage",
        data: {
          tokens: entry.data.usage,
          cost: (entry.data.usage as Rec)?.cost,
          model: entry.data.model,
          stopReason: "cache_warm",
          partial: false,
          at: entry.data.at,
        },
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

function liveThinkingRowId(live: Readonly<LiveState> | undefined) {
  return live?.run && live.generation
    ? `live:${String(live.run.taskId)}:${live.generation.attempt}`
    : undefined;
}

// Project live replies, tools and compactions. Keep the newest thinking
// reply live while the run continues; newest is the newest ingested entry ID.
function liveEntries(
  live: Readonly<LiveState> | undefined,
  newest: string | null,
  state: RowState,
  inbox?: Readonly<InboxState>,
): ProjectionEntry[] {
  const out: ProjectionEntry[] = [];
  const first = live?.run?.first;
  if (first !== undefined) {
    const thought = [state.thinking, state.unavailableThinking].find(
      (row) => row && Number(row._offset) >= Number(first),
    );
    if (thought) out.push(thought);
  }
  const message = live?.generation?.message as Rec | undefined;
  if (
    message &&
    live?.run &&
    Number(live.run.taskId) > state.completedGeneration
  ) {
    // Invariant: Thinking text may arrive only when the step ends: a thinking
    // block marks the step as started, as Pi's live thinking_start does.
    const thinking =
      Array.isArray(message.content) &&
      message.content.some((part: Rec) => part?.type === "thinking");
    out.push({
      id: liveThinkingRowId(live)!,
      parentId: newest,
      type: "message",
      message,
      thinkingKey: thinkingKey(live.run.taskId, message),
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

function latestThinkingRow(rows: readonly ProjectionEntry[]) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const message = row.message;
    if (
      row.type !== "message" ||
      !record(message) ||
      message.role !== "assistant"
    )
      continue;
    const info = thinkingInfo(message);
    if (!info.hasThinking || (info.title === null && row._offset === undefined))
      continue;
    return {
      id: row.id,
      offset: row._offset,
      thinking_key: row.thinkingKey,
      thinking_title: info.title,
      has_thinking: true,
      kind: "text",
      role: "assistant",
      live: row._offset === undefined,
      stop_reason: message.stopReason,
    };
  }
  return null;
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
  /** Change pages may carry only appended assistant text (`text_from`). */
  textDeltas?: boolean;
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
  private thinkingScan?: {
    first: EntryId;
    last: EntryId;
    cursor?: Cursor | null;
    busy: boolean;
  };
  private readonly publishedNested = new Map<string, string>();
  private activeCodemode = new Set<string>();
  // Invariant: Incomplete scans retry with backoff; new publications wake them.
  private readonly pendingFiles = new Set<string>();
  private filesRetryAt = 0;
  private filesRetryDelay = 5000;
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
    conversation: ViewConversation,
    context: Context,
    live: Readonly<LiveState> | undefined,
    envelope: Rec,
    options: PageOptions,
    replyTimes: () => Promise<ReplyTimes> = async () => ({}),
    files: PublishedFiles = async () => ({ files: {}, complete: true }),
    inbox?: Readonly<InboxState>,
    notify?: () => void,
  ): Promise<Rec> {
    this.replyTimes = replyTimes;
    await this.catchUp(conversation, context);
    const before = options.before ?? null;
    const limit = options.limit ?? 50;
    if (needsOlder(this.view, before, limit))
      await this.loadOlder(conversation, context);

    const newest = this.newest === null ? null : String(this.newest);
    const run = live?.run;
    const liveRows = liveEntries(live, newest, this.state, inbox);
    const latestThinking = run ? latestThinkingRow(liveRows) : null;
    const recoveringThinking = !!(
      notify &&
      latestThinking?.thinking_title == null &&
      run?.first !== undefined &&
      this.scheduleOlderThinking(conversation, context, run.first, notify)
    );
    this.view.rows.syncLive(liveRows, true);
    const active = (live?.tools ?? [])
      .filter((slot) => slot.name === "codemode" && slot.status === "running")
      .map((slot) => slot.callId);
    const completed = new Map<string, string[]>();
    for (const call of live?.nestedTools ?? []) {
      if (call.name !== "publish" || call.status !== "done") continue;
      const parent = active
        .filter((id) => call.callId.startsWith(`${id}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (parent)
        completed.set(parent, [...(completed.get(parent) ?? []), call.callId]);
    }
    const signatures = new Map(
      [...completed].map(([id, calls]) => [id, JSON.stringify(calls)]),
    );
    const force = new Set<string>();
    for (const [id, signature] of signatures)
      if (this.publishedNested.get(id) !== signature) force.add(id);
    for (const id of this.publishedNested.keys())
      if (
        !active.includes(id) &&
        (this.activeCodemode.has(id) || !this.pendingFiles.has(id))
      )
        force.add(id);
    if (performance.now() >= this.filesRetryAt)
      for (const id of this.pendingFiles) force.add(id);
    const callIds = this.view.rows
      .unresolvedAttachments(force)
      .filter((id) => !this.pendingFiles.has(id) || force.has(id));
    if (callIds.length)
      for (const id of this.pendingFiles)
        if (!callIds.includes(id)) callIds.push(id);
    const lookup = callIds.length
      ? await files(callIds)
      : { files: {}, complete: true };
    const published: Record<string, Rec[]> = Object.assign(
      Object.create(null),
      lookup.files,
    );
    if (callIds.length) {
      for (const id of callIds) {
        const signature = signatures.get(id);
        if (signature) this.publishedNested.set(id, signature);
        if (lookup.complete) {
          published[id] ??= [];
          this.pendingFiles.delete(id);
          if (!active.includes(id)) this.publishedNested.delete(id);
        } else {
          this.pendingFiles.add(id);
          if (published[id]) {
            const merged = new Map<string, Rec>();
            for (const item of [
              ...(this.view.rows.attachments[id] ?? []),
              ...published[id],
            ])
              merged.set(String(item.id), item);
            published[id] = [...merged.values()];
          }
        }
      }
      if (lookup.complete && !this.pendingFiles.size) {
        this.filesRetryAt = 0;
        this.filesRetryDelay = 5000;
      } else if (!lookup.complete) {
        this.filesRetryAt = performance.now() + this.filesRetryDelay;
        this.filesRetryDelay = Math.min(this.filesRetryDelay * 2, 60_000);
      }
    }
    this.activeCodemode = new Set(active);
    const page = await slowSpan("view_projection", this.cid, () =>
      window(
        this.view,
        {
          sessionId: `${this.cid}:${this.artifactPrefix}`,
          live: liveRows,
          envelope: { ...envelope, files_pending: this.pendingFiles.size > 0 },
          files: published,
        },
        { caughtUp: true, liveSynced: true, ...options, before, limit },
      ),
    );
    return {
      ...page,
      latest_thinking: {
        run_start: run?.first === undefined ? null : Number(run.first),
        row: latestThinking,
        recovering: recoveringThinking || undefined,
      },
    };
  }

  // Recover a cold thought behind the row window without delaying a paint.
  // Each view schedules at most one bounded page, only inside its active run.
  private scheduleOlderThinking(
    conversation: ViewConversation,
    context: Context,
    first: EntryId,
    notify: () => void,
  ): boolean {
    if (this.held === undefined || this.held.id < first) return false;
    if (this.thinkingScan?.first !== first)
      this.thinkingScan = { first, last: this.held.id, busy: false };
    const scan = this.thinkingScan;
    if (scan.busy) return true;
    if (scan.cursor === null) return false;
    scan.busy = true;
    void conversation
      .entries(
        { minEntryId: first, maxEntryId: scan.last },
        this.pageSize,
        scan.cursor,
        context,
      )
      .then((page) => {
        if (this.thinkingScan !== scan) return;
        let unavailable: EntryRecord | undefined;
        const entry = page.items.find((item) => {
          if (item.kind !== "pi.assistant") return false;
          const info = thinkingInfo(item.model?.[0] as Rec | undefined);
          if (info.title !== null) return true;
          if (info.hasThinking) unavailable ??= item;
          return false;
        });
        scan.cursor = entry ? null : (page.next ?? null);
        const recovered = rowState();
        if (entry) projectionEntries([entry], recovered);
        if (unavailable) projectionEntries([unavailable], recovered);
        this.mergeThinking(recovered);
      })
      .catch(() => {
        scan.cursor = null;
      })
      .finally(() => {
        scan.busy = false;
        if (this.thinkingScan === scan) notify();
      });
    return true;
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
    conversation: ViewConversation,
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
        this.view.rows.reset("durable");
        this.publishedNested.clear();
        this.activeCodemode.clear();
        this.pendingFiles.clear();
        this.filesRetryAt = 0;
        this.filesRetryDelay = 5000;
        this.newest = null;
        this.held = undefined;
        this.thinkingScan = undefined;
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
      this.view.rows.ingest(
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

  private mergeThinking(older: RowState): void {
    for (const key of ["thinking", "unavailableThinking"] as const) {
      const thought = older[key];
      if (
        thought &&
        Number(thought._offset) > Number(this.state[key]?._offset ?? -1)
      )
        this.state[key] = thought;
    }
  }

  private async loadOlder(
    conversation: ViewConversation,
    context: Context,
  ): Promise<void> {
    const page = await conversation.entries(
      {},
      this.pageSize,
      this.older,
      context,
    );
    const { records, parent } = this.olderPage(page.items, page.next);
    const older = rowState();
    this.view.rows.prepend(
      projectionEntries(
        records,
        older,
        parent,
        this.artifactPrefix,
        await this.finished(records),
      ),
    );
    this.mergeThinking(older);
  }
}

export type PublishedFiles = (
  callIds: readonly string[],
) => Promise<{ files: Record<string, Rec[]>; complete: boolean }>;

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
  private readonly rows = new WeakMap<
    ViewEntry,
    { generation: string; rows: DurableRows }
  >();

  /** Read and project one /view page; task ages stay outside the cache lock. */
  async page(
    cid: string,
    harness: ViewSession,
    conversation: ViewConversation,
    context: Context,
    envelope: Rec,
    options: PageOptions,
    files?: PublishedFiles,
    notify?: () => void,
  ): Promise<Rec> {
    let live: Readonly<LiveState> | undefined;
    let artifactPrefix: string | undefined;
    let page: Rec = unavailable();
    for await (const view of this.cache.acquire(cid)) {
      if (view === null) return page;
      const [report, snapshot, inbox] = await Promise.all([
        harness.snapshot(ReportDoc, conversation.id, context),
        harness.snapshot(LiveDoc, conversation.id, context),
        harness.snapshot(InboxDoc, conversation.id, context),
      ]);
      const generation = report!.generation;
      artifactPrefix = `d-${generation}`;
      live = snapshot;
      let cached = this.rows.get(view);
      if (cached === undefined || cached.generation !== generation) {
        if (cached !== undefined) view.rows.reset("durable");
        cached = {
          generation,
          rows: new DurableRows(cid, this.pageSize, view, artifactPrefix),
        };
        this.rows.set(view, cached);
      }
      page = await cached.rows.page(
        conversation,
        context,
        live,
        {
          ...envelope,
          generation: 0,
          retry_notice: live?.generation?.retry?.error ?? null,
        },
        options,
        async () =>
          (await harness.snapshot(ReplyTimesDoc, conversation.id, context))
            ?.finished ?? {},
        files,
        inbox,
        notify,
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
