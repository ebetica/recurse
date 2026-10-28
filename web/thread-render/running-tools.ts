// Live-tool labels and server ages advance from each row's monotonic receipt.
import {
  containsSecret,
  oneLine,
} from "../../src/tool_projection/redaction.js";
import type { ViewBlock } from "../row-thread-state/view-blocks.js";

export const TOOL_LABEL_DELAY_MS = 3000;

export function runningTools(rows: readonly ViewBlock[], now: number) {
  return rows
    .filter((row) => row.kind === "tool_call" && row.running)
    .map((row) => ({
      row,
      elapsedMs: Number.isFinite(row.tool_elapsed_ms)
        ? row.tool_elapsed_ms! +
          Math.max(0, now - (row.tool_received_at_ms ?? now))
        : 0,
    }));
}

export function runningToolLabel(row: ViewBlock): string {
  const name = row.name?.toLowerCase();
  const command = oneLine(row.args).slice(0, 2000);
  const detail = row.input?.trim() || "";
  const target = containsSecret(detail) ? "" : detail;
  if (row.stat?.kind === "read" && target) return `Reading ${target}`;
  if (name === "bash" || name === "shell")
    return command && !containsSecret(command)
      ? `Running ${command}`
      : `Running ${target.replace(/^Run\s+/i, "") || "command"}`;
  const verb = {
    read: "Reading",
    edit: "Editing",
    write: "Writing",
    wait: "Waiting",
    grep: "Searching",
    multi_grep: "Searching",
    find: "Finding",
    chdir: "Opening",
  }[name || ""];
  return verb ? `${verb}${target ? ` ${target}` : ""}` : "Using tool";
}

export function runningToolsLabel(tools: { row: ViewBlock }[]): string {
  if (tools.length === 1) return runningToolLabel(tools[0]!.row);
  return tools.every(({ row }) => row.name === "bash" || row.name === "shell")
    ? `Running ${tools.length} commands`
    : `Running ${tools.length} tools`;
}
