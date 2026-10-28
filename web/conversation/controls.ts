// Conversation header controls: scroll-to-latest cue, take over, and title
// copy. Each control owns its button wiring and request path; stop lives in
// stop.ts. This module renders controls only and never fetches.
import { backendFor } from "../backends/backend.js";
import { isTakenOver } from "../active-agents.js";
import {
  beginCopyFeedback,
  copyFeedbackIsCurrent,
  invalidateCopyFeedback,
} from "./copy.js";
import { $, msgsEl, scrollBtn, scrollEl, titleEl } from "../dom.js";
import { fillViewport, loadOlder } from "./navigation.js";
import { poll } from "./poll.js";
import { releaseViewportHold } from "./thread.js";
import { renderSidebar } from "../sidebar.js";
import { DRAFT, state } from "../state.js";
import { copyText } from "../tool_details.js";
import { type Conversation } from "../types.js";

let scrollFrame = 0;
let pendingBottom: ((top: number) => void) | null = null;
export function updateScrollBtn(): void {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const height = scrollEl.scrollHeight;
    const viewport = scrollEl.clientHeight;
    const top = pendingBottom
      ? Math.max(0, height - viewport)
      : scrollEl.scrollTop;
    const fromBottom = height - top - viewport;
    const follow = pendingBottom;
    pendingBottom = null;
    if (follow) {
      follow(top);
      scrollEl.scrollTop = top;
    }
    scrollBtn.classList.toggle("visible", fromBottom > 2 * viewport);
    scrollEl.classList.toggle("content-above", top > 1);
    scrollEl.classList.toggle("content-below", fromBottom > 1);
  });
}
/** Coalesces bottom following and edge controls into one read/write batch. */
export function followThreadBottom(onFollow: (top: number) => void): void {
  pendingBottom = onFollow;
  updateScrollBtn();
}
export function cancelThreadBottom(): void {
  pendingBottom = null;
}
scrollEl.addEventListener("scroll", updateScrollBtn, { passive: true });
// Disclosures/composer growth change edge fades without scroll events.
const edgeObserver = new ResizeObserver(updateScrollBtn);
edgeObserver.observe(scrollEl);
edgeObserver.observe(msgsEl);
new ResizeObserver(fillViewport).observe(scrollEl);
scrollEl.addEventListener(
  "scroll",
  () => {
    if (scrollEl.scrollTop < 300) loadOlder();
  },
  { passive: true },
);
export function scrollToLatest(): void {
  releaseViewportHold();
  scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
}
scrollBtn.addEventListener("click", scrollToLatest);

// Pinning prevents agent deletion and quiets upward reports.
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

export function paintTakeoverControl(conv?: Conversation | null): void {
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
  const beforeConvPinned = conv?.pinned;
  const beforeNodeMuted = node.muted;
  const beforeNodePinned = node.pinned;
  takeoverBusy = true;
  state.pendingTakeovers[id] = desired;
  if (conv) {
    conv.muted = desired;
    conv.pinned = desired;
  }
  node.muted = desired;
  node.pinned = desired;
  paintTakeoverControl(state.currentConv);
  renderSidebar();
  try {
    const r = await backendFor(id).jpost(`/api/conversations/${id}/pin`, {
      pinned: desired,
    });
    if (!r.ok) throw new Error("take over failed");
    const applied = (await r.json()) as { pinned: boolean };
    const took = applied.pinned;
    if (state.nodes[id]) {
      state.nodes[id].muted = took;
      state.nodes[id].pinned = took;
    }
    if (state.currentConv?.id === id) {
      state.currentConv.muted = took;
      state.currentConv.pinned = took;
    }
    if (state.pendingTakeovers[id] === desired)
      delete state.pendingTakeovers[id];
    return { ok: true, takenOver: took };
  } catch {
    if (state.pendingTakeovers[id] === desired)
      delete state.pendingTakeovers[id];
    if (conv && state.currentConv?.id === id) {
      conv.muted = beforeConvMuted;
      conv.pinned = beforeConvPinned;
    }
    if (state.nodes[id]) {
      state.nodes[id].muted = beforeNodeMuted;
      state.nodes[id].pinned = beforeNodePinned;
    }
    poll();
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
export function setTitleCopyable(
  on: boolean,
  identity: string | null = null,
): void {
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
