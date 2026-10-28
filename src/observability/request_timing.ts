// Bounded request-local phase timings. Nested/parallel spans overlap; their
// totals are not additive. Identifiers and fixed phase names only, never input.
import { AsyncLocalStorage } from "node:async_hooks";

const active = new AsyncLocalStorage<RequestTiming | undefined>();
let sequence = 0;
const background = new Map<string, number>();
const failedSteps = new WeakMap<object, string>();

export class RequestTiming {
  readonly id = String(++sequence);
  private readonly steps = new Map<
    string,
    { ms: number; calls: number; max: number }
  >();
  private readonly details: Record<string, string> = {};
  private readonly startedBackground = [...background.keys()]
    .slice(0, 8)
    .join(",");

  add(name: string, ms: number): void {
    const key = name.replace(/[^a-z0-9_]/gu, "_");
    if (!this.steps.has(key) && this.steps.size >= 48) return;
    const step = this.steps.get(key) ?? { ms: 0, calls: 0, max: 0 };
    step.ms += ms;
    step.calls++;
    step.max = Math.max(step.max, ms);
    this.steps.set(key, step);
  }

  detail(key: string, value: string): void {
    if (!(key in this.details) && Object.keys(this.details).length < 8)
      this.details[key] = value;
  }

  fields(): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      timing_id: this.id,
      background_start: this.startedBackground || "none",
      background_end: [...background.keys()].slice(0, 8).join(",") || "none",
      ...this.details,
    };
    for (const [key, step] of this.steps) {
      fields[`step_${key}_ms`] = Math.round(step.ms);
      fields[`step_${key}_calls`] = step.calls;
      fields[`step_${key}_max_ms`] = Math.round(step.max);
    }
    return fields;
  }
}

export async function backgroundWork<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  background.set(name, (background.get(name) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const count = background.get(name)! - 1;
    if (count) background.set(name, count);
    else background.delete(name);
  }
}

export function requestTiming(path: string): RequestTiming | undefined {
  return /^\/api\/(?:artifacts(?:\/|$)|conversations\/[^/]+(?:\/(?:diff|events|view))?$)/u.test(
    path,
  )
    ? new RequestTiming()
    : undefined;
}

export function withRequestTiming<T>(
  timing: RequestTiming | undefined,
  work: () => T,
): T {
  return active.run(timing, work);
}

export function timingId(): string | undefined {
  return active.getStore()?.id;
}

export function timingDetail(key: string, value: string): void {
  active.getStore()?.detail(key, value);
}

export function timingFailure(error: unknown): void {
  if (typeof error !== "object" || error === null) return;
  const step = failedSteps.get(error);
  if (step) timingDetail("failed_step", step);
}

export async function timed<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const timing = active.getStore();
  if (!timing) return work();
  const start = performance.now();
  try {
    return await work();
  } catch (error) {
    if (typeof error === "object" && error !== null && !failedSteps.has(error))
      failedSteps.set(error, name);
    throw error;
  } finally {
    timing.add(name, performance.now() - start);
  }
}
