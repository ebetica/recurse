// Selection-anchored review comments. This module owns the comment store,
// quote re-anchoring, the text-selection offer machinery (pointer/touch
// sequencing, popover, staging), and the displayed-snapshot binding.
import { selectionCommentRange } from "../comments/selection-text.js";
import { displayedInfo, renderComments } from "./comment-bar.js";
import { commentMount } from "./artifact-state.js";
import type { Comment, CommentBox, CommentPane } from "./artifact-state.js";

// ---- selection comments --------------------------------------------------
export const comments = new Map<string, Map<string, Comment>>();
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
    (selectionDraft?.key === id ? 1 : 0)
  );
}
export function pendingTotal(): number {
  let count = 0;
  for (const map of comments.values()) count += map.size;
  return count + (selectionDraft ? 1 : 0);
}
export const commentKey = (
  agentId: string | null,
  artifactId: string | null,
): string | null =>
  agentId && artifactId ? `${agentId}\n${artifactId}` : null;
export const currentCommentKey = (pane: CommentPane): string | null =>
  commentKey(pane._rs.agentId, pane._rs.selId);
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

export function markRange(range: Range, cid: string): HTMLElement[] {
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
/** The image or PDF page frame in `root` that a box on `page` belongs to. */
export function boxFrame(root: Element, page?: number): HTMLElement | null {
  const selector = `.report-box-frame${page ? `[data-page="${page}"]` : ""}`;
  return root.matches(selector)
    ? (root as HTMLElement)
    : root.querySelector(selector);
}
/** Show `box` as a highlight over its frame. */
export function placeBox(
  frame: Element,
  box: CommentBox,
  mark = frame.ownerDocument.createElement("mark"),
): HTMLElement {
  mark.className = "report-cmark report-cbox";
  Object.assign(mark.style, {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
  });
  if (mark.parentNode !== frame) frame.append(mark);
  return mark;
}
export function unmark(doc: Element | null, cid: string): void {
  if (!doc) return;
  for (const mark of [
    ...doc.querySelectorAll(`mark.report-cmark[data-cid="${cid}"]`),
  ]) {
    const parent = mark.parentNode!;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  }
}
export function unmarkAll(doc: Element | null): void {
  if (!doc) return;
  for (const mark of [...doc.querySelectorAll("mark.report-cmark")]) {
    const parent = mark.parentNode!;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  }
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

interface SelectionSource {
  doc: Document;
  pane: CommentPane | null;
  agentId: string | null;
  artifactId: string | null;
  version: string | null;
  generation: number;
  active: boolean;
  pointerIds: Set<number>;
  touch: boolean;
  changed: boolean;
  blocked: boolean;
  blockedRange: Range | null;
  offerToken: number;
}

interface SelectionDraft {
  key: string;
  version: string;
  root: Element;
  source: SelectionSource;
  range: Range;
  quote: string;
  box?: CommentBox;
  mark?: HTMLElement;
}
let selectionDraft: SelectionDraft | null = null;
const popover = document.createElement("div");
popover.className = "menu form report-comment-popover";
popover.setAttribute("role", "dialog");
popover.setAttribute("aria-label", "Comment on selected text");
popover.hidden = true;
const popoverLabel = document.createElement("label");
popoverLabel.className = "sr-only";
popoverLabel.htmlFor = "report-selection-comment";
popoverLabel.textContent = "Comment on selected text";
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
export function cancelSelectionComment(): void {
  // Invariant: Only clear the page selection when this popover owned one:
  // selectionchange fires for every caret move anywhere, and dropping ranges
  // unconditionally wipes the caret out of whatever input the reader is typing
  // in.
  const owned = selectionDraft !== null || !popover.hidden;
  selectionDraft?.mark?.remove();
  selectionDraft = null;
  popover.hidden = true;
  popoverInput.value = "";
  if (!owned) {
    selectionRoot = null;
    return;
  }
  window.getSelection()?.removeAllRanges();
  selectionRoot = null;
}
popoverCancel.addEventListener("click", cancelSelectionComment);
popoverInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    cancelSelectionComment();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    stageSelectionComment();
  }
});
popoverComment.addEventListener("click", stageSelectionComment);
// Never stage a draft whose text/box left the page after a file/version swap.
const draftDetached = (draft: SelectionDraft): boolean =>
  !(draft.mark ?? draft.range.startContainer).isConnected;
