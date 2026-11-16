// Owns lazy thinking disclosures and the live pill; open/text FIFO indexes each
// hold at most 64 keys, avoiding scans of retained live-refresh metadata.
// The thread renders before the live bar: beginThreadPaint() clears its mark,
// then thinkingT marks committed shared text before the live bar reads it.
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor } from "../backends/backend.js";
import { DISCLOSURE_ICON } from "../icons.js";
import { renderedLogGeneration } from "../row-thread-state.js";
import { state } from "../state.js";
import type {
  ActivityBoundary,
  ActivitySlice,
} from "../thread-render/activity-boundary.js";
import { enrich } from "../thread-render/reply-html.js";
import type { Conversation, MessageEntry, ToolEntry } from "../types.js";
import { thinkingElapsedT } from "./live-elapsed.js";
import { paint } from "./thread.js";

interface ThinkingEntry {
  open?: boolean;
  text?: string | null;
  source?: number;
  loading?: boolean;
  live?: boolean;
  timer?: number;
}

type LiveThinkingRow = {
  kind?: string;
  role?: string;
  text?: string;
  offset?: number;
  id?: string;
  live_thinking?: boolean;
  has_thinking?: boolean;
  live?: boolean;
  running?: boolean;
};

export class ThinkingStore {
  private readonly entries = new Map<string, ThinkingEntry>();
  private readonly bounds: Record<"open" | "text", string[]> = {
    open: [],
    text: [],
  };
  private committedStep: string | null = null;
  pill: {
    key: string;
    entry: MessageEntry;
    conversation: string;
    sourceId?: string;
    generation: Conversation["message_log_generation"];
  } | null = null;

