// Phone row swipes share script actions with the hold menu; scrolling stays native.
import type { Action, Section } from "../../src/sidebar_script/index.js";
import { listEl } from "../dom.js";
import { DELETE_ICON, MORE_ICON, actionIcon } from "../icons.js";
import { DRAFT, state } from "../state.js";
import { runAction, setUnread } from "./actions.js";
import { askDeleteAgent } from "./dialogs.js";
import { holdOpen, moveHold, openHold, releaseHold } from "./hold.js";
import { rowHoldItems, sectionHoldItems } from "./sections.js";
import {
  makeSwipeTray,
  type SwipeDirection,
  type SwipeItem,
} from "./swipe-tray.js";

const START = 12;
const FULL = 0.6;

interface Press {
  row: HTMLElement;
  id: string;
  touch: number;
  x: number;
  y: number;
  active: boolean;
  width: number;
}

export function initRowTouch({
  repaint,
  remove,
  rename,
  renaming,
  section,
  actions,
}: {
  repaint: () => void;
  remove: (id: string) => void;
  rename: (id: string) => void;
  renaming: () => boolean;
  section: (key: string) => Section | undefined;
  actions: (id: string) => Action[] | undefined;
}) {
  const enabled = matchMedia("(max-width: 700px) and (pointer: coarse)");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let swallowTap = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let pressAt = [0, 0];
  let press: Press | null = null;
  let revealed: {
    row: HTMLElement;
    id: string;
    direction: SwipeDirection;
    items: SwipeItem[];
    tray: NonNullable<ReturnType<typeof makeSwipeTray>>;
    distance: number;
    armed: boolean;
    settled: boolean;
  } | null = null;

  const renameRow = (id: string) => () => rename(id);
  function holdItems(id: string) {
    const rowActions = actions(id) ?? [];
    const items = rowHoldItems(rowActions, id, renameRow(id));
    if (enabled.matches && rowActions.some((a) => a.swipe))
      items.splice(-1, 0, {
        label: "Swipe actions",
        icon: MORE_ICON,
        run: (anchor) => openMenu(id, anchor),
      });
    return items;
  }

  function itemsFor(id: string, eligible: (a: Action) => boolean): SwipeItem[] {
    const node = state.nodes[id];
    if (!node) return [];
    return (actions(id) ?? []).filter(eligible).map((a) => {
      const unread = node.unread === true;
      const danger = a.do === "delete";
      const reading = a.do === "toggleUnread";
      const label = reading ? (unread ? "Read" : "Unread") : a.label;
      return {
        key: JSON.stringify([a, label]),
        label,
        danger,
        full: a.fullSwipe ?? !danger,
        showLabel: !a.do && a.label.toLowerCase() !== a.icon,
        icon: danger
          ? DELETE_ICON
          : a.do === "more"
            ? MORE_ICON
            : actionIcon(reading ? label.toLowerCase() : a.icon),
        run: (anchor) => {
          if (reading) void setUnread(id, !unread);
          else if (a.do === "delete")
            void askDeleteAgent(node.title, anchor).then((confirmed) => {
              if (confirmed) remove(id);
            });
          else if (a.do === "more") openMenu(id, anchor);
          else void runAction(a, [id], anchor);
        },
      };
    });
  }

  function openMenu(id: string, anchor: DOMRect): void {
    openHold(
      [
        ...itemsFor(id, (a) => a.do !== "more"),
        ...rowHoldItems([], id, renameRow(id)),
      ],
      anchor.x + anchor.width / 2,
      anchor.y + anchor.height / 2,
      true,
    );
  }

  listEl.addEventListener(
    "click",
    (e) => {
      const button = (e.target as Element).closest(".phone-row-menu");
      if (!button || !enabled.matches) return;
      const id = button.closest<HTMLElement>(".agent")?.dataset.id;
      if (!id) return;
      e.stopPropagation();
      openMenu(id, button.getBoundingClientRect());
    },
    true,
  );

  function close(): void {
    const shown = revealed;
    revealed = null;
    shown?.tray.close();
  }
  function choose(item: SwipeItem, anchor: DOMRect): void {
    close();
    repaint();
    item.run(anchor);
  }
  function cancelPress(): void {
    clearTimeout(holdTimer);
    const active = press?.active;
    press = null;
    if (!active) return;
    close();
    repaint();
  }

  listEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) {
        cancelPress();
        return;
      }
      swallowTap = false;
      const target = e.target as HTMLElement;
      if (revealed?.settled) {
        if (revealed.tray.element.contains(target)) return;
        close();
        swallowTap = true;
        return;
      }
      if (renaming()) return;
      const t = e.touches[0];
      const header = target.closest<HTMLElement>(".tree-section-header");
      const heldSection = section(header?.dataset.sectionKey ?? "");
      clearTimeout(holdTimer);
      pressAt = [t.clientX, t.clientY];
      if (heldSection?.actions.length)
        holdTimer = setTimeout(
          () => openHold(sectionHoldItems(heldSection), t.clientX, t.clientY),
          450,
        );
      const row = target.closest<HTMLElement>(".agent");
      const id = row?.dataset.id;
      if (!row || !id || id === DRAFT) return;
      press = {
        row,
        id,
        touch: t.identifier,
        x: t.clientX,
        y: t.clientY,
        active: false,
        width: row.offsetWidth,
      };
      if (target.closest(".phone-row-menu")) return;
      holdTimer = setTimeout(() => {
        press = null;
        swallowTap = true;
        openHold(holdItems(id), t.clientX, t.clientY);
      }, 450);
    },
    { passive: true },
  );

  listEl.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (holdOpen()) {
        e.preventDefault();
        return moveHold(t.clientX, t.clientY);
      }
      const [x, y] = pressAt;
      if (Math.hypot(t.clientX - x, t.clientY - y) > START)
        clearTimeout(holdTimer);
      if (!press || t.identifier !== press.touch || !enabled.matches) return;
      const dx = t.clientX - press.x;
      const dy = t.clientY - press.y;
      const distance = Math.abs(dx);
      const direction = dx < 0 ? "left" : "right";
      if (!press.active) {
        if (Math.abs(dy) > START && Math.abs(dy) >= distance) {
          press = null;
          return;
        }
        if (distance <= START || distance <= Math.abs(dy)) return;
      }
      if (revealed?.direction !== direction) {
        close();
        const { row, id } = press;
        const items = itemsFor(id, (a) => a.swipe === direction);
        const tray =
          items.length && makeSwipeTray(row, direction, items, choose);
        if (tray)
          revealed = {
            row,
            id,
            direction,
            items,
            tray,
            distance,
            armed: false,
            settled: false,
          };
      }
      if (!revealed && !press.active) return;
      e.preventDefault();
      press.active = true;
      if (!revealed) return;
      const { items, tray } = revealed;
      const armed = items[0]!.full && distance >= press.width * FULL;
      const extra = Math.max(0, distance - tray.width);
      const stretch = reduced.matches ? 0 : extra * (armed ? 0.55 : 0.2);
      revealed.distance = distance;
      revealed.armed = armed;
      tray.move(Math.min(distance, tray.width) + stretch, armed);
    },
    { passive: false },
  );

  listEl.addEventListener("touchend", (e) => {
    const t = e.changedTouches[0];
    if (holdOpen() && t) {
      e.preventDefault();
      releaseHold(t.clientX, t.clientY);
    }
    clearTimeout(holdTimer);
    if (!press || t?.identifier !== press.touch) return;
    const { active, row } = press;
    press = null;
    if (!active) return;
    swallowTap = true;
    const shown = revealed;
    if (shown?.armed) {
      const anchor = shown.tray.element
        .querySelector("button")!
        .getBoundingClientRect();
      choose(shown.items[0]!, anchor);
      return;
    }
    if (
      shown &&
      shown.distance >= Math.min(52, shown.tray.width / 2) &&
      row.isConnected
    ) {
      shown.settled = true;
      shown.tray.settle();
    } else close();
    repaint();
  });
  listEl.addEventListener("contextmenu", (e) => {
    if (holdOpen() || press || revealed) e.preventDefault();
  });
  listEl.addEventListener("touchcancel", cancelPress);
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (
        revealed?.settled &&
        (!listEl.contains(e.target as Node) || e.pointerType !== "touch")
      ) {
        if (!revealed.tray.element.contains(e.target as Node)) close();
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && revealed?.settled) close();
    },
    true,
  );
  enabled.addEventListener("change", () => {
    if (!enabled.matches) {
      cancelPress();
      close();
    }
  });

  return {
    active: () => !!press?.active,
    blocksDrag: () => holdOpen() || !!press,
    sync: () => {
      if (!revealed?.settled) return;
      const { row, id, direction, items } = revealed;
      const latest = itemsFor(id, (a) => a.swipe === direction);
      if (
        !row.isConnected ||
        latest.length !== items.length ||
        latest.some((item, i) => item.key !== items[i]!.key)
      )
        close();
    },
    takeTap: () => {
      const taken = swallowTap;
      swallowTap = false;
      return taken;
    },
  };
}
