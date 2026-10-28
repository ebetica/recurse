// Quote selected agent text into the main composer. Touch
// Reserve 28px for native handles below, or 64px for the toolbar above.
import { autosize } from "./composer.js";
import { inputEl } from "./dom.js";
import {
  appendSelectionQuote,
  selectionCommentRange,
} from "./comments/selection-text.js";

interface PendingSelection {
  selection: string;
  range: Range;
}

const offer = document.createElement("button");
offer.type = "button";
offer.className = "selection-comment-offer";
offer.textContent = "Comment";
offer.setAttribute("aria-label", "Comment");
offer.hidden = true;

document.body.appendChild(offer);

let pending: PendingSelection | null = null;
let pointerSelecting = false;

function inAgentContent(node: Node): Element | null {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return element?.closest(".msg.assistant .content") ?? null;
}

function hide(): void {
  pending = null;
  offer.hidden = true;
}

function place(element: HTMLElement, range: Range): void {
  if (
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected ||
    !inAgentContent(range.startContainer) ||
    !inAgentContent(range.endContainer)
  ) {
    hide();
    return;
  }
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    hide();
    return;
  }
  // Invariant: fractional sizes, so the reserved gaps hold exactly; offsetWidth
  // and offsetHeight round to whole pixels.
  const size = element.getBoundingClientRect();
  let top = Math.min(innerHeight - size.height - 8, rect.bottom + 8);
  let anchorLeft = rect.left;
  if (matchMedia("(pointer: coarse)").matches) {
    const rects = Array.from(range.getClientRects()).filter(
      (part) => part.width && part.height,
    );
    const first = rects[0] ?? rect;
    const last = rects.at(-1) ?? rect;
    anchorLeft = (first.left + last.right - size.width) / 2;
    top = rect.bottom + 28 + 8;
    if (top + size.height > innerHeight - 8) {
      top = rect.top - 64 - size.height;
      if (top < 8) {
        hide();
        return;
      }
    }
  }
  const left = Math.min(innerWidth - size.width - 8, Math.max(8, anchorLeft));
  element.style.left = `${Math.max(8, left)}px`;
  element.style.top = `${Math.max(8, top)}px`;
}

function showOffer(): void {
  if (pointerSelecting) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    if (!pending) hide();
    return;
  }
  const original = selection.getRangeAt(0);
  const text = selection.toString().trimEnd();
  const content = inAgentContent(original.startContainer);
  const range = content ? selectionCommentRange(selection, content) : original;
  if (!text.trim() || !content || !inAgentContent(range.endContainer)) {
    if (!pending) hide();
    return;
  }
  pending = { selection: text, range: range.cloneRange() };
  offer.hidden = false;
  place(offer, range);
}

offer.addEventListener("pointerdown", (event) => event.preventDefault());
offer.addEventListener("click", () => {
  if (!pending) return;
  inputEl.value = appendSelectionQuote(inputEl.value, pending.selection);
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  autosize();
  hide();
  window.getSelection()?.removeAllRanges();
  inputEl.focus();
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
});

document.addEventListener(
  "pointerdown",
  (event) => {
    const target = event.target as Node | null;
    if (target && offer.contains(target)) return;
    pointerSelecting = !!target && !!inAgentContent(target);
    if (pending) hide();
  },
  true,
);
document.addEventListener(
  "pointerup",
  () => {
    if (!pointerSelecting) return;
    pointerSelecting = false;
    showOffer();
  },
  true,
);
document.addEventListener(
  "pointercancel",
  () => {
    pointerSelecting = false;
  },
  true,
);
document.addEventListener("selectionchange", showOffer);
function reposition(): void {
  if (!pending) return;
  place(offer, pending.range);
}
window.addEventListener("resize", reposition);
window.addEventListener("scroll", reposition, true);
const messageRoot = document.querySelector("#messages");
if (messageRoot)
  new MutationObserver(reposition).observe(messageRoot, {
    childList: true,
    subtree: true,
  });
