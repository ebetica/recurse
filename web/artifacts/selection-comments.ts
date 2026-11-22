// Selection comments own quote offers and snapshots; pre-gesture scrolls do not cancel offers.
// Cmd/Ctrl+Enter stages and focuses the viewer, then sends. Adding a comment focuses its card.
// Artifact highlight controls never nest in links or buttons.
// Overlapping highlights can share an inline Tab stop; use cards to edit the others.
import { selectionCommentRange } from "../comments/selection-text/index.js";
import {
  commentMount,
  selectionCommentOwner,
  selectionDraft,
  setSelectionDraft,
  type SelectionDraft,
  type SelectionSource,
} from "../comments/selection-draft/index.js";
import { resizeTextarea } from "../composer/textarea.js";
import {
  findBoxFrame,
  inlineBoxSource,
  placeBox,
} from "../comments/box/index.js";
import { prepareCommentCrop } from "./comment-crops.js";
import { displayedInfo } from "./artifact-state.js";
import type {
  Comment,
  CommentBox,
  CommentPane,
  CommentRendering,
} from "./artifact-state.js";

// ---- selection comments --------------------------------------------------
const MAX_QUOTE_CHARS = 600;
const normalizeQuote = (text: string): string =>
  text.replace(/\s+/g, " ").trim();
export const comments = new Map<string, Map<string, Comment>>();
/** Discard a document's staged comments and their crop resources. */
export function dropComments(id: string): void {
  for (const comment of comments.get(id)?.values() ?? [])
    comment.crop?.release();
  comments.delete(id);
}
/** Discard all staged comments and their crop resources. */
export function dropAllComments(): void {
  for (const id of comments.keys()) dropComments(id);
}
let cidSeq = 0;
export function cmap(id: string): Map<string, Comment> {
  let map = comments.get(id);
  if (!map) {
    map = new Map();
    comments.set(id, map);
  }
  return map;
}
export function pendingFor(id: string | null): number {
  return (
    (id ? comments.get(id)?.size || 0 : 0) +
    (selectionDraft?.key === id && !selectionDraft.edit ? 1 : 0)
  );
}
export function pendingTotal(): number {
  let count = 0;
  for (const map of comments.values()) count += map.size;
  return count + (selectionDraft && !selectionDraft.edit ? 1 : 0);
}
export const commentKey = (
  agentId: string | null,
  artifactId: string | null,
): string | null =>
  agentId && artifactId ? `${agentId}\n${artifactId}` : null;
export const currentCommentKey = (pane: CommentPane): string | null =>
  commentKey(pane._rs.agentId, pane._rs.selId);
/** A remounted viewer returns to the revision that owns its staged comments. */
export function pendingCommentVersion(pane: CommentPane): string | undefined {
  const key = currentCommentKey(pane);
  return key ? comments.get(key)?.values().next().value?.version : undefined;
}
export function notifyCommentChange(pane: CommentPane): void {
  pane.dispatchEvent(
    new CustomEvent("recurse:comments-changed", {
      bubbles: true,
      detail: currentCommentKey(pane),
    }),
  );
}
let selectionRoot: Element | null = null;
function reportRoot(pane: CommentPane): Element | null {
  return pane.querySelector(".report-doc");
}
export function commentRoot(pane: CommentPane): Element | null {
  return selectionRoot && selectionRoot === reportRoot(pane)
    ? selectionRoot
    : reportRoot(pane);
}
export function commentRoots(pane: CommentPane): Element[] {
  const root = reportRoot(pane);
  return root ? [root] : [];
}
const activeId = (): string | null =>
  commentMount.current ? currentCommentKey(commentMount.current) : null;

/** Whether the displayed viewer has staged comments to preserve on close. */
export function hasStagedCommentsIn(root: Element): boolean {
  const pane = commentMount.current;
  const id = activeId();
  return !!pane && root.contains(pane) && !!id && !!comments.get(id)?.size;
}

