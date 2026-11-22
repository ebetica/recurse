// Conversation header and composer chrome: title/copy, take over, safety
// and warning states, chips/working dot, and selection's freshness promise.
// Empty-list/draft renders share these controls. Focused reads own freshness
// state; stop-view.ts decides Stop availability.
import { queuedDescription } from "../agent-status.js";
import { isTakenOver } from "../active-agents.js";
import { backendFor } from "../backends/index.js";
import { savedSends, outboxBubbles } from "../composer/outbox.js";
import {
  beginCopyFeedback,
  copyFeedbackIsCurrent,
  invalidateCopyFeedback,
} from "./copy.js";
import {
  FRESH,
  conversationSwitched,
  focusedRead,
  phaseFor,
} from "./freshness.js";
import { conversationStatusCopy } from "./chrome/status.js";
import { $, inputEl, liveBarEl, msgsEl, titleEl } from "../dom.js";
import {
  effortMenuInvoker,
  hideModel,
  showConversationModel,
  showDraftModel,
} from "../models.js";
import { showModelResponse } from "../model-response.js";
import { beginPaneVisit, syncPanes } from "../panes.js";
import { resetThreadView } from "../row-thread-state.js";
import { deriveSafetyView } from "../safety-view.js";
import { updateScrollBtn } from "../thread-scroll/index.js";
import { closeAgentSurface, closeShellSurface } from "./shell-surface.js";
import { refreshSidebarTree, renderAgentList } from "../sidebar/index.js";
import { state } from "../state.js";
import { resetVEye, takeToolDetailConversation } from "./thread.js";
import { paintComposerRunState, selectedCanStop } from "./stop-view.js";
import { userBubble } from "../thread-render/index.js";
import { copyText, toolDetailStore } from "../tool_details.js";
import { type Conversation } from "../types.js";
import { kidsBadge } from "../util.js";
import { html, render } from "lit";
import { showDraftTags } from "./draft-tags.js";

const DRAFT = "__draft__";
const row = $("#safety-row")!;
const btn = $<HTMLButtonElement>("#safety-btn")!;
const label = btn.querySelector(".lbl") as HTMLElement;
const warning = $<HTMLButtonElement>("#safety-warning")!;
warning.dataset.themeProtected = "safety-warning";
const unavailable = $("#safety-reason")!;
// Serializes absolute-state POSTs so slow replies cannot reverse the choice.
let busy = false;

// DESIRED state (what the operator has set): an optimistic pending value wins,
// then the shown conversation, then the sidebar snapshot.
function desiredOff(conv: Conversation): boolean {
  const id = conv.id;
  return (
    state.pendingSafety[id] ??
    conv.safety_off ??
    state.nodes[id]?.safety_off ??
    false
  );
}

// EFFECTIVE state (what review is doing right now), server-owned.
function activeOff(conv: Conversation): boolean | undefined {
  return conv.safety_off_active ?? state.nodes[conv.id]?.safety_off_active;
}

// Paint the control from the shown conversation. Hidden for a draft.
// The toggle stays interactive during a running turn — the change just applies
// next turn.
function showConversationSafety(conv: Conversation | null): void {
  const eligible = !!conv && conv.id !== DRAFT;
  row.classList.toggle("on", eligible);
  if (!conv || !eligible) {
    warning.hidden = true;
    showModelResponse(null, []);
    btn.disabled = true;
    return;
  }
  const {
    desired,
    effective,
    pending,
    label: text,
  } = deriveSafetyView(desiredOff(conv), activeOff(conv));
  row.classList.toggle("off", desired);
  row.classList.toggle("pending", pending);
  const reason = !desired ? conv.safety_unavailable : null;
  const status = reason
    ? `Safety review unavailable: ${reason}`
    : "Safety review off" +
      (pending ? (desired ? " · next turn" : " · this turn") : "");
  warning.classList.toggle("unavailable", Boolean(reason));
  warning.title = status;
  warning.setAttribute("aria-label", status);
  warning.hidden = !(desired || effective || reason);
  unavailable.hidden = !reason;
  unavailable.textContent = reason ? status : "";
  btn.setAttribute("aria-checked", String(!desired));
  btn.setAttribute(
    "aria-label",
    (desired ? "Safety review off (Yolo mode)" : "Safety review, on") +
      (pending ? ", next turn" : "") +
      (reason ? `, unavailable: ${reason}` : ""),
  );
  btn.disabled = busy;
  label.textContent = text;
  btn.classList.toggle("unavailable", Boolean(reason));
  btn.title =
    (reason ? `Safety review unavailable: ${reason}. ` : "") +
    (pending
      ? desired
        ? "This turn is still reviewed; review turns off from the next turn"
        : "This turn still skips review; review turns back on from the next turn"
      : desired
        ? "Turn per-action safety review back on"
        : "Skip per-action safety review for this conversation");
}