function positionPopover(range = selectionDraft?.range): void {
  if (selectionDraft && draftDetached(selectionDraft)) cancelSelectionComment();
  const displayed = commentMount.current && displayedInfo(commentMount.current);
  if (
    !range ||
    !commentMount.current ||
    selectionDraft?.key !== activeId() ||
    !selectionDraft ||
    !sourceIsCurrent(selectionDraft.source) ||
    !displayed ||
    selectionDraft.version !== displayed.version
  ) {
    popover.hidden = true;
    return;
  }
  const rects = range.getClientRects(),
    rect = rects[rects.length - 1];
  if (!rect) {
    popover.hidden = true;
    return;
  }
  popover.hidden = false;
  const left = Math.min(rect.right + 8, innerWidth - popover.offsetWidth - 8);
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
  pane: CommentPane | null,
  agentId: string | null,
  artifactId: string | null,
  version: string | null,
): SelectionSource {
  return {
    doc,
    pane,
    agentId,
    artifactId,
    version,
    generation: ++selectionGeneration,
    active: true,
    pointerIds: new Set(),
    touch: false,
    changed: false,
    blocked: false,
    blockedRange: null,
    offerToken: 0,
  };
}
function offerSelectionComment(source: SelectionSource): void {
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
  const quote = selected.range
    .toString()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  if (!quote) return;
  const same =
    selectionDraft?.key === id &&
    selectionDraft.version === version &&
    selectionDraft.root === selected.root &&
    selectionDraft.source === selected.source &&
    sameRange(selectionDraft.range, selected.range);
  if (!same) {
    selectionDraft = {
      key: id,
      version,
      root: selected.root,
      source,
      range: selected.range.cloneRange(),
      quote,
    };
    popoverInput.value = "";
  }
  positionPopover(selected.range);
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
  if (!pane || !id || !version || pane._rs.deleting || !pane.contains(frame)) {
    mark.remove();
    return;
  }
  if (selectionDraft?.mark !== mark) cancelSelectionComment();
  const range = frame.ownerDocument.createRange();
  range.selectNode(mark);
  selectionDraft = {
    key: id,
    version,
    root: frame,
    source: mainSelectionSource,
    range,
    quote: box.page ? `Box on page ${box.page}` : "Box on image",
    box,
    mark,
  };
  positionPopover(range);
  popoverInput.focus({ preventScroll: true });
}
const commentPanes = new WeakSet<Element>();
/** Let `pane` take selection comments when a press starts in it, and now
 * unless another shown pane holds them. */
