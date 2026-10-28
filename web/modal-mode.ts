// Typed seam for feature-owned overlays (currently the shared agent finder) to
// enter/leave a central keyboard mode without adding another global dispatcher.
import type { KeyboardMode } from "./keymap.js";

export type KeyboardModeSetter = (mode: KeyboardMode) => void;

let setter: KeyboardModeSetter | null = null;

export function installKeyboardModeController(
  next: KeyboardModeSetter,
): () => void {
  setter = next;
  return () => {
    if (setter === next) setter = null;
  };
}

export function requestKeyboardMode(mode: KeyboardMode): boolean {
  if (!setter) return false;
  setter(mode);
  return true;
}
