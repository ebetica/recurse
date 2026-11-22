// The phone More menu owns pane choices, focus keys and press-slide-release.
import { $ } from "../dom.js";
import { visibleFocusable } from "../focus_trap.js";
import { PANE_ICON } from "../icons.js";
import type { PaneDef } from "../types.js";

export function createPaneMenu({
  fab: fabEl,
  menu: menuEl,
  backdrop: backdropEl,
  overlayOpen,
  onBackdrop,
}: {
  fab: HTMLElement;
  menu: HTMLElement;
  backdrop: HTMLElement;
  overlayOpen: () => boolean;
  onBackdrop: () => void;
}) {
  const isOpen = () => menuEl.classList.contains("on");

  function renderItems(
    avail: readonly PaneDef[],
    badges: ReadonlyMap<string, string>,
    attentive: readonly PaneDef[],
    open: ReadonlySet<string>,
    pick: (id: string) => void,
  ): void {
    const panelItems = $("#pane-menu-panels")!;
    panelItems.innerHTML = "";
    for (const p of avail) {
      const b = document.createElement("button");
      const attention = attentive.includes(p);
      b.className =
        "menu-item pane-menu-item" +
        (open.has(p.id) ? " active" : "") +
        (attention ? " attention" : "");
      b.dataset.pane = p.id;
      b.setAttribute("role", "menuitem");
      const badge = badges.get(p.id) || "";
      const label = badge ? `${p.title || p.id} (${badge})` : p.title || p.id;
      if (attention) b.setAttribute("aria-label", `${label} available`);
      b.innerHTML = p.icon || PANE_ICON;
      b.querySelector("svg")?.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = label;
      b.appendChild(text);
      b.onclick = () => pick(p.id);
      panelItems.appendChild(b);
    }
  }

  function handleKey(event: KeyboardEvent): void {
    const items = visibleFocusable(menuEl);
    if (
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
      items.length
    ) {
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (index + 1 + items.length) % items.length
              : (index - 1 + items.length) % items.length;
      event.preventDefault();
      items[next].focus();
      return;
    }
    if (event.key === "Tab") {
      if (!items.length) {
        event.preventDefault();
        fabEl.focus();
        return;
      }
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && (index < 0 || index === items.length - 1)) {
        event.preventDefault();
        items[0].focus();
      }
    }
  }

  menuEl.addEventListener(
    "click",
    (event) => {
      const item = (event.target as Element | null)?.closest<HTMLButtonElement>(
        ".pane-menu-item",
      );
      if (!item || item.disabled) return;
      // Invariant: Delete's first tap is an inline confirmation, not an action.
      if (item.id === "trash-btn" && !item.classList.contains("armed")) return;
      closeMenu();
      fabEl.focus({ preventScroll: true });
    },
    true,
  );

  function openMenu(focusFirst = false): void {
    menuEl.classList.add("on");
    menuEl.scrollTop = 0;
    backdropEl.classList.add("on");
    fabEl.setAttribute("aria-expanded", "true");
    if (focusFirst)
      requestAnimationFrame(() => visibleFocusable(menuEl)[0]?.focus());
  }
  function closeMenu(): void {
    menuEl.classList.remove("on");
    fabEl.setAttribute("aria-expanded", "false");
    clearHot();
    if (!overlayOpen()) backdropEl.classList.remove("on");
  }

  // Phone FAB press/slide/release picks a panel; plain taps toggle the menu.
  let hotItem: HTMLElement | null = null;
  function clearHot(): void {
    if (hotItem) {
      hotItem.classList.remove("hot");
      hotItem = null;
    }
  }
  function setHot(el: HTMLElement | null): void {
    if (el === hotItem) return;
    clearHot();
    if (el) {
      el.classList.add("hot");
      hotItem = el;
    }
  }
  function inRect(x: number, y: number, el: HTMLElement | null): boolean {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  // Invariant: Only a painted item counts; rows the menu clips never match.
  function menuItemAt(x: number, y: number): HTMLElement | null {
    const item = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(".pane-menu-item:not(:disabled)");
    return item && menuEl.contains(item) ? item : null;
  }

  let fabActive = false,
    fabWasOpen = false;
  fabEl.addEventListener("pointerdown", (e: PointerEvent) => {
    fabActive = true;
    fabWasOpen = isOpen();
    try {
      fabEl.setPointerCapture(e.pointerId);
    } catch {}
    openMenu();
    e.preventDefault();
  });
  fabEl.addEventListener("pointermove", (e: PointerEvent) => {
    if (fabActive) setHot(menuItemAt(e.clientX, e.clientY));
  });
  const fabFinish = (commit: boolean) => (e: PointerEvent) => {
    if (!fabActive) return;
    fabActive = false;
    try {
      fabEl.releasePointerCapture(e.pointerId);
    } catch {}
    const item = menuItemAt(e.clientX, e.clientY);
    const overBtn = inRect(e.clientX, e.clientY, fabEl);
    clearHot();
    // Spec: Slide-release activates one item via pointer confirmation.
    if (commit && item) {
      item.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 1,
          clientX: e.clientX,
          clientY: e.clientY,
        }),
      );
    } else if (overBtn) {
      if (fabWasOpen) closeMenu();
    } else closeMenu();
  };
  fabEl.addEventListener("pointerup", fabFinish(true));
  fabEl.addEventListener("pointercancel", fabFinish(false));
  fabEl.addEventListener("click", (e: MouseEvent) => {
    // Spec: Detail-0 keyboard clicks toggle; pointer gestures already handled
    // their own generated clicks and must not activate twice.
    if (e.detail === 0) {
      if (isOpen()) closeMenu();
      else openMenu(true);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  fabEl.addEventListener("contextmenu", (e) => e.preventDefault());
  backdropEl.onclick = () => {
    closeMenu();
    onBackdrop();
  };

  return { close: closeMenu, isOpen, renderItems, handleKey };
}
