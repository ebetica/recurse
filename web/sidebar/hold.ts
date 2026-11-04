// Press-and-hold menu for touch: holding a row or section header opens a
// strip of action buttons above the finger. Dragging onto a button shows its
// label in a bubble, and releasing there runs it; releasing anywhere else
// cancels. Released without moving, the strip stays open for a tap instead.
import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

export interface HoldItem {
  label: string;
  icon: string;
  run(anchor: DOMRect): void;
}

const STILL = 10;
const SLOP = 8;
let host: HTMLElement | null = null;
let open: {
  items: HoldItem[];
  x: number;
  y: number;
  moved: boolean;
  over: number;
} | null = null;

const tick = () =>
  navigator.userActivation?.hasBeenActive && navigator.vibrate?.(8);

function paint(): void {
  if (!open) {
    if (host) render(nothing, host);
    if (host) host.hidden = true;
    return;
  }
  const { items, over } = open;
  render(
    html`<div class="hold-bubble" ?hidden=${over < 0} aria-hidden="true">
        ${items[over]?.label ?? ""}
      </div>
      <div class="hold-strip" role="menu" aria-label="Actions">
        ${items.map(
          (item, i) =>
            html`<button
              type="button"
              role="menuitem"
              class=${i === over ? "over" : ""}
              aria-label=${item.label}
              title=${item.label}
              @click=${(e: Event) => choose(i, e)}
            >
              ${unsafeHTML(item.icon)}
            </button>`,
        )}
      </div>`,
    host!,
  );
}

function choose(i: number, e?: Event): void {
  e?.stopPropagation();
  const item = open?.items[i];
  const button = host?.querySelectorAll("button")[i];
  const anchor = button?.getBoundingClientRect() ?? new DOMRect();
  closeHold();
  item?.run(anchor);
}

function outside(e: Event): void {
  if (open && !host!.contains(e.target as Node)) closeHold();
}
function escape(e: KeyboardEvent): void {
  if (open && e.key === "Escape") closeHold();
}

/** Open the strip for a finger at (x, y). */
export function openHold(items: HoldItem[], x: number, y: number): void {
  if (!items.length) return;
  host ??= document.body.appendChild(document.createElement("div"));
  host.id = "hold-menu";
  open = { items, x, y, moved: false, over: -1 };
  host.hidden = false;
  paint();
  const box = host.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, x - box.width / 2),
    innerWidth - box.width - 8,
  );
  const top = y - box.height - 28 > 8 ? y - box.height - 28 : y + 28;
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
  tick();
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape, true);
}

export const holdOpen = (): boolean => open !== null;

/** The finger moved to (x, y): highlight the button under it. */
export function moveHold(x: number, y: number): void {
  if (!open) return;
  if (Math.hypot(x - open.x, y - open.y) > STILL) open.moved = true;
  const buttons = [
    ...host!.querySelectorAll<HTMLElement>(".hold-strip button"),
  ];
  const over = buttons.findIndex((button) => {
    const r = button.getBoundingClientRect();
    return (
      x >= r.left - SLOP &&
      x <= r.right + SLOP &&
      y >= r.top - SLOP &&
      y <= r.bottom + SLOP
    );
  });
  if (over === open.over) return;
  open.over = over;
  if (over >= 0) tick();
  paint();
}

/** The finger lifted at (x, y): run the button under it, or cancel. */
export function releaseHold(x: number, y: number): void {
  if (!open) return;
  moveHold(x, y);
  if (open.over >= 0) return choose(open.over);
  if (open.moved) closeHold();
}

export function closeHold(): void {
  open = null;
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", escape, true);
  paint();
}
