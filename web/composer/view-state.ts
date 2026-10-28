// Session-tier composer drafts survive tab reloads, never cross-tab retention.
// Navigation snapshots before selection changes; polls never restore text.
// Restoration neither dispatches input nor moves focus.
import { inputEl } from "../dom.js";
import { conversationUiState } from "../conversation-ui-state/store.js";
import type { ComposerViewState } from "../conversation-ui-state/schema.js";
import { ComposerViewStateController } from "./view-state-model.js";

const controller = new ComposerViewStateController(
  conversationUiState,
  inputEl,
  "",
);

function announceRestore(ownerId: string): void {
  document.dispatchEvent(
    new CustomEvent("recurse:composer-state-restored", {
      detail: { ownerId },
    }),
  );
}

export function noteComposerInput(ownerId: string): void {
  controller.noteInput(ownerId);
}

export function composerHasVolatileWork(): boolean {
  return controller.hasVolatileWork();
}

export function snapshotComposerOwner(ownerId: string): void {
  controller.snapshot(ownerId);
}

export function switchComposerOwner(
  ownerId: string,
  dropPrevious = false,
): void {
  const changed = ownerId !== controller.owner();
  controller.switchTo(ownerId, dropPrevious);
  if (changed) announceRestore(ownerId);
}

export function promoteComposerOwner(ownerId: string): void {
  const changed = ownerId !== controller.owner();
  controller.promoteTo(ownerId);
  if (changed) announceRestore(ownerId);
}

export function clearComposerOwner(ownerId: string): void {
  controller.clear(ownerId);
}

export function restoreComposerValue(
  ownerId: string,
  value: ComposerViewState,
): void {
  controller.put(ownerId, value);
  if (ownerId === controller.owner()) announceRestore(ownerId);
}
