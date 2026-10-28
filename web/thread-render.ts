// Thread rendering templates: per-turn activity groups, response footers,
// message bubbles, live status, and the top-of-thread system-prompt banner.
import {
  backendFor,
  homeBackend,
  resolveUrl,
  resolveContentLink,
} from "./backends/backend.js";
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { refusedNoteT } from "./thread-render/refused.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { state } from "./state.js";
import { containsSecret, oneLine } from "../src/tool_projection/redaction.js";
import {
  runningToolLabel,
  runningTools,
  runningToolsLabel,
  TOOL_LABEL_DELAY_MS,
} from "./thread-render/running-tools.js";
import { summaryWithoutRunningCommands } from "./thread-render/turn-summary.js";
import {
  blockSections,
  expandedTurnGroups,
  turnGroups,
  type TurnGroupItem,
} from "./thread-render/turn-groups.js";
import { messageMarkdownFragment } from "./util.js";
import { renderMathPlaceholders } from "./math.js";
import {
  INLINE_IMAGE_STYLE,
  isAllowedAttachmentHref,
  isAllowedInlineImageSrc,
  scopedAttachmentPreviewHref,
} from "./image-preview/inline.js";
import { userBubbleParts } from "./thread-render/user-bubble.js";
import {
  copyText,
  shouldToggleToolRow,
  toolDetailPanel,
  toolDetailStore,
  toolOpenTimingText,
  toolRowOpen,
} from "./tool_details.js";
import {
  agentAttachmentLayout,
  agentAttachmentView,
} from "./agent-attachments.js";
import { showFileInPane } from "./files.js";
import {
  activityUsage,
  activityUsageLabel,
  replyUsageTotal,
} from "./thread-render/activity-usage.js";
import { turnUsageModel } from "./thread-render/turn-usage.js";
import { activeAgentSummary, activeDescendantCount } from "./active-agents.js";
import {
  ATTACHMENT_DOWNLOAD_ICON,
  ATTACHMENT_FILE_ICON,
  COLLAPSE_ALL_ICON,
  DISCLOSURE_ICON,
  EXPAND_ALL_ICON,
  EYE_ICON,
  HIDE_ICON,
  PERSON_ICON,
  TERMINAL_ICON,
  TOKENS_ICON,
} from "./icons.js";
import {
  activityStatusKind,
  liveActivityState,
  thinkingSummaryTail,
  type ActivityStatusKind,
} from "./thread-render/tool_activity.js";
import {
  shellSummary,
  shouldShowShellUnavailable,
} from "./thread-render/background-shells.js";
import { messageCopyScope } from "./conversation/copy.js";
import {
  fetchPrompt,
  openActivityUsageModal,
  openTurnPromptModal,
} from "./prompt.js";
import {
  boundaryDisplayedReply,
  boundaryIsLive,
  boundaryOutcomeLabel,
  compactedHeadLabel,
  type ActivityBoundary,
  type ActivitySlice,
} from "./thread-render/activity-boundary.js";
import {
  activityBodyText,
  agentMessageHeader,
  isAgentActivityMessage,
  isInternalNoticeOnly,
  isNoticeOnlyAssistant,
  isPlatformInterruption,
  stripInternalNoticeLines,
  toolExpansion,
  codemodeCallBlockReason,
  codemodeHeaderLabel,
  codemodeCallName,
  codemodeCallStatus,
  toolHeader,
  toolRowKey,
  toolSeriesDisclosure,
  toolSeriesSummary,
  visibleAssistant,
} from "./thread-render/turn-view.js";
import {
  pendingActionNote,
  threadMarkerText,
} from "./thread-render/thread-markers.js";
import { jumpToCompactionPoint } from "./conversation/navigation.js";
import {
  MessageDisclosureState,
  messageDisclosureIdentity,
} from "./conversation/message-disclosure.js";
import type {
  AgentAttachment,
  Conversation,
  Message,
  MessageEntry,
  PromptView,
  ToolEntry,
} from "./types.js";
export const messageDisclosures = new MessageDisclosureState();

// The same summaries parsed to HTML once; opened disclosures re-render often.
const markerSummaryHtml = new Map<string, string>();
const MAX_MARKER_SUMMARIES = 128;
import {
  activeShells,
  agentSurfaceAgent,
  openAgentSurface,
  openShellSurface,
  shellSurfaceAgent,
} from "./conversation/shell-surface.js";
import {
  activityGroupOpen,
  toggleActivityGroup,
  syncBlockExpanded,
  toggleBlockExpandAll,
  enrichChunk,
  expandedToolSeries,
  liveRevealChunks,
  liveRevealEntry,
  liveRevealFast,
  toggleToolSeries,
  toolSeriesKey,
} from "./conversation/disclosure.js";
import { msgsEl } from "./dom.js";
import { anchoredPaint, paint } from "./conversation/thread.js";
import { stoppingId } from "./conversation/stop.js";
import { linkPrReferences } from "./pr-references.js";
import { renderedLogGeneration, rowThreads } from "./row-thread-state.js";

// Bounded across view refreshes: projections recreate Message objects.
const mdCache = new Map<string, { content: string; html: string }>();
const MAX_RENDERED_MESSAGES = 1024;
const renderingBackend = () =>
  state.currentConv ? backendFor(state.currentConv.id) : homeBackend;
const COPY_BTN = `<button class="btn sm copy-btn" type="button">Copy</button>`;
/** The one disclosure caret; app.css turns it down while its toggle is open. */
const disclosureCaret = html`<span class="disclosure-caret" aria-hidden="true"
  >${unsafeHTML(DISCLOSURE_ICON)}</span
>`;
// Vets sanitized HTML in an inert template before any image can fetch. Only
// same-origin attachment images survive; other sources get non-fetching blocked
// markers, with responsive/lazy/alt handling for allowed images.
function applyImagePolicy(
  fragment: DocumentFragment,
  base: string | null = null,
  footer = false,
): string {
  const backend = renderingBackend();
  const tpl = document.createElement("template");
  tpl.content.append(fragment);
  // Invariant: Strip all non-img fetch elements and resource attributes/CSS
  // before inserting the fragment. Only vetted img[src] may fetch; DOMPurify's
  // safe-HTML profile alone does not block these browser resource surfaces.
  for (const el of tpl.content.querySelectorAll(
    "svg, math, source, video, audio, track, iframe, frame, embed, object, link, style, image",
  ))
    el.remove();
  for (const el of tpl.content.querySelectorAll("*")) {
    for (const attr of [
      "srcset",
      "poster",
      "background",
      "ping",
      "style",
      "lowsrc",
      "dynsrc",
    ]) {
      el.removeAttribute(attr);
    }
    if (el.tagName !== "IMG") el.removeAttribute("src");
  }
  for (const img of tpl.content.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    // Invariant: Upload bytes are inert downloads; only validated raster
    // previews (magic allowlist, manifest match, sandboxed CSP) become inline
    // images.
    const raster = isAllowedInlineImageSrc(src)
      ? src
      : scopedAttachmentPreviewHref(src);
    if (raster) {
      img.setAttribute("src", resolveUrl(backend, raster));
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      img.setAttribute("style", INLINE_IMAGE_STYLE);
      if (!(img.getAttribute("alt") || "").trim())
        img.setAttribute("alt", "image");
    } else {
      const blocked = document.createElement("span");
      blocked.className = "blocked-image";
      blocked.textContent = "Image blocked";
      blocked.title = "Only images this instance hosts can render inline";
      img.replaceWith(blocked);
    }
  }
  if (backend.label) {
    for (const anchor of tpl.content.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href")!;
      try {
        if (
          href.startsWith("/") ||
          new URL(href, location.href).origin === location.origin
        )
          anchor.setAttribute("href", resolveContentLink(backend, href));
      } catch {
        anchor.removeAttribute("href");
      }
    }
  }
  if (base) linkPrReferences(tpl.content, base);
  renderMathPlaceholders(tpl.content);
  if (footer) footerTail(tpl.content);
  return tpl.innerHTML;
}
/** Agent Markdown as inert HTML under the reply image policy. */
export function safeMarkdown(
  markdown: string,
  base: string | null = null,
): string {
  return applyImagePolicy(messageMarkdownFragment(markdown), base);
}
export function enrich(
  text: string,
  base: string | null = null,
  footer = false,
): string {
  return applyImagePolicy(messageMarkdownFragment(text), base, footer)
    .replace(/<pre>/g, `<div class="code-wrap"><pre>`)
    .replace(/<\/pre>/g, `</pre>${COPY_BTN}</div>`);
}
/** Keep the final word with a width-only footer at normal leading. */
function footerTail(fragment: DocumentFragment): void {
  const end = fragment.lastElementChild;
  const block = end?.matches("p")
    ? end
    : end?.matches("ul, ol")
      ? end.lastElementChild
      : null;
  if (!block) return;
  const walker = document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  let tail: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent?.trim()) tail = node as Text;
    } else if ((node as Element).matches("img, br, hr")) tail = null;
  }
  const match = tail?.data.match(/\S+\s*$/);
  if (
    !tail ||
    !match ||
    tail.parentElement?.closest("pre, table, .blocked-image")
  )
    return;
  const word =
    tail.parentElement?.closest("code") ?? tail.splitText(match.index!);
  const span = document.createElement("span");
  span.className = "turn-tail";
  word.replaceWith(span);
  span.append(word);
}
function enrichedFor(m: Message): string {
  const base = state.currentConv?.github_repo_url ?? null;
  const cid = state.currentConv?.id ?? "";
  const thread = rowThreads.get(cid);
  const key = `${cid}\0${thread?.sessionKey ?? thread?.instanceId}\0${m.id ?? (m as MessageEntry).offset}\0${renderingBackend().label}\0${base}`;
  let cached = mdCache.get(key);
  if (!cached || cached.content !== m.content) {
    cached = { content: m.content, html: enrich(m.content, base, true) };
    mdCache.delete(key);
    if (mdCache.size >= MAX_RENDERED_MESSAGES)
      mdCache.delete(mdCache.keys().next().value!);
  }
  mdCache.delete(key);
  mdCache.set(key, cached);
  return cached.html;
}

