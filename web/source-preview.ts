// Read-only source viewers paint text first, then share bounded, worker-only
// syntax tokens with Changes' highlighter. DOM construction never parses HTML;
// Existing marks, selections and pending comment drafts remain unchanged.
import { selectionCommentOwner } from "./comments/selection-draft/index.js";

export interface SourceToken {
  text: string;
  scopes: string[][];
}
interface Preview {
  text: string;
  name: string;
  request?: number;
  tokens?: SourceToken[];
  applied?: boolean;
}
const previews = new WeakMap<Element, Preview>();
const pending = new Map<Element, string>();
function resumePending(): void {
  for (const [element, name] of Array.from(pending)) {
    pending.delete(element);
    if (element.isConnected) highlightSource(element, name);
  }
}
document.addEventListener("selectionchange", resumePending);
document.addEventListener("click", resumePending);
type Reply = (tokens: SourceToken[] | undefined) => void;
// One shared worker; a crash or 5 s stall replaces it and fails pending work.
let worker: Worker | undefined;
let nextRequest = 0;
const replies = new Map<
  number,
  { reply: Reply; timer: ReturnType<typeof setTimeout> }
>();
function answer(id: number, tokens: SourceToken[] | undefined): void {
  const request = replies.get(id);
  if (!request) return;
  replies.delete(id);
  clearTimeout(request.timer);
  request.reply(tokens);
}
function restart(): void {
  worker?.terminate();
  worker = undefined;
  for (const id of replies.keys()) answer(id, undefined);
}
function cancel(id: number | undefined): void {
  if (id === undefined) return;
  clearTimeout(replies.get(id)?.timer);
  replies.delete(id);
}
function tokenize(text: string, name: string, reply: Reply): number {
  if (!worker) {
    worker = new Worker("/static/document-preview.worker.js", {
      type: "module",
    });
    worker.onerror = restart;
    worker.onmessage = (
      event: MessageEvent<{ id?: number; tokens?: SourceToken[] }>,
    ) => answer(event.data.id ?? -1, event.data.tokens);
  }
  const id = nextRequest++;
  replies.set(id, { reply, timer: setTimeout(restart, 5000) });
  worker.postMessage({ id, text, name });
  return id;
}
const MAX_CHARACTERS = 64 * 1024;
const MAX_LINES = 2000;

function decorate(element: Element, tokens: SourceToken[]): void {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let index = 0;
  let offset = 0;
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    let start = 0;
    while (start < node.length && index < tokens.length) {
      const token = tokens[index]!;
      const length = Math.min(node.length - start, token.text.length - offset);
      const text = node.data.slice(start, start + length);
      let parent: ParentNode = fragment;
      for (const classes of token.scopes) {
        const span = document.createElement("span");
        span.classList.add("source-token", ...classes);
        parent.append(span);
        parent = span;
      }
      parent.append(text);
      start += length;
      offset += length;
      if (offset === token.text.length) {
        index++;
        offset = 0;
      }
    }
    node.replaceWith(fragment);
  }
}

/** Add syntax without changing text, comment anchors or a native selection. */
export function highlightSource(element: Element, name: string): void {
  const text = element.textContent ?? "";
  let preview = previews.get(element);
  const selection = document.getSelection();
  if (
    selectionCommentOwner()?.contains(element) ||
    (selection &&
      !selection.isCollapsed &&
      selection.containsNode(element, true))
  ) {
    pending.set(element, name);
    return;
  }
  pending.delete(element);
  if (preview?.text === text && preview.name === name) {
    if (preview.applied || !preview.tokens) return;
    decorate(element, preview.tokens);
    element.setAttribute(
      "data-source-syntax",
      preview.tokens.some((token) => token.scopes.length)
        ? "highlighted"
        : "plain",
    );
    preview.applied = true;
    return;
  }
  cancel(preview?.request);
  for (const span of element.querySelectorAll(".source-token"))
    span.replaceWith(...span.childNodes);
  preview = { text, name };
  previews.set(element, preview);
  element.setAttribute("data-source-syntax", "plain");
  if (
    !text ||
    text.length > MAX_CHARACTERS ||
    text.split("\n").length > MAX_LINES
  )
    return;
  element.classList.add("source-syntax");
  if (!document.getElementById("source-preview-css")) {
    const stylesheet = document.createElement("link");
    stylesheet.id = "source-preview-css";
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/static/source-preview.css";
    document.head.append(stylesheet);
  }
  element.setAttribute("data-source-syntax", "loading");
  const current = preview;
  const finish = (tokens: SourceToken[] | undefined) => {
    current.request = undefined;
    if (previews.get(element) !== current) return;
    element.setAttribute("data-source-syntax", "plain");
    if (
      !element.isConnected ||
      !tokens?.length ||
      tokens.map((token) => token.text).join("") !== text
    )
      return;
    current.tokens = tokens;
    highlightSource(element, name);
  };
  current.request = tokenize(text, name, finish);
}
