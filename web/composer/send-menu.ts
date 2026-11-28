// The touch Send menu consumes the held press without moving the phone caret.
// It opens after half the shared hold so it feels quick. While the composer is
// focused, touches on Send or anywhere while the menu is open never take focus
// from it, so the phone keyboard stays up while holding, choosing, dismissing.
import { $, inputEl, sendEl } from "../dom.js";
import { primaryPointerIsCoarse } from "../state.js";
import { HOLD_MS, SLOP_PX } from "../touch-hold.js";
import { closeComposerAutocomplete } from "./autocomplete.js";

const menu = $("#send-menu");
const item = $("#send-btw");
const description = $("#send-btw-description");
const SEND_HOLD_MS = HOLD_MS / 2;
const isOpen = () => menu?.matches(":popover-open") ?? false;
let refresh = () => {};

export function refreshSendMenu(): void {
  refresh();
}

export function configureSendMenu(
  disabledReason: () => string,
  ask: () => void,
): void {
  if (!menu || !item || !description) return;
  const available = () =>
    primaryPointerIsCoarse() && !sendEl.classList.contains("stop");
  let press: { id: number; x: number; y: number; timer: number } | null = null;
  let held = false;
  let restoreFocus = false;
  const cancel = () => {
    clearTimeout(press?.timer);
    press = null;
  };
  refresh = () => {
    if (!isOpen()) return;
    if (!available()) {
      menu.hidePopover();
      return;
    }
    const reason = disabledReason();
    item.setAttribute("aria-disabled", String(!!reason));
    description.textContent = reason;
    description.hidden = !reason;
  };
  sendEl.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) {
      cancel();
      return;
    }
    held = false;
    cancel();
    if (!available() || event.button !== 0 || event.pointerType === "mouse")
      return;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        if (!available()) return;
        held = true;
        restoreFocus = true;
        closeComposerAutocomplete();
        const { left, right, top } = sendEl.getBoundingClientRect();
        const onRight = left + right > innerWidth;
        menu.style.left = onRight ? "" : `${left}px`;
        menu.style.right = onRight ? `${innerWidth - right}px` : "";
        menu.style.bottom = `${innerHeight - top}px`;
        menu.showPopover();
        refresh();
      }, SEND_HOLD_MS),
    };
  });
  sendEl.addEventListener("pointermove", (event) => {
    if (
      event.pointerId === press?.id &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > SLOP_PX
    )
      cancel();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"])
    sendEl.addEventListener(type, cancel);
  // A touch whose default runs can blur the composer (Chrome Android's native
  // long-press), so a kept press cancels its touchstart and replays the tap
  // from where the finger lifts.
  let kept: Node | null = null;
  document.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target as Node;
      kept = null;
      if (
        event.touches.length !== 1 ||
        document.activeElement !== inputEl ||
        !(isOpen() || (available() && sendEl.contains(target)))
      )
        return;
      event.preventDefault();
      kept = target;
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    "touchend",
    (event) => {
      const target = kept;
      kept = null;
      const touch = event.changedTouches[0];
      if (!target || !touch) return;
      event.preventDefault();
      const end = document.elementFromPoint(touch.clientX, touch.clientY);
      const within = (node: Element) => !!end && node.contains(end);
      if (sendEl.contains(target)) {
        if (held) held = false;
        else if (within(sendEl)) sendEl.click();
      } else if (!menu.contains(target)) menu.hidePopover();
      else if (item.contains(target) && within(item)) item.click();
    },
    true,
  );
  sendEl.addEventListener("contextmenu", (event) => {
    if (press || held) event.preventDefault();
  });
  // Native light-dismiss would close the popover on the held finger's release.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Node;
      if (event.detail && held && sendEl.contains(target)) {
        held = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (isOpen() && !menu.contains(target)) {
        menu.hidePopover();
      }
    },
    true,
  );
  menu.addEventListener("toggle", () => {
    const open = isOpen();
    sendEl.setAttribute("aria-expanded", String(open));
    if (!open && restoreFocus && document.activeElement === document.body)
      inputEl.focus({ preventScroll: true });
  });
  item.addEventListener("click", () => {
    if (disabledReason()) return;
    restoreFocus = false;
    menu.hidePopover();
    ask();
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "Escape" ||
        !isOpen() ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      menu.hidePopover();
      inputEl.focus({ preventScroll: true });
    },
    true,
  );
  window.addEventListener("recurse:selection-change", () => {
    cancel();
    restoreFocus = false;
    menu.hidePopover();
  });
}
