import { randomUUID } from "node:crypto";
import { wrapSystemReminder } from "./rewrite.ts";

export const DEFAULT_MONITOR_WAKE_DEBOUNCE_MS = 1000;
export const DEFAULT_MONITOR_WAKE_COOLDOWN_MS = 60_000;
export const DEFAULT_MONITOR_WAKE_MAX_BYTES = 16 * 1024;
export const DEFAULT_MONITOR_HEARTBEAT_PATTERN = /^idle$/i;

const TRUNCATED =
  "\n… monitor output truncated; read the full log for complete output";
export const MONITOR_NOISE_REMINDER =
  "This monitor is too chatty. Cancel it and restart it with output only when the state changes.";
/** The noise reminder as a distinctly-rendered reminder block. */
export const MONITOR_NOISE_REMINDER_BLOCK = wrapSystemReminder(
  MONITOR_NOISE_REMINDER,
);
const MONITOR_NOISE_REMINDER_SEPARATOR = "\n\n";
const MONITOR_NOISE_REMINDER_LINES = 3;
// Smallest cap preserving exact reminder plus safely clipped monitor text.
export const MIN_MONITOR_WAKE_MAX_BYTES = Math.max(
  256,
  byteLength(TRUNCATED) +
    byteLength(MONITOR_NOISE_REMINDER_SEPARATOR) +
    byteLength(MONITOR_NOISE_REMINDER_BLOCK) +
    1,
);
const MAX_PENDING_LINES_PER_MONITOR = 100;
export interface MonitorBatchDetails {
  monitorBatchId: string;
}

export type MonitorWakeDelivery = (
  message: string,
  triggerTurn: boolean,
  details: MonitorBatchDetails,
) => void;
export type MonitorWakeScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

export interface MonitorWakeConfig {
  debounceMs: number;
  cooldownMs: number;
  maxBytes: number;
  heartbeatPattern: RegExp | undefined;
  redact: boolean;
}

interface PendingMonitor {
  lines: string[];
  omitted: number;
}

const defaultScheduler: MonitorWakeScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Keep a UTF-8-safe prefix within an exact byte budget. */
function clip(value: string, maxBytes: number): string {
  const budget = Math.max(0, Math.floor(maxBytes));
  if (byteLength(value) <= budget) return value;
  if (budget === 0) return "";
  const marker = byteLength(TRUNCATED) <= budget ? TRUNCATED : "";
  const contentBudget = budget - byteLength(marker);
  let out = "";
  for (const char of value) {
    if (byteLength(out + char) > contentBudget) break;
    out += char;
  }
  return out + marker;
}