// Per-conversation prompt disclosure refetches on every reveal.
const bannerOpen = new Set<string>();
const bannerData = new Map<string, PromptView | null>();
const bannerLoading = new Set<string>();
const bannerRefresh = new Map<string, ReturnType<typeof setTimeout>>();
const bannerLastStatus = new Map<string, string>();
function scheduleBannerRefresh(cid: string, delay = 500): void {
  if (bannerRefresh.has(cid)) return;
  bannerRefresh.set(
    cid,
    setTimeout(() => {
      bannerRefresh.delete(cid);
      if (bannerOpen.has(cid)) loadBanner(cid);
    }, delay),
  );
}
function loadBanner(cid: string): void {
  if (bannerLoading.has(cid)) return;
  bannerLoading.add(cid);
  fetchPrompt(cid).then((v) => {
    bannerData.set(cid, v);
    bannerLoading.delete(cid);
    const current = state.currentConv?.id === cid ? state.currentConv : null;
    if (bannerOpen.has(cid) && current?.status === "running") {
      // Invariant: Pending capture is normally a very short window. Once
      // captured, a slow check still notices an infrastructure relaunch that
      // clears/replaces it while the logical turn remains "running" in the
      // tree.
      scheduleBannerRefresh(cid, v?.system_messages?.length ? 5000 : 500);
    }
    if (current) paint(current);
  });
}
function toggleBanner(cid: string): void {
  if (bannerOpen.has(cid)) {
    bannerOpen.delete(cid);
    const timer = bannerRefresh.get(cid);
    if (timer !== undefined) clearTimeout(timer);
    bannerRefresh.delete(cid);
  } else {
    bannerOpen.add(cid);
    loadBanner(cid);
  }
  if (state.currentConv) paint(state.currentConv);
}

// Full thinking fetches only on entry-open or focused live-step need.
const thinkingOpen = new Set<string>();
const thinkingData = new Map<string, string | null>();
const thinkingPillEntries = new Map<string, MessageEntry>();
const thinkingLoading = new Set<string>();
const thinkingSources = new Map<string, number>();
const thinkingLive = new Set<string>();
const thinkingRefreshTimers = new Map<string, number>();
let thinkingPillKey: string | null = null;
let thinkingPillConversation: string | null = null;
let thinkingPillSourceId: string | undefined;
let thinkingPillGeneration: Conversation["message_log_generation"];
let activityThinkingKey: string | null = null;
const MAX_THINKING_CACHE = 64;
function thinkingKey(conv: Conversation, entry: MessageEntry): string {
  return `${conv.id}:${conv.message_log_generation ?? "legacy"}:${entry.id ?? entry.offset}`;
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

function stopThinkingPill(): void {
  if (thinkingPillKey !== null) {
    thinkingPillEntries.delete(thinkingPillKey);
    cancelThinkingRefresh(thinkingPillKey);
  }
  thinkingPillKey = null;
  thinkingPillConversation = null;
  thinkingPillSourceId = undefined;
  thinkingPillGeneration = undefined;
}

function syncThinkingPill(
  conv: Conversation,
  rows: readonly LiveThinkingRow[],
  panelKind: string,
  boundary?: ActivityBoundary,
): { key: string | null; text: string } {
  const source = panelKind === "thinking" ? liveThinkingEntry(rows) : null;
  const sameSource =
    source?.id &&
    source.id === thinkingPillSourceId &&
    thinkingPillConversation === conv.id &&
    thinkingPillGeneration === conv.message_log_generation;
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
  if (sameSource && entry === source && thinkingPillKey)
    entry = thinkingPillEntries.get(thinkingPillKey) ?? entry;
  const key = entry ? thinkingKey(conv, entry) : null;
  if (sameSource && key && thinkingPillKey && key !== thinkingPillKey) {
    if (thinkingOpen.delete(thinkingPillKey)) thinkingOpen.add(key);
    if (thinkingData.has(thinkingPillKey))
      thinkingData.set(key, thinkingData.get(thinkingPillKey)!);
    if (thinkingSources.has(thinkingPillKey))
      thinkingSources.set(key, thinkingSources.get(thinkingPillKey)!);
    if (thinkingLive.has(thinkingPillKey)) thinkingLive.add(key);
    thinkingData.delete(thinkingPillKey);
    thinkingSources.delete(thinkingPillKey);
    thinkingLive.delete(thinkingPillKey);
    thinkingLoading.delete(thinkingPillKey);
  }
  if (thinkingPillKey !== key || thinkingPillConversation !== conv.id) {
    stopThinkingPill();
    thinkingPillKey = key;
    thinkingPillConversation = conv.id;
  }
  thinkingPillSourceId = source?.id;
  thinkingPillGeneration = conv.message_log_generation;
  if (entry && key !== null) {
    thinkingPillEntries.set(key, entry);
    if (thinkingOpen.has(key) && thinkingSources.get(key) !== entry.offset)
      loadThinking(conv.id, entry, key, true);
    scheduleThinkingRefresh(conv.id, entry, key);
  }
  const loaded = key === null ? undefined : thinkingData.get(key);
  return {
    key,
    text:
      key !== null && thinkingOpen.has(key) ? thinkingSummaryTail(loaded) : "",
  };
}
function toggleThinkingPill(key: string): void {
  const entry = thinkingPillEntries.get(key);
  const conv = state.currentConv;
  if (entry && conv?.id === thinkingPillConversation)
    toggleThinking(conv, entry);
}

function scheduleThinkingRefresh(
  cid: string,
  entry: MessageEntry,
  key: string,
): void {
  if (
    !thinkingLive.has(key) ||
    !thinkingOpen.has(key) ||
    typeof window === "undefined"
  )
    return;
  if (thinkingRefreshTimers.has(key)) return;
  thinkingRefreshTimers.set(
    key,
    window.setTimeout(() => {
      thinkingRefreshTimers.delete(key);
      if (thinkingOpen.has(key) && thinkingLive.has(key))
        loadThinking(cid, entry, key, true);
    }, 1000),
  );
}
function cancelThinkingRefresh(key: string): void {
  const timer = thinkingRefreshTimers.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  thinkingRefreshTimers.delete(key);
}
function loadThinking(
  cid: string,
  entry: MessageEntry,
  key: string,
  refresh = false,
): void {
  const offset = entry.offset >= 0 ? entry.offset : -1;
  const changedSource =
    thinkingSources.has(key) && thinkingSources.get(key) !== offset;
  if (changedSource) {
    thinkingLoading.delete(key);
    thinkingLive.delete(key);
    cancelThinkingRefresh(key);
  }
  if (
    thinkingLoading.has(key) ||
    (!refresh && !changedSource && thinkingData.has(key)) ||
    (offset < 0 && !entry.live_thinking && !entry.has_thinking)
  )
    return;
  thinkingSources.set(key, offset);
  thinkingLoading.add(key);
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
      if (thinkingSources.get(key) !== offset) return;
      thinkingLoading.delete(key);
      if (thinkingData.size >= MAX_THINKING_CACHE && !thinkingData.has(key)) {
        const oldest = thinkingData.keys().next().value;
        if (oldest !== undefined) {
          thinkingData.delete(oldest);
          thinkingSources.delete(oldest);
        }
      }
      thinkingData.set(key, text);
      if (live) thinkingLive.add(key);
      else {
        thinkingLive.delete(key);
        cancelThinkingRefresh(key);
      }
      if (state.currentConv?.id === cid) paint(state.currentConv);
      if (live) scheduleThinkingRefresh(cid, entry, key);
    });
}
function toggleThinking(conv: Conversation, entry: MessageEntry): void {
  const key = thinkingKey(conv, entry);
  if (thinkingOpen.has(key)) {
    thinkingOpen.delete(key);
    cancelThinkingRefresh(key);
  } else {
    if (thinkingOpen.size >= MAX_THINKING_CACHE) {
      const oldest = thinkingOpen.values().next().value;
      if (oldest !== undefined) {
        thinkingOpen.delete(oldest);
        cancelThinkingRefresh(oldest);
      }
    }
    thinkingOpen.add(key);
    loadThinking(conv.id, entry, key);
  }
  if (state.currentConv?.id === conv.id) paint(state.currentConv);
}

