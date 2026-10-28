// Contains native Tab in custom modals; central keymap owns Escape.
const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function visibleFocusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.hidden &&
      !element.closest("[inert]") &&
      element.getClientRects().length > 0,
  );
}

export function focusFirst(container: HTMLElement): HTMLElement | null {
  const first = visibleFocusable(container)[0] || null;
  (first || container).focus();
  return first;
}

export function installFocusTrap(
  container: HTMLElement,
  isActive: () => boolean = () => true,
): void {
  document.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (
        !isActive() ||
        !container.contains(document.activeElement) ||
        event.key !== "Tab"
      )
        return;
      const focusable = visibleFocusable(container);
      if (!focusable.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? focusable[index > 0 ? index - 1 : focusable.length - 1]
        : focusable[index >= 0 && index < focusable.length - 1 ? index + 1 : 0];
      event.preventDefault();
      next.focus();
    },
    true,
  );
}

export function restoreFocus(element: HTMLElement | null): void {
  if (element?.isConnected) element.focus();
}