// Redact credential-shaped values from model-injected monitor output.
export function redactMonitorLine(line: string): string {
  return line
    .replace(
      /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

// Coalesce meaningful monitor lines per debounce window into one
// turn-triggering message. Accepted/active turns buffer later output for the
// next batch. Consecutive repeats and heartbeats stay only in the log.
export class MonitorWakeCoalescer {
  private readonly deliver: MonitorWakeDelivery;
  private readonly schedule: MonitorWakeScheduler;
  private readonly cfg: MonitorWakeConfig;
  private readonly pending = new Map<string, PendingMonitor>();
  private readonly lastMeaningfulLine = new Map<string, string>();
  private cancelScheduled: (() => void) | undefined;
  private activeTurn = false;
  private inflight: { id: string; shellIds: Set<string> } | undefined;
  private lastDeliveryAt = 0;
  private disposed = false;

  constructor(
    deliver: MonitorWakeDelivery,
    config: Partial<MonitorWakeConfig> = {},
    schedule: MonitorWakeScheduler = defaultScheduler,
  ) {
    this.deliver = deliver;
    this.schedule = schedule;
    const merged = {
      debounceMs: DEFAULT_MONITOR_WAKE_DEBOUNCE_MS,
      cooldownMs: DEFAULT_MONITOR_WAKE_COOLDOWN_MS,
      maxBytes: DEFAULT_MONITOR_WAKE_MAX_BYTES,
      heartbeatPattern: DEFAULT_MONITOR_HEARTBEAT_PATTERN,
      redact: true,
      ...config,
    };
    const requestedMaxBytes = Number.isFinite(merged.maxBytes)
      ? Math.floor(merged.maxBytes)
      : DEFAULT_MONITOR_WAKE_MAX_BYTES;
    merged.maxBytes = Math.max(MIN_MONITOR_WAKE_MAX_BYTES, requestedMaxBytes);
    this.cfg = merged;
  }

  turnStarted(): void {
    this.activeTurn = true;
  }

  /** Return true only when this run consumed this coalescer's own batch. */
  turnEnded(deliveredBatchIds: ReadonlySet<string> = new Set()): boolean {
    this.activeTurn = false;
    const matched = Boolean(
      this.inflight && deliveredBatchIds.has(this.inflight.id),
    );
    if (matched) this.inflight = undefined;
    this.scheduleFlush();
    return matched;
  }

  hasInflightFor(shellId: string): boolean {
    return this.inflight?.shellIds.has(shellId) ?? false;
  }

  isAwaitingTurn(): boolean {
    return this.inflight !== undefined;
  }

  send(shellId: string, lines: readonly string[]): void {
    if (this.disposed) return;
    const meaningful: string[] = [];
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line || this.cfg.heartbeatPattern?.test(line)) continue;
      if (this.lastMeaningfulLine.get(shellId) === line) continue;
      this.lastMeaningfulLine.set(shellId, line);
      meaningful.push(this.cfg.redact ? redactMonitorLine(line) : line);
    }
    if (meaningful.length === 0) return;
    const pending = this.pending.get(shellId) ?? { lines: [], omitted: 0 };
    pending.lines.push(...meaningful);
    if (pending.lines.length > MAX_PENDING_LINES_PER_MONITOR) {
      const overflow = pending.lines.length - MAX_PENDING_LINES_PER_MONITOR;
      pending.lines.splice(0, overflow);
      pending.omitted += overflow;
    }
    this.pending.set(shellId, pending);
    this.scheduleFlush();
  }

  discard(shellId: string): void {
    this.pending.delete(shellId);
    this.lastMeaningfulLine.delete(shellId);
    if (this.pending.size === 0) {
      this.cancelScheduled?.();
      this.cancelScheduled = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
    this.pending.clear();
    this.lastMeaningfulLine.clear();
    this.inflight = undefined;
  }

  private scheduleFlush(): void {
    if (
      this.disposed ||
      this.activeTurn ||
      this.inflight ||
      this.cancelScheduled ||
      this.pending.size === 0
    ) {
      return;
    }
    const cooldownRemaining =
      this.lastDeliveryAt + this.cfg.cooldownMs - Date.now();
    const delay = Math.max(0, this.cfg.debounceMs, cooldownRemaining);
    this.cancelScheduled = this.schedule(() => {
      this.cancelScheduled = undefined;
      this.flush();
    }, delay);
  }

  /** One wake-batch body exactly as it would be delivered. */
  private formatBatch(batch: Array<[string, PendingMonitor]>): string {
    const sections = batch.map(([shellId, pending]) => {
      const omitted =
        pending.omitted > 0
          ? `… ${pending.omitted} earlier lines coalesced\n`
          : "";
      return `[monitor ${shellId}]\n${omitted}${pending.lines.join("\n")}`;
    });
    const meaningfulLineCount = batch.reduce(
      (count, [, pending]) => count + pending.lines.length,
      0,
    );
    const prefix =
      sections.length > 1
        ? `${sections.length} monitors emitted new output.\n\n`
        : "";
    const body = prefix + sections.join("\n\n");
    return meaningfulLineCount >= MONITOR_NOISE_REMINDER_LINES
      ? withNoiseReminder(body, this.cfg.maxBytes)
      : clip(body, this.cfg.maxBytes);
  }

  private flush(): void {
    if (
      this.disposed ||
      this.activeTurn ||
      this.inflight ||
      this.pending.size === 0
    )
      return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    const message = this.formatBatch(batch);
    if (!message) return;
    // Invariant: Mark before re-entrant delivery can schedule another turn.
    // Only this batch's message id releases the guard, never unrelated turns.
    const batchId = randomUUID();
    this.inflight = {
      id: batchId,
      shellIds: new Set(batch.map(([shellId]) => shellId)),
    };
    this.lastDeliveryAt = Date.now();
    try {
      this.deliver(message, true, { monitorBatchId: batchId });
    } catch {
      this.inflight = undefined;
      // Invariant: Restore failed delivery ahead of callback-queued output,
      // preserving per-shell order.
      const newer = new Map(this.pending);
      this.pending.clear();
      for (const [shellId, failed] of batch) {
        const next = newer.get(shellId);
        this.pending.set(
          shellId,
          next
            ? {
                lines: [...failed.lines, ...next.lines],
                omitted: failed.omitted + next.omitted,
              }
            : failed,
        );
        newer.delete(shellId);
      }
      for (const entry of newer) this.pending.set(...entry);
      this.scheduleFlush();
    }
  }
}

function withNoiseReminder(body: string, maxBytes: number): string {
  const budget = Math.max(MIN_MONITOR_WAKE_MAX_BYTES, Math.floor(maxBytes));
  const bodyBudget =
    budget -
    byteLength(MONITOR_NOISE_REMINDER_BLOCK) -
    byteLength(MONITOR_NOISE_REMINDER_SEPARATOR);
  return `${clip(body, bodyBudget)}${MONITOR_NOISE_REMINDER_SEPARATOR}${MONITOR_NOISE_REMINDER_BLOCK}`;
}