// Plain-text user bubbles except fences, whose code elements preserve diffs.
// Extract flat same-origin uploads; external/data sources stay literal text.
function fencedUserText(text: string): TemplateResult | typeof nothing {
  if (!text) return nothing;
  const parts: Array<string | TemplateResult> = [];
  const fence = /```[^\n]*\n([\s\S]*?)\n```/g;
  let cursor = 0;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(html`<pre><code>${match[1]}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return html`${parts}`;
}

export function userBubble(
  content: string,
  attachmentsOnly = false,
): TemplateResult {
  const { text, images, files } = userBubbleParts(content, {
    isAllowedInlineImageSrc: (url) => isAllowedInlineImageSrc(url),
    scopedAttachmentPreviewHref: (url) => scopedAttachmentPreviewHref(url),
    isAllowedAttachmentHref: (url) => isAllowedAttachmentHref(url),
  });
  const visibleText = attachmentsOnly ? nothing : fencedUserText(text);
  // Invariant: Keep the interpolations flush against each other: the bubble is
  // `white-space: pre-wrap`, so template whitespace would create a gap after
  // the prose and before the upload previews.
  return html`${visibleText}${images.map(
    ({ url, alt }) =>
      html`<img
        src=${resolveUrl(renderingBackend(), url)}
        alt=${alt || "image"}
        loading="lazy"
        decoding="async"
        style=${INLINE_IMAGE_STYLE}
      />`,
  )}${files.map(
    (f) =>
      html`<a
        href=${resolveUrl(renderingBackend(), f.url)}
        download=${f.label}
        style="display:inline-block;margin:var(--space-2) var(--space-3) 0 0;color:var(--accent);"
        >${f.label}</a
      >`,
  )}`;
}

// A durable point where context changed. It is system activity inside the
// response disclosure; compacted context loads only when that group opens.
export function disclosureId(
  kind: string,
  cid: string,
  identity: string | number,
): string {
  return `${kind}-${cid}-${identity}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function markerT(conv: Conversation, entry: MessageEntry): TemplateResult {
  if (entry.marker === "shell-notice") {
    const identity = `shell-notice:${renderedLogGeneration}:${entry.offset}`;
    const bodyId = disclosureId("shell-notice", conv.id, entry.offset);
    const expanded = messageDisclosures.isOpen(conv.id, identity);
    const toggle = (event?: Event) => {
      messageDisclosures.toggle(conv.id, identity);
      if (state.currentConv)
        anchoredPaint(
          state.currentConv,
          (event?.currentTarget as HTMLElement | null) ?? null,
        );
    };
    const label = `${expanded ? "Hide" : "Show"} details: ${entry.content}`;
    return html`<div
      class="turn-series shell-notice"
      role="note"
      data-message-offset=${entry.offset}
    >
      <button
        class="turn-series-toggle"
        type="button"
        title=${label}
        aria-label=${label}
        aria-expanded=${expanded ? "true" : "false"}
        aria-controls=${bodyId}
        @click=${toggle}
      >
        ${disclosureCaret}
        <span>${entry.content}</span>
      </button>
      ${expanded && entry.detail
        ? html`<div class="turn-series-body" id=${bodyId}>
            <div class="tool-payload"><pre>${entry.detail}</pre></div>
          </div>`
        : nothing}
    </div>`;
  }
  if (entry.marker !== "compact") {
    return html`<div
      class="thread-marker"
      role="note"
      data-message-offset=${entry.offset}
    >
      <span>
        ${threadMarkerText(entry)}${entry.id &&
        entry.marker === "compaction-notice" &&
        entry.content.startsWith("Context compacted")
          ? html` ·
              <button
                class="compaction-jump-link"
                type="button"
                @click=${() => void jumpToCompactionPoint(conv.id, entry.id!)}
              >
                Jump to first kept message
              </button>`
          : nothing}
      </span>
    </div>`;
  }
  const key = `${conv.id}:${entry.id}`;
  const summary = entry.content;
  const copy = async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const copied = await copyText(summary || "");
    button.textContent = copied ? "Copied" : "Copy failed";
    setTimeout(() => {
      if (button.isConnected) button.textContent = "Copy";
    }, 1200);
  };
  // Invariant: The marker's summary has its own disclosure. Opening it never
  // changes any of the surrounding turn's independently controlled activity
  // groups.
  const summaryId = disclosureId(
    "compacted-summary",
    conv.id,
    entry.id || entry.offset,
  );
  const identity = `compact:${renderedLogGeneration}:${messageDisclosureIdentity(entry)}`;
  const summaryOpen = messageDisclosures.isOpen(conv.id, identity);
  const label = compactedHeadLabel(summaryOpen);
  return html`<div
    class="compacted-activity"
    role="note"
    data-row-id=${entry.id ?? nothing}
    data-message-offset=${entry.offset}
  >
    <div class="thread-marker">
      <span
        ><button
          class="compacted-head"
          type="button"
          title=${label}
          aria-label=${label}
          aria-expanded=${summaryOpen ? "true" : "false"}
          aria-controls=${summaryId}
          @click=${(event: Event) => {
            messageDisclosures.toggle(conv.id, identity);
            if (state.currentConv)
              anchoredPaint(
                state.currentConv,
                event.currentTarget as HTMLElement,
              );
          }}
        >
          ${disclosureCaret}
          <span class="compacted-label"
            >${entry.detail || "Context compacted"}</span
          >
        </button>
      </span>
    </div>
    ${summaryOpen
      ? html`<div class="disclosure-body" id=${summaryId}>
          ${summary
            ? html`<div class="disclosure-body-head">
                  <span>Conversation summary</span>
                  <button
                    class="prompt-copy"
                    type="button"
                    aria-live="polite"
                    aria-label="Copy compacted summary"
                    @click=${copy}
                  >
                    Copy
                  </button>
                </div>
                <div class="content">
                  ${unsafeHTML(markerSummaryBody(key, summary))}
                </div>`
            : html`<p class="prompt-msg">
                This summary is no longer available.
              </p>`}
        </div>`
      : nothing}
  </div>`;
}

// The summary body as assistant-style markdown, parsed once per marker.
function markerSummaryBody(key: string, summary: string): string {
  let parsed = markerSummaryHtml.get(key);
  if (parsed === undefined) {
    parsed = enrich(summary);
    while (markerSummaryHtml.size >= MAX_MARKER_SUMMARIES) {
      const oldest = markerSummaryHtml.keys().next().value;
      if (oldest === undefined) break;
      markerSummaryHtml.delete(oldest);
    }
    markerSummaryHtml.set(key, parsed);
  }
  return parsed;
}

// The same line for something that has NOT happened yet: a compaction or clear
// requested while a turn is running only takes effect once that turn ends.
export function pendingActionT(
  conv: Conversation,
  hasCompactionMarker = false,
): TemplateResult | typeof nothing {
  // Invariant: A completed marker can outlive the transient `compacting` flag
  // by one poll. Suppress only that stale active-compaction state; a later
  // queued compact (or a clear, which takes precedence) still needs its own
  // notice.
  const staleCompaction =
    hasCompactionMarker &&
    conv.compacting === true &&
    !conv.pending_actions?.includes("clear");
  const note = staleCompaction ? null : pendingActionNote(conv);
  if (!note) return nothing;
  return html`<div class="thread-marker pending" role="status">
    <span>${note}</span>
  </div>`;
}

// Operator inputs remain plain bubbles. A turn-internal delivery line that
// lost its provenance (backend reminder, lifecycle notice) is stripped here
// so it never reaches a bubble; notice-only rows never arrive — they fold as
// activity through isAgentActivityMessage above.
function userEntryT(
  conv: Conversation,
  entry: MessageEntry,
): TemplateResult | typeof nothing {
  if (isAgentActivityMessage(entry)) return activityMessageT(conv, entry);
  const bubble = userBubble(stripInternalNoticeLines(entry.content));
  return html`<div
    class="msg user"
    data-message-offset=${entry.offset}
    data-row-id=${entry.id ?? nothing}
  >
    <div class="bubble">${bubble}</div>
  </div>`;
}

// Keeps attributed agent headers visible while their bodies fold separately.
// Provenance-less delivery notices fold as backend text, not agent words; other
// automatic inputs arrive only when response activity is open.
export function activityMessageT(
  conv: Conversation,
  entry: MessageEntry,
  alwaysVisible = false,
  inspectable = true,
  waitingControl?: TemplateResult | typeof nothing,
): TemplateResult | typeof nothing {
  const platform = isPlatformInterruption(entry);
  const view = platform ? null : agentMessageHeader(entry, conv, state.nodes);
  const notice = !platform && !view ? isInternalNoticeOnly(entry) : false;
  const lead = platform
    ? "Platform message"
    : view
      ? `Message from ${view.senderName}`
      : "Agent activity";
  const waiting = waitingControl !== undefined;
  const sub = waiting
    ? "Waiting…"
    : platform
      ? "system activity"
      : view?.relationship || "agent activity";
  const identity = `${waiting ? "pending-agent" : "agent"}:${renderedLogGeneration}:${messageDisclosureIdentity(entry)}`;
  const collapsible =
    !alwaysVisible &&
    !entry.error &&
    (platform || Boolean(view) || notice || entry.origin === "agent");
  const open = collapsible
    ? messageDisclosures.isOpen(conv.id, identity)
    : true;
  const bodyId = disclosureId(
    "agent-message",
    conv.id,
    messageDisclosureIdentity(entry),
  );
  const toggle = (event?: Event) => {
    messageDisclosures.toggle(conv.id, identity);
    if (state.currentConv)
      anchoredPaint(
        state.currentConv,
        (event?.currentTarget as HTMLElement | null) ?? null,
      );
  };
  const preview = view
    ? undefined
    : userBubbleParts(activityBodyText(entry))
        .text.split("\n")
        .find((line) => line.trim())
        ?.trim();
  const header = collapsible
    ? html`<button
        class="agent-message-row${view ? " attributed-agent-row" : ""}"
        type="button"
        @click=${toggle}
        aria-expanded=${open ? "true" : "false"}
        aria-controls=${bodyId}
      >
        ${disclosureCaret}
        <span class="lead">${lead}</span><span class="sub">${sub}</span>
        ${preview
          ? html`<span class="agent-message-preview">${preview}</span>`
          : nothing}
      </button>`
    : html`<div class="agent-message-inline-head">
        <span class="lead">${lead}</span><span class="sub">${sub}</span>
      </div>`;
  // Invariant: visible text. A row with nothing left to show (an envelope-only
  // delivery fragment, an empty agent message) renders no bubble at all:
  // without a sender it folds away entirely, with one it keeps only its header
  // line. The thread never shows an empty bubble.
  const body = activityBodyText(entry);
  if (!body && !platform && !view) return nothing;
  return html`<section
    class="agent-message inline${platform ? " platform-interruption" : ""}"
    data-message-offset=${entry.offset}
    data-row-id=${entry.id ?? nothing}
  >
    ${header}${waitingControl ?? nothing}
    ${open && body
      ? html`<div class="agent-message-body" id=${bodyId}>
          <div class="agent-message-content">${userBubble(body)}</div>
          ${inspectable
            ? html`<button
                class="agent-message-inspect"
                type="button"
                title="Show message details"
                aria-label="Show message details"
                @click=${() => openTurnPromptModal(conv.id, entry.offset)}
              >
                ${unsafeHTML(EYE_ICON)}
              </button>`
            : nothing}
        </div>`
      : nothing}
    ${open ? nothing : userBubble(body, true)}
  </section>`;
}

function activityUserBatchT(
  conv: Conversation,
  entries: MessageEntry[],
  expanded = false,
): TemplateResult {
  return html`${entries.map((entry) =>
    isAgentActivityMessage(entry)
      ? activityMessageT(
          conv,
          entry,
          !expanded && Boolean(conv.parent && entry.from === conv.parent),
          !expanded,
        )
      : userEntryT(conv, entry),
  )}`;
}

const downloadIcon = unsafeHTML(ATTACHMENT_DOWNLOAD_ICON);
const fileIcon = unsafeHTML(ATTACHMENT_FILE_ICON);

function stopAttachmentPreview(event: Event): void {
  event.stopPropagation();
}

function assistantAttachments(
  cid: string,
  items: AgentAttachment[] | undefined,
): TemplateResult | typeof nothing {
  if (!items?.length) return nothing;
  const layout = agentAttachmentLayout(items);
  return html`<div
    class=${`agent-attachments ${layout}`}
    aria-label="Attached files"
  >
    ${items.map((item) => {
      const view = agentAttachmentView(cid, item);
      if (view.kind === "unavailable") {
        return html`<div class="agent-attachment unavailable" role="status">
          <span class="agent-attachment-name">${view.name}</span>
          ${view.size
            ? html`<span class="agent-attachment-size">${view.size}</span>`
            : nothing}
          <span class="agent-attachment-state">${view.state}</span>
        </div>`;
      }
      if (view.kind === "image") {
        return html`<div class="agent-attachment-item image">
          <button
            class="agent-attachment-preview"
            type="button"
            aria-label=${view.previewLabel}
            @click=${() => showFileInPane(cid, view.id)}
          >
            <img
              src=${view.previewHref}
              alt=${view.alt}
              loading="lazy"
              decoding="async"
            />
          </button>
          <a
            class="agent-attachment-download-icon"
            href=${view.href}
            download=${view.downloadName}
            data-bytes=${item.size ?? ""}
            aria-label=${view.downloadLabel}
            @click=${stopAttachmentPreview}
          >
            ${downloadIcon}
          </a>
        </div>`;
      }
      return html`<div class="agent-attachment-item file">
        <button
          class="agent-attachment"
          type="button"
          title=${view.name}
          aria-label=${`Open ${view.name} in Files`}
          @click=${() => showFileInPane(cid, view.id)}
        >
          ${fileIcon}
          <span class="agent-attachment-name">${view.name}</span>
          ${view.size
            ? html`<span class="agent-attachment-size">${view.size}</span>`
            : nothing}
        </button>
        <a
          class="agent-attachment-file-download"
          href=${view.href}
          download=${view.downloadName}
          data-bytes=${item.size ?? ""}
          title="Download"
          aria-label=${view.downloadLabel}
          >${downloadIcon}</a
        >
      </div>`;
    })}
  </div>`;
}

// Renders replies without per-reply controls. Usage and stop outcomes live
// exactly once on the response footer, never duplicated across replies.
function assistantT(
  conv: Conversation,
  entry: MessageEntry,
  attachments: AgentAttachment[] | undefined = entry.attachments,
  expanded = false,
  footer: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  if (isNoticeOnlyAssistant(entry)) return noticesT(conv, entry, expanded);
  const full =
    typeof entry.error_detail === "string" && entry.error_detail.trim()
      ? entry.error_detail.trim()
      : typeof entry.error === "string"
        ? entry.error
        : "";
  const copyScope = messageCopyScope(
    conv.id,
    renderedLogGeneration,
    entry.offset,
    `${entry.id || ""}\0${entry.content}`,
  );
  return html`<div
      class="msg assistant"
      data-copy-scope=${copyScope}
      data-message-offset=${entry.offset}
      data-row-id=${entry.id ?? nothing}
    >
      <div class="content">
        ${entry === liveRevealEntry
          ? liveRevealChunks.map(
              (chunk, index) =>
                html`<div
                  class=${liveRevealFast &&
                  index === liveRevealChunks.length - 1
                    ? "reveal-chunk fast"
                    : "reveal-chunk"}
                >
                  ${unsafeHTML(enrichChunk(chunk))}
                </div>`,
            )
          : keyed(copyScope, unsafeHTML(enrichedFor(entry)))}
      </div>
      ${assistantAttachments(conv.id, attachments)}
      ${entry.refused_text !== undefined
        ? refusedNoteT(entry, full)
        : entry.error
          ? html`<div class="error-note" title=${full}>
              ${entry.error}${(entry.error_attempts ?? 1) > 1
                ? ` (${entry.error_attempts} attempts)`
                : ""}
            </div>`
          : nothing}
      ${footer}
    </div>
    ${entry.notices?.length ? noticesT(conv, entry, expanded) : nothing}`;
}

// A notice is platform activity, not the agent's own words, so it reads exactly
// like a platform interruption — one folded line that opens on demand — whether
// or not the reply it arrived beside had anything to say.
function noticesT(
  conv: Conversation,
  entry: MessageEntry,
  expanded = false,
): TemplateResult {
  const identity = `notice:${renderedLogGeneration}:${entry.offset}`;
  const bodyId = disclosureId("notices", conv.id, entry.offset);
  const open = expanded || messageDisclosures.isOpen(conv.id, identity);
  const toggle = (event?: Event) => {
    messageDisclosures.toggle(conv.id, identity);
    if (state.currentConv)
      anchoredPaint(
        state.currentConv,
        (event?.currentTarget as HTMLElement | null) ?? null,
      );
  };
  return html` <section
    class="agent-message inline platform-interruption notices-only"
    role="status"
    data-message-offset=${entry.offset}
  >
    ${expanded
      ? html`<div class="agent-message-inline-head">
          <span class="lead">Platform message</span
          ><span class="sub">system activity</span>
        </div>`
      : html`<button
          class="agent-message-row"
          type="button"
          @click=${toggle}
          aria-expanded=${open ? "true" : "false"}
          aria-controls=${bodyId}
        >
          ${disclosureCaret}
          <span class="lead">Platform message</span
          ><span class="sub">system activity</span>
        </button>`}
    ${open
      ? html`<div class="agent-message-body" id=${bodyId}>
          <div class="agent-message-content">
            ${entry.notices!.map((notice) => html`<div>${notice}</div>`)}
          </div>
        </div>`
      : nothing}
  </section>`;
}

// Opens tools onto lazy payloads or bounded stored whole commands. A row with
// neither remains noninteractive: no control or empty pane.
function toolRowT(
  conv: Conversation,
  entry: ToolEntry,
  modelTimeMs?: number,
): TemplateResult {
  const view = toolHeader(entry);
  const open = toolRowOpen(conv.id, entry);
  const repaint = () => {
    if (state.currentConv) paint(state.currentConv);
  };
  const block =
    rowThreads.get(conv.id)?.rows.find((row) => row.id === entry.call_id) ??
    null;
  const expansion = toolExpansion(entry, block);
  const openTiming = toolOpenTimingText(entry.timing, modelTimeMs);
  const scriptLabel =
    entry.name === "codemode"
      ? codemodeHeaderLabel(expansion.calls ?? [])
      : null;
  if (scriptLabel) {
    view.label = scriptLabel;
    view.detail = "";
  }
  const inlineKey = `${conv.id}:${toolRowKey(entry)}`;
  const inlineOpen =
    Boolean(expansion.args || expansion.output || expansion.calls) &&
    toolDetailStore.isInlineOpen(inlineKey);
  const expanded = open || inlineOpen;
  const inlineNote = ["read", "edit", "write"].includes(entry.stat?.kind || "");
  const expandable = Boolean(
    entry.artifact_id || expansion.args || expansion.output || expansion.calls,
  );
  const toggleArtifact = () =>
    entry.artifact_id &&
    toolDetailStore.toggle(conv.id, entry.artifact_id, repaint);
  const toggleInline = () =>
    (expansion.args || expansion.output || expansion.calls) &&
    toolDetailStore.toggleInline(inlineKey, repaint);
  // Invariant: Selecting the revealed command must not collapse it: only an
  // unselected click outside a control toggles, matching the live tool rows.
  const activate = (event: MouseEvent) => {
    if (entry.artifact_id) {
      toggleArtifact();
      return;
    }
    const selection = window.getSelection()?.toString() || "";
    const target = event.target as Element | null;
    if (shouldToggleToolRow(selection, Boolean(target?.closest("a,button"))))
      toggleInline();
  };
  const keyActivate = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (entry.artifact_id) toggleArtifact();
      else toggleInline();
    }
  };
  if (view.truncated) {
    return html`<div
      class="turn-tool truncated"
      role="note"
      data-message-offset=${entry.offset}
    >
      ${view.note}
    </div>`;
  }
  return html`<div
    class="turn-tool${view.stale ? " stale" : ""}"
    data-message-offset=${entry.offset}
  >
    <div
      class="turn-tool-head"
      role=${expandable ? "button" : nothing}
      tabindex=${expandable ? "0" : nothing}
      aria-expanded=${expandable ? (expanded ? "true" : "false") : nothing}
      @click=${activate}
      @keydown=${keyActivate}
    >
      <span class="turn-tool-dot" aria-hidden="true"></span>
      <span class="turn-tool-name">${view.label}</span>
      ${view.detail
        ? html`<span
            class="turn-tool-detail"
            title=${view.detailTitle ?? view.detail}
            aria-label=${view.detailTitle ?? view.detail}
            >${view.detail}</span
          >`
        : nothing}
      ${inlineNote && view.note
        ? html`<span class="turn-tool-stat">${view.note}</span>`
        : nothing}
    </div>
    ${!inlineNote && view.note
      ? html`<div class="turn-tool-note">${view.note}</div>`
      : nothing}
    ${entry.artifact_id
      ? toolDetailPanel(conv.id, entry, repaint, modelTimeMs)
      : nothing}
    ${inlineOpen && (expansion.args || expansion.output || expansion.calls)
      ? html`<div
          class="tool-detail-body"
          role="region"
          aria-label="Full tool detail"
        >
          ${openTiming
            ? html`<div
                class="tool-detail-timing"
                role="note"
                title=${openTiming}
                aria-label=${openTiming}
              >
                ${openTiming}
              </div>`
            : nothing}
          ${expansion.args
            ? html`<section
                class="tool-payload"
                aria-label=${entry.input_full
                  ? "Full command"
                  : "Full arguments"}
              >
                <pre>${expansion.args}</pre>
              </section>`
            : nothing}
          ${expansion.calls
            ? html`<ol
                class="tool-calls codemode-calls"
                aria-label="Nested calls"
              >
                ${expansion.calls.map((call) => {
                  if (call.omitted)
                    return html`<li class="tool-call">
                      <div class="tc-call-head tool-note">
                        ${call.omitted} more calls not shown
                      </div>
                    </li>`;
                  const blocked = codemodeCallBlockReason(call);
                  const note = blocked ?? call.error;
                  return html`<li
                    class="tool-call${blocked !== null ? " blocked" : ""}"
                  >
                    <div class="tc-call-head">
                      <span class="tc-name"
                        >${codemodeCallName(call.name)}</span
                      >
                      <span class="tc-input">${call.args}</span>
                      <span class="turn-tool-stat"
                        >${codemodeCallStatus(call)}</span
                      >
                    </div>
                    ${note
                      ? html`<div class="tc-call-note">${note}</div>`
                      : nothing}
                  </li>`;
                })}
              </ol>`
            : nothing}
          ${expansion.output
            ? html`<section class="tool-payload" aria-label="Output">
                <pre>${expansion.output}</pre>
                ${expansion.outputTruncated
                  ? html`<div class="tool-note">
                      Output truncated to the served bound.
                    </div>`
                  : nothing}
              </section>`
            : nothing}
        </div>`
      : nothing}
  </div>`;
}

