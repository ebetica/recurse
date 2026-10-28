// Draw selection-comment boxes on Files images/PDFs: mouse/pen drag,
// touch drag when zoomed, otherwise hold then drag to preserve swipes/scrolls.
// Touch taps explain the gesture; native cancel abandons it.
import type { CommentBox } from "../artifacts/artifact-state.js";
import { offerBoxComment, placeBox } from "../artifacts/selection-comments.js";

const HOLD_MS = 450;
const SLOP_PX = 8;
const MIN_SIZE = 0.01;

interface Point {
  x: number;
  y: number;
}
interface Press {
  id: number;
  frame: HTMLElement;
  from: Point;
  client: Point;
  timer?: number;
  mark?: HTMLElement;
}

let touchDrew = false;
/** Whether the latest touch drew a box, so it must not also swipe. */
export function touchDrewBox(): boolean {
  return touchDrew;
}

function pointIn(frame: HTMLElement, event: PointerEvent): Point {
  const rect = frame.getBoundingClientRect();
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  };
}

function boxOf(frame: HTMLElement, a: Point, b: Point): CommentBox {
  const page = Number(frame.dataset.page) || undefined;
  return {
    ...(page ? { page } : {}),
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Let boxes be drawn on every `.report-box-frame` inside `pane`. */
export function installBoxComments(pane: HTMLElement): void {
  let press: Press | null = null;
  let hint: HTMLElement | null = null;
  let hintTimer: number | undefined;
  const clearHint = () => {
    clearTimeout(hintTimer);
    hint?.remove();
    hint = null;
  };
  const showHint = (frame: HTMLElement, point: Point) => {
    clearHint();
    hint = document.createElement("span");
    hint.className = "files-box-hint";
    hint.setAttribute("role", "status");
    hint.textContent = frame.closest('[data-zoomed="true"]')
      ? "Drag to comment; use two fingers to move the image"
      : "Hold, then drag to comment on an area";
    const { width, height } = frame.getBoundingClientRect();
    hint.style.left = `${Math.max(8, Math.min(point.x * width - 140, width - 288))}px`;
    hint.style.top = `${Math.max(40, point.y * height - 12)}px`;
    frame.append(hint);
    hintTimer = window.setTimeout(clearHint, 2000);
  };
  const cancel = () => {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.frame.hasPointerCapture(press.id))
      press.frame.releasePointerCapture(press.id);
    press.mark?.remove();
    press = null;
  };
  const begin = (current: Press) => {
    current.mark = placeBox(
      current.frame,
      boxOf(current.frame, current.from, current.from),
    );
  };
  pane.addEventListener("pointerdown", (event) => {
    clearHint();
    touchDrew = false;
    cancel();
    const frame = (event.target as Element).closest<HTMLElement>(
      ".report-box-frame",
    );
    if (!event.isPrimary || event.button !== 0 || !frame?.offsetHeight) return;
    const current: Press = {
      id: event.pointerId,
      frame,
      from: pointIn(frame, event),
      client: { x: event.clientX, y: event.clientY },
    };
    press = current;
    if (event.pointerType !== "touch") {
      event.preventDefault();
      frame.setPointerCapture(event.pointerId);
      begin(current);
      return;
    }
    current.timer = window.setTimeout(() => {
      if (press !== current || !current.frame.isConnected) return;
      touchDrew = true;
      current.frame.setPointerCapture(current.id);
      begin(current);
      current.mark!.classList.add("files-box-start");
      navigator.vibrate?.(10);
    }, HOLD_MS);
  });
  pane.addEventListener("pointermove", (event) => {
    if (event.pointerId !== press?.id) return;
    if (!press.mark) {
      if (
        Math.hypot(
          event.clientX - press.client.x,
          event.clientY - press.client.y,
        ) <= SLOP_PX
      )
        return;
      if (!press.frame.closest('[data-zoomed="true"]')) {
        cancel();
        return;
      }
      clearTimeout(press.timer);
      touchDrew = true;
      press.frame.setPointerCapture(press.id);
      begin(press);
    }
    if (
      press.mark!.classList.contains("files-box-start") &&
      Math.hypot(
        event.clientX - press.client.x,
        event.clientY - press.client.y,
      ) <= SLOP_PX
    )
      return;
    placeBox(
      press.frame,
      boxOf(press.frame, press.from, pointIn(press.frame, event)),
      press.mark,
    );
  });
  pane.addEventListener("pointerup", (event) => {
    if (event.pointerId !== press?.id) return;
    const { frame, from, mark, timer } = press;
    clearTimeout(timer);
    press = null;
    if (!mark) {
      if (event.pointerType === "touch") showHint(frame, from);
      return;
    }
    const box = boxOf(frame, from, pointIn(frame, event));
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) mark.remove();
    else offerBoxComment(frame, placeBox(frame, box, mark), box);
  });
  pane.addEventListener("pointercancel", cancel);
  // Invariant: Once a held finger draws, its moves must not scroll the pane.
  pane.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length !== 1) cancel();
      else if (press?.mark && event.cancelable) event.preventDefault();
    },
    { passive: false },
  );
  // Invariant: Chrome's long-press menu must not take over an armed touch;
  // native scroll/pinch pointercancel still cancels, even after capture.
  for (const type of ["contextmenu", "dragstart", "selectstart"])
    pane.addEventListener(type, (event) => {
      if (
        press ||
        (type === "contextmenu" &&
          (event as PointerEvent).pointerType === "touch" &&
          (event.target as Element).closest(".report-box-frame"))
      )
        event.preventDefault();
    });
}