function markRange(range: Range, cid: string): HTMLElement[] {
  const root = range.commonAncestorContainer;
  const scope = (root.nodeType === 3 ? root.parentNode : root) ?? root;
  const owner = scope.ownerDocument || document;
  const walker = owner.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (range.intersectsNode(node)) nodes.push(node as Text);
  const marks: HTMLElement[] = [];
  for (const node of nodes) {
    let start = 0,
      end = (node.textContent || "").length;
    if (node === range.startContainer) start = range.startOffset;
    if (node === range.endContainer) end = range.endOffset;
    if (start >= end) continue;
    const target = start > 0 ? node.splitText(start) : node;
    if (end - start < (target.textContent || "").length)
      target.splitText(end - start);
    const mark = owner.createElement("mark");
    mark.className = "report-cmark";
    mark.dataset.cid = cid;
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}
function unwrapMark(mark: Element): void {
  const parent = mark.parentNode!;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  const box = mark.classList.contains("report-cbox");
  mark.remove();
  // Invariant: Normalizing an image frame removes Lit's empty text nodes.
  if (!box) parent.normalize();
}
const commentMarkers = "mark.report-cmark";
function removeMarkers(doc: Element | null, selector: string): void {
  for (const marker of doc?.querySelectorAll(selector) ?? [])
    unwrapMark(marker);
}
export function unmark(doc: Element | null, cid: string): void {
  removeMarkers(doc, `${commentMarkers}[data-cid="${cid}"]`);
}
export function unmarkAll(doc: Element | null): void {
  removeMarkers(doc, commentMarkers);
}
const interactiveText =
  'a[href], button, summary, [role="button"]:not(.report-cmark)';
const highlightControl = 'mark.report-cmark[role="button"]';
function makeHighlightFocusable(marks: HTMLElement[], quote: string): void {
  const mark = marks.find(
    (part) =>
      part.textContent?.trim() &&
      !part.closest(`${interactiveText}, ${highlightControl}`) &&
      !part.querySelector(highlightControl),
  );
  if (!mark) return;
  mark.tabIndex = 0;
  mark.setAttribute("role", "button");
  mark.setAttribute("aria-label", `Edit comment: ${quote}`);
  mark.setAttribute("aria-haspopup", "dialog");
}
export function orderedComments(
  id: string | null,
  doc: Element | null,
): Comment[] {
  const list = id ? [...(comments.get(id)?.values() || [])] : [];
  if (!doc) return list;
  return list.sort((a, b) => {
    const aa = doc.querySelector(`mark[data-cid="${a.cid}"]`);
    const bb = doc.querySelector(`mark[data-cid="${b.cid}"]`);
    if (!aa || !bb) return 0;
    const relation = aa.compareDocumentPosition(bb);
    return relation & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : relation & Node.DOCUMENT_POSITION_PRECEDING
        ? 1
        : 0;
  });
}

const popover = document.createElement("div");
popover.className = "menu form report-comment-popover";
popover.setAttribute("role", "dialog");
popover.setAttribute("aria-labelledby", "report-comment-label");
popover.hidden = true;
const popoverLabel = document.createElement("label");
popoverLabel.id = "report-comment-label";
popoverLabel.htmlFor = "report-selection-comment";
const popoverInput = document.createElement("textarea");
popoverInput.id = "report-selection-comment";
popoverInput.className = "text-field";
popoverInput.rows = 3;
popoverInput.placeholder = "Leave a comment…";
const popoverActions = document.createElement("div");
popoverActions.className = "report-comment-popover-actions";
const popoverCancel = document.createElement("button");
popoverCancel.type = "button";
popoverCancel.className = "btn sm quiet report-comment-popover-cancel";
popoverCancel.textContent = "Cancel";
const popoverComment = document.createElement("button");
popoverComment.type = "button";
popoverComment.className = "btn sm primary report-comment-popover-submit";
popoverComment.textContent = "Comment";
popoverActions.append(popoverCancel, popoverComment);
popover.append(popoverLabel, popoverInput, popoverActions);
document.body.appendChild(popover);
export function cancelSelectionComment(owner?: HTMLElement): void {
  if (owner && selectionCommentOwner() !== owner) return;
  // Invariant: Only clear the page selection when this popover owned one:
  // selectionchange fires for every caret move anywhere, and dropping ranges
  // unconditionally wipes the caret out of whatever input the reader is typing
  // in.
  const pane = selectionDraft?.pane;
  const owned = !!pane || !popover.hidden;
  selectionDraft?.mark?.remove();
  selectionDraft?.crop?.release();
  setSelectionDraft(null);
  popover.hidden = true;
  if (popover.parentNode !== document.body) document.body.append(popover);
  popoverInput.value = "";
  if (!owned) {
    selectionRoot = null;
    return;
  }
  window.getSelection()?.removeAllRanges();
  selectionRoot = null;
  if (pane) commentPanes.get(pane)!.renderBar(pane);
}
function finishPendingEdit(): void {
  const anchor = selectionDraft?.edit?.anchor;
  cancelSelectionComment();
  anchor?.focus({ preventScroll: true });
}
popoverCancel.addEventListener("click", finishPendingEdit);
popoverInput.addEventListener("input", () => {
  if (popover.classList.contains("composer-box")) resizeTextarea(popoverInput);
  if (selectionDraft?.edit)
    popoverComment.disabled = !popoverInput.value.trim();
});
popoverInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && closeSelectionCommentFromKeyboard()) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (isSendShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    if (selectionDraft?.edit) stageSelectionComment();
    else closeSelectionCommentFromKeyboard();
  }
});
popoverComment.addEventListener("click", () => stageSelectionComment());
/** Close the floating editor in the given viewer, or handle app-wide Escape. */
export function closeSelectionCommentFromKeyboard(
  owner?: HTMLElement,
): boolean {
  if (
    popover.hidden ||
    !selectionDraft ||
    (owner && owner !== selectionDraft.pane)
  )
    return false;
  if (selectionDraft.edit) {
    finishPendingEdit();
    return true;
  }
  const pane = selectionDraft.pane;
  stageSelectionComment(true, false);
  if (!selectionDraft) {
    const target =
      pane
        ?.closest("dialog")
        ?.querySelector<HTMLElement>('[aria-label="Close image"]') ?? pane;
    target?.focus({ preventScroll: true });
  }
  return true;
}
/** Stage a floating draft before submitting the pane's comments. */
export function stageSelectionForSend(pane: CommentPane): boolean {
  if (
    !selectionDraft ||
    selectionDraft.pane !== pane ||
    selectionDraft.key !== currentCommentKey(pane)
  )
    return true;
  if (selectionDraft.edit) return false;
  stageSelectionComment(true);
  return !selectionDraft;
}
/** Whether this viewer needs to finish an edit before submitting. */
export function editingPendingComment(pane: CommentPane): boolean {
  return selectionDraft?.pane === pane && !!selectionDraft.edit;
}
// Never stage a draft whose text/box left the page after a file/version swap.
const draftDetached = (draft: SelectionDraft): boolean =>
  !(draft.edit?.anchor ?? draft.mark ?? draft.range.startContainer).isConnected;
