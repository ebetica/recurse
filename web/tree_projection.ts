import type { TreeNode } from "./types.js";

export type TreeRelationship =
  | "current"
  | "ancestor"
  | "parent"
  | "sibling"
  | "child";

export interface ProjectedTreeEntry {
  node: TreeNode;
  depth: number;
  relationship: TreeRelationship;
  hasChildren: boolean;
  collapsed: boolean;
}

export type TreeHAction = "collapse" | "ascend";
export function resolveHAction(
  cursorId: string,
  anchorId: string,
  anchorHasChildren: boolean,
  anchorCollapsed: boolean,
): TreeHAction {
  if (cursorId === anchorId && anchorHasChildren && !anchorCollapsed)
    return "collapse";
  return "ascend";
}

export type TreeLAction = "expand" | "open";
export function resolveLAction(
  cursorId: string,
  anchorId: string,
  anchorCollapsed: boolean,
): TreeLAction {
  if (cursorId === anchorId && anchorCollapsed) return "expand";
  return "open";
}

export interface ForestProjectionOptions {
  collapsed?: ReadonlySet<string>;
  /** The first visual depth whose descendants fold by default. */
  autoCollapseDepth?: number;
  maxDepth?: number;
  maxRows?: number;
}

const DEFAULT_AUTO_COLLAPSE_DEPTH = 0;
const DEFAULT_MAX_DEPTH = 256;
const DEFAULT_MAX_ROWS = 10_000;

// Projects all nodes into a bounded forest, folding deep branches except the
// selected lineage. Missing parents/cycle components become roots;
// emitted/depth/row guards keep malformed snapshots finite.
export function projectAgentForest(
  nodes: readonly TreeNode[],
  selectedId = "",
  options: ForestProjectionOptions = {},
): ProjectedTreeEntry[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    if (!node.parent || !byId.has(node.parent)) continue;
    const siblings = children.get(node.parent) || [];
    siblings.push(node);
    children.set(node.parent, siblings);
  }

  const manuallyCollapsed = options.collapsed || new Set<string>();
  const autoCollapseDepth = Math.max(
    0,
    options.autoCollapseDepth ?? DEFAULT_AUTO_COLLAPSE_DEPTH,
  );
  const maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);
  const out: ProjectedTreeEntry[] = [];
  const emitted = new Set<string>();
  const hiddenRoots = new Set<string>();

  // Invariant: Expand the selected node and every real ancestor of it; this is
  // the only automatic exception to default folding. A malformed cycle is
  // bounded by `seen`.
  const selectedLineage = new Set<string>();
  let lineageId = selectedId;
  while (lineageId && !selectedLineage.has(lineageId)) {
    selectedLineage.add(lineageId);
    lineageId = byId.get(lineageId)?.parent || "";
  }

  const visit = (node: TreeNode, depth: number): void => {
    if (out.length >= maxRows || emitted.has(node.id)) return;
    emitted.add(node.id);
    const nodeChildren = children.get(node.id) || [];
    const hasChildren = nodeChildren.length > 0;
    const capped = hasChildren && depth >= maxDepth;
    const autoCollapsed =
      hasChildren &&
      depth >= autoCollapseDepth &&
      !selectedLineage.has(node.id);
    const collapsed =
      hasChildren &&
      (manuallyCollapsed.has(node.id) || autoCollapsed || capped);
    const relationship: TreeRelationship =
      node.id === selectedId ? "current" : depth === 0 ? "ancestor" : "child";
    out.push({ node, depth, relationship, hasChildren, collapsed });
    if (collapsed) {
      for (const child of nodeChildren) hiddenRoots.add(child.id);
      return;
    }

    for (const child of nodeChildren) visit(child, depth + 1);
  };

  // Invariant: A missing parent is treated like a root. This keeps an orphan
  // visible while the backend repairs the edge and also makes the projection
  // useful during a partial tree refresh.
  const roots = nodes.filter((node) => !node.parent || !byId.has(node.parent));
  for (const root of roots) visit(root, 0);
  // Invariant: A cycle has no root by definition; emit each unvisited component
  // as a synthetic root. `emitted` prevents revisiting the cycle edge forever.
  for (const node of nodes) {
    let parent = node.parent;
    const seen = new Set<string>();
    let hiddenByCap = false;
    while (parent && !seen.has(parent)) {
      if (hiddenRoots.has(parent)) {
        hiddenByCap = true;
        break;
      }
      seen.add(parent);
      parent = byId.get(parent)?.parent || null;
    }
    if (!hiddenRoots.has(node.id) && !hiddenByCap) visit(node, 0);
  }
  return out;
}

export function centeredRowScrollTop(
  listTop: number,
  listHeight: number,
  currentScrollTop: number,
  rowTop: number,
  rowHeight: number,
): number {
  const rowCentre = rowTop - listTop + currentScrollTop + rowHeight / 2;
  return Math.max(0, rowCentre - listHeight / 2);
}

export function nearestRowScrollTop(
  listTop: number,
  listHeight: number,
  currentScrollTop: number,
  rowTop: number,
  rowHeight: number,
): number {
  const topDelta = rowTop - listTop;
  const bottomDelta = rowTop + rowHeight - (listTop + listHeight);
  let delta = 0;
  if (rowHeight > listHeight) {
    if (topDelta < 0 && bottomDelta > 0) delta = 0;
    else if (bottomDelta > 0) delta = topDelta;
    else if (topDelta < 0) delta = bottomDelta;
  } else if (topDelta < 0) delta = topDelta;
  else if (bottomDelta > 0) delta = bottomDelta;
  return Math.max(0, currentScrollTop + delta);
}

export interface SelectedRowRevealState {
  pendingId: string | null;
}

export interface SelectedRowRevealResult {
  state: SelectedRowRevealState;
  revealId: string | null;
}

export function requestSelectedRowReveal(id: string): SelectedRowRevealState {
  return { pendingId: id || null };
}

export function resolveSelectedRowReveal(
  state: SelectedRowRevealState,
  visibleIds: readonly string[],
): SelectedRowRevealResult {
  if (!state.pendingId || !visibleIds.includes(state.pendingId))
    return { state, revealId: null };
  return { state: { pendingId: null }, revealId: state.pendingId };
}

interface RevealBounds {
  top: number;
  height: number;
}
interface RevealViewport {
  scrollTop: number;
  clientHeight: number;
  getBoundingClientRect(): RevealBounds;
}
interface RevealRow {
  getBoundingClientRect(): RevealBounds;
}

export function applySelectedRowReveal(
  state: SelectedRowRevealState,
  visibleIds: readonly string[],
  viewport: RevealViewport,
  findRow: (id: string) => RevealRow | null,
): SelectedRowRevealState {
  const reveal = resolveSelectedRowReveal(state, visibleIds);
  if (!reveal.revealId) return reveal.state;
  const row = findRow(reveal.revealId);
  if (!row) return state;
  const listRect = viewport.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  viewport.scrollTop = centeredRowScrollTop(
    listRect.top,
    viewport.clientHeight,
    viewport.scrollTop,
    rowRect.top,
    rowRect.height,
  );
  return reveal.state;
}
