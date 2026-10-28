// Pure connection-health state machine and deduplicated probe coordinator.
// Browser wiring lives in connection.ts; keeping this module DOM-free makes
// threshold, race, retry, and sleep behavior deterministic under a fake clock.

export const CONNECTION_LOST_MS = 60_000;

export type ConnectionPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "offline"
  | "auth-expired";

export type RequestOutcome =
  | "success"
  | "unavailable"
  | "auth-expired"
  | "neutral"
  | "cancelled";

export interface ConnectionSnapshot {
  phase: ConnectionPhase;
  elapsedMs: number;
  lastSuccessAt: number | null;
  inFlight: number;
  retryAttempt: number;
  retryAt: number | null;
}

export interface HealthRequest {
  readonly id: number;
  readonly availability: "core" | "optional";
}

type Listener = (snapshot: ConnectionSnapshot) => void;

export class ConnectionHealth {
  private readonly startedAt: number;
  private lastNow: number;
  private lastSuccessAt: number | null = null;
  private lastHealthRequest = 0;
  private nextRequest = 0;
  private readonly active = new Map<number, HealthRequest>();
  private coreUnavailable = false;
  // Online hints schedule probes; only authenticated HTTP proves reachability.
  private onlineHint: boolean;
  private authExpired = false;
  private suppressProbe = 0;
  private retryAttempt = 0;
  private retryAt: number | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly now: () => number,
    online = true,
    private readonly thresholdMs = CONNECTION_LOST_MS,
  ) {
    this.lastNow = now();
    this.startedAt = this.lastNow;
    this.onlineHint = online;
  }

  // Clamp a supplied clock that moves backward. performance.now() is monotonic
  // in browsers, and this guard preserves that contract in unusual runtimes and
  // under fake clocks.
  private monotonicNow(): number {
    this.lastNow = Math.max(this.lastNow, this.now());
    return this.lastNow;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const value = this.snapshot();
    for (const listener of this.listeners) listener(value);
  }

  begin(availability: "core" | "optional" = "optional"): HealthRequest {
    const request = { id: ++this.nextRequest, availability } as const;
    this.active.set(request.id, request);
    this.emit();
    return request;
  }

  settle(request: HealthRequest, outcome: RequestOutcome): void {
    if (!this.active.delete(request.id)) return;
    const now = this.monotonicNow();
    if (request.id < this.lastHealthRequest) {
      // Invariant: A late completion from an older request cannot undo a newer
      // success or failure. It is still removed from `active` above, but has no
      // say in the page's current reachability state.
      this.emit();
      return;
    }
    if (outcome === "success") {
      // Invariant: Completion-time authenticated success overrides offline
      // hints. Issue order and navigator.onLine alone cannot prove the HTTP
      // path.
      this.lastHealthRequest = request.id;
      this.lastSuccessAt = now;
      this.onlineHint = true;
      this.coreUnavailable = false;
      this.authExpired = false;
      this.suppressProbe = 0;
      this.clearRetry(false);
    } else if (outcome === "auth-expired") {
      this.lastHealthRequest = request.id;
      this.authExpired = true;
      this.suppressProbe = 0;
    } else if (outcome === "unavailable" && request.availability === "core") {
      this.lastHealthRequest = request.id;
      this.coreUnavailable = true;
    }
    // Invariant: neutral 4xx responses, optional endpoint failures, and
    // deliberate aborts neither prove health nor begin an outage.
    this.emit();
  }

  setOnline(online: boolean): void {
    if (this.onlineHint === online) return;
    this.onlineHint = online;
    // Invariant: A real outage already on screen must not be hidden by the hint
    // probe.
    if (!online) this.suppressProbe = 0;
    this.emit();
  }

  // Suppresses newly stale status until the foreground/online probe settles.
  // Generation fences stop old aborted pagehide probes clearing newer
  // suppression.
  beginWakeProbe(generation: number, suppressStale: boolean): void {
    if (suppressStale) this.suppressProbe = generation;
    this.emit();
  }

  finishWakeProbe(generation: number): void {
    if (!this.suppressProbe || this.suppressProbe !== generation) return;
    this.suppressProbe = 0;
    this.emit();
  }

  setRetry(attempt: number, retryAt: number | null): void {
    this.retryAttempt = Math.max(0, attempt);
    this.retryAt = retryAt;
    this.emit();
  }

  clearRetry(emit = true): void {
    if (!this.retryAttempt && this.retryAt === null) return;
    this.retryAttempt = 0;
    this.retryAt = null;
    if (emit) this.emit();
  }

  // Called by the one-second UI heartbeat. It derives threshold/elapsed from
  // monotonic time; browser timer throttling changes only when the paint
  // occurs, never the outage duration.
  tick(): void {
    this.emit();
  }

  snapshot(): ConnectionSnapshot {
    const now = this.monotonicNow();
    const since = this.lastSuccessAt ?? this.startedAt;
    const elapsedMs = Math.max(0, now - since);
    let phase: ConnectionPhase;
    if (this.authExpired) phase = "auth-expired";
    else if (this.suppressProbe)
      phase = this.lastSuccessAt === null ? "connecting" : "reconnecting";
    else if (!this.coreUnavailable)
      phase = this.lastSuccessAt === null ? "connecting" : "connected";
    else if (!this.onlineHint) phase = "offline";
    else
      phase = elapsedMs >= this.thresholdMs ? "disconnected" : "reconnecting";
    return {
      phase,
      elapsedMs,
      lastSuccessAt: this.lastSuccessAt,
      inFlight: this.active.size,
      retryAttempt: this.retryAttempt,
      retryAt: this.retryAt,
    };
  }
}