  key(conv: Conversation, entry: MessageEntry): string {
    return `${conv.id}:${conv.message_log_generation ?? "legacy"}:${entry.id ?? entry.offset}`;
  }
  get(key: string): ThinkingEntry | undefined {
    return this.entries.get(key);
  }
  private ensure(key: string): ThinkingEntry {
    if (!this.entries.has(key)) this.entries.set(key, {});
    return this.entries.get(key)!;
  }
  beginThreadPaint(): void {
    this.committedStep = null;
  }
  markCommittedStep(key: string): void {
    this.committedStep = key;
  }
  showsCommittedStep(key: string | null): boolean {
    return this.committedStep === key;
  }
  isPill(key: string, cid: string): boolean {
    return this.pill?.key === key && this.pill.conversation === cid;
  }
  private prune(key: string): void {
    const entry = this.get(key);
    if (
      entry &&
      Object.values(entry).every(
        (value) => value === undefined || value === false,
      )
    )
      this.entries.delete(key);
  }
  private forget(field: "open" | "text", key: string): boolean {
    const keys = this.bounds[field];
    const index = keys.indexOf(key);
    if (index < 0) return false;
    keys.splice(index, 1);
    return true;
  }
  private remember(field: "open" | "text", key: string): void {
    const keys = this.bounds[field];
    if (keys.includes(key)) return;
    if (keys.length === 64) {
      const oldest = keys.shift()!;
      const entry = this.get(oldest)!;
      if (field === "open") {
        entry.open = undefined;
        this.cancelRefresh(oldest);
      } else {
        entry.text = undefined;
        entry.source = undefined;
      }
      this.prune(oldest);
    }
    keys.push(key);
  }
  private moveKey(from: string, to: string): void {
    const previous = this.get(from);
    this.cancelRefresh(from);
    if (!previous) return;
    const target = this.get(to);
    for (const field of ["open", "text"] as const)
      if (this.forget(field, from)) this.remember(field, to);
    previous.open ||= target?.open;
    if (previous.text === undefined) previous.text = target?.text;
    previous.source ??= target?.source;
    previous.live ||= target?.live;
    previous.loading = target?.loading;
    previous.timer = target?.timer;
    this.entries.delete(from);
    this.entries.set(to, previous);
  }
  syncPill(
    conv: Conversation,
    rows: readonly LiveThinkingRow[],
    panelKind: string,
    boundary?: ActivityBoundary,
  ): string | null {
    const source = panelKind === "thinking" ? liveThinkingEntry(rows) : null;
    const sameSource =
      source?.id &&
      source.id === this.pill?.sourceId &&
      this.pill.conversation === conv.id &&
      this.pill.generation === conv.message_log_generation;
    let entry = source;
    if (source?.id && boundary) {
      for (const slice of boundary.slices) {
        const tool = slice.segment.tools.find(
          (tool) => tool.thinking_entry_id === source.id,
        );
        if (tool) {
          entry = toolThinkingEntry(slice, tool);
          break;
        }
      }
    }
    if (sameSource && entry === source) entry = this.pill!.entry;
    const key = entry ? this.key(conv, entry) : null;
    if (sameSource && key && this.pill && key !== this.pill.key)
      this.moveKey(this.pill.key, key);
    if (
      this.pill &&
      (this.pill.key !== key || this.pill.conversation !== conv.id)
    )
      this.cancelRefresh(this.pill.key);
    this.pill =
      entry && key !== null
        ? {
            key,
            entry,
            conversation: conv.id,
            sourceId: source?.id,
            generation: conv.message_log_generation,
          }
        : null;
    if (entry && key !== null) {
      if (this.get(key)?.open && this.get(key)?.source !== entry.offset)
        this.load(conv.id, entry, key, true);
      this.scheduleRefresh(conv.id, entry, key);
    }
    return key;
  }
  togglePill(key: string): void {
    const conv = state.currentConv;
    if (this.pill?.key === key && conv?.id === this.pill.conversation)
      this.toggle(conv, this.pill.entry);
  }
  private scheduleRefresh(cid: string, entry: MessageEntry, key: string): void {
    const current = this.get(key);
    if (
      !current?.live ||
      !current.open ||
      typeof window === "undefined" ||
      current.timer !== undefined
    )
      return;
    current.timer = window.setTimeout(() => {
      const latest = this.get(key);
      if (latest) latest.timer = undefined;
      if (latest?.open && latest.live) this.load(cid, entry, key, true);
    }, 1000);
  }
  private cancelRefresh(key: string): void {
    const current = this.get(key);
    if (current?.timer === undefined) return;
    clearTimeout(current.timer);
    current.timer = undefined;
  }
  load(cid: string, entry: MessageEntry, key: string, refresh = false): void {
    const current = this.ensure(key);
    const offset = entry.offset >= 0 ? entry.offset : -1;
    const changedSource =
      current.source !== undefined && current.source !== offset;
    if (changedSource) {
      current.loading = false;
      current.live = false;
      this.cancelRefresh(key);
    }
    if (
      current.loading ||
      (!refresh && !changedSource && current.text !== undefined) ||
      (offset < 0 && !entry.live_thinking && !entry.has_thinking)
    )
      return;
    current.source = offset;
    current.loading = true;
    void backendFor(cid)
      .api(
        `/api/conversations/${encodeURIComponent(cid)}/thinking?offset=${offset}`,
      )
      .then(async (response) => {
        if (!response.ok) return { text: null, live: false };
        const value: unknown = await response.json();
        if (typeof value !== "object" || value === null || Array.isArray(value))
          return { text: null, live: false };
        const body = value as { text?: unknown; live?: unknown };
        return {
          text: typeof body.text === "string" ? body.text : null,
          live: body.live === true,
        };
      })
      .catch(() => ({ text: null, live: false }))
      .then(({ text, live }) => {
        const latest = this.get(key);
        if (!latest || latest.source !== offset) return;
        latest.loading = false;
        if (latest.text === undefined) this.remember("text", key);
        latest.text = text;
        latest.live = live;
        if (!live) this.cancelRefresh(key);
        if (state.currentConv?.id === cid) paint(state.currentConv);
        if (live) this.scheduleRefresh(cid, entry, key);
      });
  }
  toggle(conv: Conversation, entry: MessageEntry): void {
    const key = this.key(conv, entry);
    const current = this.ensure(key);
    if (current.open) {
      current.open = undefined;
      this.forget("open", key);
      this.cancelRefresh(key);
      this.prune(key);
    } else {
      this.remember("open", key);
      current.open = true;
      this.load(conv.id, entry, key);
    }
    if (state.currentConv?.id === conv.id) paint(state.currentConv);
  }
}

export const thinkingStore = new ThinkingStore();

