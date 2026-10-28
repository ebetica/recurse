// One unref'd timer measures loop lag; idle servers emit nothing.
// Align CPU with window_ms, separate from timer lag and diagnostics_ms.
// Bounded names and heap/RSS are diagnostics, sampled outside the CPU window.
// Active windows summarize lag percentiles/max/count; no per-sample logs.

import { templateRoute } from "../http_transport";
import { drainSlowSpans } from "./slow_span";
import { INFO, WARNING, logEvent, type RuntimeLogger } from "./runtime_logging";

const SHOWN = 3;
const MB = 1024 * 1024;
const micros = ({ user, system }: NodeJS.CpuUsage) => user + system;
const threadCpuUsage = (
  process as NodeJS.Process & { threadCpuUsage?: () => NodeJS.CpuUsage }
).threadCpuUsage;

export interface LoopLagOptions {
  readonly logger: RuntimeLogger;

  readonly runningCount: () => number;
  /** Their ids (read only for a stall). */
  readonly runningConversations: () => readonly string[];
  /** Names of detached tasks in flight (read only for a stall). */
  readonly jobs?: () => readonly string[];
  /** Process CPU time (default process.cpuUsage). */
  readonly cpuUsage?: () => NodeJS.CpuUsage;
  /** Process memory (default process.memoryUsage). */
  readonly memoryUsage?: () => NodeJS.MemoryUsage;
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
  private readonly cpuUsage: () => NodeJS.CpuUsage;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private cpuStart = 0;
  private mainCpuStart: number | undefined;
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
    this.cpuUsage = options.cpuUsage ?? process.cpuUsage;
    this.memoryUsage = options.memoryUsage ?? process.memoryUsage;
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
    this.cpuStart = micros(this.cpuUsage());
    const mainCpu = threadCpuUsage?.();
    this.mainCpuStart = mainCpu ? micros(mainCpu) : undefined;
    this.timer = setTimeout(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  private sample(): void {
    const cpu = this.cpuUsage();
    const mainCpu = threadCpuUsage?.();
    const now = this.now();
    const late = Math.max(0, now - this.expected);
    this.samples.push(late);
    if (this.options.runningCount() > 0) this.active = true;
    const spans = drainSlowSpans();
    if (late > this.stallMs) this.stall(late, now, cpu, mainCpu, spans);
    this.finished = [];
    if (now - this.windowStart >= this.summaryMs) this.summarize(now);
    this.schedule();
  }

  private stall(
    late: number,
    now: number,
    cpu: NodeJS.CpuUsage,
    mainCpu: NodeJS.CpuUsage | undefined,
    spans: string[],
  ): void {
    const routes = new Set<string>();
    for (const request of [...this.inFlight, ...this.finished]) {
      if (routes.size >= SHOWN) break;
      routes.add(templateRoute(request.route));
    }
    const { heapUsed, rss } = this.memoryUsage();
    const conversations = this.options.runningConversations().slice(0, SHOWN);
    const jobs = [...new Set(this.options.jobs?.() ?? [])].slice(0, 6);
    logEvent(this.options.logger, WARNING, "event_loop_stall", {
      fields: {
        ms: Math.round(late),
        window_ms: Math.round(now - this.expected + this.intervalMs),
        routes: [...routes],
        conversations,
        cpu_ms: Math.round((micros(cpu) - this.cpuStart) / 1000),
        main_cpu_ms:
          mainCpu && this.mainCpuStart !== undefined
            ? Math.round((micros(mainCpu) - this.mainCpuStart) / 1000)
            : undefined,
        heap_mb: Math.round(heapUsed / MB),
        rss_mb: Math.round(rss / MB),
        jobs,
        spans,
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
