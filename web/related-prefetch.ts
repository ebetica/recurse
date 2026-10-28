// Plans capped warming only for changed parents/siblings/children. Work stays
// O(neighbours), not tree size: exclude selection/in-flight reads and cooldown
// hits; each poll issues only a few background requests.
import type { TreeNode } from "./types.js";

export const RELATED_LIMIT = 12;
export const PREFETCH_PER_POLL = 4;
export const PREFETCH_COOLDOWN_MS = 2000;

function updatedAt(node: TreeNode | undefined): number {
  return node?.updated || 0;
}

/** The selection's parent, then its siblings and children, freshest first. */
export function relatedIds(
  nodes: Record<string, TreeNode>,
  selectedId: string,
  limit = RELATED_LIMIT,
): string[] {
  const selected = nodes[selectedId];
  if (!selected) return [];
  const ordered: string[] = [];
  if (selected.parent && nodes[selected.parent]) ordered.push(selected.parent);
  const neighbours = Object.values(nodes).filter(
    (node) =>
      node.id !== selectedId &&
      node.id !== selected.parent &&
      (node.parent === selectedId || node.parent === selected.parent),
  );
  neighbours.sort((a, b) => updatedAt(b) - updatedAt(a));
  for (const node of neighbours) ordered.push(node.id);
  return ordered.slice(0, limit);
}

// The related agents to re-read after this tree poll: those whose server-side
// `updated` stamp moved (or that just appeared), minus the selection itself
// (the poll already refreshes it), anything already being fetched, and anything
// fetched within the cooldown. Capped so a busy subtree cannot fan out.
export function prefetchPlan(
  previousNodes: Record<string, TreeNode>,
  nextNodes: Record<string, TreeNode>,
  selectedId: string,
  inFlight: ReadonlySet<string>,
  lastFetched: Readonly<Record<string, number>>,
  now: number,
  perPoll = PREFETCH_PER_POLL,
): string[] {
  const plan: string[] = [];
  for (const id of relatedIds(nextNodes, selectedId)) {
    if (plan.length >= perPoll) break;
    if (id === selectedId || inFlight.has(id)) continue;
    const previous = previousNodes[id];
    if (previous && updatedAt(previous) === updatedAt(nextNodes[id])) continue;
    const fetchedAt = lastFetched[id];
    if (fetchedAt !== undefined && now - fetchedAt < PREFETCH_COOLDOWN_MS)
      continue;
    plan.push(id);
  }
  return plan;
}
