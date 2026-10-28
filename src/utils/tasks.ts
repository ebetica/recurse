// Structured ownership for otherwise detached asynchronous runtime work.
// JS cannot cancel a promise: cancellation rejects at explicit awaits and the
// producer must cooperate via AbortSignal. Every TaskSet task has a rejection
// observer so a forgotten detached task never becomes an unhandled rejection.
export class Cancelled extends Error {
  override name = "Cancelled";
  constructor(message = "cancelled") {
    super(message);
  }
}

/** wait_for reports a timeout to its caller, cancellation to its child. */
export class TimeoutError extends Error {
  override name = "TimeoutError";
  constructor() {
    super("timed out");
  }
}

function cancellation(signal: AbortSignal): Cancelled {
  return new Cancelled(
    signal.reason instanceof Error ? signal.reason.message : "cancelled",
  );
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw cancellation(signal);
}

/** Cancel the wait, not the underlying work. The promise remains observed. */
export function abortable<T>(
  work: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // Invariant: Observe even an already-started promise after caller
    // cancellation.
    Promise.resolve(work).catch(() => undefined);
    return Promise.reject(cancellation(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancellation(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(work).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** A child scope can be stopped independently without aborting its parent. */
export class AbortScope {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly parent?: AbortSignal;
  private readonly onParent = () => this.abort(this.parent?.reason);

  constructor(parent?: AbortSignal) {
    this.parent = parent;
    if (parent?.aborted) this.abort(parent.reason);
    else parent?.addEventListener("abort", this.onParent, { once: true });
  }

  abort(reason?: unknown): void {
    this.controller.abort(reason);
    this.dispose();
  }

  dispose(): void {
    this.parent?.removeEventListener("abort", this.onParent);
  }
}

/** Python wait_for semantics: abort the child's cooperative scope on expiry. */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal,
): Promise<T> {
  if (ms < 0 || Number.isNaN(ms)) throw new RangeError("invalid timeout");
  const scope = new AbortScope(parent);
  const timeoutReason = new TimeoutError();
  const timer = Number.isFinite(ms)
    ? setTimeout(() => scope.abort(timeoutReason), ms)
    : undefined;
  try {
    checkAbort(scope.signal);
    return await abortable(
      Promise.resolve().then(() => fn(scope.signal)),
      scope.signal,
    );
  } catch (error) {
    if (scope.signal.reason === timeoutReason) throw timeoutReason;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    scope.dispose();
  }
}

// Shield a producer from caller cancellation; only its await is interrupted.
export function shield<T>(
  work: PromiseLike<T>,
  caller: AbortSignal,
): Promise<T> {
  return abortable(work, caller);
}

/**
 * A TaskSet error sink that drops Cancelled, as asyncio logs nothing for a
 * cancelled task: a task aborted at shutdown or reap is not a failure.
 */
export function ignoringCancelled(
  onError: (name: string, error: unknown) => void,
): (name: string, error: unknown) => void {
  return (name, error) => {
    if (!(error instanceof Cancelled)) onError(name, error);
  };
}

export class TaskSet {
  private readonly tasks = new Map<Promise<unknown>, string>();
  constructor(
    private readonly onError: (name: string, error: unknown) => void = (
      name,
      error,
    ) => console.error("detached_task_failed", name, error),
  ) {}

  /** Holds the task until completion and observes all detached failures. */
  spawn<T>(
    name: string,
    fn: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const scope = new AbortScope(signal);
    const task = Promise.resolve().then(() => {
      checkAbort(scope.signal);
      return fn(scope.signal);
    });
    this.tasks.set(task, name);
    // Invariant: Never replace task with a rejection from a finally handler. A
    // thrown telemetry callback is also swallowed; task ownership cannot depend
    // on it.
    task.then(
      () => {
        this.tasks.delete(task);
        scope.dispose();
      },
      (error: unknown) => {
        this.tasks.delete(task);
        scope.dispose();
        try {
          this.onError(name, error);
        } catch {}
      },
    );
    return task;
  }

  get size(): number {
    return this.tasks.size;
  }

  /** The names of in-flight tasks, oldest first. */
  names(): string[] {
    return [...this.tasks.values()];
  }

  async drain(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks.keys()]);
  }
}

// FIFO async lock; cancelled waiters are removed rather than stealing a turn.
export class AsyncMutex {
  private locked = false;
  private readonly queue: Array<() => void> = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal) checkAbort(signal);
    if (!this.locked) {
      this.locked = true;
      return this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        cleanup();
        resolve(this.release());
      };
      const cancel = () => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        cleanup();
        reject(cancellation(signal!));
      };
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      this.queue.push(grant);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.locked = false;
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const unlock = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      unlock();
    }
  }
}

/** asyncio.Event-style sticky flag; clear affects later waits only. */
export class AsyncEvent {
  private setFlag = false;
  private readonly waiting = new Set<() => void>();

  get isSet(): boolean {
    return this.setFlag;
  }
  set(): void {
    this.setFlag = true;
    for (const wake of this.waiting) wake();
    this.waiting.clear();
  }
  clear(): void {
    this.setFlag = false;
  }
  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancellation(signal));
    if (this.setFlag) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.waiting.delete(wake);
        signal?.removeEventListener("abort", cancel);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const cancel = () => {
        cleanup();
        reject(cancellation(signal!));
      };
      this.waiting.add(wake);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
}