function toolThinkingEntry(
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

function toolRowsT(conv: Conversation, slice: ActivitySlice): TemplateResult {
  return html`${slice.segment.tools.map(
    (entry) =>
      html`${thinkingT(conv, toolThinkingEntry(slice, entry))}${toolRowT(
        conv,
        entry,
        entry.model_time_ms,
      )}`,
  )}`;
}

function seriesThinkingTitle(slice: ActivitySlice): string | null {
  let title: string | null = null;
  for (const entry of slice.segment.tools) {
    if (entry.thinking?.trim()) title = entry.thinking.trim();
  }
  const assistant = slice.segment.assistant;
  if (assistant?.thinking?.trim()) title = assistant.thinking.trim();
  return title;
}

function seriesIsOpen(
  conv: Conversation,
  boundary: ActivityBoundary,
  slice: ActivitySlice,
  seriesId: string | number = slice.segmentIndex,
): boolean {
  const summary = toolSeriesSummary(slice.segment);
  if (!summary) return false;
  return expandedToolSeries.has(
    toolSeriesKey(conv.id, boundary, slice.turn.turn_id, seriesId),
  );
}

function seriesThinkingTitleT(
  slice: ActivitySlice,
): TemplateResult | typeof nothing {
  const title = seriesThinkingTitle(slice);
  return title
    ? html`<div class="turn-thinking-series-title" role="note">${title}</div>`
    : nothing;
}

function toolSeriesT(
  conv: Conversation,
  boundary: ActivityBoundary,
  slice: ActivitySlice,
  seriesId: string | number = slice.segmentIndex,
  runningOwner?: ActivitySlice | null,
): TemplateResult | typeof nothing {
  const summary = toolSeriesSummary(slice.segment);
  if (!summary) return nothing;
  if (
    !slice.segment.tools.length &&
    slice.turn.open &&
    slice.segmentIndex === slice.turn.segments.length - 1
  )
    return nothing;
  if (!slice.segment.tools.length)
    return html` <div class="turn-series-summary" role="note">
      ${summary} · details unavailable
    </div>`;
  // Invariant: A series still running shows its live summary, updating in place
  // as calls finish; the panel owns the group's single pulsing dot, so the
  // series itself carries text only.
  const key = toolSeriesKey(conv.id, boundary, slice.turn.turn_id, seriesId);
  const disclosure = toolSeriesDisclosure(summary, expandedToolSeries.has(key));
  const { open, ariaLabel: label } = disclosure;
  const visibleLabel =
    runningOwner !== undefined && runningOwner !== slice
      ? summaryWithoutRunningCommands(disclosure.visibleLabel)
      : disclosure.visibleLabel;
  const bodyId = disclosureId(
    "tool-series",
    conv.id,
    `${renderedLogGeneration}-${boundary.key}-${slice.turn.turn_id}-${seriesId}`,
  );
  // Invariant: The toggle and rows render while streaming exactly as when
  // settled — only the footer summary text stays hidden — so in-flight calls
  // stay expandable and inspectable above the panel.
  return html`<div class="turn-series">
    <button
      class="turn-series-toggle"
      type="button"
      title=${label}
      aria-label=${label}
      aria-expanded=${open ? "true" : "false"}
      aria-controls=${bodyId}
      @click=${(event: Event) =>
        toggleToolSeries(
          conv.id,
          boundary,
          slice,
          seriesId,
          event.currentTarget as HTMLElement,
        )}
    >
      ${disclosureCaret}
      <span>${visibleLabel}</span>
    </button>
    ${open
      ? html`<div class="turn-series-body" id=${bodyId}>
          ${toolRowsT(conv, slice)}
        </div>`
      : nothing}
  </div>`;
}

function thinkingT(
  conv: Conversation,
  entry: MessageEntry | null,
): TemplateResult | typeof nothing {
  const title = entry?.thinking?.trim() || null;
  if (!entry || (!title && !entry.has_thinking)) return nothing;
  const key = thinkingKey(conv, entry);
  const open = thinkingOpen.has(key);
  const canLoad =
    entry.offset >= 0 ||
    entry.live_thinking === true ||
    (entry.offset < 0 && entry.has_thinking === true);
  if (open && canLoad) loadThinking(conv.id, entry, key);
  const loaded = thinkingData.get(key);
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
  const bodyId = disclosureId(
    "thinking",
    conv.id,
    `${renderedLogGeneration}-${key}`,
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
  if (thinkingPillKey === key && thinkingPillConversation === conv.id) {
    if (live) return nothing;
    activityThinkingKey = key;
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
          @click=${() => toggleThinking(conv, entry)}
        >
          ${disclosureCaret}${line}
        </button>`
      : html`<span>∴ ${line}</span>`}
    ${body}
  </div>`;
}

/** Reuse sanitized reply images while keeping activity prose folded. */
function foldedReplyImagesT(items: readonly TurnGroupItem[]): TemplateResult {
  return html`${items.map((item): TemplateResult | typeof nothing => {
    if (item.kind === "group") return foldedReplyImagesT(item.items);
    if (item.kind === "turn")
      return foldedReplyImagesT(
        turnGroups(item.boundary, null, true).filter(
          (part) =>
            part.kind !== "assistant" || part.entry !== item.visibleReply,
        ),
      );
    if (item.kind !== "assistant") return nothing;
    const template = document.createElement("template");
    template.innerHTML = enrichedFor(item.entry);
    const images = [...template.content.querySelectorAll("img")];
    return images.length
      ? html`<div class="msg assistant">
          <div class="content">
            ${images.map((image) => unsafeHTML(image.outerHTML))}
          </div>
        </div>`
      : nothing;
  })}`;
}

function turnGroupItemsT(
  conv: Conversation,
  boundary: ActivityBoundary,
  items: readonly TurnGroupItem[],
  expanded = false,
  runningOwner?: ActivitySlice | null,
  footerReply: MessageEntry | null = null,
  footer: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  return html`${items.map((item) => {
    switch (item.kind) {
      case "turn":
        if (expanded && item.visibleReply)
          return turnGroupItemsT(
            conv,
            boundary,
            expandedTurnGroups(item.boundary, conv.parent ?? null).filter(
              (part) =>
                part.kind !== "assistant" || part.entry !== item.visibleReply,
            ),
            true,
          );
        return activityBoundaryT(
          conv,
          item.boundary,
          false,
          false,
          Boolean(item.previewOf),
          true,
          expanded,
          item.previewOf ? footer : nothing,
        );
      case "users":
        return activityUserBatchT(conv, item.entries, expanded);
      case "tools":
        return html`${!seriesIsOpen(
          conv,
          boundary,
          item.slice,
          item.slice.segmentIndex,
        )
          ? seriesThinkingTitleT(item.slice)
          : nothing}${toolSeriesT(
          conv,
          boundary,
          item.slice,
          item.slice.segmentIndex,
          runningOwner,
        )}`;
      case "thought":
        return thinkingT(conv, item.entry);
      case "assistant":
        return assistantT(
          conv,
          item.entry,
          item.entry.attachments,
          false,
          item.entry === footerReply ? footer : nothing,
        );
      case "attachments":
        return assistantAttachments(conv.id, item.items);
      case "marker":
        return item.turn.system?.marker === "compact"
          ? nothing
          : markerT(conv, item.turn.system!);
      case "group": {
        if (expanded)
          return turnGroupItemsT(
            conv,
            boundary,
            item.items,
            true,
            runningOwner,
          );
        const open = activityGroupOpen(conv.id, boundary, item);
        const body = item.body ?? item.items;
        const runningSlices = body.flatMap((part) =>
          part.kind === "tools" &&
          /\b(?:Running|Preparing)\b/i.test(
            toolSeriesSummary(part.slice.segment),
          )
            ? [part.slice]
            : [],
        );
        const tools = /(?:^|, | · )[Rr]unning \d+ commands?/.test(item.line)
          ? runningTools(rowThreads.get(conv.id)?.rows ?? [], performance.now())
          : [];
        const barOwnsRunning = liveToolLabelVisible(
          conv,
          Math.max(0, ...tools.map((tool) => tool.elapsedMs)),
        );
        const owner =
          open &&
          !barOwnsRunning &&
          runningSlices.length === 1 &&
          seriesIsOpen(
            conv,
            boundary,
            runningSlices[0]!,
            runningSlices[0]!.segmentIndex,
          )
            ? runningSlices[0]!
            : null;
        const line =
          barOwnsRunning || owner
            ? summaryWithoutRunningCommands(item.line)
            : item.line;
        const bodyId = disclosureId(
          "activity-group",
          conv.id,
          `${renderedLogGeneration}-${boundary.key}-${item.key}`,
        );
        const toggle = (event: Event) =>
          toggleActivityGroup(
            conv.id,
            boundary,
            item,
            (event.currentTarget as HTMLElement)
              .closest<HTMLElement>(".activity-group")!
              .querySelector<HTMLElement>(".activity-group-summary") ??
              (event.currentTarget as HTMLElement),
          );
        const hide = html`<button
          class="activity-group-hide"
          type="button"
          @click=${toggle}
          title="Hide activity"
          aria-label="Hide activity"
        >
          ${unsafeHTML(HIDE_ICON)}
        </button>`;
        // Invariant: Visible replies between the turn's hidden items keep their
        // place and width: before the row when closed; open, they separate
        // tinted parts of the body, so the body reads in entry order.
        const shown = item.shown ?? [];
        const split = body.some((part) => shown.includes(part));
        const parts: TemplateResult[] = [];
        let run: TurnGroupItem[] = [];
        let hidePlaced = false;
        const endRun = () => {
          if (run.length)
            parts.push(
              html`<div class="activity-group-part">
                ${hidePlaced ? nothing : ((hidePlaced = true), hide)}
                ${turnGroupItemsT(conv, boundary, run, true, owner)}
              </div>`,
            );
          run = [];
        };
        for (const part of open && split ? body : []) {
          if (!shown.includes(part)) run.push(part);
          else {
            endRun();
            parts.push(turnGroupItemsT(conv, boundary, [part]));
          }
        }
        endRun();
        const row =
          line || open
            ? html`<div
                class="activity-group${open ? " open" : ""}"
                data-group=${item.key}
              >
                ${open
                  ? html`<div
                      class="activity-group-body${split ? " split" : ""}"
                      id=${bodyId}
                    >
                      ${split
                        ? parts
                        : html`${hide}${turnGroupItemsT(
                            conv,
                            boundary,
                            body,
                            true,
                            owner,
                          )}`}
                    </div>`
                  : nothing}
                ${line
                  ? html`<div class="activity-group-summary">
                      <button
                        class="activity-group-toggle"
                        type="button"
                        aria-controls=${bodyId}
                        aria-expanded=${open ? "true" : "false"}
                        @click=${toggle}
                      >
                        <span class="turn-summary"
                          >${line.slice(0, line.lastIndexOf(" ") + 1)}<span
                            class="turn-tail"
                            >${line.slice(line.lastIndexOf(" ") + 1)}</span
                          ></span
                        >
                      </button>
                    </div>`
                  : nothing}
              </div>`
            : nothing;
        // Invariant: One template either way, so the row's buttons keep focus
        // on toggle.
        return html`${open
          ? nothing
          : html`${turnGroupItemsT(conv, boundary, shown)}${foldedReplyImagesT(
              item.items,
            )}`}${row}`;
      }
    }
  })}`;
}

export function activityBoundaryT(
  conv: Conversation,
  boundary: ActivityBoundary,
  current: boolean,
  queued = false,
  replyOnly = false,
  insideChunk = false,
  expanded = false,
  inheritedFooter: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  if (current) activityThinkingKey = null;
  const compactionPoint = boundary.items.find(
    (item) => item.kind === "marker" && item.turn.system?.marker === "compact",
  );
  const bodyId = disclosureId(
    "response-activity",
    conv.id,
    `${renderedLogGeneration}-${boundary.key}`,
  );
  const running = boundaryIsLive(boundary);
  // Invariant: Only the latest response shows live or continued background
  // status. Footers contain outcomes and actions, never repeated activity
  // counts.
  const boundaryShells = current ? activeShells(conv).shellCount : 0;
  const boundaryAgents = current
    ? activeDescendantCount(state.nodes, conv.id)
    : 0;
  // Invariant: A new run supersedes the preceding response's background status,
  // even when admission precedes its first live row.
  const superseded =
    !running && (conv.status === "running" || conv.status === "interrupting");
  const status: ActivityStatusKind = activityStatusKind(
    running ||
      (current &&
        (conv.status === "running" || conv.status === "interrupting")),
    superseded ? 0 : boundaryShells,
    superseded ? 0 : boundaryAgents,
    current,
    queued,
  );
  const recorded = activityUsage(boundary.usageTurns, boundary.usagePartial);
  // Invariant: Usage appears once per response, recorded aggregate preferred.
  // Without totals, reply usage is a lower bound; disclosure never changes
  // scope.
  const replyReports = boundary.slices.flatMap((slice) => {
    const assistant = visibleAssistant(slice.segment.assistant);
    if (!assistant || isNoticeOnlyAssistant(assistant)) return [];
    return [assistant.usage];
  });
  const recordedTotal = Boolean(
    turnUsageModel(recorded.modelTotal) ||
    recorded.safetyTotal?.groups.some((group) => turnUsageModel(group)),
  );
  const usage = recordedTotal
    ? recorded
    : (replyUsageTotal(replyReports, recorded) ?? recorded);
  const usageLabel = activityUsageLabel(usage);
  const reply = boundaryDisplayedReply(boundary);
  const outcome = boundaryOutcomeLabel(boundary);
  const aggregateUsage = Boolean(
    turnUsageModel(usage.modelTotal) ||
    usage.safetyTotal?.groups.some((group) => turnUsageModel(group)),
  );
  const aggregateUsageLabel = usageLabel
    ? `View activity token usage: ${usageLabel}`
    : "View activity token usage";
  if ((current || insideChunk) && running) {
    const rows = rowThreads.get(conv.id)?.rows ?? [];
    const livePanel = liveActivityState(rows, conv.provider_starting == null);
    syncThinkingPill(conv, rows, livePanel.kind, boundary);
  }
  const projected = replyOnly
    ? reply
      ? [{ kind: "assistant" as const, entry: reply }]
      : []
    : expanded
      ? expandedTurnGroups(boundary, conv.parent ?? null)
      : turnGroups(boundary, conv.parent ?? null);
  // Invariant: Controls follow the latest visible reply, above the live panel.
  // Usage and outcomes appear only when the block settles.
  const sections = blockSections(boundary, conv.parent ?? null);
  const minimized =
    projected.some((item) => item.kind === "group") ||
    sections.series.length + sections.messages.length > 0;
  const showFooter =
    !insideChunk && Boolean(running || outcome || aggregateUsage || minimized);
  const allOpen = showFooter && syncBlockExpanded(conv.id, boundary);
  const expandLabel = allOpen ? "Collapse all" : "Expand all";
  const input = sections.inputs[0];
  const foldedAgentResponse =
    !boundary.failOpen &&
    !boundary.operatorAnchored &&
    boundary.leadingAgentMessage &&
    boundary.leadingAgentMessage.from !== conv.parent &&
    !isPlatformInterruption(boundary.leadingAgentMessage);
  const footer =
    inheritedFooter !== nothing
      ? inheritedFooter
      : showFooter
        ? html`<div class="turn-foot">
            ${!running && outcome
              ? html`<span
                  class="turn-outcome${outcome === "Failed" ? " error" : ""}"
                  role="status"
                  >${outcome}</span
                >`
              : nothing}
            <div class="turn-foot-actions">
              ${!running && aggregateUsage
                ? html`<button
                    class="turn-tokens activity-usage"
                    type="button"
                    title=${aggregateUsageLabel}
                    aria-label=${aggregateUsageLabel}
                    @click=${() =>
                      openActivityUsageModal(
                        conv.id,
                        usage,
                        conv.model,
                        input === undefined
                          ? undefined
                          : () => openTurnPromptModal(conv.id, input),
                        boundary.slices.flatMap(
                          (slice) =>
                            slice.segment.assistant?.model_responses ?? [],
                        ),
                      )}
                  >
                    ${unsafeHTML(TOKENS_ICON)}
                  </button>`
                : nothing}
              ${running || minimized
                ? html`<button
                    class="turn-expand${allOpen ? " on" : ""}"
                    type="button"
                    title=${expandLabel}
                    aria-label=${expandLabel}
                    aria-expanded=${allOpen ? "true" : "false"}
                    ?disabled=${!minimized}
                    @click=${(event: Event) =>
                      toggleBlockExpandAll(
                        conv.id,
                        boundary,
                        event.currentTarget as HTMLElement,
                      )}
                  >
                    ${unsafeHTML(allOpen ? COLLAPSE_ALL_ICON : EXPAND_ALL_ICON)}
                  </button>`
                : nothing}
            </div>
          </div>`
        : nothing;
  const footerReply = projected.findLast(
    (item) =>
      (item.kind === "assistant" && !isNoticeOnlyAssistant(item.entry)) ||
      (item.kind === "turn" && item.previewOf),
  );
  return html`<section
    class="activity-boundary turn${current
      ? " current"
      : ""}${foldedAgentResponse
      ? " folded-agent-response"
      : ""}${boundary.wakeTurns ? " wake-chunk" : ""}${insideChunk
      ? " chunk-turn"
      : ""}${replyOnly ? " chunk-preview" : ""}${!running &&
    footerReply?.kind === "assistant" &&
    footerReply.entry.refused_text !== undefined
      ? " refused"
      : ""}"
  >
    <div class="activity-body" id=${bodyId}>
      ${boundary.slices.some((slice) => slice.turn.partial)
        ? html`<div class="turn-note" role="note">
            Only the most recent part of this response is shown — it was too
            large to load whole.
          </div>`
        : nothing}
      ${turnGroupItemsT(
        conv,
        boundary,
        insideChunk
          ? projected.filter(
              (item) => !(item.kind === "thought" && item.entry.live_thinking),
            )
          : projected,
        expanded,
        undefined,
        footerReply?.kind === "assistant" ? footerReply.entry : null,
        footer,
      )}
      ${!footerReply ? footer : nothing}
    </div>
    ${status === "waiting" ? waitingPanelT(conv) : nothing}
    ${compactionPoint ? markerT(conv, compactionPoint.turn.system!) : nothing}
    ${current && running ? workingT(conv, boundary) : nothing}
  </section>`;
}

function capturedSystemMessages(messages: unknown[]): TemplateResult[] {
  return messages.map((value, index) => {
    const message = value as {
      replace?: boolean;
      content?: string;
      sections?: Record<string, string | null>;
      toolsAdded?: { name: string }[];
      toolsRemoved?: string[];
    };
    const sections = Object.entries(message.sections || {});
    if (message.content) sections.unshift(["content", message.content]);
    const kind = message.replace
      ? "replace"
      : index === 0
        ? "baseline"
        : "delta";
    const set = sections
      .filter(([, text]) => text !== null)
      .map(([name]) => name);
    const removed = sections
      .filter(([, text]) => text === null)
      .map(([name]) => name);
    const changes = [
      ["Sets", set],
      ["Removes", removed],
      ["Tools added", message.toolsAdded?.map((tool) => tool.name) || []],
      ["Tools removed", message.toolsRemoved || []],
    ] as const;
    return html`<div class="prompt-block system-message">
      <div class="prompt-block-head">Message ${index + 1} · ${kind}</div>
      <div class="prompt-msg">
        ${changes
          .filter(([, names]) => names.length)
          .map(
            ([label, names]) => html`<div>${label}: ${names.join(", ")}</div>`,
          )}
      </div>
      ${sections.map(([name, text]) =>
        text === null
          ? html`<p class="prompt-msg">${name} · removed</p>`
          : html`<details class="prompt-details prompt-section">
              <summary>
                ${disclosureCaret}${name} ·
                ${new TextEncoder().encode(text).byteLength.toLocaleString()}
                bytes
              </summary>
              <div class="prompt-block"><pre>${text}</pre></div>
            </details>`,
      )}
    </div>`;
  });
}

// The top-of-thread "System prompt" banner: the standing instructions the model
// runs under for this agent, collapsed by default and revealed inline.
export function promptBanner(conv: Conversation): TemplateResult {
  const cid = conv.id;
  const open = bannerOpen.has(cid);
  const data = bannerData.get(cid);
  const previousStatus = bannerLastStatus.get(cid);
  bannerLastStatus.set(cid, conv.status);
  if (
    open &&
    conv.status === "running" &&
    (previousStatus !== "running" || data?.capture_status !== "captured")
  ) {
    scheduleBannerRefresh(cid);
  }
  const transcript = Boolean(data?.system_messages?.length);
  const text = transcript
    ? JSON.stringify(data!.system_messages, null, 2)
    : data?.system || "";
  const copyLabel = transcript ? "system messages" : "system prompt";
  const copy = async (e: Event) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const copied = await copyText(text);
    btn.textContent = copied ? "Copied" : "Copy failed";
    btn.classList.toggle("copied", copied);
    btn.setAttribute(
      "aria-label",
      copied ? `${copyLabel} copied` : `Couldn't copy ${copyLabel}`,
    );
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
      btn.setAttribute("aria-label", `Copy ${copyLabel}`);
    }, 1200);
  };
  const captured =
    transcript ||
    (data &&
      (data.capture_status === undefined ||
        data.capture_status === "captured"));
  return html`<div class="prompt-banner">
    <button
      class="prompt-banner-row"
      type="button"
      aria-expanded=${open ? "true" : "false"}
      @click=${() => toggleBanner(cid)}
    >
      ${disclosureCaret}
      <span class="lead">System prompt</span>
      <span class="sub">${open ? "" : "model instructions and changes"}</span>
    </button>
    ${open
      ? html`<div class="prompt-banner-body">
          ${bannerLoading.has(cid) && data === undefined
            ? html`<p class="prompt-msg">Loading…</p>`
            : captured
              ? html`<div class="prompt-block-head">
                    <span
                      >${transcript
                        ? "System messages · latest captured request"
                        : "Turn-start prompt · system messages unavailable"}</span
                    >
                    <button
                      class="prompt-copy"
                      type="button"
                      aria-live="polite"
                      aria-label=${`Copy ${copyLabel}`}
                      @click=${copy}
                    >
                      Copy
                    </button>
                  </div>
                  ${transcript
                    ? capturedSystemMessages(data!.system_messages!)
                    : html`<pre>${text}</pre>`}`
              : data?.capture_status === "pending"
                ? html`<p class="prompt-msg">
                    The system prompt is being assembled for this turn.
                  </p>`
                : data?.capture_status === "unavailable"
                  ? html`<p class="prompt-msg">
                      No system prompt has been captured yet.
                    </p>`
                  : html`<p class="prompt-msg">
                      Couldn't load the system prompt.
                    </p>`}
          ${data?.naming
            ? html`<details
                class="prompt-details prompt-section conversation-name-capture"
              >
                <summary>
                  ${disclosureCaret}Conversation
                  name${data.naming.title ? ` · ${data.naming.title}` : ""}
                </summary>
                <div class="prompt-block">
                  <pre>${JSON.stringify(data.naming, null, 2)}</pre>
                </div>
              </details>`
            : nothing}
        </div>`
      : nothing}
  </div>`;
}

