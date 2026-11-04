// Experimental sidebar API: documented, but may change without migration.
// API v1 Agent fields retain their contract; other fields are experimental.
// Pure, stateless sidebar(rows, now) receives detached backend snapshots.
// Usage and side conversations are omitted. See README.md.
import type { Agent } from "../../src/web/api_v1/schema.js";
import type { ScriptSection } from "./arrangement.js";

export interface SidebarRow extends Agent {
  /** API v1 Agent: conversation id. */
  id: string;
  /** API v1 Agent: parent id, or null for a root. */
  parent: string | null;
  /** API v1 Agent: conversation title. */
  title: string;
  /** API v1 Agent: own state, without descendant overlays. */
  status: Agent["status"];
  /** API v1 Agent: bounded state explanation, or null. */
  status_reason: string | null;
  /** API v1 Agent: queued message count. */
  queued: number;
  /** API v1 Agent: live background shell count. */
  background_shells: number;
  /** API v1 Agent: live monitor shell count. */
  monitor_shells: number;
  /** API v1 Agent: operator take-over marker. */
  taken_over: boolean;
  /** API v1 Agent: absent here; side conversations stay in the Side pane. */
  side_of?: string;
  /** API v1 Agent: configured initial directory, not the current chdir. */
  workdir: string | null;
  /** API v1 Agent: last activity in epoch seconds. */
  updated: number;

  /** Experimental: active state, including working/waiting descendants. */
  busy: boolean;
  /** Experimental: ancestry depth; roots are 0. */
  depth: number;
  /** Experimental: direct child count, excluding side conversations. */
  children: number;
  /** Experimental: true for qualified remote conversation ids. */
  remote: boolean;
  /** Experimental: selected model id, or null. */
  model: string | null;
  /** Experimental: configured effort level, or null for an off-ladder model. */
  effort: number | null;
  /** Experimental: bounded latest-message or state preview. */
  preview: string;
  /** Experimental: whether the last stored turn failed. */
  error: boolean;
  /** Experimental: own stored PR links, without additional GitHub reads. */
  prs: {
    number: number;
    state: string;
    checks: string | null;
    merged: boolean;
  }[];
  /** Experimental: recorded branch, only when already available. */
  branch?: string;
  /** Experimental: recorded directory, only when already available. */
  cwd?: string;
  /** API v1 Agent: latest operator message in epoch seconds, or null. */
  operator_message_at: number | null;
  /** API v1 Agent: latest finished turn in epoch seconds, or null. */
  replied_at: number | null;
  /** Experimental: seconds since updated, or 0 while busy. */
  idle_for: number;
  /** Experimental: frozen activity order, 0 first. */
  rank: number;
  /** API v1 Agent: live tags; epoch seconds at/until, author by. */
  tags: Record<string, { at: number; by: string; until?: number }>;
}

/** now is epoch seconds; the built-in script selects only depth-0 roots. */
export default function sidebar(
  rows: readonly SidebarRow[],
  now: number,
): ScriptSection[];
