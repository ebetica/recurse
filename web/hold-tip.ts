// Visual-only instant hold tips for Stop/Delete/Takeover never shift layout.
// Buttons own actions and accessible meaning; detail-0 keyboard/AT clicks
// remain native. Holds only reveal, not confirm.

export const HOLD_TO_REVEAL_MS = 600;
export const HOLD_TIP_TIMEOUT_MS = 3000;
// Suppresses only the click immediately following a hold, never later clicks.
const HOLD_CONSUME_MS = 1500;

export interface HoldTipClock {
  now(): number;
  /** Schedule fn; the returned callback cancels it. */
  after(ms: number, fn: () => void): () => void;
}

const systemClock: HoldTipClock = {
  now: () => performance.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface HoldTipOptions {
  /** Current tip text; null means nothing to show (button not actionable). */
  text: () => string | null;
  /** Gate presses (e.g. the composer button in Send mode tracks nothing). */
  enabled?: () => boolean;
  /** Fired when a press reaches the hold threshold. */
  onHold?: () => void;
  /** Fired when a held pointer is released (after the hold callback). */
  onHoldEnd?: () => void;
  clock?: HoldTipClock;
  holdMs?: number;
  tipMs?: number;
}

export interface HoldTip {
  // Consumes held-press clicks only; keyboard/AT activation remains native.
  takeHoldConsumed(): boolean;
  /** Show the current text now; auto-hides after the tip timeout. */
  show(): void;
  /** Keep the tip up (armed) until hide(). */
  pin(): void;
  hide(): void;
  // Drops stale tips when repaint makes a button unactionable; null never arms.
  sync(): void;
}

export interface HoldTipConfirmation<T> {
  // Arms on first activation; second activation returns true and disarms.
  activate(target: T): boolean;
  isArmed(target: T): boolean;
  disarm(): void;
  /** Disarm when the active target changes or becomes unactionable. */
  sync(target: T | null): void;
}

export function createHoldTipConfirmation<T>(
  tip: HoldTip,
  opts: {
    clock?: HoldTipClock;
    timeoutMs?: number;
    onArmedChange?: (armed: boolean) => void;
  } = {},
): HoldTipConfirmation<T> {
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.timeoutMs ?? HOLD_TIP_TIMEOUT_MS;
  let armed = false;
  let armedTarget: T;
  let cancelDisarm: (() => void) | null = null;

  const disarm = () => {
    if (!armed) return;
    armed = false;
    cancelDisarm?.();
    cancelDisarm = null;
    opts.onArmedChange?.(false);
    tip.hide();
  };

  return {
    activate: (target) => {
      if (armed && Object.is(armedTarget, target)) {
        disarm();
        return true;
      }
      disarm();
      armed = true;
      armedTarget = target;
      opts.onArmedChange?.(true);
      tip.pin();
      cancelDisarm = clock.after(timeoutMs, disarm);
      return false;
    },
    isArmed: (target) => armed && Object.is(armedTarget, target),
    disarm,
    sync: (target) => {
      if (armed && (target === null || !Object.is(armedTarget, target)))
        disarm();
    },
  };
}

export function attachHoldTip(
  anchor: HTMLButtonElement,
  doc: Document,
  opts: HoldTipOptions,
): HoldTip {
  const clock = opts.clock ?? systemClock;
  const holdMs = opts.holdMs ?? HOLD_TO_REVEAL_MS;
  const tipMs = opts.tipMs ?? HOLD_TIP_TIMEOUT_MS;
  const tip = doc.createElement("div");
  tip.className = "hold-tip";
  tip.setAttribute("aria-hidden", "true");
  doc.body.appendChild(tip);

  let pressing = false;
  let held = false;
  let heldAt = 0;
  let holdReleased = false;
  let pinned = false;
  let stashedTitle: string | null = null;
  let cancelHold: (() => void) | null = null;
  let cancelHide: (() => void) | null = null;

  const clearHide = () => {
    cancelHide?.();
    cancelHide = null;
  };

  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const vw = doc.documentElement?.clientWidth || 1024;
    const vh =
      doc.documentElement?.clientHeight || doc.defaultView?.innerHeight || 768;
    const margin = 8;
    const gap = 8;
    const width = tip.offsetWidth || 192;
    const height = tip.offsetHeight || 48;
    const right = rect.left + rect.width;
    const inTitleRow =
      rect.top < 64 || Boolean(anchor.closest?.("#conv-titlebar"));

    if (inTitleRow) {
      const leftRoom = rect.left - margin;
      const rightRoom = vw - right - margin;
      const rawLeft =
        leftRoom >= rightRoom ? rect.left - gap - width : right + gap;
      const maxLeft = Math.max(margin, vw - width - margin);
      const left = Math.min(Math.max(rawLeft, margin), maxLeft);
      const anchorHeight = rect.height || rect.bottom - rect.top;
      const center = rect.top + anchorHeight / 2;
      const minCenter = margin + height / 2;
      const maxCenter = Math.max(minCenter, vh - margin - height / 2);
      const top = Math.min(Math.max(center, minCenter), maxCenter);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      tip.style.transform = "translateY(-50%)";
      return;
    }

    if (rect.top > vh / 2) {
      const rightRoom = vw - (rect.left + rect.width) - margin;
      if (rightRoom >= width + gap) {
        tip.style.left = `${rect.left + rect.width + gap}px`;
        tip.style.top = `${rect.top + (rect.height || rect.bottom - rect.top) / 2}px`;
        tip.style.transform = "translateY(-50%)";
        return;
      }
      const leftRoom = rect.left - margin;
      if (leftRoom >= width + gap) {
        tip.style.left = `${rect.left - gap}px`;
        tip.style.top = `${rect.top + (rect.height || rect.bottom - rect.top) / 2}px`;
        tip.style.transform = "translate(-100%, -50%)";
        return;
      }
    }

    const half = width / 2 + margin;
    const x = Math.min(Math.max(rect.left + rect.width / 2, half), vw - half);
    tip.style.left = `${x}px`;
    tip.style.top = `${rect.top - gap}px`;
    tip.style.transform = "translate(-50%, -100%)";
  };

  const showTip = (autoHide: boolean): boolean => {
    const text = opts.text();
    if (!text) return false;
    if (anchor.title) {
      stashedTitle = anchor.title;
      anchor.title = "";
    }
    tip.textContent = text;
    tip.classList.add("on");
    place();
    clearHide();
    if (autoHide)
      cancelHide = clock.after(tipMs, () => {
        if (!pinned) hideTip();
      });
    return true;
  };

  const hideTip = () => {
    pinned = false;
    clearHide();
    tip.classList.remove("on");
    // Invariant: A repaint may have set a fresh title while the tip was up
    // (e.g. the Stop button repaint on disarm); only restore the title we
    // cleared.
    if (stashedTitle !== null && anchor.title === "")
      anchor.title = stashedTitle;
    stashedTitle = null;
  };

  const hoverHide = () => {
    if (!pinned) hideTip();
  };

  const repark = () => {
    if (tip.classList.contains("on")) place();
  };
  doc.defaultView?.addEventListener("scroll", repark, {
    passive: true,
    capture: true,
  });
  doc.defaultView?.addEventListener("resize", repark);

  anchor.addEventListener("pointerdown", (event: PointerEvent) => {
    // Invariant: Only the primary press can hold: a long right-press must
    // neither peek nor (on Take over) toggle.
    if ((event?.button ?? 0) !== 0) return;
    if (opts.enabled && !opts.enabled()) return;
    pressing = true;
    held = false;
    holdReleased = false;
    cancelHold?.();
    cancelHold = clock.after(holdMs, () => {
      cancelHold = null;
      if (!pressing) return;
      pressing = false;
      held = true;
      heldAt = clock.now();
      showTip(true);
      opts.onHold?.();
    });
  });
  const endPress = () => {
    const releaseHold = held && !holdReleased;
    pressing = false;
    cancelHold?.();
    cancelHold = null;
    if (releaseHold) {
      holdReleased = true;
      opts.onHoldEnd?.();
    }
  };
  anchor.addEventListener("pointerup", endPress);
  anchor.addEventListener("pointercancel", endPress);
  anchor.addEventListener("pointerleave", () => {
    endPress();
    hoverHide();
  });
  anchor.addEventListener("blur", hoverHide);
  anchor.addEventListener("mouseenter", () => {
    if (opts.enabled && !opts.enabled()) return;
    showTip(false);
  });
  anchor.addEventListener("mouseleave", hoverHide);
  // Invariant: Capture Escape because handled keymap events stop propagation.
  // It drops hover/peek only; pinned tips clear with their confirmation arm.
  doc.addEventListener(
    "keydown",
    (event: Event) => {
      if ((event as KeyboardEvent).key === "Escape") hoverHide();
    },
    true,
  );

  // Invariant: A repaint can replace the anchor (a re-rendered sidebar button):
  // the parked div in body would then float forever, so removal hides the tip
  // and unparks it. Guarded for DOM-free tests, which have no observer.
  if (typeof MutationObserver !== "undefined" && doc.body) {
    const observer = new MutationObserver(() => {
      if (anchor.isConnected) return;
      observer.disconnect();
      pressing = false;
      held = false;
      cancelHold?.();
      cancelHold = null;
      hideTip();
      tip.remove();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  return {
    takeHoldConsumed: () => {
      if (!held) return false;
      held = false;
      return clock.now() - heldAt < HOLD_CONSUME_MS;
    },
    show: () => showTip(true),
    pin: () => {
      if (showTip(false)) pinned = true;
    },
    hide: hideTip,
    sync: () => {
      if (!opts.text()) hideTip();
    },
  };
}
