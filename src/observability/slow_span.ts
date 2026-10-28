// Bounded CPU-attribution spans survive until the next sample; never input.
const threadCpuUsage = (
  process as NodeJS.Process & {
    threadCpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  }
).threadCpuUsage;
const spans: string[] = [];

/** Measure synchronous work, even throws, without retaining results. */
export function slowSpan<T>(
  name: string,
  cid: string | undefined,
  fn: () => T,
): T {
  if (!threadCpuUsage) return fn();
  const start = performance.now();
  const cpu = threadCpuUsage();
  try {
    return fn();
  } finally {
    const used = threadCpuUsage(cpu);
    const cpuMs = (used.user + used.system) / 1000;
    if (cpuMs >= 50) {
      if (spans.length === 3) spans.shift();
      spans.push(
        `${name}:${cid ?? "-"}:${Math.round(performance.now() - start)}:${Math.round(cpuMs)}`,
      );
    }
  }
}

/** Each sample consumes its own window, so a later stall cannot inherit it. */
export function drainSlowSpans(): string[] {
  return spans.splice(0);
}
