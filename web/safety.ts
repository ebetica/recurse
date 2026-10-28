// Operator safety escape hatch applies per conversation from the next turn.
// Desired toggle/label differ from effective launched state while running;
// next-turn wording exposes queued changes. Drafts have nothing to persist.
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
  unavailable.hidden = true;
  btn.disabled = true;
}

btn.onclick = async () => {
  const conv = state.currentConv;
  const id = conv?.id;
  if (busy || !conv || !id || id === DRAFT) return;
  const previous = desiredOff(conv);
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
