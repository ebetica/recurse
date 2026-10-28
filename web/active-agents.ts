// Projects active-agent chips from the existing tree snapshot. Taken-over
// agents never count for parents, but traversal still reaches active
// descendants beneath them, matching backend overlay exclusion.
import type { TreeNode } from "./types.js";

const ACTIVE_STATUSES: ReadonlySet<TreeNode["status"]> = new Set([
  "running",
  "working",
  "waiting",
  "interrupting",
]);

export function isTakenOver(node: { pinned?: boolean | null }): boolean {
  return node.pinned === true;
}

export interface ActiveDescendant {
  node: TreeNode;
  depth: number;
}

// Lists active descendants depth-first, including beneath taken-over agents.
// Visited ids bound corrupt cycles; settled/unknown/deleting agents do not
// count.
export function activeDescendants(
  nodes: Readonly<Record<string, TreeNode>>,
  parentId: string,
): ActiveDescendant[] {
  const children = new Map<string, TreeNode[]>();
  for (const node of Object.values(nodes)) {
    if (node.parent == null || node.id === parentId) continue;
    const siblings = children.get(node.parent);
    if (siblings) siblings.push(node);
    else children.set(node.parent, [node]);
  }
  const found: ActiveDescendant[] = [];
  const seen = new Set<string>([parentId]);
  const visit = (id: string, depth: number) => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (!isTakenOver(child) && ACTIVE_STATUSES.has(child.status))
        found.push({ node: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(parentId, 1);
  return found;
}

export function activeDescendantCount(
  nodes: Readonly<Record<string, TreeNode>>,
  parentId: string,
): number {
  return activeDescendants(nodes, parentId).length;
}

export function activeAgentSummary(activeCount: number): string {
  if (activeCount <= 0) return "";
  return `${activeCount} active agent${activeCount === 1 ? "" : "s"}`;
}
