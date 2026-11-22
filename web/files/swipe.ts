// Shared file and image stepping, without taking over zoom or box gestures.
import { touchDrewBox } from "../comments/box/index.js";
import { installImageWheelNavigation } from "../image-preview/index.js";

export const coarsePointer = matchMedia("(pointer: coarse)");

// Invariant: A horizontal swipe steps files only at normal zoom and only when
// no element under the finger scrolls sideways; pinch-zoomed drags pan.
export function installSwipe(
  element: HTMLElement,
  step: (delta: -1 | 1) => void,
): void {
  installImageWheelNavigation(element, step);
  let start: { x: number; y: number } | null = null;
  const scrollsSideways = (node: Element | null): boolean => {
    for (let at = node; at && at !== element; at = at.parentElement)
      if (at.scrollWidth > at.clientWidth + 1) return true;
    return false;
  };
  element.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target as Element;
      start =
        event.touches.length === 1 &&
        (window.visualViewport?.scale ?? 1) <= 1.01 &&
        !target.closest('[data-zoomed="true"]') &&
        target.closest(".files-detail") &&
        !scrollsSideways(target)
          ? { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY }
          : null;
    },
    { passive: true },
  );
  element.addEventListener("touchcancel", () => (start = null));
  element.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches[0];
      if (
        !start ||
        !touch ||
        touchDrewBox() ||
        (event.target as Element).closest('[data-zoomed="true"]')
      )
        return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      start = null;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy))
        step(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );
}
