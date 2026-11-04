// Wall spans/open-phase overlaps give context, not CPU causes; no native reads.
const spans: string[] = [];

/** Finish on the same synchronous stack; paired SDK hooks may finish twice. */
export function startSlowSpan(name: string, cid: string | undefined) {
  const start = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const ms = performance.now() - start;
    if (ms >= 50) {
      if (spans.length === 3) spans.shift();
      spans.push(`${name}:${cid ?? "-"}:${Math.round(ms)}`);
    }
  };
}

/** Attribute synchronous work, including I/O waits and throws, by wall time. */
export function slowSpan<T>(
  name: string,
  cid: string | undefined,
  fn: () => T,
): T {
  const finish = startSlowSpan(name, cid);
  try {
    return fn();
  } finally {
    finish();
  }
}

/** Each sample consumes its own window, so a later stall cannot inherit it. */
export function drainSlowSpans(): string[] {
  return spans.splice(0);
}

type OpenPhase = { cid: string; name: string; started: number; ended?: number };
const opening = new Set<OpenPhase>();
const completed: OpenPhase[] = [];

function finishPhase(phase: OpenPhase, ended: number): void {
  if (ended - phase.started < 50) return;
  if (completed.length === 3) completed.shift();
  completed.push({ ...phase, ended });
}

/** Track one live open; its owner must close this scope in finally. */
export function startOpenPhase(cid: string) {
  const phase: OpenPhase = {
    cid,
    name: "admission",
    started: performance.now(),
  };
  opening.add(phase);
  return {
    begin(name: string): void {
      if (!opening.has(phase)) return;
      const now = performance.now();
      finishPhase(phase, now);
      phase.name = name;
      phase.started = now;
    },
    close(): void {
      if (opening.delete(phase)) finishPhase(phase, performance.now());
    },
  };
}

/** Read only for a stall, including finished phases overlapping its window. */
export function overlappingOpenPhases(
  windowStart: number,
  now: number,
): string[] {
  return [...completed, ...opening]
    .map((phase) => {
      const end = Math.min(phase.ended ?? now, now);
      return {
        phase,
        ms: end - phase.started,
        overlap: end - Math.max(phase.started, windowStart),
      };
    })
    .filter(({ ms, overlap }) => ms >= 50 && overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3)
    .map(({ phase, ms }) => `${phase.cid}:${phase.name}:${Math.round(ms)}ms`);
}
