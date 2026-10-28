// Bounded, lossy input-to-paint telemetry, never on the fetch path.
// Labels use only known shell ids or element types, never DOM text/values.
import {
  TIMING_TARGETS,
  TIMING_EVENTS,
  type UiStall,
} from "../src/web/timing_labels.js";
type Timing = {
  label: string;
  ms: number;
  conversation_id: string;
  trace_id: string;
};
const shellIds = new Set(TIMING_TARGETS);
const queue: (Timing | UiStall)[] = [];
const pending: { at: number; name: string; timing: Timing }[] = [];
let active: Timing | null = null;
let scheduled = false;
let conversationId = () => "";
export function recordUiTiming(
  label: string,
  ms: number,
  conversation_id = conversationId(),
  trace_id = "",
): void {
  if (typeof window === "undefined") return;
  enqueueUiTiming({ label, ms: Math.round(ms), conversation_id, trace_id });
}
export function enqueueUiTiming(item: Timing | UiStall): void {
  queue.push(item);
  if (queue.length > 100) queue.shift();
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    const flush = () => {
      scheduled = false;
      const batch = queue.splice(0, 100);
      void fetch("/api/ui-timing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    };
    if ("requestIdleCallback" in window)
      window.requestIdleCallback(flush, { timeout: 2000 });
    else setTimeout(flush, 0);
  }, 5000);
}
/** Only requests dispatched by the input handler inherit its trace. */
export function interactionTrace(): string {
  if (!active) return "";
  try {
    return (active.trace_id ||= Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""));
  } catch {
    return "";
  }
}
export function startInteractionTiming(
  currentConversation: () => string,
): void {
  conversationId = currentConversation;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const match = pending.find(
          (item) =>
            item.name === entry.name && Math.abs(item.at - entry.startTime) < 2,
        );
        if (match) match.timing.ms = Math.round(entry.duration);
      }
    });
    observer.observe({
      type: "event",
      buffered: true,
      durationThreshold: 16,
    } as PerformanceObserverInit);
  } catch {}
  for (const name of TIMING_EVENTS) {
    document.addEventListener(
      name,
      (event) => {
        if (!event.isTrusted) return;
        const element = (event.target as Element)?.closest?.(
          "button, input, textarea, select, a, summary, [role=button], [role=treeitem]",
        );
        const label = shellIds.has(element?.id || "")
          ? element!.id
          : element?.tagName.toLowerCase() || "document";
        const timing: Timing = {
          label: `${name}:${label}`,
          ms: 0,
          conversation_id: conversationId(),
          trace_id: "",
        };
        const item = { at: event.timeStamp, name, timing };
        pending.push(item);
        if (pending.length > 100) pending.shift();
        active = timing;
        setTimeout(() => {
          if (active === timing) active = null;
        }, 0);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            timing.ms ||= Math.round(performance.now() - item.at);
            recordUiTiming(
              timing.label,
              timing.ms,
              timing.conversation_id,
              timing.trace_id,
            );
            // Invariant: Event Timing may follow fallback but precede upload.
            queue[queue.length - 1] = timing;
          }),
        );
      },
      { capture: true, passive: true },
    );
  }
}
