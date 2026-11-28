// Rendering + formatting helpers shared across the message pane, sidebar, and
// composer. `marked` and `DOMPurify` are bundled from npm (pinned in bun.lock),
// not pulled from a CDN — the whole app ships as one hash-locked bundle.
// Markdown tables share a scroll wrapper; long columns wrap at a readable minimum.
import { marked } from "marked";
import DOMPurify from "dompurify";
import { mathExtension } from "../src/markdown_math.js";
import { PERSON_ICON } from "./icons.js";
import "./icons.js";
import { parseMessageMarkdown } from "../src/message_markdown.js";
import { strikethrough } from "../src/markdown_strikethrough.js";

marked.setOptions({ gfm: true });
marked.use(mathExtension, strikethrough);
function wrapMarkdownTables(fragment: DocumentFragment): void {
  for (const table of fragment.querySelectorAll("table")) {
    const longColumns = new Set<number>();
    let hasSpans = false;
    for (const row of table.rows)
      for (const cell of row.cells) {
        hasSpans ||= cell.colSpan !== 1 || cell.rowSpan !== 1;
        // Roughly one 12em line of average-width text, without measuring layout.
        if ((cell.textContent ?? "").trim().length > 24) {
          longColumns.add(cell.cellIndex);
          cell.classList.add("table-wrap-text");
        }
      }
    // Spanning raw HTML cells don't have a stable column index.
    if (!hasSpans && longColumns.size)
      for (const row of table.rows)
        for (const cell of row.cells)
          if (longColumns.has(cell.cellIndex))
            cell.classList.add("table-wrap-text");
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    table.before(wrapper);
    wrapper.append(table);
  }
}
const MARKDOWN_URI_POLICY = {
  ALLOWED_URI_REGEXP: /^(?!(?:javascript|vbscript|data):)/i,
};

/** Navigation schemes survive; script/data links stay inert and labelled. */
function sanitizedMarkdownFragment(
  t: string,
  message: boolean,
): DocumentFragment {
  const html = message
    ? parseMessageMarkdown(t || "")
    : (marked.parse(t || "", { async: false }) as string);
  const fragment = DOMPurify.sanitize(html, {
    ...MARKDOWN_URI_POLICY,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const removed of DOMPurify.removed) {
    if (
      "attribute" in removed &&
      removed.attribute?.name === "href" &&
      removed.attribute.value.trim() &&
      removed.from instanceof HTMLAnchorElement &&
      fragment.contains(removed.from)
    ) {
      removed.from.classList.add("artifact-blocked-link");
      const label = document.createElement("span");
      label.className = "artifact-link-host";
      label.textContent = " (link blocked)";
      removed.from.after(label);
    }
  }
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.getAttribute("href") || ""))
      continue;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
  }
  wrapMarkdownTables(fragment);
  return fragment;
}
export const documentMarkdownFragment = (t: string): DocumentFragment =>
  sanitizedMarkdownFragment(t, false);
/** Keep the sanitizer's inert parsed tree for reply policy. */
export const messageMarkdownFragment = (t: string): DocumentFragment =>
  sanitizedMarkdownFragment(t, true);

// "3 👤" markup for a subagent count; "" when there are none.
export const kidsBadge = (n: number): string =>
  n > 0 ? `${n} ${PERSON_ICON}` : "";

export function relTime(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
