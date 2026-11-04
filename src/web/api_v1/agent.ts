// Shared API v1 Agent projection for agent reads and sidebar snapshots.
import type { Agent } from "./schema";
import { liveTags } from "../../agents/conversation_tags";

export function agentStatus(raw: unknown): Agent["status"] {
  return raw === "interrupting"
    ? "stopping"
    : raw === "waiting"
      ? "idle"
      : raw === "idle" ||
          raw === "running" ||
          raw === "interrupted" ||
          raw === "error" ||
          raw === "deleting"
        ? raw
        : "unknown";
}

export function agent(
  row: Readonly<Record<string, unknown>>,
  shells: readonly { mode: string }[],
  queued: number,
): Agent {
  return {
    id: String(row.id),
    parent: typeof row.parent === "string" ? row.parent : null,
    title: String(row.title),
    status: agentStatus(row.status),
    status_reason:
      typeof row.status_reason === "string" ? row.status_reason : null,
    queued: (typeof row.queued === "number" ? row.queued : 0) + queued,
    background_shells: shells.filter((s) => s.mode === "background").length,
    monitor_shells: shells.filter((s) => s.mode === "monitor").length,
    taken_over: row.taken_over === true,
    ...(typeof row.side_of === "string" ? { side_of: row.side_of } : {}),
    workdir: typeof row.workdir === "string" ? row.workdir : null,
    updated: typeof row.updated === "number" ? row.updated : 0,
    tags: liveTags(row.tags, Date.now() / 1000),
    operator_message_at:
      typeof row.operator_message_at === "number"
        ? row.operator_message_at
        : null,
    replied_at: typeof row.replied_at === "number" ? row.replied_at : null,
  };
}
