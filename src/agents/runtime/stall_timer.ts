// One queue-stall timer names a stuck driver, not a busy one.
// The one-shot fired bit belongs to the bounded live intent and dies with it.
// A null scheduler skips arming; monotonic clock/scheduler are injected.
import {
  WARNING,
  logEvent,
  type RuntimeLogger,
} from "../../observability/runtime_logging";

/** Queue-to-dispatch stall threshold in seconds. */
export const QUEUE_STALL_SECONDS = 10.0;

export type Intent = Record<string, unknown>;

export interface StallOwner {
  readonly cid: string;
  oldestSendable(): Intent | null;
  claimStall(storeId: string): Intent | null;
  pendingDepth(): number;
}

export interface TimerHandle {
  cancel(): void;
}

export interface StallTimerDeps {
  monotonic(): number;
  /** loop.call_later; null when no loop runs. */
  scheduler: {
    callLater(delaySeconds: number, fn: () => void): TimerHandle;
  } | null;
  log: RuntimeLogger;
}

/** Real scheduler over setTimeout. */
export const timeoutScheduler = {
  callLater(delaySeconds: number, fn: () => void): TimerHandle {
    const timer = setTimeout(fn, delaySeconds * 1000);
    return { cancel: () => clearTimeout(timer) };
  },
};

type Slot = [handle: TimerHandle | null, storeId: string, fired: boolean];

const isNumber = (value: unknown): value is number => typeof value === "number";

/** One node's stall-timer slot, bound to its exact node object. */
export class StallTimer {
  slot: Slot | null = null;

  constructor(private readonly deps: StallTimerDeps) {}

  /** Reset the queue-stall timer to the oldest waiting intent. */
  rearm(owner: StallOwner): void {
    const { scheduler } = this.deps;
    if (scheduler === null) return;
    const old = this.slot;
    this.slot = null;
    old?.[0]?.cancel();
    const oldest = owner.oldestSendable();
    const storeId = oldest?.store_id;
    const admittedAt = oldest?.admitted_at;
    if (typeof storeId !== "string" || !isNumber(admittedAt)) return;
    if (pyTruthy(oldest!._stall_logged)) {
      // Invariant: Backoff can hide the head, and a take/return can alternate
      // it with another waiter. Neither is a new stall.
      this.slot = [null, storeId, true];
      return;
    }
    const delay = QUEUE_STALL_SECONDS - (this.deps.monotonic() - admittedAt);
    if (delay <= 0) {
      this.slot = [null, storeId, false];
      this.fire(owner, storeId);
      return;
    }
    this.slot = [
      scheduler.callLater(delay, () => this.fire(owner, storeId)),
      storeId,
      false,
    ];
  }

  /** Cancel the queue-stall timer; the node is going away. */
  drop(): void {
    const slot = this.slot;
    this.slot = null;
    slot?.[0]?.cancel();
  }

  /** Fire against the exact node object the timer was armed for. */
  private fire(owner: StallOwner, storeId: string): void {
    const slot = this.slot;
    if (slot === null || slot[1] !== storeId) return;
    slot[0] = null;
    const oldest = owner.oldestSendable();
    if (oldest === null || oldest.store_id !== storeId) return;
    const admittedAt = oldest.admitted_at;
    if (!isNumber(admittedAt)) return;
    const waited = this.deps.monotonic() - admittedAt;
    if (waited < QUEUE_STALL_SECONDS) {
      this.rearm(owner);
      return;
    }
    if (owner.claimStall(storeId) === null) return;
    slot[2] = true;
    logEvent(this.deps.log, WARNING, "intent_queue_stall", {
      conversation_id: owner.cid,
      fields: {
        store_id: storeId,
        waited_seconds: waited.toFixed(3),
        queue_depth: owner.pendingDepth(),
      },
    });
  }
}

const pyTruthy = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === "object" && value !== null
      ? Object.keys(value).length > 0
      : Boolean(value);
