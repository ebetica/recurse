// Canonical presentation for an agent's backend state. Keep every visible,
// tooltip, and assistive-technology label on this one path so a state change
// cannot leave the colored marker saying one thing and its text saying another.
import type { TreeNode } from "./types.js";

export type AgentStateKey =
  | "idle"
  | "running"
  | "working"
  | "waiting"
  | "taken-over"
  | "queued"
  | "interrupting"
  | "interrupted"
  | "error"
  | "deleting"
  | "unknown";

export interface AgentStatePresentation {
  key: AgentStateKey;
  label: string;
  description: string;
}

export const RESTART_PARKED_DESCRIPTION = "Interrupted by a server restart";
export const RESTART_PARKED_STATUS = "interrupted by a server restart";

const STATES: Record<
  Exclude<AgentStateKey, "queued">,
  Omit<AgentStatePresentation, "key">
> = {
  idle: {
    label: "Idle",
    description: "Idle",
  },
  running: {
    label: "Running",
    description: "Running this agent's current turn",
  },
  working: {
    label: "Working",
    description: "Working in this agent's subtree",
  },
  waiting: {
    label: "Waiting",
    description: "Waiting on background work",
  },
  "taken-over": {
    label: "Taken over",
    description: "Taken over by the operator",
  },
  interrupting: {
    label: "Interrupting",
    description: "Interrupting the current turn",
  },
  interrupted: {
    label: "Interrupted",
    description: "Interrupted: the previous turn was stopped",
  },
  error: {
    label: "Error",
    description: "Error on the previous turn",
  },
  deleting: {
    label: "Deleting",
    description: "Deleting this agent",
  },
  unknown: {
    label: "Unknown",
    description: "Unknown agent state",
  },
};

const KNOWN = new Set(Object.keys(STATES));

// Presents canonical status, safely visible for malformed/legacy values.
// Takeover changes only the idle ring; running/settled states and errors remain
// visible with the operator-hold tag beside them.
export function presentAgentState(
  status: TreeNode["status"],
  restartParked?: boolean,
  takenOver = false,
  stopPending = false,
): AgentStatePresentation {
  let key =
    typeof status === "string" && KNOWN.has(status)
      ? (status as Exclude<AgentStateKey, "queued" | "taken-over">)
      : "unknown";
  if (stopPending && (key === "running" || key === "interrupting"))
    key = "interrupting";
  if (takenOver && key === "idle")
    return { key: "taken-over", ...STATES["taken-over"] };
  let state = { key, ...STATES[key] };
  // Invariant: Same interrupted state, different cause: the server restarted
  // under it. Keep this neutral because active turns resume automatically while
  // idle parks wait for an explicit resume or a later message.
  if (key === "interrupted" && restartParked) {
    state = { ...state, description: RESTART_PARKED_DESCRIPTION };
  }
  if (!takenOver) return state;
  return {
    ...state,
    label: `${state.label} · Taken over`,
    description: `${state.description}, taken over by the operator`,
  };
}

export function queuedLabel(count: number): string {
  return String(count);
}

export function queuedDescription(count: number): string {
  return `${count} queued message${count === 1 ? "" : "s"}`;
}
