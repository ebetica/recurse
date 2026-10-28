// Pure helpers for the /revive finder (ui.ts "revive" mode): the
// server (GET /api/agent-archive) ranks and pages archived agents; this module
// only builds the request path and the finder rows.
import type { AgentMentionResult } from "../agent-finder.js";

export interface ArchivedAgentRow {
  archive_id: string;
  cid: string;
  reason: "reap" | "clear";
  title: string | null;
  parent: string | null;
  parent_title: string | null;
  top_level: boolean;
  archived: number;
  workdir: string | null;
}

export interface ArchivePage {
  agents: ArchivedAgentRow[];
  next_offset: number | null;
}

export const REVIVE_PAGE = 20;

export function archiveSearchPath(query: string, offset = 0): string {
  const params = new URLSearchParams({
    q: query.trim(),
    offset: String(offset),
    limit: String(REVIVE_PAGE),
  });
  return `/api/agent-archive?${params}`;
}

function ago(seconds: number): string {
  const minutes = Math.floor(Math.max(seconds, 0) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * One finder row: top-level agents in the first group; the badge says why
 * and when ("deleted 3d ago"); the second line says where it lived.
 */
export function reviveResult(
  row: ArchivedAgentRow,
  nowSeconds: number,
): AgentMentionResult {
  const title = (row.title ?? "").replace(/\s+/gu, " ").trim() || row.cid;
  const verb = row.reason === "clear" ? "cleared" : "deleted";
  const where = row.top_level
    ? "top-level"
    : `subagent of ${row.parent_title || row.parent || "?"}`;
  return {
    id: row.archive_id,
    title: row.reason === "clear" ? `${title} (before clear)` : title,
    group: row.top_level ? "related" : "other",
    relationship: `${verb} ${ago(nowSeconds - row.archived)}`,
    path: `${where} · ${row.cid}`,
    updated: row.archived,
    status: "idle",
    takenOver: false,
  };
}

/** The refusal sentence of a failed revive response body. */
export function reviveFailure(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  const message = (detail as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "Revive failed";
}
