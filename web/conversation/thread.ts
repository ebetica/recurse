// Owns thread assembly, paint state, change keys and where the reader left
// each thread. Chrome/fetch invoke paint/renderConv but never mutate this
// presentation state.
import { showModelResponse } from "../model-response.js";
import { activeDescendantCount } from "../active-agents.js";
import {
  boundaryHasHiddenActivity,
  boundaryIsLive,
  planVEyePress,
} from "../thread-render/activity-boundary.js";
import { turnGroupBlocks } from "../thread-render/turn-groups.js";
import { updateChrome } from "./chrome.js";
import {
  cancelThreadBottom,
  followThreadBottom,
  updateScrollBtn,
} from "./controls.js";
import {
  activityBoundaryKey,
  backfillOldestBoundary,
  expandedActivityBoundaries,
  prepareLiveReveal,
  revealActivityBoundary,
} from "./disclosure.js";
import { msgsEl, scrollEl } from "../dom.js";
import {
  BOTTOM_FOLLOW_THRESHOLD_PX,
  captureViewport,
  hasScrolledAwayFromBottom,
  type SavedViewport,
  shouldFollowConversationBottom,
  type ScrollAnchorRow,
  withScrollAnchor,
} from "./scroll-anchor.js";
import { renderMermaidIn } from "../mermaid.js";
import { renderMathIn } from "../math.js";
import { fillViewport, revealRowMessage } from "./navigation.js";
import {
  acceptedOptimisticEntries,
  hasSendablePending,
  isDeliveryReceipt,
  visibleOptimisticEntries,
} from "../pending-queue/pending-message.js";
import {
  acceptedBubble,
  optPending,
  optimisticBubble,
  pendingBubble,
} from "../pending-queue.js";
import {
  loadOlderRows,
  loaded,
  reconcile,
  renderedLogGeneration,
  rowReadStatus,
  rowThreadOlder,
  rowThreads,
} from "../row-thread-state.js";
import {
  activeShells,
  agentSurfaceAgent,
  closeAgentSurface,
  closeShellSurface,
  paintAgentSurface,
  paintShellSurface,
  shellSurfaceAgent,
  shellSurfaceOpen,
} from "./shell-surface.js";
import { contextUsageKey } from "../context/tokens.js";
import { conversationPainted } from "../show-timing.js";
import { state } from "../state.js";
import { stoppingId } from "./stop.js";
import {
  activityBoundaryT,
  pendingActionT,
  promptBanner,
  queuedT,
  shellUnavailableT,
  waitingPanelT,
  workingT,
} from "../thread-render.js";
import { activityStatusKind } from "../thread-render/tool_activity.js";
import { copyText, toolDetailStore } from "../tool_details.js";
import { type Conversation } from "../types.js";
import { type ViewBlock } from "../row-thread-state/view-blocks.js";
import { type TemplateResult, html, nothing, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { beginCopyFeedback, copyFeedbackIsCurrent } from "./copy.js";

msgsEl.addEventListener("dragstart", (event) => {
  if (event.target instanceof HTMLImageElement) event.preventDefault();
});

msgsEl.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".copy-btn");
  if (!btn) return;
  const pre = btn.parentElement?.querySelector("pre");
  const scope =
    btn.closest<HTMLElement>("[data-copy-scope]")?.dataset.copyScope;
  if (!pre || !scope) return;
  const attempt = beginCopyFeedback(btn, scope);
  btn.textContent = "Copy";
  btn.classList.remove("copied");
  const copied = await copyText(pre.innerText);
  const currentScope = () =>
    btn.closest<HTMLElement>("[data-copy-scope]")?.dataset.copyScope;
  if (!copyFeedbackIsCurrent(attempt, btn.isConnected, currentScope())) return;
  btn.textContent = copied ? "Copied" : "Copy failed";
  btn.classList.toggle("copied", copied);
  setTimeout(() => {
    if (!copyFeedbackIsCurrent(attempt, btn.isConnected, currentScope()))
      return;
    btn.textContent = "Copy";
    btn.classList.remove("copied");
  }, 1200);
});

// v tracks durable boundary keys, untoggling only eyes it opened.
let vEyeActive = false;
const vEyeOpened = new Set<string>();

// Anchors repaints on surviving keyed boundary rows or the clicked control.
// Folding above the viewport must never move the reader's screen position.
export function anchoredPaint(
  conv: Conversation,
  anchor: ScrollAnchorRow | null = null,
): void {
  releaseBottomFollow();
  const rows = [...msgsEl.querySelectorAll<HTMLElement>(":scope > *")];
  withScrollAnchor(
    scrollEl,
    rows,
    () => {
      paint(conv);
      if (anchor) cancelThreadBottom();
    },
    anchor,
  );
}

