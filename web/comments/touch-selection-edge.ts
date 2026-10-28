// Android selection handles cannot scroll nested thread viewports natively.
// After touch press, an endpoint leaving #scroll scrolls one step and clamps
// the selection at the visible edge, never into title/composer chrome.
import { msgsEl, scrollEl } from "../dom.js";

const EDGE_STEP_PX = 24;

function followSelectionEdge(): void {
  const selection = getSelection();
  if (!selection?.anchorNode || !selection.focusNode) return;
  if (selection.isCollapsed || !msgsEl.contains(selection.anchorNode)) return;
  const thread = document.createRange();
  thread.selectNodeContents(scrollEl);
  const side = thread.comparePoint(selection.focusNode, selection.focusOffset);
  if (side === 0) return;
  scrollEl.scrollTop += side * EDGE_STEP_PX;
  const view = scrollEl.getBoundingClientRect();
  const content = msgsEl.getBoundingClientRect();
  const x =
    (Math.max(view.left, content.left) + Math.min(view.right, content.right)) /
    2;
  const y = side < 0 ? view.top + 1 : view.bottom - 1;
  const caret = document.caretPositionFromPoint?.(x, y);
  const range = caret ? null : document.caretRangeFromPoint?.(x, y);
  const node = caret ? caret.offsetNode : range?.startContainer;
  if (node && msgsEl.contains(node))
    selection.extend(node, caret ? caret.offset : range!.startOffset);
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (event.pointerType === "touch")
      document.addEventListener("selectionchange", followSelectionEdge);
    else document.removeEventListener("selectionchange", followSelectionEdge);
  },
  true,
);
