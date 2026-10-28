// Pure removal selection over a snapshot of visible navigation order. Explicit
// deletes and missing-tree recovery resolve against surviving ids so state
// changes never make navigation depend on stale DOM.
import type { TreeNode } from "./types.js";

export interface RemovalSelectionSnapshot {
  selectedId: string;
  order: string[];
  removedIds: string[];
}

export function descendantIds(
  nodes: Record<string, TreeNode>,
  root: string,
): string[] {
  const out = [root];
  const seen = new Set([root]);
  for (let i = 0; i < out.length; i++) {
    for (const n of Object.values(nodes)) {
      if (n.parent === out[i] && !seen.has(n.id)) {
        seen.add(n.id);
        out.push(n.id);
      }
    }
  }
  return out;
}

// A deleting ancestor hides its whole subtree in the sidebar, so a selected
// child must be treated as deleted too rather than waiting for missing-row
// grace. The tree snapshot is authoritative for this check; client tombstones
// are handled by the sidebar's optimistic-delete mask.
export function isDeletingTreeNode(
  nodes: readonly TreeNode[],
  id: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let node = byId.get(id);
  while (node && !seen.has(node.id)) {
    if (node.status === "deleting") return true;
    seen.add(node.id);
    node = node.parent ? byId.get(node.parent) : undefined;
  }
  return false;
}

// When a poll says the open agent vanished, find the highest missing ancestor.
// This identifies the removed subtree even when an API caller reaped an
// ancestor rather than the open row itself.
export function missingSubtreeRoot(
  nodes: Record<string, TreeNode>,
  selectedId: string,
  survivingIds: ReadonlySet<string>,
): string {
  let root = selectedId;
  let parent = nodes[root]?.parent;
  const seen = new Set([selectedId]);
  while (parent && !survivingIds.has(parent) && !seen.has(parent)) {
    root = parent;
    seen.add(root);
    parent = nodes[root]?.parent;
  }
  return root;
}

export function snapshotRemovalSelection(
  order: readonly string[],
  removedIds: string[],
  selectedId: string,
): RemovalSelectionSnapshot | null {
  if (!removedIds.includes(selectedId)) return null;
  return { selectedId, order: [...order], removedIds };
}

// Prefer the first still-present row after the whole removed subtree. At the
// end of the snapshot, walk backward to the nearest preceding row.
export function resolveRemovalSelection(
  snapshot: RemovalSelectionSnapshot,
  survivingIds: ReadonlySet<string>,
): string | null {
  const removed = new Set(snapshot.removedIds);
  const positions = snapshot.order
    .map((id, i) => (removed.has(id) ? i : -1))
    .filter((i) => i >= 0);
  const first = positions.length
    ? Math.min(...positions)
    : snapshot.order.indexOf(snapshot.selectedId);
  const last = positions.length ? Math.max(...positions) : first;

  for (let i = Math.max(0, last + 1); i < snapshot.order.length; i++) {
    const id = snapshot.order[i];
    if (!removed.has(id) && survivingIds.has(id)) return id;
  }
  for (let i = Math.min(first - 1, snapshot.order.length - 1); i >= 0; i--) {
    const id = snapshot.order[i];
    if (!removed.has(id) && survivingIds.has(id)) return id;
  }
  return survivingIds.values().next().value || null;
}

// Capture every ancestor before an optimistic delete removes the local branch.
// The first id is the immediate parent; later ids are bounded by the local
// tree.
export function ancestorIds(
  nodes: Record<string, TreeNode>,
  id: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let parent = nodes[id]?.parent;
  while (parent && !seen.has(parent)) {
    out.push(parent);
    seen.add(parent);
    parent = nodes[parent]?.parent;
  }
  return out;
}

// Explicit deletes prefer ordered siblings, then ancestors. A changed
// selection is a user decision and must win over the delete completion.
export function removalNeighbourIds(
  nodes: Record<string, TreeNode>,
  order: readonly string[],
  selectedId: string,
): string[] {
  const siblings = order.filter(
    (id) => nodes[id]?.parent === nodes[selectedId]?.parent,
  );
  const index = siblings.indexOf(selectedId);
  return [
    ...siblings.slice(index + 1),
    ...siblings.slice(0, index).reverse(),
    ...ancestorIds(nodes, selectedId),
  ];
}

// A newer explicit selection must not be replaced by deletion completion.
export function resolveConfirmedRemovalSelection(
  snapshotSelectedId: string | null,
  neighbourIds: readonly string[],
  currentSelectedId: string,
  survivingIds: ReadonlySet<string>,
): string | null {
  if (!snapshotSelectedId || snapshotSelectedId !== currentSelectedId)
    return null;
  for (const id of neighbourIds) if (survivingIds.has(id)) return id;
  return survivingIds.values().next().value || null;
}
