// Rendering + formatting helpers shared across the message pane, sidebar, and
// composer. `marked` and `DOMPurify` are bundled from npm (pinned in bun.lock),
// not pulled from a CDN — the whole app ships as one hash-locked bundle.
import { marked } from "marked";
import DOMPurify from "dompurify";
import { mathExtension } from "./math.js";
import { PERSON_ICON } from "./icons.js";
export { PERSON_ICON } from "./icons.js";
import { parseMessageMarkdown } from "./util/message-markdown.js";
import { strikethrough } from "./util/strikethrough.js";

marked.setOptions({ gfm: true });
marked.use(mathExtension, strikethrough);
function markdownHtml(t: string, message: boolean): string {
  const html = message
    ? parseMessageMarkdown(t || "")
    : (marked.parse(t || "", { async: false }) as string);
  return html.replace(
    /(<table\b[\s\S]*?<\/table>)/gi,
    '<div class="table-scroll">$1</div>',
  );
}
export const md = (t: string, message = false): string =>
  DOMPurify.sanitize(markdownHtml(t, message));
/** Keep the sanitizer's inert parsed tree for reply policy. */
export const messageMarkdownFragment = (t: string): DocumentFragment =>
  DOMPurify.sanitize(markdownHtml(t, true), { RETURN_DOM_FRAGMENT: true });

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

// compact interval label from seconds: "30m", "2h", "1d", else "45s"
export function fmtEvery(secs: number | null | undefined): string {
  secs = Math.round(secs || 0);
  for (const [u, d] of [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ] as const)
    if (secs >= d && secs % d === 0) return secs / d + u;
  return secs + "s";
}