function shellChipT(
  conv: Conversation,
  label: string,
): TemplateResult | typeof nothing {
  if (!label) return nothing;
  const title = conv.shells?.agent_title || conv.title || conv.id;
  const { shellCount } = activeShells(conv);
  return html`<button
    class="badge running shell-chip live"
    type="button"
    data-shell-chip
    data-agent-id=${conv.id}
    aria-controls="shell-overlay"
    aria-expanded=${shellSurfaceAgent === conv.id ? "true" : "false"}
    aria-label=${`${label} for ${title}`}
    title=${`${label} for ${title}`}
    @click=${(event: Event) => {
      event.stopPropagation();
      openShellSurface(conv.id, event.currentTarget as HTMLButtonElement);
    }}
  >
    <span class="chip-label">${shellCount}</span>${unsafeHTML(TERMINAL_ICON)}
  </button>`;
}

// Sibling to the shell chip: names this conversation's running subagents from
// the tree the sidebar already polls, and opens the same overlay card listing
// them — every row navigates like a sidebar row.
function agentChipT(
  conv: Conversation,
  label: string,
): TemplateResult | typeof nothing {
  if (!label) return nothing;
  const title = conv.title || conv.id;
  return html`<button
    class="badge accent agent-chip"
    type="button"
    data-agent-chip
    data-agent-id=${conv.id}
    aria-controls="shell-overlay"
    aria-expanded=${agentSurfaceAgent === conv.id ? "true" : "false"}
    aria-label=${`${label} for ${title}`}
    title=${`${label} for ${title}`}
    @click=${(event: Event) => {
      event.stopPropagation();
      openAgentSurface(conv.id, event.currentTarget as HTMLButtonElement);
    }}
  >
    <span class="chip-label"
      >${activeDescendantCount(state.nodes, conv.id)}</span
    >${unsafeHTML(PERSON_ICON)}
  </button>`;
}