export function toggleLatestTurnEye(): void {
  const conv = state.currentConv;
  if (!conv || conv.id !== state.selectedId || msgsEl.hasAttribute("inert"))
    return;
  // Invariant: Untoggling v closes only eyes that v opened, never manual opens.
  const cid = conv.id;
  const byKey = new Map(
    turnGroupBlocks(loaded, conv.parent ?? null)
      .flatMap((block) => [block, ...(block.wakeTurns ?? [])])
      .filter(boundaryHasHiddenActivity)
      .map((block) => [activityBoundaryKey(cid, block), block] as const),
  );
  const press = planVEyePress(
    [...byKey].map(([key]) => ({
      key,
      open: expandedActivityBoundaries.has(key),
    })),
    vEyeActive,
    [...vEyeOpened],
  );
  if (!press.length) {
    if (vEyeActive) {
      vEyeOpened.clear();
      vEyeActive = false;
    }
    return;
  }
  if (!vEyeActive) {
    vEyeOpened.clear();
    for (const key of press) {
      const block = byKey.get(key);
      if (!block) continue;
      vEyeOpened.add(key);
      revealActivityBoundary(cid, block);
    }
    vEyeActive = true;
    // Invariant: Opening the oldest response pulls its older page like clicking
    // its own eye would; other presses are already fully loaded by definition.
    const oldest = turnGroupBlocks(loaded, conv.parent ?? null).at(0);
    if (oldest && vEyeOpened.has(activityBoundaryKey(cid, oldest)))
      void backfillOldestBoundary(cid, oldest.key);
    anchoredPaint(conv);
    return;
  }
  for (const key of press) expandedActivityBoundaries.delete(key);
  vEyeOpened.clear();
  vEyeActive = false;
  anchoredPaint(conv);
}

// Repaints tree-derived subagent counts only when the count changes.
let lastAgentChipKey = "";
window.addEventListener("recurse:tree-authoritative", () => {
  const conv = state.currentConv;
  if (!conv || conv.id !== state.selectedId) return;
  const key = `${conv.id}:${activeDescendantCount(state.nodes, conv.id)}`;
  if (key === lastAgentChipKey) return;
  lastAgentChipKey = key;
  state.openConvHash = convHash(conv);
  paint(conv);
});