export function claimComments(pane: CommentPane): void {
  commentPanes.add(pane);
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
function onSelectionTouchStart(source: SelectionSource): void {
  if (!selectionInteractionActive(source)) source.changed = false;
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
function onSelectionScroll(source: SelectionSource): void {
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
  const onTouchStart = () => onSelectionTouchStart(source);
  const onTouchEnd = () => onSelectionTouchEnd(source);
  const onTouchCancel = () => onSelectionTouchCancel(source);
  const onScroll = () => onSelectionScroll(source);
  doc.addEventListener("selectionchange", onChange);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("pointercancel", onPointerCancel, true);
  doc.addEventListener("touchstart", onTouchStart, true);
  doc.addEventListener("touchend", onTouchEnd, true);
  doc.addEventListener("touchcancel", onTouchCancel, true);
  doc.addEventListener("scroll", onScroll, true);
}
const mainSelectionSource = createSelectionSource(
  document,
  null,
  null,
  null,
  null,
);
installSelectionInteractions(mainSelectionSource);
function invalidateAllSelectionSequences(): void {
  invalidateSelectionSequence(mainSelectionSource);
}
addEventListener(
  "scroll",
  () => {
    invalidateAllSelectionSequences();
    positionPopover();
  },
  true,
);
addEventListener("resize", () => positionPopover());
function stageSelectionComment(): void {
  const draft = selectionDraft,
    id = activeId();
  const note = popoverInput.value.trim();
  const displayed = commentMount.current
    ? displayedInfo(commentMount.current)
    : null;
  if (draft && draftDetached(draft)) {
    cancelSelectionComment();
    return;
  }
  if (
    !draft ||
    !id ||
    !commentMount.current ||
    commentMount.current._rs.deleting ||
    !sourceIsCurrent(draft.source) ||
    !displayed?.version ||
    draft.version !== displayed.version
  )
    return;
  if (!note) {
    popoverInput.focus();
    return;
  }
  const cid = `ac${++cidSeq}`;
  const marks = draft.mark ? [draft.mark] : markRange(draft.range, cid);
  if (draft.mark) draft.mark.dataset.cid = cid;
  draft.mark = undefined;
  if (!marks.length) {
    cancelSelectionComment();
    return;
  }
  cmap(id).set(cid, {
    cid,
    agentId: commentMount.current._rs.agentId!,
    artifactId: commentMount.current._rs.selId!,
    version: displayed.version,
    range: draft.range.cloneRange(),
    quote: draft.quote,
    text: note,
    box: draft.box,
  });
  cancelSelectionComment();
  renderComments(commentMount.current);
  requestAnimationFrame(() => {
    const card = commentMount.current?.querySelector<HTMLElement>(
      `.report-comment[data-cid="${cid}"]`,
    );
    card
      ?.querySelector<HTMLTextAreaElement>("textarea")
      ?.focus({ preventScroll: true });
  });
}
function findQuote(doc: Element, quote: string): Range | null {
  const want = quote.replace(/\s+/g, " ").trim();
  if (!want) return null;
  const owner = doc.ownerDocument || document;
  const walker = owner.createTreeWalker(doc, NodeFilter.SHOW_TEXT, null);
  const nodes: { node: Text; start: number; text: string }[] = [];
  let full = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent || "";
    nodes.push({ node: node as Text, start: full.length, text });
    full += text;
  }
  const normalized: string[] = [],
    offsets: number[] = [];
  let space = false;
  for (let i = 0; i < full.length; i++) {
    if (/\s/.test(full[i])) {
      if (space) continue;
      normalized.push(" ");
      offsets.push(i);
      space = true;
    } else {
      normalized.push(full[i]);
      offsets.push(i);
      space = false;
    }
  }
  const at = normalized.join("").indexOf(want);
  if (at < 0) return null;
  const start = offsets[at],
    end = offsets[at + want.length - 1] + 1;
  const locate = (offset: number) => {
    for (const segment of nodes)
      if (
        offset >= segment.start &&
        offset <= segment.start + segment.text.length
      )
        return { node: segment.node, offset: offset - segment.start };
    return null;
  };
  const first = locate(start),
    last = locate(end);
  if (!first || !last) return null;
  const range = owner.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);
  return range;
}
/** Re-place or hide the open popover after the shown document changed. */
export const syncSelectionDraft = (): void => positionPopover();
export function reanchor(pane: CommentPane, id: string): void {
  positionPopover();
  const key = commentKey(pane._rs.agentId, id);
  const map = key ? comments.get(key) : null;
  if (!map) return;
  for (const comment of map.values()) {
    if (
      commentRoots(pane).some((root) =>
        root.querySelector(`mark[data-cid="${comment.cid}"]`),
      )
    )
      continue;
    const { box } = comment;
    if (box) {
      const frame = commentRoots(pane)
        .map((root) => boxFrame(root, box.page))
        .find(Boolean);
      if (frame) placeBox(frame, box).dataset.cid = comment.cid;
      continue;
    }
    for (const doc of commentRoots(pane)) {
      const range = findQuote(doc, comment.quote);
      if (range) {
        markRange(range, comment.cid);
        break;
      }
    }
  }
}