export interface ProbeOptions {
  force?: boolean;
  suppressStale?: boolean;
}

// Browser heartbeat ordering, kept DOM-free for fake-clock coverage. After a
// long timer gap the forced probe must install stale-label suppression BEFORE
// tick derives/paints elapsed outage state. Ordinary heartbeats and a known
// update target retain their existing tick-first behavior.
export function heartbeatNeedsSuppression(
  slept: boolean,
  indicatorWasVisible: boolean,
  phase: ConnectionPhase,
): boolean {
  return slept || (!indicatorWasVisible && phase === "disconnected");
}

export function runConnectionHeartbeat(
  suppressBeforeTick: boolean,
  updatePending: boolean,
  indicatorWasVisible: boolean,
  requestProbe: (force?: boolean, suppressStale?: boolean) => unknown,
  tick: () => void,
): void {
  if (suppressBeforeTick && !updatePending) {
    requestProbe(true, !indicatorWasVisible);
    tick();
    return;
  }
  tick();
  if (!updatePending) requestProbe();
}

// A single health/version probe shared by the generation timer, Retry button,
// and browser lifecycle events. Failed probes back off with bounded jitter;
// callers during an active probe receive that exact promise.
export class HealthProbe {
  private active: Promise<boolean> | null = null;
  private controller: AbortController | null = null;
  private attempt = 0;
  private retryAt = 0;
  private generation = 0;

  constructor(
    private readonly health: ConnectionHealth,
    private readonly fetchProbe: (signal: AbortSignal) => Promise<boolean>,
    private readonly now: () => number,
    private readonly random: () => number = Math.random,
    private readonly baseDelayMs = 1_000,
    private readonly maxDelayMs = 30_000,
  ) {}

  request(options: ProbeOptions = {}): Promise<boolean> | null {
    if (this.active) {
      if (options.suppressStale)
        this.health.beginWakeProbe(this.generation, true);
      return this.active;
    }
    const generation = ++this.generation;
    if (options.suppressStale) this.health.beginWakeProbe(generation, true);
    if (!options.force && this.now() < this.retryAt) {
      this.health.finishWakeProbe(generation);
      return null;
    }
    const controller = new AbortController();
    this.controller = controller;
    const promise = this.fetchProbe(controller.signal)
      .then((ok) => {
        if (ok) {
          this.attempt = 0;
          this.retryAt = 0;
          this.health.clearRetry();
        } else if (!controller.signal.aborted) {
          // Invariant: Normal poll traffic may have recovered while this failed
          // probe was unwinding. Its newer success wins, including over retry
          // metadata.
          if (this.health.snapshot().phase === "connected") {
            this.attempt = 0;
            this.retryAt = 0;
            this.health.clearRetry();
          } else {
            this.attempt++;
            const base = Math.min(
              this.maxDelayMs,
              this.baseDelayMs * 2 ** (this.attempt - 1),
            );
            const jitter = 0.8 + 0.4 * this.random();
            this.retryAt = this.now() + Math.round(base * jitter);
            this.health.setRetry(this.attempt, this.retryAt);
          }
        }
        return ok;
      })
      .catch(() => false)
      .finally(() => {
        if (this.active === promise) {
          this.active = null;
          this.controller = null;
        }
        this.health.finishWakeProbe(generation);
      });
    this.active = promise;
    return promise;
  }

  noteHealthy(): void {
    this.attempt = 0;
    this.retryAt = 0;
    this.health.clearRetry();
  }

  cancel(): void {
    const generation = this.generation;
    this.controller?.abort();
    this.controller = null;
    this.active = null;
    this.noteHealthy();
    this.health.finishWakeProbe(generation);
  }
}
