// Pure state for the shared composer action. Any composer payload stays in Send
// mode; otherwise a running conversation takes two activations to confirm Stop.
export type StopActivation = "click" | "keyboard";
export type StopMode = "turn" | "processes";
export type ComposerControlIntent =
  | "none"
  | "send"
  | "prepare-stop"
  | "arm-stop"
  | "stop";

export interface ComposerControlState {
  hasPayload: boolean;
  sendable: boolean;
  stopAvailable: boolean;
  stopTargetId: string | null;
  armedTargetId: string | null;
}

export const initialComposerControlState = (): ComposerControlState => ({
  hasPayload: false,
  sendable: false,
  stopAvailable: false,
  stopTargetId: null,
  armedTargetId: null,
});

export function updateComposerControl(
  state: ComposerControlState,
  update: Partial<
    Pick<
      ComposerControlState,
      "hasPayload" | "sendable" | "stopAvailable" | "stopTargetId"
    >
  >,
): ComposerControlState {
  const next = { ...state, ...update };
  if (
    next.hasPayload ||
    !next.stopAvailable ||
    next.stopTargetId !== state.stopTargetId
  ) {
    next.armedTargetId = null;
  }
  return next;
}

export function activateComposerControlState(state: ComposerControlState): {
  state: ComposerControlState;
  intent: ComposerControlIntent;
} {
  if (state.hasPayload) {
    return {
      state: { ...state, armedTargetId: null },
      intent: state.sendable ? "send" : "none",
    };
  }
  if (!state.stopAvailable) return { state, intent: "none" };
  const id = state.stopTargetId;
  if (!id) return { state, intent: "prepare-stop" };
  if (state.armedTargetId === id) {
    return {
      state: { ...state, armedTargetId: null },
      intent: "stop",
    };
  }
  return {
    state: { ...state, armedTargetId: id },
    intent: "arm-stop",
  };
}

export interface StopProcessesCandidate {
  status?: string | null;
  active_run?: string | null;
  shells?: { active_count?: number | null } | null;
}

/** Idle with live shells: Stop would kill owned processes, not a turn. */
export function canStopProcesses(
  conv: StopProcessesCandidate | null | undefined,
): boolean {
  if (!conv || conv.status === "running" || conv.active_run) return false;
  return (conv.shells?.active_count ?? 0) > 0;
}

/** Stable arm target for an idle processes Stop (no run to key on). */
export function processesStopTargetId(cid: string): string {
  return `${cid}:processes`;
}

/** Composer Stop labels; turn strings are frozen by existing tests. */
export function stopControlLabel(
  mode: StopMode,
  armed: boolean,
  preparing: boolean,
  failed = false,
): string {
  if (mode === "processes")
    return armed ? "Confirm stop processes" : "Stop processes";
  if (armed) return "Confirm stop this agent";
  if (preparing) return "Finding this turn to stop";
  // Invariant: An unacknowledged stop settled retryable: the next activation
  // re-issues it with the same idempotency key, so the label says so.
  if (failed) return "Stop again";
  return "Stop this agent";
}
