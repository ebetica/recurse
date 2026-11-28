// Paint a held coarse-pointer press without changing the native gesture.
const CONTROLS = `button, a[href], summary, select, input,
  label:has(:is([type="checkbox"], [type="radio"])), [role="button"],
  [role="tab"], [role="option"], [role="treeitem"], [role="menuitem"],
  .dv-tab, .commentable > .diff-num, .files-thumb, .artifact-markdown img,
  img[data-path-image], #messages img:is([src$="/preview"], [src$="/thumbnail"])`;
const DISABLED = ':disabled, [aria-disabled="true"]';

export function installTouchPressFeedback(): void {
  const coarse = matchMedia("(pointer: coarse)");
  const observe = { capture: true, passive: true };
  let pressed: { element: Element; pointerId: number } | undefined;
  const clear = () => {
    pressed?.element.removeAttribute("data-touch-pressed");
    pressed = undefined;
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!coarse.matches || !event.isPrimary || event.button !== 0) return;
      clear();
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest(CONTROLS);
      if (!control || control.closest(DISABLED)) return;
      if (
        control instanceof HTMLLabelElement &&
        control.control?.matches(DISABLED)
      )
        return;
      const element =
        control.id === "context-indicator"
          ? (control.closest("#context-control") ?? control)
          : control;
      pressed = { element, pointerId: event.pointerId };
      element.setAttribute("data-touch-pressed", "");
    },
    observe,
  );
  for (const type of [
    "pointerup",
    "pointercancel",
    "lostpointercapture",
  ] as const)
    document.addEventListener(
      type,
      (event) => {
        if (pressed?.pointerId === event.pointerId) clear();
      },
      observe,
    );
  window.addEventListener("blur", clear);
}
