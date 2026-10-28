// Pure decisions behind pane visibility, Pane-mode j/k switching, and the pane
// keyboard-focus ring. Kept DOM-free (like keyboard_context.ts) so panes.ts can
// apply them to real elements while the reducer logic stays unit-testable
// without a browser.

import type { PaneVisibility } from "../conversation-ui-state/schema.js";

export type PaneActivation =
  | { kind: "close"; id: string }
  | { kind: "open"; id: string }
  | null;

export function resolvePaneActivation(
  openIds: readonly string[],
  availableIds: readonly string[],
  preferredId?: string,
): PaneActivation {
  if (openIds.length > 0) return { kind: "close", id: openIds[0] };
  if (preferredId && availableIds.includes(preferredId))
    return { kind: "open", id: preferredId };
  if (availableIds.length > 0) return { kind: "open", id: availableIds[0] };
  return null;
}

// Preserve the remembered pane across explicit visibility changes.
export function paneVisibilityAfterUserAction(
  prior: PaneVisibility,
  id: string,
  opening: boolean,
  preserveLastId = false,
): PaneVisibility {
  const priorLast = prior.kind === "default" ? undefined : prior.lastId;
  return opening
    ? { kind: "open", id, lastId: preserveLastId && priorLast ? priorLast : id }
    : { kind: "closed", lastId: priorLast || id };
}

export function paneIsActionable(
  openIds: readonly string[],
  availableIds: readonly string[],
): boolean {
  return openIds.length > 0 || availableIds.length > 0;
}

// Cycles available panes in registration order, wrapping deterministically.
// Empty lists yield null; single/current-only choices are caller no-ops.
export function cyclePane(
  availableIds: readonly string[],
  currentId: string | null,
  delta: -1 | 1,
): string | null {
  if (availableIds.length === 0) return null;
  const index = currentId ? availableIds.indexOf(currentId) : -1;
  if (index < 0) return availableIds[delta > 0 ? 0 : availableIds.length - 1];
  const next = (index + delta + availableIds.length) % availableIds.length;
  return availableIds[next];
}

// The open pane that should carry the keyboard-focus indicator, given the pane
// column under the active element (null when focus is in the tree, composer, or
// anywhere outside an open pane). Returning null clears the ring.
export function paneFocusIndicatorId(
  focusedColumnId: string | null,
  openIds: readonly string[],
): string | null {
  return focusedColumnId && openIds.includes(focusedColumnId)
    ? focusedColumnId
    : null;
}