let toolDetailConversation: string | null = null;
// Follows a new selection to bottom until the reader gestures or jumps.
let bottomFollowConversation: string | null = null;
let followedScrollTop = 0;
function scrollToBottom(): void {
  followThreadBottom((top) => {
    followedScrollTop = top;
  });
}
// Where the reader left each thread (null: at the bottom), bounded like rows.
const savedViewports = new Map<string, SavedViewport | null>();
const MAX_SAVED_VIEWPORTS = 100;
type ViewportHold = SavedViewport & { conversation: string; revealed: boolean };
// Holds a returning reader's row in place until they scroll or jump.
let viewportHold: ViewportHold | null = null;
let heldScrollTop = 0;
let heldRowSearch: SavedViewport | null = null;
export function releaseBottomFollow(): void {
  bottomFollowConversation = null;
  viewportHold = null;
  cancelThreadBottom();
}
export function releaseViewportHold(): void {
  viewportHold = null;
}
function saveViewport(id: string): void {
  if (!scrollEl.clientHeight) return;
  const saved =
    viewportHold?.conversation === id
      ? { row: viewportHold.row, offset: viewportHold.offset }
      : bottomFollowConversation === id
        ? null
        : captureViewport(scrollEl, [
            ...msgsEl.querySelectorAll<HTMLElement>("[data-row-id]"),
          ]);
  savedViewports.delete(id);
  savedViewports.set(id, saved);
  for (const oldest of savedViewports.keys()) {
    if (savedViewports.size <= MAX_SAVED_VIEWPORTS) break;
    savedViewports.delete(oldest);
  }
}
function heldRowLoaded(cid: string, row: string): boolean {
  return !!rowThreads.get(cid)?.rows.some((held) => `row:${held.id}` === row);
}
// Folds are per visit, so a saved row inside a fold that closed is revealed
// once. Only a row that still has no element (inside a compacted range) is
// replaced by the nearest rendered row after it, then before it.
function heldRowElement(hold: ViewportHold): HTMLElement | null {
  const exact = msgsEl.querySelector<HTMLElement>(
    `[data-row-id="${CSS.escape(hold.row)}"]`,
  );
  if (exact) return exact;
  const conv = state.currentConv;
  if (!hold.revealed && conv?.id === hold.conversation) {
    hold.revealed = true;
    if (revealRowMessage(hold.conversation, hold.row)) {
      paint(conv);
      return null;
    }
  }
  const rows = rowThreads.get(hold.conversation)?.rows ?? [];
  const index = rows.findIndex((held) => `row:${held.id}` === hold.row);
  if (index < 0) return null;
  const rendered = new Map(
    [...msgsEl.querySelectorAll<HTMLElement>("[data-row-id]")].map(
      (element) => [element.dataset.rowId, element],
    ),
  );
  for (const held of [
    ...rows.slice(index + 1),
    ...rows.slice(0, index).reverse(),
  ]) {
    const element = rendered.get(`row:${held.id}`);
    if (element) return element;
  }
  return null;
}
function applyViewportHold(): void {
  const hold = viewportHold;
  if (!hold || toolDetailConversation !== hold.conversation) return;
  // Invariant: Before /view answers there are no rows to look through yet.
  if (!rowThreads.has(hold.conversation)) return;
  if (!heldRowLoaded(hold.conversation, hold.row)) void pageToHeldRow(hold);
  else {
    const target = heldRowElement(hold);
    if (target && viewportHold === hold)
      scrollEl.scrollTop +=
        target.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top -
        hold.offset;
  }
  // Invariant: Offsets the thread itself set (holding, clamping after a
  // repaint, older-page compensation) are not the reader scrolling away.
  heldScrollTop = scrollEl.scrollTop;
}
// Pages older history until the held row is loaded. Only exhausted history
// (the row no longer exists) falls back to the bottom; a failed page keeps
// the hold for the next paint to retry.
async function pageToHeldRow(hold: ViewportHold) {
  if (heldRowSearch === hold) return;
  heldRowSearch = hold;
  const cid = hold.conversation;
  const count = () => rowThreads.get(cid)?.rows.length ?? 0;
  try {
    let held = count();
    while (
      viewportHold === hold &&
      cid === state.selectedId &&
      state.currentConv?.id === cid &&
      !heldRowLoaded(cid, hold.row) &&
      rowThreadOlder.get(cid) !== false
    ) {
      await loadOlderRows(state.currentConv, false);
      heldScrollTop = scrollEl.scrollTop;
      if (count() <= held) break;
      held = count();
    }
  } finally {
    heldRowSearch = null;
  }
  if (viewportHold !== hold) return;
  if (heldRowLoaded(cid, hold.row)) return applyViewportHold();
  if (rowThreadOlder.get(cid) !== false) return;
  viewportHold = null;
  bottomFollowConversation = cid;
  scrollToBottom();
}
for (const event of ["pointerdown", "touchmove", "wheel", "keydown"])
  scrollEl.addEventListener(event, releaseBottomFollow, { passive: true });
scrollEl.addEventListener(
  "scroll",
  () => {
    // Invariant: Scroll events report the current offset, so one queued by the
    // previous thread reads the held offset and keeps the hold.
    if (
      viewportHold !== null &&
      Math.abs(scrollEl.scrollTop - heldScrollTop) > 1
    )
      releaseBottomFollow();
    if (
      bottomFollowConversation !== null &&
      hasScrolledAwayFromBottom(
        followedScrollTop,
        scrollEl.scrollTop,
        scrollEl.scrollHeight,
        scrollEl.clientHeight,
      )
    )
      releaseBottomFollow();
  },
  { passive: true },
);

if (typeof ResizeObserver !== "undefined") {
  const bottomFollowResize = new ResizeObserver(() => {
    const id = bottomFollowConversation ?? viewportHold?.conversation ?? null;
    if (id === null || id !== state.selectedId || toolDetailConversation !== id)
      return;
    if (viewportHold) applyViewportHold();
    else scrollToBottom();
  });
  bottomFollowResize.observe(msgsEl);
  bottomFollowResize.observe(scrollEl);
}

