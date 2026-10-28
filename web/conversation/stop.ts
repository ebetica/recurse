// Stop control and dispatch. The browser owns only the POST-in-flight paint;
// authoritative running, interrupting, and idle state always comes from /view.
import { backendFor } from "../backends/backend.js";
import { setComposerStopAvailability } from "../composer/action.js";
import { phaseFor } from "./freshness.js";
import { inputEl } from "../dom.js";
import { DRAFT, state } from "../state.js";
import {
  type StopActivation,
  type StopMode,
  canStopProcesses,
  processesStopTargetId,
} from "../stop-control.js";
import { createStopId, reportStopIdFallback } from "../stop-control/id.js";
import { reportStopDiagnostic } from "../stop-control/telemetry.js";
import { type Conversation } from "../types.js";
import { requestUiStatus } from "../ui-events.js";
import { freshness, stopReadAuthoritativeId } from "./chrome.js";
import { refreshConv } from "./fetch.js";
import { paint } from "./thread.js";

// POST-flight Stop feedback; only the next /view is durable status authority.
export let stoppingId: string | null = null;

export function stopPublicationPending(): boolean {
  return stoppingId !== null;
}

export function clearStopForNewTurn(cid: string): void {
  if (stoppingId === cid) stoppingId = null;
  if (state.pendingStops[cid]) setStopPending(cid, false);
}

function setStopPending(cid: string, pending: boolean): void {
  if (pending) state.pendingStops[cid] = true;
  else delete state.pendingStops[cid];
  window.dispatchEvent(new Event("recurse:stop-pending"));
}

export function selectedCanStop(conv?: Conversation | null): boolean {
  if (conv?.id === state.selectedId)
    return Boolean(conv.active_run) || conv.status === "running";
  return ["running", "interrupting"].includes(
    state.nodes[state.selectedId]?.status || "",
  );
}

export function paintStopControl(
  conv?: Conversation | null,
  eligible = true,
): void {
  const posting = stoppingId === state.selectedId;
  const authoritative =
    stopReadAuthoritativeId === state.selectedId &&
    phaseFor(freshness, state.selectedId) === "fresh";
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

// Confirmation re-reads the authoritative Stop snapshot so a tokenless
// replacement is scoped to the run that exists at confirmation time.
async function currentRun(cid: string): Promise<string | null> {
  await refreshConv(null, "stop");
  const conv = state.currentConv;
  return conv?.id === cid ? conv.active_run || null : null;
}

// Composer arming still resolves the exact run before the confirming click.
export async function prepareStopTarget(): Promise<string | null> {
  const cid = state.selectedId;
  const run = await currentRun(cid);
  return state.selectedId === cid && run ? `${cid}:${run}` : null;
}

export async function requestStop(
  input: StopActivation = "keyboard",
): Promise<void> {
  const cid = state.selectedId;
  let conv = state.currentConv;
  reportStopDiagnostic("dispatch_started", { conversationId: cid, input });
  if (conv?.id === cid && !conv.active_run && conv.status !== "running") {
    if (canStopProcesses(conv)) {
      await requestIdleProcessStop(cid, input);
      return;
    }
    requestUiStatus("Already finished");
    return;
  }
  if (stoppingId === cid) return;
  const run = await currentRun(cid);
  if (!run || state.selectedId !== cid) {
    requestUiStatus("Already finished");
    return;
  }
  conv = state.currentConv;
  const generated = createStopId();
  if (generated.generator !== "random_uuid") {
    reportStopIdFallback(generated.generator);
    reportStopDiagnostic("request_id_fallback", {
      conversationId: cid,
      runId: run,
      stopId: generated.id,
      requestIdGenerator: generated.generator,
    });
  }
  const stopId = generated.id;
  stoppingId = cid;
  setStopPending(cid, true);
  paintStopControl(conv);
  if (conv?.id === cid) paint(conv);
  reportStopDiagnostic("request_initiated", {
    conversationId: cid,
    runId: run,
    stopId,
    input,
    requestIdGenerator: generated.generator,
  });
  try {
    const response = await backendFor(cid).jpost(
      `/api/conversations/${cid}/deliver`,
      { run_id: run, stop_id: stopId },
      { availability: "core" },
    );
    reportStopDiagnostic("request_result", {
      conversationId: cid,
      runId: run,
      stopId,
      input,
      result: response.ok ? "accepted" : "rejected",
      status: response.status,
    });
    if (!response.ok) {
      setStopPending(cid, false);
      requestUiStatus(
        response.status === 409
          ? "That turn already ended. Tap Stop again to stop the current one."
          : "Stop failed — press Stop to retry",
      );
    }
  } catch {
    reportStopDiagnostic("request_failure", {
      conversationId: cid,
      runId: run,
      stopId,
      input,
      result: "exception",
    });
    setStopPending(cid, false);
    requestUiStatus("Stop failed — press Stop to retry");
  } finally {
    if (stoppingId === cid) stoppingId = null;
    inputEl.disabled = false;
    if (state.selectedId === cid) {
      await refreshConv();
      paintStopControl(
        state.currentConv?.id === cid ? state.currentConv : null,
      );
    }
  }
}

async function requestIdleProcessStop(
  cid: string,
  input: StopActivation,
): Promise<void> {
  const generated = createStopId();
  if (generated.generator !== "random_uuid") {
    reportStopIdFallback(generated.generator);
    reportStopDiagnostic("request_id_fallback", {
      conversationId: cid,
      stopId: generated.id,
      requestIdGenerator: generated.generator,
    });
  }
  const stopId = generated.id;
  try {
    const response = await backendFor(cid).jpost(
      `/api/conversations/${cid}/deliver`,
      { stop_id: stopId },
      { availability: "core" },
    );
    reportStopDiagnostic("request_result", {
      conversationId: cid,
      stopId,
      input,
      result: response.ok ? "accepted" : "rejected",
      status: response.status,
    });
    requestUiStatus(response.ok ? "Processes stopped" : "A turn is running");
  } catch {
    reportStopDiagnostic("request_failure", {
      conversationId: cid,
      stopId,
      input,
      result: "exception",
    });
    requestUiStatus("Stop failed — press Stop to retry");
  }
  if (state.selectedId === cid) await refreshConv();
}
