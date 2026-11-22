// Hold opens the action menu; left swipe deletes; native scrolling keeps pan-y.
import type { Action, Section } from "../../src/sidebar_script/index.js";
import { listEl } from "../dom.js";
import { DRAFT } from "../state.js";
import { holdOpen, moveHold, openHold, releaseHold } from "./hold.js";
import { rowHoldItems, sectionHoldItems } from "./sections.js";

const SWIPE_START = 12;
const DISMISS_MIN = 90;
interface Swipe {
  row: HTMLElement;
  id: string | undefined;
  x0: number;
  y0: number;
  dx: number;
  active: boolean;
  armed: boolean;
}

function resetRow(row: HTMLElement | null, animate: boolean): void {
  if (!row) return;
  row.classList.remove("swiping", "dismiss-armed");
  if (animate)
    row.style.transition =
      "transform var(--motion-move) ease, opacity var(--motion-move) ease";
  else row.style.transition = "";
  row.style.transform = "";
  row.style.opacity = "";
}

export function initRowTouch({
  remove,
  rename,
  renaming,
  section,
  actions,
}: {
  remove: (id: string | undefined) => void;
  rename: (id: string) => void;
  renaming: () => boolean;
  section: (key: string) => Section | undefined;
  actions: (id: string) => Action[] | undefined;
}) {
  let touchActionHandled = false;
  let longPressTimer = 0;
  let swipe: Swipe | null = null;
  let pressAt = [0, 0];

  listEl.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      if (renaming() || e.touches.length > 1) return;
      const t = e.touches[0];
      const header = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        ".tree-section-header",
      );
      const heldSection = section(header?.dataset.sectionKey ?? "");
      clearTimeout(longPressTimer);
      pressAt = [t.clientX, t.clientY];
      if (heldSection?.actions.length)
        longPressTimer = setTimeout(
          () => openHold(sectionHoldItems(heldSection), t.clientX, t.clientY),
          450,
        ) as unknown as number;
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        ".agent",
      );
      if (!row) return;
      const id = row.dataset.id;
      swipe = {
        row,
        id,
        x0: t.clientX,
        y0: t.clientY,
        dx: 0,
        active: false,
        armed: false,
      };
      touchActionHandled = false;
      // Invariant: Holding opens the row's action menu, Rename last; the row's
      // own tap-open is swallowed afterwards. A draft row has no actions.
      if (id && id !== DRAFT)
        longPressTimer = setTimeout(() => {
          if (!swipe || swipe.active) return;
          touchActionHandled = true;
          swipe = null;
          const items = rowHoldItems(actions(id) ?? [], id, () => rename(id));
          openHold(items, t.clientX, t.clientY);
        }, 450) as unknown as number;
    },
    { passive: true },
  );

  listEl.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      const t = e.touches[0];
      if (holdOpen()) {
        e.preventDefault();
        return moveHold(t.clientX, t.clientY);
      }
      const [x, y] = pressAt;
      if (Math.hypot(t.clientX - x, t.clientY - y) > SWIPE_START)
        clearTimeout(longPressTimer);
      if (!swipe) return;
      const dx = t.clientX - swipe.x0,
        dy = t.clientY - swipe.y0;
      if (!swipe.active) {
        // Invariant: First real movement kills the long-press. Commit to a
        // horizontal swipe only when the travel is clearly sideways; a vertical
        // drag hands off to scrolling.
        if (Math.abs(dy) > SWIPE_START && Math.abs(dy) >= Math.abs(dx)) {
          clearTimeout(longPressTimer);
          swipe = null;
          return;
        }
        if (Math.abs(dx) > SWIPE_START && Math.abs(dx) > Math.abs(dy)) {
          clearTimeout(longPressTimer);
          if (!swipe.id || swipe.id === DRAFT) {
            swipe = null;
            return;
          }
          swipe.active = true;
          swipe.row.style.transition = "";
          swipe.row.classList.add("swiping");
        } else return;
      }
      e.preventDefault();
      swipe.dx = Math.min(0, dx);
      swipe.row.style.transform = `translateX(${swipe.dx}px)`;
      swipe.row.style.opacity = String(Math.max(0.35, 1 + swipe.dx / 260));
      const armed = -swipe.dx >= DISMISS_MIN;
      if (armed !== swipe.armed) {
        swipe.armed = armed;
        swipe.row.classList.toggle("dismiss-armed", armed);
      }
    },
    { passive: false },
  );

  function endSwipe(): void {
    clearTimeout(longPressTimer);
    if (!swipe) return;
    const s = swipe;
    swipe = null;
    if (!s.active) return;
    if (s.armed) {
      // Invariant: Slide the row out, then delete optimistically (the teardown
      // runs on the backend). touchActionHandled keeps the follow-up tap from
      // opening it.
      touchActionHandled = true;
      const w = s.row.offsetWidth || 320;
      s.row.classList.remove("dismiss-armed");
      s.row.style.transition =
        "transform var(--motion-fast) ease, opacity var(--motion-fast) ease";
      s.row.style.transform = `translateX(-${w}px)`;
      s.row.style.opacity = "0";
      setTimeout(() => remove(s.id), 150);
    } else {
      resetRow(s.row, true);
    }
  }
  listEl.addEventListener("touchend", (e: TouchEvent) => {
    const t = e.changedTouches[0];
    // Invariant: A hold's release never also taps the row or header under it.
    if (holdOpen() && t) {
      e.preventDefault();
      releaseHold(t.clientX, t.clientY);
    }
    endSwipe();
  });
  listEl.addEventListener("contextmenu", (e) => {
    // Invariant: A touch hold's context menu would cancel the touch and menu.
    if (holdOpen() || swipe) e.preventDefault();
  });
  listEl.addEventListener("touchcancel", () => {
    // Invariant: A cancelled hold keeps its menu open for a tap.
    clearTimeout(longPressTimer);
    if (swipe && swipe.active) resetRow(swipe.row, true);
    swipe = null;
  });

  return {
    active: () => !!swipe?.active,
    blocksDrag: () => holdOpen() || !!swipe,
    takeTap: () => {
      if (!touchActionHandled) return false;
      touchActionHandled = false;
      return true;
    },
  };
}
