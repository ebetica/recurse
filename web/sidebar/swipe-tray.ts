// Paints one touch tray inside its row so list scrolling and clipping stay native.
import { html, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { HoldItem } from "./hold.js";

export type SwipeDirection = "left" | "right";
export interface SwipeItem extends HoldItem {
  key: string;
  full: boolean;
  showLabel: boolean;
}

const TARGET_WIDTH = 44;
const ACTION_GAP = 8;
const MAX_LABEL_WIDTH = 80;
const MAX_ACTIONS = 3;

/** Keep the fixed badges and some of the title visible even at maximum stretch. */
function revealRoom(row: HTMLElement): number {
  const title = row.querySelector<HTMLElement>(".row1 > .title")!;
  const body = getComputedStyle(title.parentElement!);
  return (
    Math.floor(
      title.offsetWidth +
        parseFloat(body.marginLeft) +
        parseFloat(body.marginRight),
    ) - 24
  );
}

export function makeSwipeTray(
  row: HTMLElement,
  direction: SwipeDirection,
  items: SwipeItem[],
  choose: (item: SwipeItem, anchor: DOMRect) => void,
) {
  const room = revealRoom(row);
  const slot = TARGET_WIDTH + ACTION_GAP;
  const shown = items.slice(
    0,
    Math.max(0, Math.min(MAX_ACTIONS, Math.floor(room / slot))),
  );
  if (!shown.length) return null;
  const labels = shown.filter((item) => item.showLabel).length;
  const baseWidth = shown.length * slot;
  const labelWidth = labels
    ? Math.min(
        MAX_LABEL_WIDTH,
        TARGET_WIDTH + Math.floor((room - baseWidth) / labels),
      )
    : TARGET_WIDTH;
  const width = baseWidth + labels * (labelWidth - TARGET_WIDTH);
  const tray = document.createElement("div");
  tray.className = "swipe-tray";
  row.dataset.swipeDirection = direction;
  tray.setAttribute("role", "group");
  tray.setAttribute("aria-label", "Swipe actions");
  render(
    html`${shown.map(
      (item) =>
        html`<button
          type="button"
          class=${`icon-btn lg${item.danger ? " swipe-danger" : ""}${item.showLabel ? " swipe-labelled" : ""}`}
          style=${item.showLabel ? `width:${labelWidth}px` : ""}
          title=${item.label}
          aria-label=${item.label}
          @click=${(event: Event) => {
            event.stopPropagation();
            choose(
              item,
              (event.currentTarget as HTMLElement).getBoundingClientRect(),
            );
          }}
        >
          <span class="swipe-pill" aria-hidden="true"
            >${item.showLabel ? item.label : unsafeHTML(item.icon)}</span
          >
        </button>`,
    )}`,
    tray,
  );
  tray.inert = true;
  row.append(tray);
  row.dataset.swiping = "drag";
  const moveTo = (distance: number) =>
    row.style.setProperty("--swipe-size", `${distance}px`);
  return {
    width,
    element: tray,
    move: (distance: number, armed: boolean) => {
      tray.classList.toggle("swipe-full", armed);
      moveTo(Math.min(room, distance));
    },
    settle: () => {
      row.dataset.swiping = "open";
      tray.classList.remove("swipe-full");
      moveTo(width);
      const settling = row
        .getAnimations()
        .filter(
          (a) =>
            a instanceof CSSTransition &&
            a.transitionProperty === "--swipe-size",
        );
      if (!settling.length) tray.inert = false;
      else
        void Promise.allSettled(settling.map((a) => a.finished)).then(() => {
          tray.inert = false;
        });
    },
    close: () => {
      const focused = tray.contains(document.activeElement);
      tray.remove();
      delete row.dataset.swiping;
      row.style.removeProperty("--swipe-size");
      if (focused) row.focus({ preventScroll: true });
    },
  };
}
