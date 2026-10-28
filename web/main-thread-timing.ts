// Bounded, lossy main-thread stall diagnostics. Never reads DOM text or input.
// Prefer frame script attribution; one deferred task fallback, no retries.
import { enqueueUiTiming } from "./interaction-timing.js";
import {
  STALL_MARKERS,
  sanitizeStall,
  type UiStall,
} from "../src/web/timing_labels.js";
type Frame = PerformanceEntry & { scripts?: UiStall["scripts"] };
const markers: UiStall["markers"] = [];
export function markMainThreadEvent(
  name: (typeof STALL_MARKERS)[number],
): void {
  markers.push({ name, at: Math.round(performance.now()) });
  if (markers.length > 8) markers.shift();
}
export function startMainThreadTiming(
  context: () => Omit<
    UiStall,
    "label" | "ms" | "trace_id" | "markers" | "scripts"
  >,
  hidden: () => boolean,
): void {
  for (const name of STALL_MARKERS)
    window.addEventListener(
      `recurse:${name}`,
      () => markMainThreadEvent(name),
      { capture: true },
    );
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = (entry: Frame) => {
    if (document.hidden || hidden() || performance.now() - last < 10_000)
      return;
    last = performance.now();
    const item: UiStall = {
      label: "main_thread_blocked",
      ms: Math.round(entry.duration),
      trace_id: "",
      ...context(),
      markers: markers.map((m) => ({
        name: m.name,
        at: entry.startTime + entry.duration - m.at,
      })),
      scripts: entry.scripts || [],
    };
    enqueueUiTiming({ ...item, ...sanitizeStall(item, location.origin) });
  };
  for (const type of ["longtask", "long-animation-frame"]) {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration <= 200) continue;
          if (type === "long-animation-frame") {
            clearTimeout(timer);
            timer = undefined;
            report(entry);
          } else if (!timer)
            timer = setTimeout(() => {
              timer = undefined;
              report(entry);
            }, 250);
        }
      }).observe({ type });
    } catch {}
  }
}
