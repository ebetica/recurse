// URL-only view filter; authentication and server access stay unchanged.
import { readTreeLink } from "./deep-link.js";
import type { TreeNode } from "./types.js";

export const sharedTrees = readTreeLink(location.hash);

/** Keeps only named top-level trees and their descendants, in wire order. */
export function sharedTreeNodes(nodes: TreeNode[]): TreeNode[] {
  if (sharedTrees === null) return nodes;
  const children = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    const parent = node.parent || node.side_of;
    if (!parent) continue;
    const list = children.get(parent) || [];
    list.push(node);
    children.set(parent, list);
  }
  const allowed = new Set<string>();
  const pending = nodes.filter(
    (node) => !node.parent && !node.side_of && sharedTrees.includes(node.id),
  );
  while (pending.length) {
    const node = pending.pop()!;
    if (allowed.has(node.id)) continue;
    allowed.add(node.id);
    pending.push(...(children.get(node.id) || []));
  }
  return nodes.filter((node) => allowed.has(node.id));
}

/** Restart changed filters without retaining another tree's caches. */
export function reloadChangedTreeLink(): boolean {
  if (
    JSON.stringify(readTreeLink(location.hash)) === JSON.stringify(sharedTrees)
  )
    return false;
  location.reload();
  return true;
}
