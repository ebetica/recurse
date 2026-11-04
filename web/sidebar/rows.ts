// Experimental, stateless sidebar rows: API v1 Agents plus cheap cached tree
// fields. The browser and server dry run use the same projection.
import { agent } from "../../src/web/api_v1/agent.js";
import type { Agent } from "../../src/web/api_v1/schema.js";

export interface Tag {
  at: number;
  by: string;
  until?: number;
}
export type Tags = Record<string, Tag>;

export interface SidebarRow extends Agent {
  busy: boolean;
  children: number;
  remote: boolean;
  model: string | null;
  effort: number | null;
  preview: string;
  error: boolean;
  prs: {
    number: number;
    state: string;
    checks: string | null;
    merged: boolean;
  }[];
  branch?: string;
  cwd?: string;
  operator_message_at: number | null;
  replied_at: number | null;
  idle_for: number;
  rank: number;
  depth: number;
  tags: Tags;
}

export interface RowSource {
  id: string;
  parent?: string | null;
  side_of?: string | null;
  title: string;
  status: string;
  agent?: Agent;
  taken_over?: boolean;
  pinned?: boolean;
  queued: number;
  children: number;
  model?: string | null;
  effort?: number | null;
  preview?: string;
  error?: boolean;
  prs?: SidebarRow["prs"];
  branch?: string;
  cwd?: string;
  updated: number;
  operator_message_at?: number | null;
  replied_at?: number | null;
  tags?: unknown;
}

const BUSY = new Set(["running", "working", "waiting", "interrupting"]);

/** Tags whose `until` has not passed at `now`. */
export function liveTags(tags: unknown, now: number): Tags {
  const live: Tags = {};
  if (!tags || typeof tags !== "object") return live;
  for (const [name, tag] of Object.entries(tags as Record<string, Tag>))
    if (tag && typeof tag.at === "number" && !(tag.until! <= now))
      live[name] = { ...tag };
  return live;
}

/** A tree row as the script sees it; `rank` is its place in activity order. */
export function sidebarRow(
  node: RowSource,
  rank: number,
  now: number,
  tags: unknown = node.tags,
  depth = 0,
): SidebarRow {
  const busy = BUSY.has(node.status);
  return {
    ...(node.agent ?? agent({ ...node }, [], 0)),
    id: node.id,
    parent: node.parent ?? null,
    busy,
    children: node.children,
    remote: node.id.includes("/"),
    model: node.model ?? null,
    effort: node.effort ?? null,
    preview: node.preview ?? "",
    error: node.error ?? false,
    prs: node.prs?.map((pr) => ({ ...pr })) ?? [],
    ...(node.branch !== undefined && { branch: node.branch }),
    ...(node.cwd !== undefined && { cwd: node.cwd }),
    operator_message_at: node.operator_message_at ?? null,
    replied_at: node.replied_at ?? null,
    idle_for: busy ? 0 : Math.max(0, now - node.updated),
    rank,
    depth,
    tags: liveTags(tags, now),
  };
}

/** All conversations, with memoized ancestry depths and cycle protection. */
export function sidebarRows(
  nodes: RowSource[],
  now: number,
  tags: (node: RowSource) => unknown = (node) => node.tags,
): SidebarRow[] {
  nodes = nodes.filter((node) => !node.side_of);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const depth = (node: RowSource): number => {
    if (depths.has(node.id)) return depths.get(node.id)!;
    const path: RowSource[] = [];
    const seen = new Set<string>();
    let current: RowSource | undefined = node;
    while (current && !depths.has(current.id) && !seen.has(current.id)) {
      path.push(current);
      seen.add(current.id);
      current = byId.get(current.parent ?? "");
    }
    let value = current ? (depths.get(current.id) ?? -1) : -1;
    for (const item of path.reverse()) depths.set(item.id, ++value);
    return depths.get(node.id)!;
  };
  return nodes.map((node, rank) =>
    sidebarRow(node, rank, now, tags(node), depth(node)),
  );
}
