// Agent-tree focus refreshes the current rows before targeting the cursor.
// Pane exits share the phone menu fallback. The app supplies list rendering
// during startup, keeping focus callers independent of the sidebar root.
import { listEl } from "../dom.js";
import { state } from "../state.js";

export let renderAgentList: () => void;
export function configureAgentFocus(render: () => void): void {
  renderAgentList = render;
}

export let restoringMovedListControl: HTMLElement | null = null;
export function restoreMovedListControl(control: HTMLElement): void {
  restoringMovedListControl = control;
  try {
    control.focus({ preventScroll: true });
  } finally {
    restoringMovedListControl = null;
  }
}

export function focusAgentTree(): boolean {
  renderAgentList();
  const row = listEl.querySelector<HTMLElement>(
    `.agent[data-id="${CSS.escape(state.cursorId)}"]`,
  );
  row?.focus();
  return !!row && document.activeElement === row;
}

export function restoreAgentFocus(): boolean {
  if (focusAgentTree()) return true;
  if (!matchMedia("(max-width: 700px)").matches) return false;
  const menu = document.getElementById("menu-btn");
  menu?.focus();
  return document.activeElement === menu;
}
