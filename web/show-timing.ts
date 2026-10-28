// Bounded DOM-free log for cold-load stages and click-to-painted waits.
// Browser diagnostics expose marks/measures, one cold-load report and
// window.recurseShowTiming() for read-only inspection.
import { interactionTrace, recordUiTiming } from "./interaction-timing.js";

export interface StageTiming {
  readonly name: string;
  readonly at: number;
}

export interface InteractionTiming {
  readonly id: string;
  readonly ms: number;
}

export interface ConversationRequestTiming {
  readonly traceId: string;
  readonly clickToDispatchMs: number;
}

export interface ShowTimingSnapshot {
  readonly coldStages: StageTiming[];
  readonly coldComplete: boolean;
  readonly recentSwitches: InteractionTiming[];
  readonly slowestSwitchMs: number | null;
  readonly medianSwitchMs: number | null;
}

export const RECENT_SWITCH_LIMIT = 20;

export class ShowTimingLog {
  private readonly stages: StageTiming[] = [];
  private readonly seenStages = new Set<string>();
  private readonly recent: InteractionTiming[] = [];
  private pending: { id: string; at: number } | null = null;
  private pendingRequest: { id: string; at: number; traceId: string } | null =
    null;
  private slowest: number | null = null;
  private reportedCold = false;

  constructor(
    private readonly now: () => number,
    private readonly limit = RECENT_SWITCH_LIMIT,
  ) {}

  // Records only the first occurrence of a cold-load stage.
  stage(name: string): boolean {
    if (this.seenStages.has(name)) return false;
    this.seenStages.add(name);
    this.stages.push({ name, at: this.now() });
    return true;
  }

  // A newer open replaces an unpainted open: only the latest wait is timed.
  begin(id: string, traceId = ""): void {
    const at = this.now();
    this.pending = { id, at };
    this.pendingRequest = traceId ? { id, at, traceId } : null;
  }

  /** Claim the first focused request caused by this exact open. Cached paint
   *  does not consume it: dispatch can happen after synchronous cache work. */
  requestDispatched(id: string): ConversationRequestTiming | null {
    if (!this.pendingRequest || this.pendingRequest.id !== id) return null;
    const timing = {
      traceId: this.pendingRequest.traceId,
      clickToDispatchMs: this.now() - this.pendingRequest.at,
    };
    this.pendingRequest = null;
    return timing;
  }

  // Times paint only against a matching open, never a poll-driven repaint.
  painted(id: string): InteractionTiming | null {
    if (!this.pending || this.pending.id !== id) return null;
    const timing = { id, ms: this.now() - this.pending.at };
    this.pending = null;
    this.recent.push(timing);
    while (this.recent.length > this.limit) this.recent.shift();
    if (this.slowest === null || timing.ms > this.slowest)
      this.slowest = timing.ms;
    return timing;
  }

  // Returns chronological cold stages once all arrive, exactly once per page.
  // Reads race, so reporting at paint alone could omit an unfinished read.
  takeColdReport(names: readonly string[]): StageTiming[] | null {
    if (this.reportedCold) return null;
    if (!names.every((name) => this.seenStages.has(name))) return null;
    this.reportedCold = true;
    return this.snapshot().coldStages;
  }

  snapshot(): ShowTimingSnapshot {
    const sorted = this.recent.map((item) => item.ms).sort((a, b) => a - b);
    return {
      // Invariant: In time order, which is not arrival order: the tree read and
      // the focused read race, and a gap between consecutive stages is the
      // number that matters, so the report has to read chronologically.
      coldStages: [...this.stages].sort((a, b) => a.at - b.at),
      coldComplete: this.seenStages.has(COLD_PAINTED),
      recentSwitches: [...this.recent],
      slowestSwitchMs: this.slowest,
      medianSwitchMs: sorted.length
        ? sorted[Math.floor(sorted.length / 2)]
        : null,
    };
  }
}

export const COLD_TREE = "tree-read";
export const COLD_FOCUSED = "focused-read";
export const COLD_PAINTED = "first-turn-painted";

const hasPerformance = typeof performance !== "undefined";
const log = new ShowTimingLog(() =>
  hasPerformance ? performance.now() : Date.now(),
);

const COLD_STAGES = [COLD_TREE, COLD_FOCUSED, COLD_PAINTED] as const;
const OPEN_MARK = "recurse:open-conversation";
const SWITCH_MEASURE = "recurse:click-to-painted-turn";
let fallbackTraceSequence = 0;
let showTrace = "";

function switchTraceId(): string {
  try {
    const value = crypto.randomUUID().replaceAll("-", "");
    if (value) return value;
  } catch {}
  fallbackTraceSequence += 1;
  return `${Date.now().toString(16)}${fallbackTraceSequence.toString(16).padStart(8, "0")}`.padEnd(
    32,
    "0",
  );
}

// Per-switch entries would otherwise accumulate in the browser's user-timing
// buffer for the tab's lifetime. Only the latest switch needs to be on the
// timeline; the bounded ring above is what keeps the history.
function mark(name: string, replace = false): void {
  try {
    if (replace) performance.clearMarks?.(name);
    performance.mark?.(name);
  } catch {}
}

function measure(name: string, ms: number, startMs: number): void {
  try {
    performance.clearMeasures?.(name);
    performance.measure?.(name, { start: startMs, duration: ms });
  } catch {}
}

/** Report the first tree read, first focused read, and first painted turn. */
export function coldStage(name: string): void {
  if (!log.stage(name)) return;
  recordUiTiming(`cold:${name}`, performance.now());
  mark(`recurse:cold:${name}`);
  const report = log.takeColdReport(COLD_STAGES);
  if (report)
    console.info(
      "Cold load stages (ms from page start): " +
        report.map((item) => `${item.name} ${Math.round(item.at)}`).join(", "),
    );
}

/** The reader opened a conversation; the clock runs until its thread paints. */
export function beginShowingConversation(id: string): void {
  showTrace = interactionTrace() || switchTraceId();
  log.begin(id, showTrace);
  mark(OPEN_MARK, true);
}

/** Correlate this open's first focused fetch with server-side timings. */
export function conversationRequestDispatched(
  id: string,
): ConversationRequestTiming | null {
  return log.requestDispatched(id);
}

/** This conversation's thread is on screen. */
export function conversationPainted(id: string): void {
  coldStage(COLD_PAINTED);
  const timing = log.painted(id);
  if (timing) {
    recordUiTiming("conversation-switch", timing.ms, id, showTrace);
    measure(
      SWITCH_MEASURE,
      timing.ms,
      (hasPerformance ? performance.now() : Date.now()) - timing.ms,
    );
  }
}

export function showTimingSnapshot(): ShowTimingSnapshot {
  return log.snapshot();
}

if (typeof window !== "undefined")
  (window as unknown as Record<string, unknown>).recurseShowTiming =
    showTimingSnapshot;