function positionPopover(): void {
  if (selectionDraft && draftDetached(selectionDraft)) cancelSelectionComment();
  const draft = selectionDraft;
  if (
    !draft ||
    draft.key !== currentCommentKey(draft.pane) ||
    !sourceIsCurrent(draft.source) ||
    draft.version !== displayedInfo(draft.pane)?.version
  ) {
    popover.hidden = true;
    return;
  }
  const rects = (draft.edit?.anchor ?? draft.range).getClientRects();
  const rect = rects[rects.length - 1];
  if (!rect) {
    popover.hidden = true;
    return;
  }
  const pane = draft.pane;
  const parent = pane.querySelector(".image-comment-sidebar") ?? document.body;
  if (popover.parentNode !== parent) parent.append(popover);
  const file = !!pane.closest('.image-popout, [data-pane="files"]');
  popover.className = file
    ? "composer-box files-comment-composer report-comment-popover"
    : "menu form report-comment-popover";
  popover.classList.toggle("editing", !!draft.edit);
  popoverInput.className = file ? "composer-input" : "text-field";
  popoverInput.rows = file ? 1 : 3;
  popoverInput.style.height = "";
  popoverLabel.className = draft.edit ? "" : "sr-only";
  popoverLabel.textContent = draft.edit
    ? "Edit comment"
    : draft.box
      ? "Comment on selected area"
      : "Comment on selected text";
  popoverComment.textContent = draft.edit ? "Save" : "Comment";
  popoverComment.disabled = !!draft.edit && !popoverInput.value.trim();
  popover.hidden = false;
  if (file) resizeTextarea(popoverInput);
  const paneRight = draft.edit
    ? pane.getBoundingClientRect().right
    : innerWidth;
  const left = Math.min(rect.right + 8, paneRight - popover.offsetWidth - 8);
  const below = rect.bottom + 8;
  const top =
    below + popover.offsetHeight <= innerHeight - 8
      ? below
      : rect.top - popover.offsetHeight - 8;
  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${Math.max(8, top)}px`;
}
interface SelectionSnapshot {
  range: Range;
  root: Element;
  source: SelectionSource;
}
let selectionGeneration = 0;
function sourceIsCurrent(source: SelectionSource): boolean {
  return source.active && source.doc === document;
}
function selectionRange(source: SelectionSource): SelectionSnapshot | null {
  const pane = commentMount.current,
    displayed = pane && displayedInfo(pane);
  if (!pane || !displayed || !sourceIsCurrent(source)) return null;
  const selection = source.doc.defaultView?.getSelection();
  const root = reportRoot(pane);
  if (!selection || selection.isCollapsed || !selection.rangeCount || !root)
    return null;
  const range = selectionCommentRange(selection, root);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer) ||
    !range.toString().trim()
  )
    return null;
  selectionRoot = root;
  return { range, root, source };
}
function sameRange(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}
function createSelectionSource(
  doc: Document,
  agentId: string | null,
  artifactId: string | null,
  version: string | null,
): SelectionSource {
  return {
    doc,
    agentId,
    artifactId,
    version,
    generation: ++selectionGeneration,
    active: true,
    pointerIds: new Set(),
    interactionStarted: 0,
    touch: false,
    changed: false,
    blocked: false,
    blockedRange: null,
    offerToken: 0,
  };
}
function editorHasChanges(): boolean {
  return (
    !!selectionDraft &&
    popoverInput.value.trim() !==
      (selectionDraft.edit?.comment.text.trim() ?? "")
  );
}
function offerSelectionComment(source: SelectionSource): void {
  if (
    selectionDraft?.edit ||
    (selectionDraft?.pane !== commentMount.current && editorHasChanges())
  )
    return;
  const selected = selectionRange(source),
    pane = commentMount.current,
    id = activeId();
  const displayed = pane && displayedInfo(pane);
  // Invariant: A collapsed tap, a selection outside the current artifact, and a
  // stale selection are all inert. In particular, do not cancel a floating
  // draft or clear a composer caret just because selectionchange fired
  // elsewhere.
  if (!selected || !pane || !id || !displayed || pane._rs.deleting) return;
  const version = displayed.version;
  if (!version) return;
  const quote = normalizeQuote(selected.range.toString()).slice(
    0,
    MAX_QUOTE_CHARS,
  );
  if (!quote) return;
  const previousPane = selectionDraft?.pane;
  const same =
    previousPane === pane &&
    selectionDraft?.key === id &&
    selectionDraft.version === version &&
    selectionDraft.root === selected.root &&
    selectionDraft.source === selected.source &&
    sameRange(selectionDraft.range, selected.range);
  if (!same) {
    selectionDraft?.mark?.remove();
    selectionDraft?.crop?.release();
    setSelectionDraft({
      pane,
      key: id,
      version,
      root: selected.root,
      source,
      range: selected.range.cloneRange(),
      quote,
    });
    popoverInput.value = "";
  }
  positionPopover();
  if (previousPane && previousPane !== pane)
    commentPanes.get(previousPane)!.renderBar(previousPane);
  commentPanes.get(pane)!.renderBar(pane);
}
function selectionInteractionActive(source: SelectionSource): boolean {
  return source.pointerIds.size > 0 || source.touch;
}
function scheduleSelectionOffer(source: SelectionSource): void {
  const token = ++source.offerToken,
    generation = source.generation;
  requestAnimationFrame(() =>
    setTimeout(() => {
      if (
        token === source.offerToken &&
        generation === source.generation &&
        source.active &&
        sourceIsCurrent(source) &&
        !selectionInteractionActive(source)
      ) {
        offerSelectionComment(source);
      }
    }, 0),
  );
}
/** Offer the comment popover for a box just drawn as `mark` over `frame`. */
export function offerBoxComment(
  frame: Element,
  mark: HTMLElement,
  box: CommentBox,
): void {
  const pane = commentMount.current,
    id = activeId(),
    version = pane && displayedInfo(pane)?.version;
  if (
    !pane ||
    !id ||
    !version ||
    pane._rs.deleting ||
    !pane.contains(frame) ||
    (selectionDraft?.pane !== pane && editorHasChanges())
  ) {
    mark.remove();
    return;
  }
  if (box.image && !canReplaceDraft()) {
    mark.remove();
    return;
  }
  if (selectionDraft?.mark !== mark) cancelSelectionComment();
  const range = frame.ownerDocument.createRange();
  range.selectNode(mark);
  const alt = box.image
    ? frame.querySelector("img")?.alt.replace(/\s+/g, " ").trim().slice(0, 80)
    : null;
  setSelectionDraft({
    pane,
    key: id,
    version,
    root: frame,
    source: mainSelectionSource,
    range,
    quote: box.page
      ? `Box on page ${box.page}`
      : alt
        ? `Box on image: ${alt}`
        : "Box on image",
    box,
    crop: prepareCommentCrop(frame, box),
    mark,
  });
  positionPopover();
  popoverInput.focus({ preventScroll: true });
}
/** Artifact text comments use the floating editor for their pending entries. */
export function canEditPendingComment(
  pane: CommentPane,
  comment: Comment,
): boolean {
  return pane.dataset.pane === "report" && !comment.box;
}

function canReplaceDraft(): boolean {
  if (
    !editorHasChanges() ||
    confirm("Discard what you typed in the open comment box?")
  )
    return true;
  popoverInput.focus({ preventScroll: true });
  return false;
}

/** Open the same editor from the highlighted text or its pending card. */
export function editPendingComment(
  pane: CommentPane,
  cid: string,
  anchor: HTMLElement,
): boolean {
  const key = currentCommentKey(pane);
  const comment = key ? comments.get(key)?.get(cid) : undefined;
  if (
    !key ||
    !comment ||
    !canEditPendingComment(pane, comment) ||
    pane._rs.deleting ||
    comment.version !== displayedInfo(pane)?.version
  )
    return false;
  const same = selectionDraft?.edit?.comment === comment;
  if (!same && !canReplaceDraft()) return true;
  const value = same ? popoverInput.value : comment.text;
  cancelSelectionComment();
  commentMount.current = pane;
  setSelectionDraft({
    pane,
    key,
    version: comment.version,
    root: pane,
    source: mainSelectionSource,
    range: comment.range,
    quote: comment.quote,
    edit: { comment, anchor },
  });
  if (anchor.matches("mark") && !anchor.hasAttribute("tabindex"))
    anchor.tabIndex = -1;
  popoverInput.value = value;
  commentPanes.get(pane)!.renderBar(pane);
  positionPopover();
  popoverInput.focus({ preventScroll: true });
  return true;
}
function isSendShortcut(event: KeyboardEvent): boolean {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    event.key === "Enter" &&
    !event.isComposing &&
    !event.altKey &&
    !event.shiftKey &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}
/** Submit the comments belonging to a viewer keyboard surface. */
export function handleCommentShortcut(
  event: KeyboardEvent,
  root: Element,
): void {
  if (!isSendShortcut(event)) return;
  if (
    selectionDraft?.pane === root &&
    !stageSelectionForSend(selectionDraft.pane)
  )
    return;
  const button = root.querySelector<HTMLButtonElement>(".report-sendbar-send");
  if (!button || button.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  button.click();
}
function editHighlightedText(
  pane: CommentPane,
  event: MouseEvent | KeyboardEvent,
): void {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !(event.target instanceof Element)
  )
    return;
  const mark = event.target.closest<HTMLElement>(
    `.report-doc ${commentMarkers}[data-cid]:not(.report-cbox)`,
  );
  if (!mark || mark.closest(interactiveText)) return;
  if (event instanceof KeyboardEvent) {
    if (
      event.isComposing ||
      event.repeat ||
      event.target !== mark ||
      !mark.matches(highlightControl)
    )
      return;
  } else if (!window.getSelection()?.isCollapsed) return;
  const cid = mark.dataset.cid;
  if (cid && editPendingComment(pane, cid, mark)) {
    event.preventDefault();
    event.stopPropagation();
  }
}
const commentPanes = new WeakMap<Element, CommentRendering>();
/** Let `pane` take selection comments when a press starts in it, and now
 * unless another shown pane holds them. */
export function claimComments(
  pane: CommentPane,
  rendering: CommentRendering,
): void {
  if (!commentPanes.has(pane)) {
    commentPanes.set(pane, rendering);
    pane.addEventListener("keydown", (event) => {
      handleCommentShortcut(event, pane);
      if (
        pane.dataset.pane === "report" &&
        (event.key === "Enter" || event.key === " ")
      )
        editHighlightedText(pane, event);
    });
    if (pane.dataset.pane === "report")
      pane.addEventListener(
        "click",
        (event) => editHighlightedText(pane, event),
        {
          capture: true,
        },
      );
  }
  if (!commentMount.current?.isConnected) commentMount.current = pane;
}
function onSelectionPointerDown(
  source: SelectionSource,
  event: PointerEvent,
): void {
  for (
    let node = event.target instanceof Element ? event.target : null;
    node;
    node = node.parentElement
  )
    if (commentPanes.has(node)) {
      commentMount.current = node as CommentPane;
      break;
    }
  if (!selectionInteractionActive(source)) source.changed = false;
  source.interactionStarted = event.timeStamp;
  source.blocked = false;
  source.blockedRange = null;
  source.pointerIds.add(event.pointerId);
  source.offerToken++;
}
function onSelectionPointerUp(
  source: SelectionSource,
  event: PointerEvent,
): void {
  source.pointerIds.delete(event.pointerId);
  if (!selectionInteractionActive(source)) {
    if (source.changed && !source.blocked) scheduleSelectionOffer(source);
    source.changed = false;
  }
}
function invalidateSelectionSequence(source: SelectionSource): void {
  source.changed = false;
  source.blocked = true;
  const selection = source.doc.defaultView?.getSelection();
  source.blockedRange = selection?.rangeCount
    ? selection.getRangeAt(0).cloneRange()
    : null;
  source.offerToken++;
}
function onSelectionPointerCancel(
  source: SelectionSource,
  event: PointerEvent,
): void {
  source.pointerIds.delete(event.pointerId);
  invalidateSelectionSequence(source);
}
function onSelectionTouchStart(source: SelectionSource, event: Event): void {
  if (!selectionInteractionActive(source)) source.changed = false;
  source.interactionStarted = event.timeStamp;
  source.blocked = false;
  source.blockedRange = null;
  source.touch = true;
  source.offerToken++;
}
function onSelectionTouchEnd(source: SelectionSource): void {
  source.touch = false;
  if (!selectionInteractionActive(source)) {
    if (source.changed && !source.blocked) scheduleSelectionOffer(source);
    source.changed = false;
  }
}
function onSelectionTouchCancel(source: SelectionSource): void {
  source.touch = false;
  invalidateSelectionSequence(source);
}
function onSelectionScroll(source: SelectionSource, event: Event): void {
  if (event.timeStamp < source.interactionStarted) return;
  invalidateSelectionSequence(source);
  positionPopover();
}
function installSelectionInteractions(source: SelectionSource): void {
  const { doc } = source;
  const onChange = () => {
    if (!source.active) return;
    if (selectionInteractionActive(source)) {
      source.changed = true;
      return;
    }
    if (source.blocked) {
      const selection = source.doc.defaultView?.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && source.blockedRange && sameRange(range, source.blockedRange))
        return;
      source.blocked = false;
      source.blockedRange = null;
      source.offerToken++;
      if (!range) return;
    }
    scheduleSelectionOffer(source);
  };
  const onPointerDown = (event: Event) =>
    onSelectionPointerDown(source, event as PointerEvent);
  const onPointerUp = (event: Event) =>
    onSelectionPointerUp(source, event as PointerEvent);
  const onPointerCancel = (event: Event) =>
    onSelectionPointerCancel(source, event as PointerEvent);
  const onTouchStart = (event: Event) => onSelectionTouchStart(source, event);
  const onTouchEnd = () => onSelectionTouchEnd(source);
  const onTouchCancel = () => onSelectionTouchCancel(source);
  const onScroll = (event: Event) => onSelectionScroll(source, event);
  doc.addEventListener("selectionchange", onChange);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("pointercancel", onPointerCancel, true);
  doc.addEventListener("touchstart", onTouchStart, true);
  doc.addEventListener("touchend", onTouchEnd, true);
  doc.addEventListener("touchcancel", onTouchCancel, true);
  doc.addEventListener("scroll", onScroll, true);
}
const mainSelectionSource = createSelectionSource(document, null, null, null);
installSelectionInteractions(mainSelectionSource);
addEventListener(
  "scroll",
  (event) => onSelectionScroll(mainSelectionSource, event),
  true,
);
addEventListener("resize", () => positionPopover());
function stageSelectionComment(allowEmpty = false, focusCard = true): void {
  const draft = selectionDraft;
  if (!draft) return;
  const { pane } = draft;
  const id = currentCommentKey(pane);
  const note = popoverInput.value.trim();
  const displayed = displayedInfo(pane);
  if (draftDetached(draft)) {
    cancelSelectionComment();
    return;
  }
  if (
    !id ||
    draft.key !== id ||
    pane._rs.deleting ||
    !sourceIsCurrent(draft.source) ||
    !displayed?.version ||
    draft.version !== displayed.version
  )
    return;
  if (!note && (!allowEmpty || draft.edit)) {
    popoverInput.focus();
    return;
  }
  if (draft.edit) {
    const { comment } = draft.edit;
    if (comments.get(id)?.get(comment.cid) === comment) comment.text = note;
    finishPendingEdit();
    commentPanes.get(pane)!.renderComments(pane);
    return;
  }
  const cid = `ac${++cidSeq}`;
  const textRange = draft.box
    ? undefined
    : textOffsets(draft.range, commentRoot(pane));
  const marks = draft.mark ? [draft.mark] : markRange(draft.range, cid);
  if (draft.mark) draft.mark.dataset.cid = cid;
  draft.mark = undefined;
  if (!marks.length) {
    cancelSelectionComment();
    return;
  }
  if (pane.dataset.pane === "report" && !draft.box)
    makeHighlightFocusable(marks, draft.quote);
  cmap(id).set(cid, {
    cid,
    agentId: pane._rs.agentId!,
    artifactId: pane._rs.selId!,
    version: displayed.version,
    range: draft.range.cloneRange(),
    quote: draft.quote,
    textRange,
    text: note,
    box: draft.box,
    crop: draft.crop,
  });
  draft.crop = undefined;
  cancelSelectionComment();
  commentPanes.get(pane)!.renderComments(pane);
  notifyCommentChange(pane);
  if (focusCard)
    pane
      .querySelector<HTMLElement>(
        `.report-comment[data-cid="${cid}"] :is(textarea, .report-comment-edit)`,
      )
      ?.focus({ preventScroll: true });
}
const boxHintSelector = ".files-box-hint";
function textOffsets(range: Range, root: Element | null): Comment["textRange"] {
  if (!root?.contains(range.commonAncestorContainer)) return;
  const hints = root.querySelectorAll(boxHintSelector);
  const textLength = (part: Range) => {
    let length = part.toString().length;
    for (const hint of hints) {
      if (!part.intersectsNode(hint)) continue;
      const overlap = part.cloneRange();
      overlap.selectNodeContents(hint);
      if (overlap.compareBoundaryPoints(Range.START_TO_START, part) < 0)
        overlap.setStart(part.startContainer, part.startOffset);
      if (overlap.compareBoundaryPoints(Range.END_TO_END, part) > 0)
        overlap.setEnd(part.endContainer, part.endOffset);
      length -= overlap.toString().length;
    }
    return length;
  };
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = textLength(prefix);
  return { start, end: start + textLength(range) };
}

function uniqueQuoteOffsets(full: string, quote: string): Comment["textRange"] {
  if (!quote || quote.length >= MAX_QUOTE_CHARS) return;
  const normalized: string[] = [];
  const offsets: number[] = [];
  let space = false;
  for (let i = 0; i < full.length; i++) {
    if (/\s/.test(full[i])) {
      if (space) continue;
      normalized.push(" ");
      space = true;
    } else {
      normalized.push(full[i]);
      space = false;
    }
    offsets.push(i);
  }
  const text = normalized.join("");
  const at = text.indexOf(quote);
  if (at < 0 || text.indexOf(quote, at + 1) >= 0) return;
  return { start: offsets[at], end: offsets[at + quote.length - 1] + 1 };
}

function findQuote(doc: Element, { quote, textRange }: Comment): Range | null {
  const owner = doc.ownerDocument || document;
  const walker = owner.createTreeWalker(doc, NodeFilter.SHOW_TEXT, null);
  const nodes: { node: Text; start: number; text: string }[] = [];
  let full = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(boxHintSelector)) continue;
    const text = node.textContent || "";
    nodes.push({ node: node as Text, start: full.length, text });
    full += text;
  }
  const verified =
    textRange &&
    textRange.end <= full.length &&
    normalizeQuote(full.slice(textRange.start, textRange.end)).slice(
      0,
      MAX_QUOTE_CHARS,
    ) === quote;
  const offsets = verified ? textRange : uniqueQuoteOffsets(full, quote);
  if (!offsets) return null;
  const locate = (offset: number) => {
    for (const segment of nodes)
      if (
        offset >= segment.start &&
        offset <= segment.start + segment.text.length
      )
        return { node: segment.node, offset: offset - segment.start };
    return null;
  };
  const first = locate(offsets.start),
    last = locate(offsets.end);
  if (!first || !last) return null;
  const range = owner.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);
  return range;
}
/** Re-place or hide the open popover after the shown document changed. */
export const syncSelectionDraft = (): void => positionPopover();
export function reanchor(
  pane: CommentPane,
  id: string,
  { pruneStale = false } = {},
): void {
  positionPopover();
  const key = commentKey(pane._rs.agentId, id);
  const map = key ? comments.get(key) : null;
  if (!map && !pruneStale) return;
  const roots = commentRoots(pane);
  if (pruneStale)
    for (const root of roots)
      for (const marker of root.querySelectorAll<HTMLElement>(
        `${commentMarkers}[data-cid]`,
      ))
        if (!map?.has(marker.dataset.cid!)) unwrapMark(marker);
  if (!map || !key) return;
  const version = displayedInfo(pane)?.version;
  for (const comment of map.values()) {
    if (comment.version !== version) continue;
    const marker = `mark[data-cid="${comment.cid}"]`;
    const editable = canEditPendingComment(pane, comment);
    if (roots.some((root) => root.querySelector(marker))) {
      if (editable) {
        const marks = roots.flatMap((root) => [
          ...root.querySelectorAll<HTMLElement>(marker),
        ]);
        if (!marks.some((mark) => mark.matches(highlightControl)))
          makeHighlightFocusable(marks, comment.quote);
      }
      continue;
    }
    const { box } = comment;
    if (box) {
      const frame = roots.map((root) => findBoxFrame(root, box)).find(Boolean);
      if (!frame) continue;
      if (!box.image) placeBox(frame, box).dataset.cid = comment.cid;
      else
        void Promise.all([
          comment.crop?.inlineSource,
          inlineBoxSource(frame),
        ]).then(([saved, current]) => {
          if (
            saved &&
            saved === current &&
            pane.contains(frame) &&
            comments.get(key)?.get(comment.cid) === comment &&
            displayedInfo(pane)?.version === comment.version &&
            !frame.querySelector(marker)
          )
            placeBox(frame, box).dataset.cid = comment.cid;
        });
      continue;
    }
    for (const doc of roots) {
      const range = findQuote(doc, comment);
      if (range) {
        const marks = markRange(range, comment.cid);
        if (editable) makeHighlightFocusable(marks, comment.quote);
        break;
      }
    }
  }
}
