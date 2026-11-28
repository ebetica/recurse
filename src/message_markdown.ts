// Message prose escapes HTML tokens, never raw input, to preserve Markdown.
// Reply previews and local image checks read the same rendered Markdown.
import { Marked } from "marked";
import { escapedHtml, mathExtension } from "./markdown_math.js";
import { strikethrough } from "./markdown_strikethrough.js";

const messages = new Marked({ gfm: true }, mathExtension, strikethrough, {
  renderer: { html: escapedHtml },
});

export function parseMessageMarkdown(text: string): string {
  return messages.parse(text, { async: false }) as string;
}
