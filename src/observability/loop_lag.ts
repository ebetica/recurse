// Unref'd main/Worker timers; idle emits nothing. No native CPU/memory reads.
// observer_late_ms: max observer lateness in window, including overdue ticks.
// Both late suggests shared pause; only main late suggests main-thread work.
// No snapshot waits. window_ms excludes diagnostics; spans aren't CPU causes.

import { Worker } from "node:worker_threads";
import { templateRoute } from "../http_transport";
import {
  drainSlowSpans,
  drainWorkerReplies,
  overlappingOpenPhases,
} from "./slow_span";
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
  private observer: { worker: Worker; state: BigInt64Array } | null = null;
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
    drainWorkerReplies(-Infinity);
    this.windowStart = this.now();
    this.startObserver();
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const observer = this.observer;
    this.observer = null;
    void observer?.worker.terminate();
  }

  private startObserver(): void {
    try {
      const state = new BigInt64Array(new SharedArrayBuffer(5 * 8));
      Atomics.store(state, 0, this.observerClock());
      const worker = new Worker(
        new URL("./loop_lag.worker.ts", import.meta.url),
        {
          workerData: {
            buffer: state.buffer,
            intervalMs: Math.max(50, this.intervalMs),
          },
        },
      );
      const observer = { worker, state };
      this.observer = observer;
      const failed = () => {
        if (this.observer !== observer) return;
        this.observer = null;
        void worker.terminate();
      };
      worker.on("error", failed);
      worker.on("exit", failed);
      worker.unref();
    } catch {
      this.observer = null;
    }
  }

  private observerClock(): bigint {
    return BigInt(Math.floor(performance.timeOrigin + performance.now()));
  }

  private observerLateness(): number | undefined {
    const state = this.observer?.state;
    if (!state) return undefined;
    const now = this.observerClock();
    const start = Atomics.load(state, 0);
    const version = Atomics.load(state, 1);
    const window = Atomics.load(state, 2);
    const expected = Atomics.load(state, 3);
    const maximum = Atomics.load(state, 4);
    const endVersion = Atomics.load(state, 1);
    if (!expected || version % 2n !== 0n || version !== endVersion)
      return undefined;
    return Math.max(
      0,
      window === start ? Number(maximum) : 0,
      Number(now - (expected > start ? expected : start)),
    );
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
    if (this.observer)
      Atomics.store(this.observer.state, 0, this.observerClock());
    this.timer = setTimeout(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  private sample(): void {
    const now = this.now();
    const late = Math.max(0, now - this.expected);
    this.samples.push(late);
    if (this.options.runningCount() > 0) this.active = true;
    const start = this.expected - this.intervalMs;
    const spans = drainSlowSpans(start, now);
    const replies = drainWorkerReplies(start);
    if (late > this.stallMs)
      this.stall(late, now, spans, replies, this.observerLateness());
    this.finished = [];
    if (now - this.windowStart >= this.summaryMs) this.summarize(now);
    this.schedule();
  }

  private stall(
    late: number,
    now: number,
    spans: string[],
    replies: string[],
    observerLate: number | undefined,
  ): void {
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
        ...(observerLate === undefined
          ? {}
          : { observer_late_ms: observerLate }),
        window_ms: Math.round(now - this.expected + this.intervalMs),
        routes: [...routes],
        conversations,
        jobs,
        spans,
        worker_replies: replies,
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
