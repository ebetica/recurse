// A refused reply's note: the reason, and Resend, which puts the operator's
// text, with its upload links, back in the composer. Durable leaves the
// refused turn out of later model requests (src/agents/durable/refusals.ts).
import { html, nothing, type TemplateResult } from "lit";
import { resendText } from "../composer.js";
import type { MessageEntry } from "../types.js";

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

export function refusedNoteT(
  entry: MessageEntry,
  full: string,
): TemplateResult {
  const text = entry.refused_text?.replace(/^\[recurse-origin: [^\]]*\]\n/, "");
  return html`<div class="error-note refused-note" role="note" title=${full}>
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