// Keys loaded turns and pending bubbles by identity to preserve their DOM.
// Working turns remain visible before turn_start; cancelling a pending item
// cannot transfer its hidden DOM node to a queued sibling.
function threadTemplate(conv: Conversation): TemplateResult {
  const running = conv.status === "running" || conv.status === "interrupting";
  // Invariant: A conversation the server is deleting has no Pi history to read
  // back: its session is already retired, so say what is happening instead of
  // crying unavailable while retrying a read that can never succeed.
  const piHistoryNotice =
    conv.status === "deleting"
      ? html`<div class="history-unavailable deleting" role="status">
          Deleting this conversation…
        </div>`
      : rowReadStatus.get(conv.id) === "unavailable"
        ? html`<div class="history-unavailable" role="alert">
            Conversation history is unavailable. Retrying…
          </div>`
        : nothing;
  const blocks = turnGroupBlocks(loaded, conv.parent ?? null);
  // Invariant: Session offsets retain chronology when outcome markers move to
  // their cut. Live rows follow persisted rows; ties keep incoming arrival
  // order.
  const position = (row: ViewBlock) =>
    row.offset !== undefined && row.offset >= 0 ? row.offset : Infinity;
  let latestEntry: ViewBlock | undefined;
  let latestCompaction: ViewBlock | undefined;
  for (const row of rowThreads.get(conv.id)?.rows ?? []) {
    const customCompact =
      row.kind === "marker" &&
      row.role === "custom" &&
      (row.meta as { compact_marker?: unknown } | null)?.compact_marker ===
        true;
    if (
      row.kind === "marker" &&
      !customCompact &&
      !["compaction", "shell-notice", "compaction-notice"].includes(row.role)
    )
      continue;
    if (!["marker", "text", "tool_call"].includes(row.kind)) continue;
    if (!latestEntry || position(row) >= position(latestEntry))
      latestEntry = row;
    const related =
      row.kind === "marker" &&
      (row.role === "compaction" ||
        (customCompact &&
          (row.text === "Compacting…" ||
            row.text.startsWith("Compaction failed:"))));
    if (
      related &&
      (!latestCompaction || position(row) >= position(latestCompaction))
    ) {
      latestCompaction = row;
    }
  }
  const pending = (conv.pending || []).filter(
    (message) => !isDeliveryReceipt(message),
  );
  // Invariant: An accepted send whose committed row is not read back yet
  // belongs before the live turn it started or steered, not after that turn's
  // tool rows.
  const accepted = acceptedOptimisticEntries(optPending(conv.id));
  const last = blocks.length - 1;
  const acceptedBefore = last >= 0 && boundaryIsLive(blocks[last]) ? last : -1;
  const acceptedT = repeat(
    accepted,
    (o) => "acc:" + o.seq,
    (o) => acceptedBubble(o),
  );
  // Invariant: An admitted send with no live run yet (cold start, head-of-line
  // queue, post-restart redrive) must not look dead: the queued panel shows
  // from admission, where the working panel only starts at dispatch. Failure
  // rows keep their own retry UI and never count.
  const queued =
    hasSendablePending(pending) ||
    visibleOptimisticEntries(optPending(conv.id)).length > 0;
  const currentTurnOpen = loaded.some((turn) => turn.open);
  // Invariant: Inbox steers wait for a request boundary, not run end.
  // The run remains authoritative even between rendered response rows.
  const queuedPanel = queued && !running;
  const tailShells = running ? 0 : activeShells(conv).shellCount;
  const tailAgents = running ? 0 : activeDescendantCount(state.nodes, conv.id);
  // Invariant: Stopped with continued background work but no rendered response
  // to hold the waiting panel (an empty thread): the panel tails the thread
  // instead. A queued next turn owns the single live surface instead.
  const tailWaiting =
    !running &&
    !queued &&
    blocks.length === 0 &&
    activityStatusKind(false, tailShells, tailAgents) === "waiting";
  return html` ${promptBanner(conv)} ${piHistoryNotice}
  ${repeat(
    blocks,
    (block) => `${renderedLogGeneration}:${block.key}`,
    (block, index) =>
      html`${index === acceptedBefore ? acceptedT : nothing}
      ${activityBoundaryT(conv, block, index === last, queued)}`,
  )}
  ${acceptedBefore < 0 ? acceptedT : nothing}
  ${running && !queuedPanel && !currentTurnOpen ? workingT(conv) : nothing}
  ${tailWaiting ? waitingPanelT(conv) : nothing}
  ${queuedPanel ? queuedT(conv) : nothing}
  ${running ? nothing : shellUnavailableT(conv)}
  ${pendingActionT(
    conv,
    latestCompaction !== undefined &&
      ((latestCompaction.role === "custom" &&
        latestCompaction.text === "Compacting…") ||
        latestCompaction === latestEntry),
  )}
  ${repeat(
    pending,
    (m, i) => m.id ?? i,
    (m) => pendingBubble(conv, m),
  )}
  ${repeat(
    visibleOptimisticEntries(optPending(conv.id)),
    (o) => "opt:" + o.seq,
    (o) => optimisticBubble(conv, o),
  )}`;
}

