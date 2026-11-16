// Async copy feedback is imperative because code-copy buttons live inside
// sanitized markdown. Track the initiating control and render scope so delayed
// writes and older timers cannot update a reused control. Prompt controls share
// a template while retaining their existing labelled or text-only feedback.
import { html, type TemplateResult } from "lit";
import { copyText } from "../tool_details.js";

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

export interface CopyFeedbackAttempt {
  control: object;
  scope: string;
  token: symbol;
}

const active = new WeakMap<object, symbol>();

export function beginCopyFeedback(
  control: object,
  scope: string,
): CopyFeedbackAttempt {
  const attempt = { control, scope, token: Symbol() };
  active.set(control, attempt.token);
  return attempt;
}

export function invalidateCopyFeedback(control: object): void {
  active.delete(control);
}

export function messageCopyScope(
  conversationId: string,
  generation: number,
  index: number,
  identity: string,
): string {
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const fingerprint = `${identity.length.toString(36)}:${(hash >>> 0).toString(36)}`;
  return `${conversationId}:${generation}:${index}:${fingerprint}`;
}

export function copyFeedbackIsCurrent(
  attempt: CopyFeedbackAttempt,
  connected: boolean,
  renderedScope: string | undefined,
): boolean {
  return (
    connected &&
    renderedScope === attempt.scope &&
    active.get(attempt.control) === attempt.token
  );
}
