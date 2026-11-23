// Edits and focuses the composer while keeping the phone caret on control taps.
import { $, inputEl, phoneComposerFocused } from "../dom.js";
import { currentUiOwnerId } from "../state.js";
import { resizeTextarea } from "./textarea.js";
import { restoreComposerValue } from "./view-state.js";

window.addEventListener(
  "mousedown",
  (event) => {
    if (event.button !== 0) return;
    // Cancel the mouse focus default, not the touch gesture or its click.
    const target = event.target;
    if (
      phoneComposerFocused() &&
      target instanceof Element &&
      target.closest("#composer-wrap button, #model-menu")
    )
      event.preventDefault();
  },
  true,
);
$("#conv-controls")?.addEventListener("mousedown", (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    !(event.target instanceof Element)
  )
    return;
  const button = event.target.closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  // Keep focus in the row on browsers that don't focus clicked buttons.
  event.preventDefault();
  button.focus({ preventScroll: true });
});

interface RecoveryOwner {
  owner: string | null;
  uiStateId: string;
}
export let pendingSavedRecovery: RecoveryOwner | null = null;

export function setPendingSavedRecovery(owner: RecoveryOwner | null): void {
  pendingSavedRecovery = owner;
}

export function activeComposerOwnerId(): string {
  return pendingSavedRecovery?.uiStateId ?? currentUiOwnerId();
}

export function autosize(): void {
  resizeTextarea(inputEl);
}

// Focus Insert mode without disturbing a draft. A keyboard entry always places
// the caret at the end, while an already-focused composer keeps its selection.
export function focusComposerAtEnd(): boolean {
  if (
    !inputEl.getClientRects().length ||
    getComputedStyle(inputEl).visibility === "hidden" ||
    inputEl.closest(".dock-parking")
  ) {
    const show = new CustomEvent("recurse:show-chat", {
      cancelable: true,
      detail: () => focusComposerAtEnd(),
    });
    dispatchEvent(show);
    if (show.defaultPrevented) return true;
  }
  if (inputEl.disabled || inputEl.readOnly || !inputEl.isConnected)
    return false;
  const alreadyFocused = document.activeElement === inputEl;
  inputEl.focus();
  if (document.activeElement !== inputEl) return false;
  if (!alreadyFocused) {
    const end = inputEl.value.length;
    inputEl.setSelectionRange(end, end);
  }
  return true;
}

/** Put a refused message's text back in the composer, after any draft. */
export function resendText(text: string): void {
  const draft = inputEl.value.trimEnd();
  const value = draft ? `${draft}\n\n${text}` : text;
  restoreComposerValue(activeComposerOwnerId(), {
    text: value,
    selectionStart: value.length,
    selectionEnd: value.length,
  });
  autosize();
  focusComposerAtEnd();
}
