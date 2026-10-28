// Cheap bounded startup timing/mechanism counters with injected clock/sink.
// AsyncLocalStorage crosses promises, never implicitly crosses Worker threads.

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export class StartupMeasurement {
  readonly counters = new Map<string, number>();

  constructor(
    readonly key: string,
    readonly started: number,
  ) {}

  count(key: string, amount = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }
}

export interface MeasureOptions {
  /** Monotonic seconds; defaults to performance.now() converted to seconds. */
  readonly now?: () => number;
  /** Receives one complete line; defaults to stdout. */
  readonly write?: (line: string) => void;
}

const active = new AsyncLocalStorage<StartupMeasurement | undefined>();

/** Time an operation and emit its measurement on success or failure. */
export function measure<T>(
  key: string,
  operation: (measurement: StartupMeasurement) => T | Promise<T>,
  options: MeasureOptions = {},
): T | Promise<T> {
  const parentMeasurement = active.getStore();
  const now = options.now ?? monotonicSeconds;
  const write = options.write ?? ((line: string) => console.log(line));
  const measurement = new StartupMeasurement(key, now());
  const finish = (): void => {
    const duration = (now() - measurement.started).toFixed(6);
    const counts = [...measurement.counters.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join(" ");
    const line = `[startup] step=${key} duration_seconds=${duration}${counts ? ` ${counts}` : ""}`;
    // Invariant: Reset the active measurement before printing: top-level
    // output has no active measurement, while nested output may increment its
    // parent.
    active.run(parentMeasurement, () => write(line));
  };

  return active.run(measurement, () => {
    let result: T | Promise<T>;
    try {
      result = operation(measurement);
    } catch (error) {
      finish();
      throw error;
    }
    if (isPromiseLike<T>(result)) {
      return Promise.resolve(result).finally(finish);
    }
    finish();
    return result;
  });
}

/** Increment a counter only while a startup measurement is active. */
export function count(key: string, amount = 1): void {
  active.getStore()?.count(key, amount);
}

function monotonicSeconds(): number {
  return performance.now() / 1000;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