function liveThinkingEntry(
  rows: readonly LiveThinkingRow[],
): MessageEntry | null {
  const start =
    rows.findLastIndex((row) => row.role === "user" || row.role === "custom") +
    1;
  const current = rows.slice(start);
  if (!current.some((row) => row.live || row.running || row.live_thinking))
    return null;
  const row = current.findLast(
    (candidate) =>
      candidate.kind === "text" &&
      candidate.role === "assistant" &&
      (candidate.live_thinking || candidate.has_thinking),
  );
  if (!row) return null;
  return {
    kind: "assistant",
    role: "assistant",
    content: row.text ?? "",
    offset: row.offset ?? -1,
    id: row.id ? `row:${row.id}` : undefined,
    live_thinking: true,
  };
}

export function toolThinkingEntry(
  slice: ActivitySlice,
  entry: ToolEntry,
): MessageEntry {
  return {
    kind: "assistant",
    role: "assistant",
    content: "",
    offset: entry.offset,
    id: `thinking:${slice.turn.turn_id}:${entry.seq}`,
    thinking: entry.thinking,
    has_thinking: entry.has_thinking,
    model_time_ms: entry.model_time_ms,
    live_thinking: entry.offset < 0,
    thinking_elapsed_ms: entry.thinking_elapsed_ms,
  };
}

const disclosureCaret = html`<span class="disclosure-caret" aria-hidden="true"
  >${unsafeHTML(DISCLOSURE_ICON)}</span
>`;

export function thinkingT(
  conv: Conversation,
  entry: MessageEntry | null,
): TemplateResult | typeof nothing {
  const title = entry?.thinking?.trim() || null;
  if (!entry || (!title && !entry.has_thinking)) return nothing;
  const key = thinkingStore.key(conv, entry);
  const open = !!thinkingStore.get(key)?.open;
  const canLoad =
    entry.offset >= 0 ||
    entry.live_thinking === true ||
    (entry.offset < 0 && entry.has_thinking === true);
  if (open && canLoad) thinkingStore.load(conv.id, entry, key);
  const loaded = thinkingStore.get(key)?.text;
  const live = entry.live_thinking === true;
  const durationMs =
    typeof entry.model_time_ms === "number" &&
    Number.isFinite(entry.model_time_ms)
      ? entry.model_time_ms
      : entry.thinking_elapsed_ms;
  const duration =
    typeof durationMs === "number" && Number.isFinite(durationMs)
      ? Math.max(0, Math.round(durationMs / 1000))
      : undefined;
  const label = live ? "Thinking" : "Thought";
  const durationT = live
    ? typeof entry.thinking_elapsed_ms === "number"
      ? thinkingElapsedT(entry.thinking_elapsed_ms, false)
      : nothing
    : duration === undefined
      ? nothing
      : html` for ${duration}s`;
  const titleT = title ? html` · ${title}` : nothing;
  const bodyId = `thinking-${conv.id}-${renderedLogGeneration}-${key}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  );
  const body = !open
    ? nothing
    : loaded === undefined
      ? html`<div class="turn-thinking-body" id=${bodyId}>Loading…</div>`
      : loaded === null
        ? html`<div class="turn-thinking-body" id=${bodyId}>
            Thinking unavailable.
          </div>`
        : html`<div class="turn-thinking-body" id=${bodyId}>
            ${unsafeHTML(enrich(loaded))}
          </div>`;
  // Invariant: Live thinking belongs to the pill. A visible committed step
  // owns the shared disclosure and text instead, without duplicating prose.
  if (thinkingStore.isPill(key, conv.id)) {
    if (live) return nothing;
    thinkingStore.markCommittedStep(key);
  }
  const line = html`<span class="turn-thinking-line">
    ${label}${durationT}${titleT}
  </span>`;
  return html`<div
    class="turn-thinking"
    role="note"
    aria-label=${title ? `${label}${title}` : label}
  >
    ${canLoad
      ? html`<button
          class="turn-thinking-toggle${live ? " live-thinking-step" : ""}"
          type="button"
          aria-expanded=${open ? "true" : "false"}
          aria-controls=${bodyId}
          @click=${() => thinkingStore.toggle(conv, entry)}
        >
          ${disclosureCaret}${line}
        </button>`
      : html`<span>∴ ${line}</span>`}
    ${body}
  </div>`;
}
