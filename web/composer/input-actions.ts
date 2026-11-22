// Edits and focuses the composer and keeps its controls steady during clicks.
import { $, inputEl, phoneComposerFocused } from "../dom.js";
import { currentUiOwnerId } from "../state.js";
import { resizeTextarea } from "./textarea.js";
import { restoreComposerValue } from "./view-state.js";

const composer = $("#composer")!;
const phoneLayout = matchMedia("(max-width: 700px)");
const expandedByInput = ":focus-within, :has(#input:not(:placeholder-shown))";
const finishPress = () => {
  if (composer.dataset.controlsPress) delete composer.dataset.controlsPress;
};
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
    // Keep the phone row steady until the click lands on its original target.
    if (!phoneLayout.matches) return;
    if (composer.matches(expandedByInput))
      composer.dataset.controlsPress = "open";
    else if (event.target instanceof Node && composer.contains(event.target))
      composer.dataset.controlsPress = "closed";
  },
  true,
);
window.addEventListener(
  "mouseup",
  (event) => {
    if (event.button === 0 && composer.dataset.controlsPress)
      requestAnimationFrame(finishPress);
  },
  true,
);
window.addEventListener("click", finishPress, true);
window.addEventListener("pointercancel", finishPress);
window.addEventListener("blur", finishPress);
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
