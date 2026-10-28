// DOM owner for the shared Send/Stop composer button.
import { sendEl, titleEl } from "../dom.js";
import { attachHoldTip } from "../hold-tip.js";
import { SEND_ICON, STOP_ICON } from "../icons.js";
import {
  activateComposerControlState,
  initialComposerControlState,
  stopControlLabel,
  updateComposerControl,
  type ComposerControlIntent,
  type StopMode,
} from "../stop-control.js";

const ARM_TIMEOUT_MS = 3000;

let controlState = initialComposerControlState();
let stopStatus: "ready" | "stopping" | "error" = "ready";
let controlMode: StopMode = "turn";
let preparingStop = false;
let preparationGeneration = 0;
let disarmTimer = 0;

const stopHold = attachHoldTip(sendEl, document, {
  text: () => {
    // Invariant: Null mirrors unactionable exactly (availability, payload, and
    // the disabled window around a stop preparation), so sync() can drop a
    // stale tip on any repaint.
    if (
      !controlState.stopAvailable ||
      controlState.hasPayload ||
      sendEl.disabled
    )
      return null;
    const armed =
      controlState.stopTargetId !== null &&
      controlState.armedTargetId === controlState.stopTargetId;
    if (controlMode === "processes")
      return armed ? "Tap again to stop processes" : "Tap to stop processes";
    return armed ? "Tap again to stop" : "Tap to stop";
  },
  enabled: () =>
    controlState.stopAvailable && !controlState.hasPayload && !sendEl.disabled,
});

/** True once when the press that just ended was a hold: skip the tap action. */
export function consumeComposerStopHold(): boolean {
  return stopHold.takeHoldConsumed();
}

function cancelStopPreparation(): void {
  if (!preparingStop) return;
  preparingStop = false;
  preparationGeneration++;
}

function paintComposerControl(): void {
  const stopMode = !controlState.hasPayload && controlState.stopAvailable;
  const armed =
    stopMode &&
    controlState.stopTargetId !== null &&
    controlState.armedTargetId === controlState.stopTargetId;
  const label = stopMode
    ? stopControlLabel(
        controlMode,
        armed,
        preparingStop,
        stopStatus === "error",
      )
    : "Send message";
  sendEl.classList.toggle("stop", stopMode);
  sendEl.classList.toggle("armed", armed);
  sendEl.classList.toggle("stopping", stopMode && stopStatus === "stopping");
  sendEl.classList.toggle("error", stopMode && stopStatus === "error");
  sendEl.disabled =
    preparingStop ||
    (controlState.hasPayload ? !controlState.sendable : !stopMode);
  sendEl.title = label;
  sendEl.setAttribute("aria-label", label);
  sendEl.innerHTML = stopMode ? STOP_ICON : SEND_ICON;
  titleEl.classList.toggle("stop-armed", armed);
  // Invariant: The one repaint for every control state change: a tip whose text
  // just went null (settled turn, typed payload, new selection) is stale here,
  // not armed, so it drops with the paint instead of floating.
  stopHold.sync();
}

export function setComposerSendState(
  hasPayload: boolean,
  sendable: boolean,
): void {
  controlState = updateComposerControl(controlState, { hasPayload, sendable });
  if (hasPayload) cancelStopPreparation();
  if (controlState.armedTargetId === null) clearTimeout(disarmTimer);
  paintComposerControl();
}

export function setComposerStopAvailability(
  stopAvailable: boolean,
  stopTargetId: string | null,
  status: "ready" | "stopping" | "error" = "ready",
  mode: StopMode = "turn",
): void {
  controlState = updateComposerControl(controlState, {
    stopAvailable,
    stopTargetId,
  });
  controlMode = mode;
  stopStatus = status;
  if (!stopAvailable) cancelStopPreparation();
  if (controlState.armedTargetId === null) clearTimeout(disarmTimer);
  paintComposerControl();
}

export function activeComposerStopPreparation(): number | null {
  return preparingStop ? preparationGeneration : null;
}

export function armPreparedComposerStop(
  stopTargetId: string | null,
  generation: number,
): void {
  if (!preparingStop || generation !== preparationGeneration) return;
  preparingStop = false;
  if (
    !stopTargetId ||
    !controlState.stopAvailable ||
    controlState.stopTargetId !== stopTargetId ||
    controlState.hasPayload
  ) {
    paintComposerControl();
    return;
  }
  controlState = { ...controlState, armedTargetId: stopTargetId };
  clearTimeout(disarmTimer);
  disarmTimer = setTimeout(
    disarmComposerStop,
    ARM_TIMEOUT_MS,
  ) as unknown as number;
  paintComposerControl();
  stopHold.pin();
}

export function disarmComposerStop(): void {
  if (!controlState.armedTargetId && !preparingStop) return;
  controlState = { ...controlState, armedTargetId: null };
  cancelStopPreparation();
  clearTimeout(disarmTimer);
  stopHold.hide();
  paintComposerControl();
}

export function activateComposerControl(): ComposerControlIntent {
  if (preparingStop) return "none";
  const result = activateComposerControlState(controlState);
  controlState = result.state;
  clearTimeout(disarmTimer);
  if (result.intent === "prepare-stop") {
    preparingStop = true;
    preparationGeneration++;
  }
  if (result.intent === "arm-stop") {
    disarmTimer = setTimeout(
      disarmComposerStop,
      ARM_TIMEOUT_MS,
    ) as unknown as number;
  }
  paintComposerControl();
  // Invariant: Pin after the repaint: the paint restores the button title, and
  // the pin clears it again while the tip is up so hover shows only the tip.
  if (result.intent === "arm-stop") stopHold.pin();
  return result.intent;
}

window.addEventListener("recurse:selection-change", () => {
  setComposerStopAvailability(false, null);
});
document.addEventListener(
  "keydown",
  (event) => {
    if ((event as KeyboardEvent).key === "Escape") disarmComposerStop();
  },
  true,
);
document.addEventListener(
  "click",
  (event) => {
    if ((event.target as HTMLElement | null)?.closest?.("#send")) return;
    disarmComposerStop();
  },
  true,
);

paintComposerControl();