function hideSafety(): void {
  showModelResponse(null, []);
  row.classList.remove("on", "off", "pending");
  warning.hidden = true;
  btn.disabled = true;
}

/** Whether local keyboard commands belong to the safety confirmation. */
export function safetyConfirmationOpen(): boolean {
  return !!$('[data-theme-protected="safety-confirmation"][open]');
}

/** Cancel the confirmation through the app's local-layer Escape route. */
export function closeSafetyConfirmation(): boolean {
  const dialog = $<HTMLDialogElement>(
    '[data-theme-protected="safety-confirmation"][open]',
  );
  if (!dialog) return false;
  dialog.close("cancel");
  return true;
}

/** Require a separate operator click outside the themeable safety switch. */
function confirmSafetyOff(): Promise<boolean> {
  const returnFocus =
    document.activeElement === inputEl ? inputEl : effortMenuInvoker();
  const dialog = document.createElement("dialog");
  dialog.className = "settings-sheet";
  dialog.dataset.themeProtected = "safety-confirmation";
  dialog.setAttribute("aria-labelledby", "safety-confirm-title");
  dialog.innerHTML = `<form method="dialog">
    <header class="settings-sheet-head"><h2 id="safety-confirm-title">Turn off safety review?</h2></header>
    <div class="settings-detail-content">
      <p>Tools will run without per-action safety review in this conversation.</p>
      <div class="dialog-buttons">
        <button class="btn" value="cancel" autofocus>Cancel</button>
        <button class="btn" value="off">Turn off safety review</button>
      </div>
    </div>
  </form>`;
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        resolve(dialog.returnValue === "off");
      },
      { once: true },
    );
    document.body.append(dialog);
    // Native modal focus restoration needs an invoker that survives closing
    // the popover. A touch action may already be keeping the draft focused.
    btn.closest<HTMLElement>(":popover-open")?.hidePopover();
    returnFocus.focus({ preventScroll: true });
    dialog.showModal();
    // Invariant: Theme suspension precedes focus, even when CSS hid the dialog.
    queueMicrotask(() => {
      if (dialog.open)
        dialog.querySelector<HTMLButtonElement>("[autofocus]")?.focus();
    });
  });
}

btn.onclick = async () => {
  const conv = state.currentConv;
  const id = conv?.id;
  if (busy || !conv || !id || id === DRAFT) return;
  const previous = desiredOff(conv);
  if (!previous && !(await confirmSafetyOff())) return;
  if (busy || state.currentConv?.id !== id || desiredOff(conv) !== previous)
    return;
  const desired = !previous;
  busy = true;
  // Invariant: Optimistically move only the DESIRED state; the effective state
  // is owned by the server so a mid-turn toggle never falsely claims review is
  // off.
  state.pendingSafety[id] = desired;
  conv.safety_off = desired;
  if (state.nodes[id]) state.nodes[id].safety_off = desired;
  showConversationSafety(conv);
  renderAgentList();
  try {
    const r = await backendFor(id).jpost(`/api/conversations/${id}/safety`, {
      off: desired,
    });
    if (!r.ok) throw new Error("safety toggle failed");
    const data = (await r.json()) as {
      safety_off: boolean;
      safety_off_active?: boolean;
    };
    conv.safety_off = data.safety_off;
    if (data.safety_off) conv.safety_unavailable = null;
    conv.safety_off_active = data.safety_off_active;
    if (state.nodes[id]) {
      state.nodes[id].safety_off = data.safety_off;
      state.nodes[id].safety_off_active = data.safety_off_active;
    }
  } catch {
    conv.safety_off = previous;
    if (state.nodes[id]) state.nodes[id].safety_off = previous;
    refreshSidebarTree();
  } finally {
    busy = false;
    delete state.pendingSafety[id];
    showConversationSafety(state.currentConv);
    renderAgentList();
  }
};

// Taking over prevents agent deletion and quiets upward reports.
const takeoverBtn = $<HTMLButtonElement>("#takeover-btn")!;
// Serializes absolute-state POSTs to prevent reversed completion.
let takeoverBusy = false;

