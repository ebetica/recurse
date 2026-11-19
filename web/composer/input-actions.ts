// Edits and focuses the current composer without loading send jobs.
import { inputEl } from "../dom.js";
import { currentUiOwnerId } from "../state.js";
import { resizeTextarea } from "./textarea.js";
import { restoreComposerValue } from "./view-state.js";

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
