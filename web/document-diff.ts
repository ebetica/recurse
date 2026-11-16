// Marks what is new in a rendered Markdown document since an earlier version,
// wrapping new words of the sanitised render in <ins> and flagging new blocks;
// removed text is never shown. Changed blocks pair with a similar old block at
// their level (so moves stay unmarked), then refine by item, cell and word.
import { diffArrays } from "diff";

const CONTAINERS = new Set([
  "UL",
  "OL",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "BLOCKQUOTE",
]);
const NESTED = "ul, ol, table, pre, blockquote";
const ATOMS =
  ".artifact-image-frame, .artifact-blocked-image, button, img, iframe, .katex, [data-math-placeholder], svg";
const WORD = /[\p{L}\p{N}_'’]+|\s+|[^\s\p{L}\p{N}_'’]/gu;
const PAIR_SIMILARITY = 0.45;
const ADDED = "doc-diff-added";

/** Original image sources by element, recorded before URL attributes go. */
export const diffKeys = new WeakMap<Element, string>();

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Image and embed sources, or a math formula not yet typeset. */
const mediaKey = (element: Element) =>
  diffKeys.get(element) ??
  element.getAttribute("data-math-placeholder") ??
  undefined;

function blockKey(element: Element): string {
  const own = mediaKey(element);
  if (own !== undefined) return own;
  const media = [...element.querySelectorAll("*")]
    .map(mediaKey)
    .filter((key) => key !== undefined)
    .join(" ");
  return `${element.tagName}|${squash(element.textContent || "")}|${media}`;
}

function similarity(a: Element, b: Element): number {
  const words = (element: Element) =>
    (
      squash(element.textContent || "")
        .toLowerCase()
        .match(WORD) ?? []
    ).filter((word) => word !== " ");
  const left = words(a);
  const right = words(b);
  if (!left.length && !right.length) return 1;
  let same = 0;
  for (const change of diffArrays(left, right))
    if (!change.added && !change.removed) same += change.count;
  return (2 * same) / (left.length + right.length);
}

/** Lists and tables pair when they share at least one similar row or item. */
function sharesChild(old: Element, current: Element): boolean {
  const before = [...old.querySelectorAll("li, tr, p")];
  const after = [...current.querySelectorAll("li, tr, p")];
  const keys = new Set(before.map(blockKey));
  if (after.some((item) => keys.has(blockKey(item)))) return true;
  if (before.length * after.length > 2500) return false;
  return before.some((left) =>
    after.some((right) => similarity(left, right) >= PAIR_SIMILARITY),
  );
}

function pairable(old: Element, current: Element): boolean {
  if (old.tagName !== current.tagName) return false;
  if (CONTAINERS.has(current.tagName)) return sharesChild(old, current);
  return similarity(old, current) >= PAIR_SIMILARITY;
}

interface Token {
  key: string;
  node: Text | Element;
  start: number;
  end: number;
}

function tokens(root: Element): Token[] {
  const list: Token[] = [];
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child instanceof Text) {
        for (const match of child.data.matchAll(WORD))
          list.push({
            key: /^\s+$/.test(match[0]) ? " " : match[0],
            node: child,
            start: match.index,
            end: match.index + match[0].length,
          });
      } else if (child instanceof Element) {
        if (child.parentNode === root && child.matches(NESTED)) continue;
        if (child.matches(ATOMS))
          list.push({
            key: `\0${blockKey(child)}`,
            node: child,
            start: 0,
            end: 0,
          });
        else walk(child);
      }
    }
  };
  walk(root);
  return list;
}

/** Wrap each run of new tokens in an <ins> marker. */
function wrap(added: Token[]): void {
  const byNode = new Map<Text | Element, Token[]>();
  for (const token of added) {
    const list = byNode.get(token.node) ?? [];
    list.push(token);
    byNode.set(token.node, list);
  }
  for (const [node, list] of byNode) {
    const ins = () => {
      const element = document.createElement("ins");
      element.className = ADDED;
      return element;
    };
    if (!(node instanceof Text)) {
      const element = ins();
      node.replaceWith(element);
      element.append(node);
      continue;
    }
    const fragment = document.createDocumentFragment();
    let position = 0;
    let open: HTMLElement | null = null;
    for (const token of list) {
      if (token.start > position) {
        fragment.append(node.data.slice(position, token.start));
        open = null;
      }
      if (!open) fragment.append((open = ins()));
      open.append(node.data.slice(token.start, token.end));
      position = token.end;
    }
    if (position < node.data.length) fragment.append(node.data.slice(position));
    node.replaceWith(fragment);
  }
}

function markAdded(element: Element): void {
  element.classList.add(ADDED);
}

function children(
  oldParent: Element | DocumentFragment,
  newParent: Element | DocumentFragment,
): void {
  const olds = [...oldParent.children];
  const news = [...newParent.children];
  const removed: Element[] = [];
  const added: Element[] = [];
  let oi = 0;
  let ni = 0;
  for (const change of diffArrays(olds.map(blockKey), news.map(blockKey))) {
    if (change.removed) removed.push(...olds.slice(oi, (oi += change.count)));
    else if (change.added) added.push(...news.slice(ni, (ni += change.count)));
    else {
      oi += change.count;
      ni += change.count;
    }
  }
  for (const current of added) {
    const key = blockKey(current);
    let at = removed.findIndex((old) => blockKey(old) === key);
    if (at < 0) at = removed.findIndex((old) => pairable(old, current));
    if (at < 0) markAdded(current);
    else refine(removed.splice(at, 1)[0]!, current);
  }
}

function refine(old: Element, current: Element): void {
  if (CONTAINERS.has(current.tagName)) return children(old, current);
  if (current.tagName === "TR") {
    const before = [...old.children];
    const after = [...current.children];
    if (before.length !== after.length) return markAdded(current);
    after.forEach((cell, index) => words(before[index]!, cell));
    return;
  }
  words(old, current);
  const nested = (element: Element) =>
    [...element.children].filter((child) => child.matches(NESTED));
  const before = nested(old);
  nested(current).forEach((child, index) => {
    const prior = before[index];
    if (prior?.tagName === child.tagName) refine(prior, child);
    else markAdded(child);
  });
}

function words(old: Element, current: Element): void {
  const after = tokens(current);
  const changes = diffArrays(tokens(old), after, {
    comparator: (left, right) => left.key === right.key,
  });
  const added: Token[] = [];
  let index = 0;
  changes.forEach((change, at) => {
    if (change.removed) return;
    const run = after.slice(index, (index += change.count));
    // Spec: A lone shared word between edits reads as part of the new phrase.
    const lone =
      !change.added &&
      at > 0 &&
      at < changes.length - 1 &&
      (changes[at - 1]!.added || changes[at + 1]!.added) &&
      run.filter((token) => token.key !== " ").length <= 1;
    if ((change.added || lone) && run.some((token) => token.key !== " "))
      added.push(...run);
  });
  wrap(added);
}

/** Mark what in `current` is new since `old`. */
export function markDocumentChanges(
  old: DocumentFragment,
  current: DocumentFragment,
): void {
  children(old, current);
}

/** Remove the markers, leaving the plain document and any comment marks. */
export function clearDocumentChanges(root: Element): void {
  for (const ins of root.querySelectorAll(`ins.${ADDED}`))
    ins.replaceWith(...ins.childNodes);
  for (const element of root.querySelectorAll(`.${ADDED}`))
    element.classList.remove(ADDED);
}
