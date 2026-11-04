// One unref'd timer measures lag; active windows summarize, idle emit nothing.
// No native CPU or memory reads: process accounting can itself block.
// window_ms covers the timer interval; diagnostics_ms measures stall details.
// Bounded wall spans and overlapping open phases are context, not CPU causes.

import { templateRoute } from "../http_transport";
import { drainSlowSpans, overlappingOpenPhases } from "./slow_span";
import { INFO, WARNING, logEvent, type RuntimeLogger } from "./runtime_logging";

const SHOWN = 3;

export interface LoopLagOptions {
  readonly logger: RuntimeLogger;

  readonly runningCount: () => number;
  /** Their ids (read only for a stall). */
  readonly runningConversations: () => readonly string[];
  /** Names of detached tasks in flight (read only for a stall). */
  readonly jobs?: () => readonly string[];
  readonly intervalMs?: number;
  readonly stallMs?: number;
  readonly summaryMs?: number;
  readonly now?: () => number;
}

export interface TrackedRequest {
  readonly route: string | null;
}

export class LoopLag {
  private readonly intervalMs: number;
  private readonly stallMs: number;
  private readonly summaryMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expected = 0;
  private windowStart = 0;
  private samples: number[] = [];
  private active = false;
  private readonly inFlight = new Set<TrackedRequest>();
  private finished: TrackedRequest[] = [];

  constructor(private readonly options: LoopLagOptions) {
    this.intervalMs = options.intervalMs ?? 20;
    this.stallMs = options.stallMs ?? 250;
    this.summaryMs = options.summaryMs ?? 60_000;
    this.now = options.now ?? (() => performance.now());
  }

  start(): void {
    if (this.timer !== null) return;
    drainSlowSpans();
    this.windowStart = this.now();
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Track one request until the returned function is called. */
  request(request: TrackedRequest): () => void {
    this.active = true;
    this.inFlight.add(request);
    return () => {
      if (!this.inFlight.delete(request)) return;
      if (this.finished.length < SHOWN) this.finished.push(request);
    };
  }

  private schedule(): void {
    this.expected = this.now() + this.intervalMs;
    this.timer = setTimeout(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  private sample(): void {
    const now = this.now();
    const late = Math.max(0, now - this.expected);
    this.samples.push(late);
    if (this.options.runningCount() > 0) this.active = true;
    const spans = drainSlowSpans();
    if (late > this.stallMs) this.stall(late, now, spans);
    this.finished = [];
    if (now - this.windowStart >= this.summaryMs) this.summarize(now);
    this.schedule();
  }

  private stall(late: number, now: number, spans: string[]): void {
    const routes = new Set<string>();
    for (const request of [...this.inFlight, ...this.finished]) {
      if (routes.size >= SHOWN) break;
      routes.add(templateRoute(request.route));
    }
    const conversations = this.options.runningConversations().slice(0, SHOWN);
    const jobs = [...new Set(this.options.jobs?.() ?? [])].slice(0, 6);
    logEvent(this.options.logger, WARNING, "event_loop_stall", {
      fields: {
        ms: Math.round(late),
        window_ms: Math.round(now - this.expected + this.intervalMs),
        routes: [...routes],
        conversations,
        jobs,
        spans,
        phases: overlappingOpenPhases(this.expected - this.intervalMs, now),
        diagnostics_ms: Math.round(this.now() - now),
      },
    });
  }

  private summarize(now: number): void {
    if (this.active && this.samples.length > 0) {
      const sorted = this.samples.sort((a, b) => a - b);
      const at = (ratio: number) =>
        sorted[
          Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)
        ]!;
      logEvent(this.options.logger, INFO, "event_loop_lag", {
        fields: {
          p50_ms: at(0.5),
          p99_ms: at(0.99),
          max_ms: sorted.at(-1)!,
          samples: sorted.length,
        },
      });
    }
    this.samples = [];
    this.active = this.inFlight.size > 0;
    this.windowStart = now;
  }
}
