// Message prose escapes HTML tokens, never raw input, to preserve Markdown.
// Artifact Markdown deliberately permits HTML; util.md sanitizes both paths.
// Token escaping prevents document elements such as title reaching the DOM.
import { Marked } from "marked";
import { mathExtension } from "../math.js";
import { strikethrough } from "./strikethrough.js";

const messages = new Marked({ gfm: true }, mathExtension, strikethrough, {
  renderer: {
    html: (text: string) =>
      text.replace(/[&<>"']/g, (char) => {
        const entities: Record<string, string> = {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        };
        return entities[char];
      }),
  },
});

export function parseMessageMarkdown(text: string): string {
  return messages.parse(text, { async: false }) as string;
}
