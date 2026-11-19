// Thread rendering templates: per-turn activity groups, response footers,
// and message bubbles.
import { enrich } from "./thread-render/reply-html.js";
import { html, nothing, type TemplateResult } from "lit";
import { SERVER_COMPACTION_MARKER } from "../src/extensions/core/context/server-compaction.js";
import { keyed } from "lit/directives/keyed.js";
import { resendText } from "./composer/index.js";
import { refusedNoteT } from "./thread-render/refused.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { state } from "./state.js";
import { runningTools } from "./thread-render/running-tools.js";
import { summaryWithoutRunningCommands } from "./thread-render/turn-summary.js";
import {
  blockSections,
  expandedTurnGroups,
  turnGroups,
  type TurnGroupItem,
} from "./thread-render/turn-groups.js";
import {
  anchoredPaint,
  paint,
  userBubble,
  userBubbleParts,
} from "./thread-render/index.js";
import {
  shouldToggleToolRow,
  toolDetailPanel,
  toolDetailStore,
  toolOpenTimingText,
  toolReviewFailureText,
  toolRowOpen,
} from "./tool_details.js";
import {
  agentAttachmentLayout,
  agentAttachmentView,
} from "./agent-attachments.js";
import { enlargeFileImage, showFileInPane } from "./files.js";
import {
  activityHasUsage,
  activityUsageLabel,
  boundaryUsage,
} from "./thread-render/activity-usage.js";
import { activeDescendantCount } from "./active-agents.js";
import {
  ATTACHMENT_DOWNLOAD_ICON,
  ATTACHMENT_FILE_ICON,
  COLLAPSE_ALL_ICON,
  DISCLOSURE_ICON,
  EXPAND_ALL_ICON,
  EYE_ICON,
  HIDE_ICON,
  TOKENS_ICON,
} from "./icons.js";
import {
  activityStatusKind,
  type ActivityStatusKind,
} from "./thread-render/tool_activity.js";
import { copyButtonT } from "./conversation/copy-button/index.js";
import { messageCopyScope } from "./conversation/copy.js";
import { openActivityUsageModal, openTurnPromptModal } from "./prompt.js";
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
} from "./thread-render/turn-view.js";
import {
  pendingActionNote,
  threadMarkerText,
} from "./thread-render/thread-markers.js";
import { jumpToCompactionPoint } from "./conversation/navigation.js";
import {
  messageDisclosures,
  messageDisclosureIdentity,
} from "./conversation/message-disclosure.js";
import type {
  AgentAttachment,
  Conversation,
  Message,
  MessageEntry,
  ToolEntry,
} from "./types.js";

import { activeShells } from "./conversation/shell-surface.js";
import {
  liveToolLabelVisible,
  waitingPanelT,
} from "./conversation/live-panel.js";
import { thinkingT, toolThinkingEntry } from "./conversation/thinking.js";
import {
  activityGroupOpen,
  toggleActivityGroup,
  syncBlockExpanded,
  toggleBlockExpandAll,
  expandedToolSeries,
  toggleToolSeries,
  toolSeriesKey,
} from "./conversation/disclosure.js";
import { renderedLogGeneration } from "./row-thread-state.js";
import {
  liveRevealChunks,
  liveRevealEntry,
  liveRevealFast,
  rowThreads,
} from "./row-thread-state/index.js";

/** The one disclosure caret; app.css turns it down while its toggle is open. */
const disclosureCaret = html`<span class="disclosure-caret" aria-hidden="true"
  >${unsafeHTML(DISCLOSURE_ICON)}</span
>`;
function enrichedFor(m: Message): string {
  return enrich(m.content, state.currentConv?.github_repo_url ?? null, true);
}

