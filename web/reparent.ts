// Pure re-parent (move) validity for the sidebar drag gesture. Kept DOM-free so
// the invariants (no self, no cycle into a descendant) are tested
// directly. The backend re-validates on apply, so this is for immediate UI
// feedback and highlighting, not authority.
import type { TreeNode } from "./types.js";
import { descendantIds } from "./selection.js";

type ReparentReason =
  | "ok"
  | "noop"
  | "missing-source"
  | "missing-target"
  | "self"
  | "descendant";

export function reparentValidity(
  nodes: Record<string, TreeNode>,
  sourceId: string,
  targetId: string | null,
): ReparentReason {
  if (!sourceId || !nodes[sourceId]) return "missing-source";
  if (targetId === null) return nodes[sourceId].parent === null ? "noop" : "ok";
  if (!targetId || !nodes[targetId]) return "missing-target";
  if (targetId === sourceId) return "self";
  if (descendantIds(nodes, sourceId).includes(targetId)) return "descendant";
  if (nodes[sourceId].parent === targetId) return "noop";
  return "ok";
}

// Whether a drop should be accepted at all (a no-op counts: releasing on the
// current parent quietly does nothing rather than reporting an error).
export function canDrop(
  nodes: Record<string, TreeNode>,
  sourceId: string,
  targetId: string | null,
): boolean {
  const reason = reparentValidity(nodes, sourceId, targetId);
  return reason === "ok" || reason === "noop";
}