// The one thinking banner's shared box: pulsing dot, label slot, and the
// shell/agent chips on the right. Streaming and waiting states render the
// same component in the same position and differ only in label and mood.
function panelBoxT(
  conv: Conversation,
  mood: string,
  label: TemplateResult,
  ariaLabel: string,
  stopping = false,
  summary: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  const { shellCount } = activeShells(conv);
  const shellLabel = shellSummary(shellCount);
  const agentLabel = activeAgentSummary(
    activeDescendantCount(state.nodes, conv.id),
  );
  const groupLabel = agentLabel ? `${ariaLabel}, ${agentLabel}` : ariaLabel;
  return html`<div class="msg assistant">
    <div
      class="working live-panel${stopping ? " stopping" : ""}"
      role="group"
      aria-label=${groupLabel}
    >
      <div class="live-panel-box ${mood}" role="group">
        <div class="live-panel-head">
          <span class="live-dot" aria-hidden="true"></span>
          ${label}
          ${shellChipT(conv, shellLabel)}${agentChipT(conv, agentLabel)}
        </div>
        ${summary}
      </div>
    </div>
  </div>`;
}

type LiveTitleState = {
  turnKey: string;
  title: string;
  shownAt: number;
};
const liveTitleStates = new Map<string, LiveTitleState>();
const LIVE_TITLE_STATE_LIMIT = 128;
const LIVE_TITLE_HOLD_MS = 1500;
let thinkingPillTimer: number | null = null;
let toolLabelTimer: number | null = null;
let expandedToolsKey: string | null = null;

