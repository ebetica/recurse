import type { AgentTreeStatus, TreeNode } from "./types.js";

export const UI_REFRESH_EVENT = "recurse:ui-refresh";
export const ARTIFACTS_REFRESH_EVENT = "recurse:artifacts-refresh";
export const UI_STATUS_EVENT = "recurse:ui-status";

const ACTIVE_TURN_STATUSES: ReadonlySet<AgentTreeStatus> = new Set([
  "running",
  "interrupting",
]);

// Detects only worktree-quiescent transitions.
export function turnJustSettled(
  previous: AgentTreeStatus | undefined,
  current: AgentTreeStatus | undefined,
): boolean {
  return (
    previous !== undefined &&
    current !== undefined &&
    ACTIVE_TURN_STATUSES.has(previous) &&
    !ACTIVE_TURN_STATUSES.has(current)
  );
}

// Detects observed settle or changed quiescent stamps between polls.
// Own running/interrupting polls stay cache-only; descendant-projected working
// still refreshes on updated-stamp changes. Rename/queue changes may trigger
// one harmless extra refresh.
export function treeMutationNeedsUiRefresh(
  previous: TreeNode | undefined,
  current: TreeNode,
): boolean {
  if (!previous) return false;
  if (turnJustSettled(previous.status, current.status)) return true;
  return (
    !ACTIVE_TURN_STATUSES.has(current.status) &&
    previous.updated !== current.updated
  );
}

// Refreshes optional UI snapshots after a real mutation.
export function requestUiRefresh(agentId: string): void {
  window.dispatchEvent(
    new CustomEvent(UI_REFRESH_EVENT, {
      detail: { agentId },
    }),
  );
}

/** Refresh Artifacts without implying that the worktree is quiescent. */
export function requestArtifactsRefresh(agentId: string): void {
  window.dispatchEvent(
    new CustomEvent(ARTIFACTS_REFRESH_EVENT, { detail: { agentId } }),
  );
}

export function requestUiStatus(message: string): void {
  window.dispatchEvent(
    new CustomEvent(UI_STATUS_EVENT, {
      detail: { message },
    }),
  );
}
