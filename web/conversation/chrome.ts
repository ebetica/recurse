// Conversation chrome and freshness: the topbar (title, chips, working dot),
// the freshness promise between selection and authoritative read, and the
// empty-list and draft renders. This module owns the freshness and chrome
// state machine; refresh outcomes arrive via noteRefreshFailed/Applied.
import { queuedDescription } from "../agent-status.js";
import {
  paintTakeoverControl,
  setTitleCopyable,
  updateScrollBtn,
} from "./controls.js";
import {
  FRESH,
  refreshApplied,
  refreshFailed,
  type FreshnessState,
  conversationSwitched,
  phaseFor,
} from "./freshness.js";
import { conversationStatusCopy } from "./chrome/status.js";
import { $, inputEl, msgsEl, titleEl } from "../dom.js";
import { hideModel, showConversationModel, showDraftModel } from "../models.js";
import { beginPaneVisit, syncPanes } from "../panes.js";
import { retargetFocusedEvents } from "./poll.js";
import { resetThreadView } from "../row-thread-state.js";
import { hideSafety, showConversationSafety } from "../safety.js";
import { closeAgentSurface, closeShellSurface } from "./shell-surface.js";
import { DRAFT, state } from "../state.js";
import { resetVEye, takeToolDetailConversation } from "./thread.js";
import { paintStopControl, selectedCanStop } from "./stop.js";
import { userBubble } from "../thread-render.js";
import { toolDetailStore } from "../tool_details.js";
import { type Conversation } from "../types.js";
import { kidsBadge } from "../util.js";
import { html, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { NEW_AGENT_ICON } from "../icons.js";

// Cold-switch chrome is inert; cached threads remain interactive.
const freshnessEl = $("#conv-freshness")!;
const freshnessLabelEl = freshnessEl.querySelector(".sr-only")!;
const threadLoadingEl = $("#thread-loading")!;
export let freshness: FreshnessState = FRESH;
// Stop stays detached until the selected conversation's focused read applies.
export let stopReadAuthoritativeId: string | null = null;

export function applyFreshness(): void {
  const phase = phaseFor(freshness, state.selectedId);
  const label =
    phase === "loading"
      ? "Loading conversation"
      : phase === "refreshing"
        ? "Refreshing conversation"
        : "";
  freshnessEl.classList.toggle("on", phase !== "fresh");
  freshnessLabelEl.textContent = label;
  if (label) freshnessEl.title = label;
  else freshnessEl.removeAttribute("title");
  threadLoadingEl.classList.toggle("on", phase === "loading");
  threadLoadingEl.textContent = phase === "loading" ? "Loading…" : "";
  msgsEl.classList.toggle("stale", phase === "loading");
  msgsEl.toggleAttribute("inert", phase === "loading");
  paintStopControl(state.currentConv);
}

// Drop every conversation-scoped control until the selected agent's own view
// arrives. The title comes from the tree, which already names this agent.
function clearConversationChrome(id: string): void {
  const node = state.nodes[id];
  titleEl.textContent =
    state.pendingTitles[id]?.title || node?.title || "Agent";
  setTitleCopyable(true, id);
  hideModel();
  hideSafety();
  paintTakeoverControl(null);

  $("#conv-status")!.classList.remove("running");
  $("#chip-kids")!.classList.remove("on");
  $("#chip-queued")!.classList.remove("on");
  $("#chip-state")!.classList.remove("on");
  state.selectedRunning = selectedCanStop();
  paintStopControl(null, false);
  inputEl.disabled = false;
  inputEl.placeholder = "Message this agent…";
}

// Called by selectAgent with whether showCached painted this agent's thread.
export function noteConversationSwitch(
  id: string,
  paintedFromCache: boolean,
): void {
  stopReadAuthoritativeId = null;
  // Invariant: v's toggle-all belongs to the conversation it ran in; a switch
  // starts it over rather than untoggling another agent's eyes.
  resetVEye();
  freshness = conversationSwitched(id, paintedFromCache);
  if (!paintedFromCache) clearConversationChrome(id);
  applyFreshness();
  // Invariant: The newly opened agent owns the one SSE subscription; the
  // previously open one closes here so only the focused conversation streams.
  retargetFocusedEvents(id);
}

// Completes tree-derived chrome when the conversation read wins.
let chromeAwaitingNode: string | null = null;

export function updateChrome(conv: Conversation): void {
  const node = state.nodes[conv.id];
  chromeAwaitingNode = node ? null : conv.id;
  titleEl.textContent =
    state.pendingTitles[conv.id]?.title ||
    conv.title ||
    node?.title ||
    "New agent";
  setTitleCopyable(true, conv.id);
  showConversationModel(conv);
  showConversationSafety(conv);
  paintTakeoverControl(conv);

  const st = $("#chip-state")!;
  const kids = $("#chip-kids")!;
  const kidCount = node?.children || 0;
  kids.innerHTML = kidCount > 0 ? kidsBadge(kidCount) : "";
  kids.classList.toggle("on", kidCount > 0);
  $("#conv-status")!.classList.toggle("running", conv.status === "running");
  const q = (conv.pending || []).length;
  const queued = $("#chip-queued")!;
  queued.querySelector<HTMLElement>(".queue-count")!.textContent = q
    ? String(q)
    : "";
  queued.classList.toggle("on", q > 0);
  if (q) {
    const description = queuedDescription(q);
    queued.title = description;
    queued.setAttribute("aria-label", description);
  } else {
    queued.removeAttribute("title");
    queued.removeAttribute("aria-label");
  }
  const statusDescription = conversationStatusCopy(conv);
  st.classList.toggle("on", Boolean(statusDescription));
  if (statusDescription) {
    st.title = statusDescription;
    st.setAttribute("aria-label", statusDescription);
  } else {
    st.removeAttribute("title");
    st.removeAttribute("aria-label");
  }
  state.selectedRunning = selectedCanStop(conv);
  paintStopControl(conv);
  inputEl.disabled = false;
  // Invariant: The composer stays available while working and interrupting.
  // Messages accepted during the abort are queued for the next run.
  inputEl.placeholder = "Message this agent…";
}

// Finish the chrome of a thread that was painted before its tree node arrived.
// The thread itself is already right, so this repaints only the topbar rather
// than re-rendering the whole thread through the hash.
export function completeChromeFromTree(): void {
  const id = chromeAwaitingNode;
  if (!id || !state.nodes[id]) return;
  const conv = state.currentConv;
  if (!conv || conv.id !== id || id !== state.selectedId) {
    chromeAwaitingNode = null;
    return;
  }
  updateChrome(conv);
}

export function renderEmptyAgentList(): void {
  const tdc = takeToolDetailConversation();
  if (tdc) toolDetailStore.closeConversation(tdc);
  closeShellSurface(false);
  closeAgentSurface(false);
  state.currentConv = null;
  freshness = FRESH;
  applyFreshness();
  titleEl.textContent = "No agents";
  setTitleCopyable(false);
  hideModel();
  hideSafety();
  paintTakeoverControl(null);

  $("#conv-status")!.classList.remove("running");
  $("#chip-kids")!.classList.remove("on");
  $("#chip-queued")!.classList.remove("on");
  $("#chip-state")!.classList.remove("on");
  state.selectedRunning = false;
  paintStopControl(null, false);
  inputEl.disabled = true;
  inputEl.placeholder = "Create an agent to start";
  resetThreadView();
  beginPaneVisit("");
  render(
    html`<div class="draft-hello">
      <h2>No agents</h2>
      <p class="draft-sub">Create a top-level agent to start.</p>
    </div>`,
    msgsEl,
  );
  updateScrollBtn();
  syncPanes();
}

// the blank thread shown for a drafted agent, before it exists on the server
export function renderDraft(): void {
  const tdc = takeToolDetailConversation();
  if (tdc) toolDetailStore.closeConversation(tdc);
  closeShellSurface(false);
  closeAgentSurface(false);
  const draft = state.draft;
  freshness = FRESH;
  applyFreshness();
  titleEl.textContent = "New agent";
  setTitleCopyable(false);
  // Invariant: Move the shared model row out of any prior draft host before lit
  // replaces the thread. Empty drafts put that same control back into their
  // pane below.
  hideModel();
  hideSafety();
  $("#conv-status")!.classList.remove("running");
  $("#chip-kids")!.classList.remove("on");
  $("#chip-queued")!.classList.remove("on");
  $("#chip-state")!.classList.remove("on");
  paintTakeoverControl(null);

  state.selectedRunning = false;
  paintStopControl(null);
  resetThreadView();
  const d = draft || { parent: null };
  const pending = d.pending || [];
  inputEl.disabled = false;
  inputEl.placeholder = pending.length
    ? "Message this agent…"
    : "Describe the first task for this agent…";
  render(
    pending.length
      ? html` ${pending.map(
            (m) =>
              html`<div class="msg user pending">
                <div class="bubble">${userBubble(m.content)}</div>
              </div>`,
          )}
          <div class="msg assistant">
            <div class="working">
              <span class="status"></span><span>starting agent…</span>
            </div>
          </div>`
      : html`<div class="draft-hello">
          <div class="icon">${unsafeHTML(NEW_AGENT_ICON)}</div>
          <h2>New agent</h2>
          <div id="draft-model-host" class="draft-model-host"></div>
        </div>`,
    msgsEl,
  );
  // Invariant: The selector is intentionally omitted once creation is pending:
  // the send job already owns a synchronous snapshot and later UI changes
  // cannot retarget it.
  if (!pending.length) showDraftModel(draft?.level);
  updateScrollBtn();
  state.currentConv = null;
  // Invariant: A draft is a real navigation boundary even though it has no
  // server-side conversation yet. End the prior agent visit so returning to
  // that agent gets a fresh default-open decision instead of inheriting stale
  // dismissal state.
  beginPaneVisit(DRAFT);
  syncPanes();
}

// Refresh outcomes for refreshConv in fetch.ts: the freshness state machine
// stays here; fetch only reports which transition happened.
export function noteRefreshFailed(id: string): void {
  freshness = refreshFailed(freshness, id);
}

export function noteRefreshApplied(id: string): void {
  freshness = refreshApplied(freshness, id);
}

export function setStopReadAuthoritative(id: string | null): void {
  stopReadAuthoritativeId = id;
}