function updateThinkingPillTimer(): void {
  if (typeof performance === "undefined") return;
  const spans = msgsEl.querySelectorAll<HTMLElement>(
    ".live-thinking-elapsed[data-thinking-received]",
  );
  if (!spans.length) {
    if (thinkingPillTimer !== null && typeof window !== "undefined") {
      window.clearInterval(thinkingPillTimer);
      thinkingPillTimer = null;
    }
    return;
  }
  const now = performance.now();
  for (const span of spans) {
    const base = Number(span.dataset.thinkingElapsed ?? "NaN");
    const received = Number(span.dataset.thinkingReceived ?? "NaN");
    if (!Number.isFinite(base) || !Number.isFinite(received)) continue;
    const elapsed = Math.floor((base + Math.max(0, now - received)) / 1000);
    span.textContent =
      span.dataset.thinkingHasTitle === "true"
        ? `${elapsed}s`
        : ` for ${elapsed}s`;
  }
}

function ensureThinkingPillTimer(): void {
  if (thinkingPillTimer !== null || typeof window === "undefined") return;
  thinkingPillTimer = window.setInterval(updateThinkingPillTimer, 1000);
}

// The interval changes textContent; keep Lit child markers outside the span.
function thinkingElapsedT(
  elapsedMs: number,
  hasTitle: boolean,
): TemplateResult {
  ensureThinkingPillTimer();
  const received = typeof performance === "undefined" ? 0 : performance.now();
  const seconds = Math.floor(elapsedMs / 1000);
  return html`<span
    class="live-thinking-elapsed"
    data-thinking-elapsed=${elapsedMs}
    data-thinking-received=${received}
    data-thinking-has-title=${String(hasTitle)}
    role="timer"
    aria-label=${`${seconds} seconds`}
    .textContent=${hasTitle ? `${seconds}s` : ` for ${seconds}s`}
  ></span>`;
}

