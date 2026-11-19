// Owns lazy thinking disclosures and the live pill. Tool and reply projections
// use the original thinking row's identity, so a new offset or series index
// does not close an open disclosure. The pill keeps its expansion for the run.
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor } from "../backends/backend.js";
import { DISCLOSURE_ICON } from "../icons.js";
import { renderedLogGeneration } from "../row-thread-state.js";
import { state } from "../state.js";
import type { ActivitySlice } from "../thread-render/activity-boundary.js";
import { paint } from "../thread-render/index.js";
import { enrich } from "../thread-render/reply-html.js";
import type { LiveActivityRow } from "../thread-render/tool_activity.js";
import type { Conversation, MessageEntry, ToolEntry } from "../types.js";
import { thinkingElapsedT } from "./live-elapsed.js";

interface ThinkingEntry {
  open?: boolean;
  text?: string | null;
  source?: number;
  loading?: boolean;
  live?: boolean;
  timer?: number;
}

class ThinkingStore {
  private readonly entries = new Map<string, ThinkingEntry>();
  private readonly bounds: Record<"open" | "text", string[]> = {
    open: [],
    text: [],
  };
  pill: {
    key: string;
    entry: MessageEntry;
    conversation: string;
    generation: Conversation["message_log_generation"];
    run: Conversation["active_run_start"];
    expanded: boolean;
  } | null = null;

  key(conv: Conversation, entry: MessageEntry): string {
    const source = entry.thinking_key
      ? `request:${entry.thinking_key}`
      : (entry.id ?? entry.offset);
    return `${conv.id}:${conv.message_log_generation ?? "legacy"}:${source}`;
  }
  get(key: string): ThinkingEntry | undefined {
    return this.entries.get(key);
  }
  private ensure(key: string): ThinkingEntry {
    if (!this.entries.has(key)) this.entries.set(key, {});
    return this.entries.get(key)!;
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
  private pillFor(conv: Conversation) {
    const pill = this.pill;
    return pill?.conversation === conv.id &&
      pill.generation === conv.message_log_generation &&
      pill.run === conv.active_run_start
      ? pill
      : null;
  }
  clearPill(): void {
    if (this.pill) this.cancelRefresh(this.pill.key);
    this.pill = null;
  }
  syncPill(
    conv: Conversation,
    row: LiveActivityRow | undefined,
  ): string | null {
    if (!row) {
      this.clearPill();
      return null;
    }
    const entry: MessageEntry = {
      kind: "assistant",
      role: "assistant",
      content: "",
      offset: row.offset ?? -1,
      id: row.id ? `row:${row.id}` : undefined,
      thinking_key: row.thinking_key,
      live_thinking: row.live_thinking || row.live,
      has_thinking: row.has_thinking,
    };
    const key = this.key(conv, entry);
    const expanded = this.pillFor(conv)?.expanded ?? false;
    if (this.pill && this.pill.key !== key) this.cancelRefresh(this.pill.key);
    this.pill = {
      key,
      entry,
      conversation: conv.id,
      generation: conv.message_log_generation,
      run: conv.active_run_start,
      expanded,
    };
    if (this.wantsRefresh(conv.id, key)) {
      if (this.get(key)?.source !== entry.offset)
        this.load(conv.id, entry, key, true);
      this.scheduleRefresh(conv.id, entry, key);
    }
    return key;
  }
  togglePill(key: string): void {
    const conv = state.currentConv;
    const pill = this.pill;
    if (pill?.key !== key || conv?.id !== pill.conversation) return;
    pill.expanded = !pill.expanded;
    if (pill.expanded) {
      const current = this.ensure(key);
      this.remember("open", key);
      current.open = true;
      this.load(conv.id, pill.entry, key);
    } else if (!this.wantsRefresh(conv.id, key)) {
      this.cancelRefresh(key);
    }
    paint(conv);
  }
  private wantsRefresh(cid: string, key: string): boolean {
    const pill = this.pill;
    return pill?.key === key && pill.conversation === cid
      ? pill.expanded
      : !!this.get(key)?.open;
  }
  private scheduleRefresh(cid: string, entry: MessageEntry, key: string): void {
    const current = this.get(key);
    if (
      !current?.live ||
      !this.wantsRefresh(cid, key) ||
      typeof window === "undefined" ||
      current.timer !== undefined
    )
      return;
    current.timer = window.setTimeout(() => {
      const latest = this.get(key);
      if (latest) latest.timer = undefined;
      if (latest?.live && this.wantsRefresh(cid, key))
        this.load(cid, entry, key, true);
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
    const query = new URLSearchParams({ offset: String(offset) });
    if (offset < 0 && entry.thinking_key)
      query.set("live_row", entry.thinking_key);
    void backendFor(cid)
      .api(`/api/conversations/${encodeURIComponent(cid)}/thinking?${query}`)
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
      if (!this.wantsRefresh(conv.id, key)) this.cancelRefresh(key);
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

export function toolThinkingEntry(
  slice: ActivitySlice,
  entry: ToolEntry,
): MessageEntry {
  return {
    kind: "assistant",
    role: "assistant",
    content: "",
    offset: entry.offset,
    id:
      entry.thinking_entry_id ?? `thinking:${slice.turn.turn_id}:${entry.seq}`,
    thinking: entry.thinking,
    thinking_key: entry.thinking_key,
    has_thinking: entry.has_thinking,
    model_time_ms: entry.model_time_ms,
    live_thinking: entry.offset < 0,
    thinking_elapsed_ms: entry.thinking_elapsed_ms,
  };
}

export const disclosureCaret = html`<span
  class="disclosure-caret"
  aria-hidden="true"
  >${unsafeHTML(DISCLOSURE_ICON)}</span
>`;

export function thinkingT(
  conv: Conversation,
  entry: MessageEntry | null,
): TemplateResult | typeof nothing {
  const title = entry?.thinking?.trim() || null;
  if (!entry || (!title && !entry.has_thinking)) return nothing;
  const key = thinkingStore.key(conv, entry);
  const live = entry.live_thinking === true;
  if (live && thinkingStore.isPill(key, conv.id)) return nothing;
  const open = !!thinkingStore.get(key)?.open;
  const canLoad =
    entry.offset >= 0 ||
    entry.live_thinking === true ||
    (entry.offset < 0 && entry.has_thinking === true);
  if (open && canLoad) thinkingStore.load(conv.id, entry, key);
  const loaded = thinkingStore.get(key)?.text;
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