export type TakeoverToggleResult =
  | { ok: true; takenOver: boolean }
  | { ok: false; reason: "missing" | "busy" | "failed" };

function optimisticTakenOver(id: string): boolean {
  const conv = state.currentConv?.id === id ? state.currentConv : null;
  const node = state.nodes[id];
  return (
    state.pendingTakeovers[id] ??
    (conv ? isTakenOver(conv) : undefined) ??
    (node ? isTakenOver(node) : undefined) ??
    false
  );
}

function paintTakeoverControl(conv?: Conversation | null): void {
  const id = conv?.id || state.selectedId;
  const eligible = !!conv?.parent && id !== DRAFT;
  const taken = eligible && optimisticTakenOver(id);
  takeoverBtn.classList.toggle("on", eligible);
  takeoverBtn.classList.toggle("active", taken);
  takeoverBtn.disabled = !eligible || takeoverBusy;
  takeoverBtn.setAttribute("aria-pressed", String(taken));
  const label = taken ? "Taken over" : "Take over";
  takeoverBtn.title = label;
  const menuLabel = taken ? "Hand back control" : "Take control";
  takeoverBtn.querySelector("span")!.textContent = menuLabel;
  takeoverBtn.setAttribute("aria-label", menuLabel);
}

export async function requestTakeoverToggle(
  id: string,
): Promise<TakeoverToggleResult> {
  const node = state.nodes[id];
  if (!node) return { ok: false, reason: "missing" };
  if (takeoverBusy) return { ok: false, reason: "busy" };

  const conv = state.currentConv?.id === id ? state.currentConv : null;
  const desired = !optimisticTakenOver(id);
  const beforeConvMuted = conv?.muted;
  const beforeConvTakenOver = conv?.taken_over;
  const beforeNodeMuted = node.muted;
  const beforeNodeTakenOver = node.taken_over;
  takeoverBusy = true;
  state.pendingTakeovers[id] = desired;
  if (conv) {
    conv.muted = desired;
    conv.taken_over = desired;
  }
  node.muted = desired;
  node.taken_over = desired;
  paintTakeoverControl(state.currentConv);
  renderAgentList();
  try {
    const backend = backendFor(id);
    const url = `/api/conversations/${id}`;
    let r = await backend.jpost(`${url}/take-over`, { taken_over: desired });
    // Spec: A connected backend older than the taken_over rename only has
    // `/pin`; drop this fallback one release after the rename.
    if (r.status === 404)
      r = await backend.jpost(`${url}/pin`, { pinned: desired });
    if (!r.ok) throw new Error("take over failed");
    const applied = (await r.json()) as {
      taken_over?: boolean;
      pinned?: boolean;
    };
    const took = applied.taken_over ?? applied.pinned === true;
    if (state.nodes[id]) {
      state.nodes[id].muted = took;
      state.nodes[id].taken_over = took;
    }
    if (state.currentConv?.id === id) {
      state.currentConv.muted = took;
      state.currentConv.taken_over = took;
    }
    if (state.pendingTakeovers[id] === desired)
      delete state.pendingTakeovers[id];
    return { ok: true, takenOver: took };
  } catch {
    if (state.pendingTakeovers[id] === desired)
      delete state.pendingTakeovers[id];
    if (conv && state.currentConv?.id === id) {
      conv.muted = beforeConvMuted;
      conv.taken_over = beforeConvTakenOver;
    }
    if (state.nodes[id]) {
      state.nodes[id].muted = beforeNodeMuted;
      state.nodes[id].taken_over = beforeNodeTakenOver;
    }
    refreshSidebarTree();
    return { ok: false, reason: "failed" };
  } finally {
    takeoverBusy = false;
    paintTakeoverControl(state.currentConv);
  }
}

takeoverBtn.onclick = () => {
  if (!takeoverBtn.classList.contains("on") || takeoverBtn.disabled) return;
  void requestTakeoverToggle(state.selectedId);
};