export function paint(conv: Conversation): void {
  const thread = rowThreads.get(conv.id);
  showModelResponse(conv.id, thread?.rows ?? [], thread?.sessionKey);
  if (toolDetailConversation && toolDetailConversation !== conv.id) {
    toolDetailStore.closeConversation(toolDetailConversation);
  }
  if (shellSurfaceAgent && shellSurfaceAgent !== conv.id)
    closeShellSurface(false);
  if (agentSurfaceAgent && agentSurfaceAgent !== conv.id)
    closeAgentSurface(false);
  const previousConversation = toolDetailConversation;
  const replacingConversation =
    previousConversation === null || previousConversation !== conv.id;
  if (replacingConversation) {
    if (previousConversation !== null) saveViewport(previousConversation);
    const saved = savedViewports.get(conv.id);
    viewportHold = saved
      ? { ...saved, conversation: conv.id, revealed: false }
      : null;
    bottomFollowConversation = saved ? null : conv.id;
    // Invariant: A bottom follow the outgoing thread queued must not land here.
    cancelThreadBottom();
    // Invariant: The outgoing thread's offsets mean nothing here; a scroll
    // event it queued must not read as leaving this thread's bottom.
    followedScrollTop = 0;
  } else if (
    (bottomFollowConversation ?? conv.id) !== conv.id ||
    (viewportHold?.conversation ?? conv.id) !== conv.id
  ) {
    // Invariant: A draft/empty render clears toolDetailConversation without a
    // thread id; do not carry the old conversation's follow latch into a later
    // visit.
    bottomFollowConversation = null;
    viewportHold = null;
  }
  toolDetailConversation = conv.id;
  prepareLiveReveal(conv);
  const nearBottom =
    scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <
    BOTTOM_FOLLOW_THRESHOLD_PX;
  const followBottom =
    !viewportHold &&
    shouldFollowConversationBottom(
      previousConversation,
      conv.id,
      nearBottom,
      bottomFollowConversation,
    );
  render(threadTemplate(conv), msgsEl);
  paintShellSurface(conv);
  paintAgentSurface(conv);
  renderMermaidIn(msgsEl);
  renderMathIn(msgsEl);
  if (viewportHold) applyViewportHold();
  else if (followBottom) scrollToBottom();
  updateScrollBtn();
  fillViewport();
}

export function renderConv(conv: Conversation): void {
  updateChrome(conv);
  reconcile(conv);
  lastAgentChipKey = `${conv.id}:${activeDescendantCount(state.nodes, conv.id)}`;
  paint(conv);
  conversationPainted(conv.id);
}

// Captures all drawn state: turn identity/open state/summary plus volatile
// draft and pending content/sender, so equal counts cannot mask changes.
export function convHash(conv: Conversation): string {
  // Invariant: Shell elapsed time is visible only in the open details surface;
  // avoid repainting the thread every second while the surface is closed.
  const includeElapsed =
    shellSurfaceOpen() && Boolean(conv.shells?.items.length);
  const shellItems = conv.shells?.items.map((item) =>
    includeElapsed ? item : { ...item, elapsed_seconds: null },
  );
  return JSON.stringify([
    conv.thread_generation,
    conv.message_log_generation,
    conv.github_repo_url,
    conv.msg_count,
    rowReadStatus.get(conv.id),
    conv.status,
    conv.active_run,
    conv.retry_notice,
    ...contextUsageKey(conv),
    rowThreads.get(conv.id)?.instanceId,
    rowThreads.get(conv.id)?.revision,
    conv.compacting,
    conv.pending_actions,
    conv.provider_starting,
    conv.core_reused,
    conv.title,
    conv.muted,
    conv.safety_unavailable,
    conv.shells?.status,
    conv.shells?.agent_title,
    conv.shells?.active_count,
    conv.shells?.background_count,
    conv.shells?.truncated,
    shellItems,
    activeDescendantCount(state.nodes, conv.id),
    stoppingId === conv.id,
    (conv.pending || []).map((m) => [
      m.id,
      m.from,
      m.content,
      m.delivery_state,
      m.uncertain,
      m.error,
    ]),
  ]);
}

// Reset by noteConversationSwitch in chrome.ts: v's toggle-all belongs to the
// conversation it ran in, so a switch starts it over.
export function resetVEye(): void {
  vEyeActive = false;
  vEyeOpened.clear();
}

// Take and clear the tool-detail tracking for renderEmptyAgentList/renderDraft
// in chrome.ts: closing a conversation also closes its detail view.
export function takeToolDetailConversation(): string | null {
  const current = toolDetailConversation;
  if (current) saveViewport(current);
  toolDetailConversation = null;
  return current;
}
