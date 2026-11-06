// Wall spans/open-phase overlaps give context, not CPU causes; no native reads.
import { AsyncLocalStorage } from "node:async_hooks";

type Span = { name: string; started: number; ended: number; ms: number };
const spans: Span[] = [];

/** Finish on the same synchronous stack; paired SDK hooks may finish twice. */
export function startSlowSpan(name: string, cid: string | undefined) {
  const start = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const ms = performance.now() - start;
    if (ms >= 50) {
      spans.push({
        name: `${name}:${cid ?? "-"}:${Math.round(ms)}`,
        started: start,
        ended: start + ms,
        ms,
      });
      spans.sort((a, b) => b.ms - a.ms);
      spans.length = Math.min(spans.length, 3);
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
export function drainSlowSpans(
  windowStart = -Infinity,
  now = Infinity,
): string[] {
  return spans
    .splice(0)
    .filter((span) => span.ended > windowStart && span.started < now)
    .map((span) => span.name);
}

type Reply = { name: string; ended: number; bytes: number; ms: number };
const replies: Reply[] = [];

/** Delivery includes scheduling and runtime decoding, not just sync work. */
export function workerReply(name: string, bytes: number, sent: number): void {
  const ended = performance.now();
  const ms = Math.max(0, performance.timeOrigin + ended - sent);
  if (bytes < 1024 * 1024 && ms < 50) return;
  replies.push({ name, bytes, ms, ended });
  replies.sort((a, b) => b.bytes - a.bytes || b.ms - a.ms);
  replies.length = Math.min(replies.length, 3);
}

/** Retain counters only, consumed with the same delayed sample as spans. */
export function drainWorkerReplies(windowStart: number): string[] {
  return replies
    .splice(0)
    .filter((reply) => reply.ended > windowStart)
    .map(({ name, bytes, ms }) => `${name}:${bytes}B:${Math.round(ms)}ms`);
}

type OpenPhase = {
  cid: string;
  name: string;
  started: number;
  ended?: number;
  stringBytes?: number;
};
const awaitedReplies = new AsyncLocalStorage<(bytes: number) => void>();

/** Capture the caller's scope before a worker replies in another context. */
export function awaitedReplyBytes(): ((bytes: number) => void) | undefined {
  return awaitedReplies.getStore();
}
const opening = new Set<OpenPhase>();
const completed: OpenPhase[] = [];

function finishPhase(phase: OpenPhase, ended: number): void {
  if (ended - phase.started < 50) return;
  if (completed.length === 3) completed.shift();
  completed.push({ ...phase, ended });
}

/** Awaited calls include I/O and Pi continuations; they are not sync spans. */
export async function awaitedSpan<T>(
  name: string,
  cid: string,
  work: () => Promise<T>,
): Promise<T> {
  const scope = startOpenPhase(cid);
  scope.begin(`awaited_${name}`);
  try {
    return await awaitedReplies.run(scope.replyBytes, () =>
      slowSpan(`${name}_call`, cid, work),
    );
  } finally {
    scope.close();
  }
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
    replyBytes(bytes: number): void {
      phase.stringBytes = (phase.stringBytes ?? 0) + bytes;
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
    .map(
      ({ phase, ms }) =>
        `${phase.cid}:${phase.name}:${Math.round(ms)}ms` +
        (phase.stringBytes === undefined ? "" : `:${phase.stringBytes}B`),
    );
}
