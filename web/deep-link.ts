// Names agents in #agent fragments: same-page, proxy/base-path-independent.
// Fragments never reach HTTP and remain separate from generation query keys.
// sidebar.ts wires history; conversation.ts chooses the boot view.

import { parseConversationId } from "./backends/backend.js";

export const AGENT_LINK_KEY = "agent";
export const TREE_LINK_KEY = "trees";

// Bounds id shape before DOM/path use; callers decide whether ids may open.
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Rejects oversized fragments before parsing; they are not recognized links.
const MAX_FRAGMENT_LENGTH = 512;
const MAX_SHARED_FRAGMENT_LENGTH = 8192;

function fragmentTooLong(raw: string): boolean {
  return (
    raw.length >
    (raw.startsWith("trees=")
      ? MAX_SHARED_FRAGMENT_LENGTH
      : MAX_FRAGMENT_LENGTH)
  );
}

function validAgentId(id: string): boolean {
  try {
    const { label, cid } = parseConversationId(id);
    return label !== "." && label !== ".." && AGENT_ID.test(cid);
  } catch {
    return false;
  }
}

/** Shared links filter the signed-in view; they grant no access. */
export function readTreeLink(hash: string): string[] | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const value = params.get(TREE_LINK_KEY);
  if (value === null) return null;
  if (hash.length > MAX_SHARED_FRAGMENT_LENGTH) return [];
  return [...new Set(value.split(",").filter(validAgentId))];
}

/** Builds a tree-only link without unrelated conversation or artifact state. */
export function treeLinkUrl(href: string, roots: string[]): string {
  const url = new URL(href);
  url.hash = "trees=" + roots.filter(validAgentId).join(",");
  return url.href;
}

export interface AgentLinkRead {
  /** Whether the fragment carries an `agent` parameter at all. */
  present: boolean;
  /** The valid id it carries, or null when absent or rejected. */
  id: string | null;
}

export function readArtifactLink(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw || fragmentTooLong(raw)) return null;
  const id = new URLSearchParams(raw).get("artifact");
  return id && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id) ? id : null;
}

export function readAgentLink(hash: string): AgentLinkRead {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw || fragmentTooLong(raw)) return { present: false, id: null };
  const value = new URLSearchParams(raw).get(AGENT_LINK_KEY);
  if (value === null) return { present: false, id: null };
  return { present: true, id: validAgentId(value) ? value : null };
}

// Builds the agent URL while preserving origin, path and search.
export function agentLinkUrl(
  href: string,
  agent: string,
  keepArtifact = true,
): string {
  const url = new URL(href);
  const params = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );
  if (!keepArtifact) params.delete("artifact");
  if (agent && validAgentId(agent)) params.set(AGENT_LINK_KEY, agent);
  else params.delete(AGENT_LINK_KEY);
  const fragment = params.toString();
  url.hash = fragment ? "#" + fragment : "";
  return url.href;
}

export interface HistoryView {
  agent: string;
  draft: boolean;
}

// Reads explicit app history state or browser-created link entries.
// Unreadable/rejected entries safely resolve to the default view.
export function readHistoryView(
  entryState: unknown,
  hash: string,
): HistoryView {
  const stamped = (entryState as { recurseView?: unknown } | null | undefined)
    ?.recurseView;
  if (stamped && typeof stamped === "object") {
    const { agent, draft } = stamped as { agent?: unknown; draft?: unknown };
    if (typeof agent === "string" && validAgentId(agent))
      return { agent, draft: draft === true };
  }
  return { agent: readAgentLink(hash).id || "", draft: false };
}

// Distinguishes chosen navigation from app corrections of the current entry.
// Boot restore, history replay and removal recovery never add phantom Back
// steps.
export function historyDisposition(
  entry: HistoryView,
  next: HistoryView,
  correcting: boolean,
): "push" | "replace" {
  if (correcting) return "replace";
  return entry.agent === next.agent && entry.draft === next.draft
    ? "replace"
    : "push";
}

export interface BootSelection {
  /** The agent to open, or null to stay on the default view. */
  select: string | null;
  /** The link named an agent this reader cannot be shown. */
  unavailable: boolean;
}

// Cold-load links outrank saved selection. Invalid/unavailable links fall back
// only to the default, never unrelated remembered conversations.
export function resolveBootSelection(
  link: AgentLinkRead,
  remembered: string | null,
  exists: (id: string) => boolean,
  fallback: string | null = null,
): BootSelection {
  if (link.present) {
    if (!link.id || !exists(link.id))
      return { select: fallback, unavailable: true };
    return { select: link.id, unavailable: false };
  }
  const last = remembered && exists(remembered) ? remembered : null;
  return { select: last || fallback, unavailable: false };
}