// The bar owns running counts only while its delayed tool label is visible.
function liveToolLabelVisible(conv: Conversation, elapsedMs: number): boolean {
  return (
    elapsedMs >= TOOL_LABEL_DELAY_MS &&
    conv.status === "running" &&
    stoppingId !== conv.id &&
    !conv.retry_notice
  );
}

// Long-running tools yield a stable label; quick calls keep the thinking line.
// Stop overlays and retry notices retain priority.
export function workingT(
  conv: Conversation,
  boundary?: ActivityBoundary,
): TemplateResult {
  const rows = rowThreads.get(conv.id)?.rows ?? [];
  const panel = liveActivityState(rows, conv.provider_starting == null);
  const retryNotice = conv.retry_notice;
  const tools = runningTools(rows, performance.now());
  const longest = Math.max(0, ...tools.map((tool) => tool.elapsedMs));
  const toolVisible = longest >= TOOL_LABEL_DELAY_MS;
  if (toolLabelTimer !== null) window.clearTimeout(toolLabelTimer);
  toolLabelTimer =
    tools.length && !toolVisible
      ? window.setTimeout(() => {
          toolLabelTimer = null;
          if (state.currentConv?.id === conv.id) paint(state.currentConv);
        }, TOOL_LABEL_DELAY_MS - longest)
      : null;
  const stopping = conv.status === "interrupting" || stoppingId === conv.id;
  const overlay = stopping ? "Interrupting this turn…" : null;
  const thinkingPreview = syncThinkingPill(
    conv,
    rows,
    overlay || retryNotice ? "" : panel.kind,
    boundary,
  );
  const thinkingFull =
    thinkingPreview.key === null ? null : thinkingData.get(thinkingPreview.key);
  const thinkingExpanded =
    thinkingPreview.key !== null && thinkingOpen.has(thinkingPreview.key);
  const thinkingText =
    thinkingExpanded &&
    activityThinkingKey !== thinkingPreview.key &&
    typeof thinkingFull === "string"
      ? thinkingFull.trim()
      : "";
  const label = overlay ?? retryNotice ?? panel.label;
  const title =
    overlay ??
    retryNotice ??
    (toolVisible ? runningToolsLabel(tools) : panel.title);
  const showTools = liveToolLabelVisible(conv, longest);
  const toolsKey = `${conv.id}\0${conv.active_run ?? panel.key.split("\0", 1)[0]}`;
  if (!tools.length) expandedToolsKey = null;
  const toolsExpanded = showTools && expandedToolsKey === toolsKey;
  const titleState = (() => {
    if (panel.kind !== "thinking" || overlay || retryNotice || showTools)
      return { title, changed: false };
    const now = typeof performance === "undefined" ? 0 : performance.now();
    const turnKey = panel.key.split("\0", 1)[0] ?? panel.key;
    const previous = liveTitleStates.get(conv.id);
    if (!previous || previous.turnKey !== turnKey) {
      if (!previous && liveTitleStates.size >= LIVE_TITLE_STATE_LIMIT) {
        const oldest = liveTitleStates.keys().next().value;
        if (typeof oldest === "string") liveTitleStates.delete(oldest);
      }
      liveTitleStates.set(conv.id, {
        turnKey,
        title: panel.title,
        shownAt: now,
      });
      return { title: panel.title, changed: false };
    }
    if (previous.title === panel.title)
      return { title: previous.title, changed: false };
    if (now - previous.shownAt < LIVE_TITLE_HOLD_MS)
      return { title: previous.title, changed: false };
    previous.title = panel.title;
    previous.shownAt = now;
    return { title: panel.title, changed: true };
  })();
  const elapsed =
    overlay === null &&
    !retryNotice &&
    panel.kind === "thinking" &&
    (showTools || panel.thinkingElapsedMs !== undefined)
      ? thinkingElapsedT(
          showTools ? longest : panel.thinkingElapsedMs!,
          showTools || titleState.title !== "Thinking",
        )
      : nothing;
  const hasSummary =
    thinkingPreview.key !== null &&
    typeof thinkingFull === "string" &&
    Boolean(thinkingSummaryTail(thinkingFull));
  const toggle = showTools
    ? () => {
        expandedToolsKey = toolsExpanded ? null : toolsKey;
        paint(conv);
      }
    : thinkingPreview.key !== null
      ? () => toggleThinkingPill(thinkingPreview.key!)
      : null;
  const canToggle =
    showTools ||
    (panel.kind === "thinking" &&
      thinkingPreview.key !== null &&
      (!thinkingData.has(thinkingPreview.key) ||
        thinkingSources.get(thinkingPreview.key) !==
          thinkingPillEntries.get(thinkingPreview.key)?.offset ||
        hasSummary ||
        thinkingExpanded));
  const thinkingPrefix =
    panel.kind === "thinking" &&
    !showTools &&
    !overlay &&
    !retryNotice &&
    titleState.title !== "Thinking"
      ? "Thinking ·\u00a0"
      : nothing;
  const head = html`<span class="live-thinking-head"
    >${thinkingPrefix}<span class="live-thinking-title"
      >${titleState.title}</span
    >${elapsed}</span
  >`;
  const labelT = canToggle
    ? html`<button
        class="live-label live-thinking-copy${titleState.changed
          ? " live-title-changing"
          : ""}"
        type="button"
        title=${titleState.title}
        aria-expanded=${String(showTools ? toolsExpanded : thinkingExpanded)}
        @click=${() => toggle?.()}
      >
        ${head}
      </button>`
    : html`<span
        class="live-label${titleState.changed ? " live-title-changing" : ""}"
        title=${titleState.title}
        >${head}</span
      >`;
  const summary = toolsExpanded
    ? html`<div class="live-tool-body">
        ${tools.map(({ row, elapsedMs }) => {
          const command =
            containsSecret(row.args) || containsSecret(row.input || "")
              ? "Command withheld"
              : row.args || runningToolLabel(row);
          const output = row.tool_output_tail ?? row.result ?? "";
          const tail = containsSecret(output)
            ? "Output withheld"
            : output.split("\n").slice(-5).map(oneLine).join("\n");
          return html`<div class="live-tool-row">
            <div class="live-tool-head">
              <code>${command}</code>${thinkingElapsedT(elapsedMs, true)}
            </div>
            ${tail ? html`<pre>${tail}</pre>` : nothing}
          </div>`;
        })}
      </div>`
    : thinkingText
      ? html`<div class="live-thinking-summary">${thinkingText}</div>`
      : nothing;
  const mood = overlay
    ? "is-overlay"
    : retryNotice
      ? "is-retrying"
      : panel.kind === "thinking"
        ? thinkingText
          ? "is-thinking has-thinking-summary is-expanded"
          : "is-thinking"
        : "";
  return panelBoxT(conv, mood, labelT, label, stopping, summary);
}

// Renders admitted-but-undispatched input as queued, not dead or working. It
// replaces the live panel, never sits beside it; failures keep retry UI.
export function queuedT(conv: Conversation): TemplateResult {
  const label = "Queued…";
  return panelBoxT(
    conv,
    "is-queued",
    html`<span class="live-label" title=${label} aria-hidden="true"
      >${label}</span
    >`,
    label,
  );
}

// A stopped turn with continued background work keeps the same banner in the
// same position, reading Waiting… with the shell/agent chips on the right.
// Plain words for a continued state, never the backend status word.
export function waitingPanelT(conv: Conversation): TemplateResult {
  const label = "Waiting…";
  return panelBoxT(
    conv,
    "is-waiting",
    html`<span class="live-label" title=${label} aria-hidden="true"
      >${label}</span
    >`,
    label,
  );
}

// The poll-fed shell record reports when its details cannot load. That notice
// keeps its text row at the thread tail; the chips themselves live only in
// the panel, so they never render down here.
export function shellUnavailableT(
  conv: Conversation,
): TemplateResult | typeof nothing {
  const { shellView, shellCount } = activeShells(conv);
  if (!shouldShowShellUnavailable(shellView?.status, shellCount))
    return nothing;
  return html`<div class="msg system">
    <div class="notice-note" role="status">
      Background shell details are unavailable.
    </div>
  </div>`;
}
