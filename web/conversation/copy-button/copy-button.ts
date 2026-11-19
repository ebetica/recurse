// Prompt and compacted-summary controls share a copy template, retaining their
// labelled or text-only feedback. Clipboard writes happen only on click.
import { html, type TemplateResult } from "lit";
import { copyText } from "../../tool_details.js";

export function copyButtonT(
  text: string,
  label: string,
  copiedLabel?: string,
): TemplateResult {
  const copy = async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const copied = await copyText(text);
    button.textContent = copied ? "Copied" : "Copy failed";
    if (copiedLabel) {
      button.classList.toggle("copied", copied);
      button.setAttribute(
        "aria-label",
        copied ? `${copiedLabel} copied` : `Couldn't copy ${label}`,
      );
    }
    setTimeout(() => {
      if (copiedLabel || button.isConnected) button.textContent = "Copy";
      if (copiedLabel) {
        button.classList.remove("copied");
        button.setAttribute("aria-label", `Copy ${label}`);
      }
    }, 1200);
  };
  return html`<button
    class="prompt-copy"
    type="button"
    aria-live="polite"
    aria-label=${`Copy ${label}`}
    @click=${copy}
  >
    Copy
  </button>`;
}
