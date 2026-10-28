// Desktop-only dividers persist widths; double-click restores defaults. Phone
// full-bleed overlays ignore stored widths and hide grips.
import { $ } from "./dom.js";

const SIDEBAR_KEY = "recurse.sidebarWidth";
const PANES_KEY = "recurse.panesWidth";

// Required shell regions declared in index.html.
const sidebarEl = $("#sidebar")!;
const panesEl = $("#panes")!;
const mq = matchMedia("(max-width: 700px)");
const isMobile = (): boolean => mq.matches;

function readWidth(key: string): number | null {
  const v = parseInt(localStorage.getItem(key) || "", 10);
  return Number.isFinite(v) ? v : null;
}

// Leave the chat column at least this wide when clamping either region.
const CHAT_MIN = 420;

function clampSidebar(w: number): number {
  return Math.round(
    Math.max(220, Math.min(w, Math.min(640, innerWidth - CHAT_MIN))),
  );
}
// Clamp against the LIVE sidebar width so a wide sidebar + wide panes can never
// together squeeze the chat below CHAT_MIN.
function clampPanes(w: number): number {
  const sidebar = sidebarEl.getBoundingClientRect().width;
  return Math.round(
    Math.max(320, Math.min(w, innerWidth - sidebar - CHAT_MIN)),
  );
}

// The panes framework reads this on every layout so a dragged width survives
// the per-poll relayout and a fresh open of the panel. Null ⇒ fall back to the
// even flex split (also on mobile, where the overlay owns the width).
export function storedPanesWidth(): number | null {
  if (isMobile()) return null;
  const w = readWidth(PANES_KEY);
  return w == null ? null : clampPanes(w);
}

// ---- sidebar (left) -------------------------------------------------------
function applySidebar(): void {
  const w = readWidth(SIDEBAR_KEY);
  sidebarEl.style.width =
    w != null && !isMobile() ? clampSidebar(w) + "px" : "";
}

// ---- shared drag plumbing -------------------------------------------------
function makeGrip(kind: string, host: HTMLElement): HTMLDivElement {
  const g = document.createElement("div");
  g.className = "resize-grip " + kind;
  g.title = "Drag to resize · double-click to reset";
  host.appendChild(g);
  return g;
}

// onStart(e) returns a context object; onMove(e, ctx) computes/applies/persists
// the new width. Pointer capture keeps events flowing to the grip even when the
// cursor outruns it.
function draggable<C>(
  grip: HTMLElement,
  onStart: (e: PointerEvent) => C,
  onMove: (e: PointerEvent, ctx: C) => void,
): void {
  grip.addEventListener("pointerdown", (e: PointerEvent) => {
    if (isMobile() || e.button !== 0) return;
    e.preventDefault();
    const ctx = onStart(e);
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => onMove(ev, ctx);
    const up = () => {
      grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}

// ---- wire up the two grips ------------------------------------------------
const sidebarGrip = makeGrip("sb", sidebarEl);
draggable(
  sidebarGrip,
  () => ({ left: sidebarEl.getBoundingClientRect().left }),
  (e, ctx) => {
    const w = clampSidebar(e.clientX - ctx.left);
    sidebarEl.style.width = w + "px";
    localStorage.setItem(SIDEBAR_KEY, String(w));
  },
);
sidebarGrip.addEventListener("dblclick", () => {
  localStorage.removeItem(SIDEBAR_KEY);
  applySidebar();
});

const panesGrip = makeGrip("pn", panesEl);
draggable(
  panesGrip,
  () => ({ right: panesEl.getBoundingClientRect().right }),
  (e, ctx) => {
    const w = clampPanes(ctx.right - e.clientX);
    panesEl.style.flex = "none";
    panesEl.style.width = w + "px";
    localStorage.setItem(PANES_KEY, String(w));
  },
);
panesGrip.addEventListener("dblclick", () => {
  localStorage.removeItem(PANES_KEY);
  window.dispatchEvent(new Event("panes-relayout"));
});

// Opening a pane on mobile clears #panes' innerHTML (one column at a time),
// which detaches the grip. panes.js calls this from layout() so the handle is
// re-attached and survives a mobile-open → back-to-desktop round trip.
export function ensurePanesGrip(): void {
  if (!panesGrip.isConnected) panesEl.appendChild(panesGrip);
}

addEventListener("resize", applySidebar);
mq.addEventListener("change", applySidebar);
applySidebar();