// The header title doubles as a "copy this agent's id" control.
const titleCopiedEl = $("#title-copied")!;
let titleCopyIdentity: string | null = null;
let titleCopyTimer = 0;
function clearTitleCopyFeedback(): void {
  clearTimeout(titleCopyTimer);
  titleEl.classList.remove("copied");
  titleCopiedEl.classList.remove("on");
}
function setTitleCopyable(on: boolean, identity: string | null = null): void {
  titleEl.classList.toggle("copyable", on);
  if (titleCopyIdentity !== identity) {
    clearTitleCopyFeedback();
    invalidateCopyFeedback(titleEl);
  }
  titleCopyIdentity = identity;
  if (on) {
    titleEl.title = "Click to copy agent ID";
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");
  } else {
    clearTitleCopyFeedback();
    titleEl.removeAttribute("title");
    titleEl.removeAttribute("role");
    titleEl.removeAttribute("tabindex");
  }
}
async function copyAgentId(): Promise<void> {
  const id = state.selectedId;
  if (!titleEl.classList.contains("copyable") || !id || id === DRAFT) return;
  const attempt = beginCopyFeedback(titleEl, id);
  clearTitleCopyFeedback();
  const copied = await copyText(id);
  if (
    !copied ||
    !titleEl.classList.contains("copyable") ||
    !copyFeedbackIsCurrent(
      attempt,
      titleEl.isConnected,
      titleCopyIdentity || undefined,
    )
  )
    return;
  titleEl.classList.add("copied");
  titleCopiedEl.classList.add("on");
  clearTimeout(titleCopyTimer);
  titleCopyTimer = setTimeout(() => {
    if (
      !copyFeedbackIsCurrent(
        attempt,
        titleEl.isConnected,
        titleCopyIdentity || undefined,
      )
    )
      return;
    titleEl.classList.remove("copied");
    titleCopiedEl.classList.remove("on");
  }, 1400) as unknown as number;
}
titleEl.addEventListener("click", copyAgentId);
titleEl.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    copyAgentId();
  }
});

// Cold-switch chrome is inert; cached threads remain interactive.
const freshnessEl = $("#conv-freshness")!;
const freshnessLabelEl = freshnessEl.querySelector(".sr-only")!;
const threadLoadingEl = $("#thread-loading")!;

export function applyFreshness(): void {
  const phase = phaseFor(focusedRead.freshness, state.selectedId);
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
  const loading =
    phase === "loading" &&
    !savedSends().some((send) => send.convId === state.selectedId);
  threadLoadingEl.classList.toggle("on", loading);
  threadLoadingEl.textContent = loading ? "Loading…" : "";
  msgsEl.classList.toggle("stale", loading);
  msgsEl.toggleAttribute("inert", loading);
  liveBarEl.classList.toggle("stale", phase === "loading");
  paintComposerRunState(state.currentConv);
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
  paintComposerRunState(null, false);
  inputEl.disabled = false;
  inputEl.placeholder = "Message this agent…";
}

// Called by selectAgent with whether showCached painted this agent's thread.
export function noteConversationSwitch(
  id: string,
  paintedFromCache: boolean,
): void {
  focusedRead.stopReadAuthoritativeId = null;
  // Invariant: v's toggle-all belongs to the conversation it ran in; a switch
  // starts it over rather than untoggling another agent's eyes.
  resetVEye();
  focusedRead.freshness = conversationSwitched(id, paintedFromCache);
  if (!paintedFromCache) clearConversationChrome(id);
  applyFreshness();
  if (!paintedFromCache) renderColdOutbox(id);
}

/** Keep saved sends visible before an offline conversation can be read. */
export function renderColdOutbox(id: string): void {
  if (!id) return;
  if (!savedSends().some((send) => send.convId === id)) {
    if (msgsEl.querySelector("[data-cold-outbox]")) render(html``, msgsEl);
    return;
  }
  render(html`<div data-cold-outbox>${outboxBubbles(id)}</div>`, msgsEl);
  inputEl.disabled = false;
  applyFreshness();
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
  paintComposerRunState(conv);
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
  focusedRead.freshness = FRESH;
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
  paintComposerRunState(null, false);
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
  focusedRead.freshness = FRESH;
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
  paintComposerRunState(null);
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
          <h2>New agent</h2>
          <div id="draft-model-host" class="draft-model-host"></div>
          <div id="draft-tag-host"></div>
        </div>`,
    msgsEl,
  );
  // Invariant: The selector is intentionally omitted once creation is pending:
  // the send job already owns a synchronous snapshot and later UI changes
  // cannot retarget it.
  if (!pending.length) {
    showDraftModel(draft?.level);
    if (draft) void showDraftTags(draft);
  }
  updateScrollBtn();
  state.currentConv = null;
  // Invariant: A draft is a real navigation boundary even though it has no
  // server-side conversation yet. End the prior agent visit so returning to
  // that agent gets a fresh default-open decision instead of inheriting stale
  // dismissal state.
  beginPaneVisit(DRAFT);
  syncPanes();
}
