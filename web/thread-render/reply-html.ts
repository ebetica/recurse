// Reply Markdown sanitization and image policy, shared with Changes and live
// chunks. One cache bounds both entries and retained key/HTML characters;
// math bypasses it because lazy KaTeX availability changes the output.
import {
  backendFor,
  homeBackend,
  resolveContentLink,
} from "../backends/backend.js";
import { state } from "../state.js";
import { messageMarkdownFragment } from "../util.js";
import { renderMathPlaceholders } from "../math.js";
import { renderReferenceImages } from "../image-preview/inline.js";
import { linkPrReferences } from "../pr-references.js";
import { linkFilePaths } from "../file-path-links.js";
import { COPY_ICON, PANE_EXPAND_ICON as EXPAND_ICON } from "../icons.js";

const renderedHtml = new Map<string, string>();
const MAX_RENDERED_HTML = 1024;
const MAX_RENDERED_HTML_CHARACTERS = 8 * 1024 * 1024;
const MAX_RENDERED_HTML_ENTRY_CHARACTERS = MAX_RENDERED_HTML_CHARACTERS / 4;
let renderedHtmlCharacters = 0;
const renderingBackend = () =>
  state.currentConv ? backendFor(state.currentConv.id) : homeBackend;
// Display names for common fence languages; other fences show as written.
const LANGUAGE_NAMES: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  py: "Python",
  python: "Python",
  rs: "Rust",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  text: "Text",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  txt: "Text",
  typescript: "TypeScript",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Zsh",
};
// Code header bar; the language comes from a serialized attribute, so escape <>.
const codeHead = (lang: string | undefined) =>
  `<div class="code-head"><span class="code-lang">${
    (lang && Object.hasOwn(LANGUAGE_NAMES, lang.toLowerCase())
      ? LANGUAGE_NAMES[lang.toLowerCase()]
      : lang
    )
      ?.replace(/</g, "&lt;")
      .replace(/>/g, "&gt;") ?? "Text"
  }</span>` +
  `<button class="icon-btn copy-btn" type="button" aria-label="Copy code" title="Copy code">${COPY_ICON}</button>` +
  `<button class="icon-btn code-expand-btn" type="button" aria-label="Expand code" title="Expand code">${EXPAND_ICON}</button></div>`;

// Classifies sanitized images in an inert template before any can fetch.
// Local paths use authenticated previews; web images need an explicit click.
function applyImagePolicy(
  fragment: DocumentFragment,
  base: string | null | undefined,
  footer: boolean,
): string {
  const backend = renderingBackend();
  const tpl = document.createElement("template");
  tpl.content.append(fragment);
  // Invariant: Strip all non-img fetch elements and resource attributes/CSS
  // before inserting the fragment. Only vetted img[src] may fetch; DOMPurify's
  // safe-HTML profile alone does not block these browser resource surfaces.
  for (const el of tpl.content.querySelectorAll(
    "svg, math, source, video, audio, track, iframe, frame, embed, object, link, style, image",
  ))
    el.remove();
  for (const el of tpl.content.querySelectorAll("*")) {
    for (const attr of [
      "srcset",
      "poster",
      "background",
      "ping",
      "style",
      "lowsrc",
      "dynsrc",
      "data-external-image",
      "data-image-alt",
      "data-path-image",
      "data-image-path",
    ]) {
      el.removeAttribute(attr);
    }
    if (el.tagName !== "IMG") el.removeAttribute("src");
  }
  renderReferenceImages(tpl.content, state.currentConv?.id ?? null, backend);
  if (state.currentConv) linkFilePaths(tpl.content, state.currentConv.id);
  if (backend.label) {
    for (const anchor of tpl.content.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href")!;
      try {
        if (
          href.startsWith("/") ||
          new URL(href, location.href).origin === location.origin
        )
          anchor.setAttribute("href", resolveContentLink(backend, href));
      } catch {
        anchor.removeAttribute("href");
      }
    }
  }
  if (base !== undefined) linkPrReferences(tpl.content, base);
  renderMathPlaceholders(tpl.content);
  if (footer) footerTail(tpl.content);
  return tpl.innerHTML;
}
/** Agent Markdown as inert HTML under the reply image policy. */
export function safeMarkdown(
  markdown: string,
  base?: string | null,
  footer = false,
): string {
  const key = JSON.stringify([
    state.currentConv?.id ?? null,
    renderingBackend().label,
    base === undefined ? false : base,
    footer,
    markdown,
  ]);
  let html = renderedHtml.get(key);
  if (html !== undefined) {
    renderedHtml.delete(key);
    renderedHtml.set(key, html);
    return html;
  }
  const fragment = messageMarkdownFragment(markdown);
  const math = fragment.querySelector("[data-math-placeholder]") !== null;
  html = applyImagePolicy(fragment, base, footer);
  const characters = key.length + html.length;
  if (!math && characters <= MAX_RENDERED_HTML_ENTRY_CHARACTERS) {
    while (
      renderedHtml.size >= MAX_RENDERED_HTML ||
      renderedHtmlCharacters + characters > MAX_RENDERED_HTML_CHARACTERS
    ) {
      const oldest = renderedHtml.keys().next().value!;
      renderedHtmlCharacters -=
        oldest.length + renderedHtml.get(oldest)!.length;
      renderedHtml.delete(oldest);
    }
    renderedHtml.set(key, html);
    renderedHtmlCharacters += characters;
  }
  return html;
}
export function enrich(
  text: string,
  base?: string | null,
  footer = false,
): string {
  return safeMarkdown(text, base, footer)
    .replace(
      /<pre>(?=(?:<code class="(?:[^"]*\s)?language-([^"\s]+))?)/g,
      (_, lang: string | undefined) =>
        `<div class="code-wrap">${codeHead(lang)}<pre>`,
    )
    .replace(/<\/pre>/g, `</pre></div>`);
}
/** Keep the final word with a width-only footer at normal leading. */
function footerTail(fragment: DocumentFragment): void {
  const end = fragment.lastElementChild;
  const block = end?.matches("p")
    ? end
    : end?.matches("ul, ol")
      ? end.lastElementChild
      : null;
  if (!block) return;
  const walker = document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  let tail: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) {
      if (
        node.textContent?.trim() &&
        !node.parentElement?.closest(".thread-image")
      )
        tail = node as Text;
    } else if ((node as Element).matches("img, br, hr")) tail = null;
  }
  const match = tail?.data.match(/\S+\s*$/);
  if (!tail || !match || tail.parentElement?.closest("pre, table")) return;
  const word =
    tail.parentElement?.closest("code") ?? tail.splitText(match.index!);
  const span = document.createElement("span");
  span.className = "turn-tail";
  word.replaceWith(span);
  span.append(word);
}
