// Operator safety escape hatch applies per conversation from the next turn.
// Desired toggle/label differ from effective launched state while running;
// next-turn wording exposes queued changes. Drafts have nothing to persist.
// Turning review off requires a protected confirmation; enabling is one click.
import { backendFor } from "./backends/backend.js";
import { state } from "./state.js";
import { $ } from "./dom.js";
import { poll } from "./conversation/poll.js";
import { renderSidebar } from "./sidebar.js";
import { showModelResponse } from "./model-response.js";
import { deriveSafetyView } from "./safety-view.js";
import type { Conversation } from "./types.js";

const DRAFT = "__draft__";
const row = $("#safety-row")!;
const btn = $<HTMLButtonElement>("#safety-btn")!;
const label = btn.querySelector(".lbl") as HTMLElement;
const unavailable = $("#safety-unavailable")!;
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
export function showConversationSafety(conv: Conversation | null): void {
  const eligible = !!conv && conv.id !== DRAFT;
  row.classList.toggle("on", eligible);
  delete row.dataset.themeProtected;
  unavailable.hidden = true;
  if (!conv || !eligible) {
    showModelResponse(null, []);
    btn.disabled = true;
    return;
  }
  const {
    desired,
    pending,
    label: text,
  } = deriveSafetyView(desiredOff(conv), activeOff(conv));
  row.classList.toggle("off", desired);
  row.classList.toggle("pending", pending);
  const reason = !desired ? conv.safety_unavailable : null;
  if (desired || activeOff(conv) === true || reason)
    row.dataset.themeProtected = "safety-warning";
  btn.setAttribute("aria-checked", String(!desired));
  btn.setAttribute(
    "aria-label",
    (desired ? "Safety review off (Yolo mode)" : "Safety review, on") +
      (pending ? ", next turn" : "") +
      (reason ? `, unavailable: ${reason}` : ""),
  );
  btn.disabled = busy;
  label.textContent = text;
  unavailable.hidden = !reason;
  unavailable.title = reason ? `Safety review unavailable: ${reason}` : "";
  btn.classList.toggle("unavailable", Boolean(reason));
  btn.title = pending
    ? desired
      ? "This turn is still reviewed; review turns off from the next turn"
      : "This turn still skips review; review turns back on from the next turn"
    : desired
      ? "Turn per-action safety review back on"
      : "Skip per-action safety review for this conversation";
}

export function hideSafety(): void {
  showModelResponse(null, []);
  row.classList.remove("on", "off", "pending");
  delete row.dataset.themeProtected;
  unavailable.hidden = true;
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
  const dialog = document.createElement("dialog");
  dialog.className = "settings-sheet";
  dialog.dataset.themeProtected = "safety-confirmation";
  dialog.setAttribute("aria-labelledby", "safety-confirm-title");
  dialog.innerHTML = `<form method="dialog">
    <header class="settings-sheet-head"><h2 id="safety-confirm-title">Turn off safety review?</h2></header>
    <div class="settings-detail-content">
      <p>Tools will run without per-action safety review in this conversation.</p>
      <button class="btn" value="cancel" autofocus>Cancel</button>
      <button class="btn" value="off">Turn off safety review</button>
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
  renderSidebar();
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
    poll();
  } finally {
    busy = false;
    delete state.pendingSafety[id];
    showConversationSafety(state.currentConv);
    renderSidebar();
  }
};