// A durable point where context changed. It is system activity inside the
// response disclosure; compacted context loads only when that group opens.
function disclosureId(
  kind: string,
  cid: string,
  identity: string | number,
): string {
  return `${kind}-${cid}-${identity}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function messageToggle(cid: string, identity: string) {
  return (event?: Event) => {
    messageDisclosures.toggle(cid, identity);
    if (state.currentConv)
      anchoredPaint(
        state.currentConv,
        (event?.currentTarget as HTMLElement | null) ?? null,
      );
  };
}

function foldedMessageHeaderT({
  lead,
  sub,
  open,
  bodyId,
  toggle,
  attributed = false,
  preview,
}: {
  lead: string;
  sub: string;
  open: boolean;
  bodyId: string;
  toggle: (event?: Event) => void;
  attributed?: boolean;
  preview?: string;
}): TemplateResult {
  return html`<button
    class="agent-message-row${attributed ? " attributed-agent-row" : ""}"
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
  </button>`;
}

function markerT(conv: Conversation, entry: MessageEntry): TemplateResult {
  if (entry.marker === "shell-notice") {
    const identity = `shell-notice:${renderedLogGeneration}:${entry.offset}`;
    const bodyId = disclosureId("shell-notice", conv.id, entry.offset);
    const expanded = messageDisclosures.isOpen(conv.id, identity);
    const toggle = messageToggle(conv.id, identity);
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
  const serverCompacted =
    entry.marker === "compact" && entry.content === SERVER_COMPACTION_MARKER;
  if (entry.marker !== "compact" || serverCompacted) {
    return html`<div
      class="thread-marker ${serverCompacted ? "compacted-activity" : ""}"
      role="note"
      data-row-id=${serverCompacted ? entry.id : nothing}
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
  const summary = entry.content;
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
      <button
        class="compacted-head"
        type="button"
        title=${label}
        aria-label=${label}
        aria-expanded=${summaryOpen ? "true" : "false"}
        aria-controls=${summaryId}
        @click=${messageToggle(conv.id, identity)}
      >
        ${disclosureCaret}
        <span class="compacted-label"
          >${entry.detail || "Context compacted"}</span
        >
      </button>
    </div>
    ${summaryOpen
      ? html`<div class="disclosure-body" id=${summaryId}>
          ${summary
            ? html`<div class="disclosure-body-head">
                  <span>Conversation summary</span>
                  ${copyButtonT(summary || "", "compacted summary")}
                </div>
                <div class="content">${unsafeHTML(enrich(summary))}</div>`
            : html`<p class="prompt-msg">
                This summary is no longer available.
              </p>`}
        </div>`
      : nothing}
  </div>`;
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
    data-theme="user-message"
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
  const toggle = messageToggle(conv.id, identity);
  const preview = view
    ? undefined
    : userBubbleParts(activityBodyText(entry))
        .text.split("\n")
        .find((line) => line.trim())
        ?.trim();
  const header = collapsible
    ? foldedMessageHeaderT({
        lead,
        sub,
        open,
        bodyId,
        toggle,
        attributed: Boolean(view),
        preview,
      })
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
            @click=${() => enlargeFileImage(cid, view.id)}
          >
            <img
              src=${view.previewHref}
              alt=${view.alt}
              loading="lazy"
              decoding="async"
            />
            <span class="image-filename" title=${view.alt}>${view.alt}</span>
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
      data-theme="assistant-message"
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
                  ${unsafeHTML(
                    enrich(chunk, conv.github_repo_url ?? null, true),
                  )}
                </div>`,
            )
          : keyed(copyScope, unsafeHTML(enrichedFor(entry)))}
      </div>
      ${assistantAttachments(conv.id, attachments)}
      ${entry.refused_text !== undefined
        ? refusedNoteT(entry, full, resendText)
        : entry.error
          ? html`<div
              class="error-note"
              data-theme-protected="reply-error"
              title=${full}
            >
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
  const toggle = messageToggle(conv.id, identity);
  return html` <section
    class="agent-message inline platform-interruption notices-only"
    data-theme-protected="safety-notice"
    role="status"
    data-message-offset=${entry.offset}
  >
    ${expanded
      ? html`<div class="agent-message-inline-head">
          <span class="lead">Platform message</span
          ><span class="sub">system activity</span>
        </div>`
      : foldedMessageHeaderT({
          lead: "Platform message",
          sub: "system activity",
          open,
          bodyId,
          toggle,
        })}
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
  const expansion = toolExpansion({ ...entry, artifact_id: undefined }, block);
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
  const hasInline = Boolean(
    expansion.args || expansion.output || expansion.calls,
  );
  const expanded = entry.artifact_id
    ? open
    : toolDetailStore.isInlineOpen(inlineKey);
  const detail =
    open && entry.artifact_id
      ? toolReviewFailureText(
          toolDetailStore.get(conv.id, entry.artifact_id)?.artifact,
        )
      : "";
  const inlineNote = ["read", "edit", "write"].includes(entry.stat?.kind || "");
  const expandable = hasInline || Boolean(entry.artifact_id);
  const toggle = () => {
    if (entry.artifact_id)
      toolDetailStore.toggle(conv.id, entry.artifact_id, repaint);
    else if (hasInline) toolDetailStore.toggleInline(inlineKey, repaint);
  };
  // Invariant: Selecting the revealed command must not collapse it: only an
  // unselected click outside a control toggles, matching the live tool rows.
  const activate = (event: MouseEvent) => {
    const selection = window.getSelection()?.toString() || "";
    const target = event.target as Element | null;
    if (shouldToggleToolRow(selection, Boolean(target?.closest("a,button"))))
      toggle();
  };
  const keyActivate = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
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
    ${entry.artifact_id && !hasInline
      ? toolDetailPanel(conv.id, entry, repaint, modelTimeMs)
      : nothing}
    ${expanded && hasInline
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
                    data-theme-protected=${blocked !== null
                      ? "safety-denial"
                      : nothing}
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
          ${expansion.output || detail
            ? html`<section class="tool-payload" aria-label="Output">
                <pre>
${[expansion.output, detail].filter(Boolean).join("\n")}</pre
                >
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
  const ariaLabel = visibleLabel
    ? label
    : open
      ? "Hide command details"
      : "Show command details";
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
      aria-label=${ariaLabel}
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
      <span>${visibleLabel || "Command details"}</span>
    </button>
    ${open
      ? html`<div class="turn-series-body" id=${bodyId}>
          ${toolRowsT(conv, slice)}
        </div>`
      : nothing}
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
      ? html`<div class="msg assistant" data-theme="assistant-message">
          <div class="content">
            ${images.map((image) =>
              unsafeHTML((image.closest(".thread-image") ?? image).outerHTML),
            )}
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
        return activityBoundaryT(conv, item.boundary, {
          current: false,
          replyOnly: Boolean(item.previewOf),
          insideChunk: true,
          expanded,
          inheritedFooter: item.previewOf ? footer : nothing,
        });
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
  {
    current,
    queued = false,
    replyOnly = false,
    insideChunk = false,
    expanded = false,
    inheritedFooter = nothing,
  }: {
    current: boolean;
    queued?: boolean;
    replyOnly?: boolean;
    insideChunk?: boolean;
    expanded?: boolean;
    inheritedFooter?: TemplateResult | typeof nothing;
  },
): TemplateResult {
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
  const usage = boundaryUsage(boundary);
  const usageLabel = activityUsageLabel(usage);
  const reply = boundaryDisplayedReply(boundary);
  const outcome = boundaryOutcomeLabel(boundary);
  const aggregateUsage = activityHasUsage(usage);
  const aggregateUsageLabel = usageLabel
    ? `View activity token usage: ${usageLabel}`
    : "View activity token usage";
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
            Earlier parts of this response are not loaded. Scroll up to load
            more.
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
  </section>`;
}
