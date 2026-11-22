// Draw selection-comment boxes on Files and Artifact images/PDFs. Image mouse comments
// require a modifier; touch and pen hold before dragging. PDF mouse drag is
// unchanged. Touch taps explain the gesture; native cancel abandons it.
import type { CommentBox } from "../../artifacts/artifact-state.js";
import { imageCommentHint } from "../../image-preview/index.js";

const inlineSources = new WeakMap<Element, Promise<string | null>>();

/** Register the authored position and the actual immutable source after decode. */
export function registerInlineBoxFrame(
  frame: HTMLElement,
  index: number,
  source: Promise<string | null>,
): void {
  frame.classList.add("report-box-frame");
  frame.dataset.boxImage = String(index);
  frame.title = imageCommentHint();
  inlineSources.set(
    frame,
    source.then((value) => {
      if (!value) return null;
      const url = new URL(value, location.href);
      url.searchParams.delete("refresh");
      return url.href;
    }),
  );
}

/** Mutable or missing images do not have an immutable source for reanchoring. */
export function inlineBoxSource(
  frame: Element,
): Promise<string | null> | undefined {
  return inlineSources.get(frame);
}

/** Find the exact source of a box, even when the document was remounted. */
export function findBoxFrame(root: Element, box: CommentBox): Element | null {
  const source = box.image
    ? `[data-box-image="${box.image}"]`
    : box.page
      ? `[data-page="${box.page}"]`
      : ":not([data-box-image], [data-page])";
  const selector = `.report-box-frame${source}`;
  return root.matches(selector) ? root : root.querySelector(selector);
}

type BoxCommentOffer = (
  frame: Element,
  mark: HTMLElement,
  box: CommentBox,
) => void;
let offerBoxComment: BoxCommentOffer;

export function configureBoxCommentOffer(offer: BoxCommentOffer): void {
  offerBoxComment = offer;
}

/** Show `box` as a highlight over its frame. */
export function placeBox(
  frame: Element,
  box: CommentBox,
  mark = frame.ownerDocument.createElement("mark"),
): HTMLElement {
  mark.className = "report-cmark report-cbox";
  Object.assign(mark.style, {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
  });
  if (mark.parentNode !== frame) frame.append(mark);
  return mark;
}

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
  time: number;
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
  const page = Number(frame.dataset.page);
  const image = Number(frame.dataset.boxImage);
  return {
    ...(page ? { page } : image ? { image } : {}),
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Let boxes be drawn on every `.report-box-frame` inside `pane`. */
export function installBoxComments(pane: HTMLElement): void {
  let press: Press | null = null;
  let drawnImage: HTMLElement | null = null;
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
    hint.textContent = "Hold, then drag to comment on an area";
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
    drawnImage = null;
    cancel();
    const frame = (event.target as Element).closest<HTMLElement>(
      ".report-box-frame",
    );
    if (!event.isPrimary || event.button !== 0 || !frame?.offsetHeight) return;
    const inline = !!frame.dataset.boxImage;
    if (inline && frame.hasAttribute("aria-busy")) return;
    const image = inline || !!frame.closest(".image-zoom-viewport");
    if (image && event.pointerType === "mouse") {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      if (!(mac ? event.metaKey : event.ctrlKey)) return;
    }
    const current: Press = {
      id: event.pointerId,
      frame,
      from: pointIn(frame, event),
      client: { x: event.clientX, y: event.clientY },
      time: event.timeStamp,
    };
    press = current;
    if (
      event.pointerType === "mouse" ||
      (!image && event.pointerType !== "touch")
    ) {
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
  // Invariant: Capture phase runs before the image viewer's own handler, so
  // a drag that cancels the hold here pans with this same move.
  pane.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerId !== press?.id) return;
      const { frame, mark, client } = press;
      if (!mark || mark.classList.contains("files-box-start")) {
        if (
          Math.hypot(event.clientX - client.x, event.clientY - client.y) <=
          SLOP_PX
        )
          return;
        // Invariant: Holds are timed by when the finger moved, so a busy
        // page that ran the hold timer first still pans a quick drag.
        if (!mark || event.timeStamp - press.time < HOLD_MS) {
          touchDrew = false;
          cancel();
          frame
            .closest(".image-zoom-viewport")
            ?.setPointerCapture(event.pointerId);
          return;
        }
      }
      placeBox(frame, boxOf(frame, press.from, pointIn(frame, event)), mark);
    },
    { capture: true },
  );
  // Invariant: Capture phase releases a quick tap's hold before the image
  // viewer's handler, so a busy page that ran the hold timer first still taps.
  pane.addEventListener(
    "pointerup",
    (event) => {
      if (event.pointerId !== press?.id) return;
      const { frame, mark, time } = press;
      if (
        !mark?.classList.contains("files-box-start") ||
        event.timeStamp - time >= HOLD_MS
      )
        return;
      touchDrew = false;
      frame.releasePointerCapture(event.pointerId);
      mark.remove();
      press.mark = undefined;
    },
    { capture: true },
  );
  pane.addEventListener("pointerup", (event) => {
    if (event.pointerId !== press?.id) return;
    const { frame, from, mark, timer } = press;
    clearTimeout(timer);
    press = null;
    if (!mark) {
      if (event.pointerType !== "mouse") showHint(frame, from);
      return;
    }
    const box = boxOf(frame, from, pointIn(frame, event));
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) {
      mark.remove();
      if (box.image && event.pointerType !== "mouse") {
        drawnImage = frame;
        showHint(frame, from);
      }
    } else {
      if (box.image) drawnImage = frame;
      offerBoxComment(frame, placeBox(frame, box, mark), box);
    }
  });
  // A drawn area must not also open the image or its wrapping link.
  pane.addEventListener(
    "click",
    (event) => {
      if (!event.detail || !drawnImage?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
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
