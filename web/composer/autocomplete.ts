// One ARIA/key-ownership seam for every composer popup. Slash skills and @agent
// references stay independent features, while the textarea exposes only the
// currently visible listbox and global/modal Escape can close the top layer.
import { inputEl } from "../dom.js";

interface PopupOwner {
  id: string;
  close: () => void;
  ownsKey: (key: string, shiftKey: boolean) => boolean;
}

let owner: PopupOwner | null = null;

export function showComposerAutocomplete(
  id: string,
  close: () => void,
  ownsKey: (key: string, shiftKey: boolean) => boolean,
  activeDescendant?: string,
): void {
  if (owner && owner.id !== id) owner.close();
  owner = { id, close, ownsKey };
  inputEl.setAttribute("aria-expanded", "true");
  inputEl.setAttribute("aria-controls", id);
  if (activeDescendant)
    inputEl.setAttribute("aria-activedescendant", activeDescendant);
  else inputEl.removeAttribute("aria-activedescendant");
}

export function updateComposerAutocomplete(
  id: string,
  activeDescendant?: string,
): void {
  if (owner?.id !== id) return;
  if (activeDescendant)
    inputEl.setAttribute("aria-activedescendant", activeDescendant);
  else inputEl.removeAttribute("aria-activedescendant");
}

export function hideComposerAutocomplete(id: string): void {
  if (owner?.id !== id) return;
  owner = null;
  inputEl.setAttribute("aria-expanded", "false");
  inputEl.removeAttribute("aria-controls");
  inputEl.removeAttribute("aria-activedescendant");
}

export function composerAutocompleteIs(id: string): boolean {
  return owner?.id === id;
}
export function composerAutocompleteOpen(): boolean {
  return owner !== null;
}

export function composerAutocompleteOwnsKey(
  key: string,
  shiftKey: boolean,
): boolean {
  return !!owner?.ownsKey(key, shiftKey);
}

export function closeComposerAutocomplete(): boolean {
  const current = owner;
  if (!current) return false;
  current.close();
  return true;
}
