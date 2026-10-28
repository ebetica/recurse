// Bounds/deduplicates warming behind focused reads; navigation aborts it all.
// Oldest waiting tasks drop; callers retain invalidations and expose failures.
// Task slots and nested holds expire independently of network/body completion.
// Rejections are contained, never retried here; callers own recurring retry.

export type BackgroundTask = (signal: AbortSignal) => Promise<unknown>;

interface RunningTask {
  controller: AbortController;
  timer: number;
}

export const BACKGROUND_CONCURRENCY = 2;
export const BACKGROUND_QUEUE_LIMIT = 12;
// Slot deadline prevents frozen background requests starving later warming.
export const BACKGROUND_TASK_TIMEOUT_MS = 15_000;
// Hold deadline outlives poll wedge escape but cannot suppress warming forever.
export const HOLD_TIMEOUT_MS = 13_000;

export class BackgroundQueue {
  private readonly waiting: { key: string; task: BackgroundTask }[] = [];
  private readonly running = new Map<string, RunningTask>();
  private paused = 0;

  constructor(
    private readonly concurrency = BACKGROUND_CONCURRENCY,
    private readonly limit = BACKGROUND_QUEUE_LIMIT,
    private readonly taskTimeoutMs = BACKGROUND_TASK_TIMEOUT_MS,
  ) {}

  /** Queue best-effort work. Already queued or running keys are ignored. */
  enqueue(key: string, task: BackgroundTask): void {
    if (this.running.has(key) || this.waiting.some((item) => item.key === key))
      return;
    this.waiting.push({ key, task });
    while (this.waiting.length > this.limit) this.waiting.shift();
    this.drain();
  }

  // Nestable critical-path holds reopen only after all release or expire.
  // Deadlines are independent of request timeouts, which may cover headers
  // only.
  hold(maxMs = HOLD_TIMEOUT_MS): () => void {
    this.paused++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.paused--;
      this.drain();
    };
    const timer = setTimeout(release, maxMs) as unknown as number;
    return release;
  }

  /** Abandon one key when its reader moved on. */
  abandon(key: string): void {
    const waitingIndex = this.waiting.findIndex((item) => item.key === key);
    if (waitingIndex >= 0) this.waiting.splice(waitingIndex, 1);
    const entry = this.running.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.controller.abort();
    this.running.delete(key);
    this.drain();
  }

  /** The reader moved on: abort what is running and forget what was waiting. */
  abandonAll(): void {
    this.waiting.length = 0;
    for (const entry of this.running.values()) {
      clearTimeout(entry.timer);
      entry.controller.abort();
    }
    this.running.clear();
  }

  get held(): boolean {
    return this.paused > 0;
  }
  get runningKeys(): string[] {
    return [...this.running.keys()];
  }
  get waitingKeys(): string[] {
    return this.waiting.map((item) => item.key);
  }

  private drain(): void {
    while (
      this.paused === 0 &&
      this.running.size < this.concurrency &&
      this.waiting.length
    ) {
      const next = this.waiting.shift()!;
      const controller = new AbortController();
      const entry: RunningTask = { controller, timer: 0 };
      this.running.set(next.key, entry);
      const release = (): void => {
        clearTimeout(entry.timer);
        if (this.running.get(next.key) === entry) {
          this.running.delete(next.key);
          this.drain();
        }
      };
      // Invariant: A task that never settles has its slot taken back, not
      // merely an abort it might ignore.
      entry.timer = setTimeout(() => {
        controller.abort();
        release();
      }, this.taskTimeoutMs) as unknown as number;
      // Invariant: Swallow sync throws and async rejection, freeing the slot.
      // The queue never retries; callers may still expose failures through
      // their UI.
      try {
        void next
          .task(controller.signal)
          .catch(() => {})
          .finally(release);
      } catch {
        release();
      }
    }
  }
}

/** The one queue every background cache update in the app shares. */
export const backgroundWork = new BackgroundQueue();

// Boot starts held so module registration cannot probe before the focused read.
const releaseStartupHold = backgroundWork.hold();

// Enables warming after the initial focused read settles, even on failure.
// Idempotent; failing focus reads must not permanently hide pane discovery.
export function focusedPathReady(): void {
  releaseStartupHold();
}
