// Paints the composer's turn border and Stop control from the focused read
// and the browser's in-flight Stop request.
import { setComposerStopAvailability } from "../composer/index.js";
import { $ } from "../dom.js";
import { DRAFT, state } from "../state.js";
import {
  type StopMode,
  canStopProcesses,
  processesStopTargetId,
} from "../stop-control.js";
import type { Conversation } from "../types.js";
import { focusedRead, phaseFor } from "./freshness.js";

const composerCard = $("#composer-card");

export function selectedCanStop(conv?: Conversation | null): boolean {
  if (conv?.id === state.selectedId)
    return Boolean(conv.active_run) || conv.status === "running";
  return ["running", "interrupting"].includes(
    state.nodes[state.selectedId]?.status || "",
  );
}

export function paintComposerRunState(
  conv?: Conversation | null,
  eligible = true,
): void {
  const posting = state.stopPostInFlightId === state.selectedId;
  composerCard?.toggleAttribute(
    "data-turn-running",
    eligible &&
      conv?.id === state.selectedId &&
      conv.status === "running" &&
      !posting,
  );
  const authoritative =
    focusedRead.stopReadAuthoritativeId === state.selectedId &&
    phaseFor(focusedRead.freshness, state.selectedId) === "fresh";
  const processes =
    canStopProcesses(conv) && !selectedCanStop(conv) && !posting;
  const visible =
    eligible &&
    authoritative &&
    state.selectedId !== DRAFT &&
    (selectedCanStop(conv) || posting || processes);
  const mode: StopMode = processes ? "processes" : "turn";
  const run = conv?.id === state.selectedId ? conv.active_run : null;
  const target = !visible
    ? null
    : mode === "processes"
      ? processesStopTargetId(state.selectedId)
      : run
        ? `${state.selectedId}:${run}`
        : null;
  setComposerStopAvailability(
    visible,
    target,
    posting || conv?.status === "interrupting" ? "stopping" : "ready",
    mode,
  );
}
