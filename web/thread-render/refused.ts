// A refused reply's reason and Resend button; the caller owns composer actions.
// This template has no orchestration dependency. Durable omits refused turns
// from later model requests (src/agents/durable/refusals.ts).
import { html, nothing, type TemplateResult } from "lit";
import type { MessageEntry } from "../types.js";

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

export function refusedNoteT(
  entry: MessageEntry,
  full: string,
  resendText: (text: string) => void,
): TemplateResult {
  const text = entry.refused_text?.replace(/^\[recurse-origin: [^\]]*\]\n/, "");
  return html`<div
    class="error-note refused-note"
    data-theme-protected="reply-refusal"
    role="note"
    title=${full}
  >
    <span>${sentence(entry.error || "The provider refused this turn")}</span>
    ${text
      ? html`<button
          class="btn sm refused-resend"
          type="button"
          @click=${() => resendText(text)}
        >
          Resend
        </button>`
      : nothing}
  </div>`;
}
