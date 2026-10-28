// Keyed synchronous exponential backoff resets when identities change.
// Deferred reaps retain pending work; startup seeds reaps/spawns from storage.
// Async seed steps have explicit abort points, preserving save/drop order.
import { Cancelled, checkAbort } from "../utils/tasks";
import {
  ERROR,
  WARNING,
  logEvent,
  logException,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import {
  activeRunId,
  type ConversationRecord,
  type ConversationStore,
} from "./conversation_store";

export type RetryKey = string | number | boolean | null | readonly RetryKey[];
export type RetryEntry = Record<string, unknown>;

export interface RetryScheduleOptions {
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly clock?: () => number;
}

interface StoredEntry {
  readonly key: RetryKey;
  readonly entry: RetryEntry;
}

function keyToken(key: RetryKey): string {
  if (Array.isArray(key)) {
    const parts = key.map((part) => keyToken(part));
    return `tuple:${parts.map((part) => `${part.length}:${part}`).join("")}`;
  }
  if (key === null) return "none";
  if (typeof key === "boolean") return `number:${Number(key)}`;
  if (typeof key === "number") return `number:${key === 0 ? "0" : String(key)}`;
  return `string:${key.length}:${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python equality for the JSON-compatible identity values used by callers. */
function pythonEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "boolean" && typeof right === "number") {
    return Number(left) === right;
  }
  if (typeof right === "boolean" && typeof left === "number") {
    return left === Number(right);
  }
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => pythonEqual(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) =>
          Object.hasOwn(right, key) && pythonEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function pythonInt(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  if (
    typeof value === "string" &&
    /^[\t-\r\x1c-\x20]*[+-]?\d+[\t-\r\x1c-\x20]*$/.test(value)
  ) {
    return Number(value.trim());
  }
  throw new TypeError("retry attempt count must be an integer");
}

function pythonFloat(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const number = Number(value);
    if (!Number.isNaN(number)) return number;
  }
  throw new TypeError("retry due time must be a number");
}

export class RetrySchedule {
  private readonly base: number;
  private readonly cap: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, StoredEntry>();

  constructor(options: RetryScheduleOptions) {
    this.base = Number(options.baseDelay);
    this.cap = Number(options.maxDelay);
    this.clock = options.clock ?? (() => performance.now() / 1000);
  }

  private delay(attempt: number): number {
    return Math.min(this.cap, this.base * 2 ** Math.max(0, attempt - 1));
  }

  /** Backoff before 1-based attempt N. */
  delayFor(attempt: number): number {
    return this.delay(attempt);
  }

  /** Park one caller-built entry, replacing any prior record for the key. */
  queue(key: RetryKey, entry: RetryEntry): void {
    const token = keyToken(key);
    const previous = this.entries.get(token);
    this.entries.set(token, {
      key: previous?.key ?? key,
      entry: { ...entry },
    });
  }

  /** Stable shallow copies of every parked entry. */
  snapshot(): Array<[RetryKey, RetryEntry]> {
    return Array.from(this.entries.values(), ({ key, entry }) => [
      key,
      { ...entry },
    ]);
  }

  /** TypeScript equivalent of Python's `key in schedule`. */
  contains(key: RetryKey): boolean {
    return this.entries.has(keyToken(key));
  }

  /** The live mutable entry for a key, or null when it is not parked. */
  record(key: RetryKey): RetryEntry | null {
    return this.entries.get(keyToken(key))?.entry ?? null;
  }

  noteFailure(key: RetryKey, identity: unknown = null): RetryEntry {
    const now = this.clock();
    const token = keyToken(key);
    const previous = this.entries.get(token);
    let entry = previous?.entry;
    if (
      entry === undefined ||
      (identity !== null && !pythonEqual(entry.identity ?? null, identity))
    ) {
      entry = { identity, attempts: 0 };
    }
    const rawAttempts = Object.hasOwn(entry, "attempts") ? entry.attempts : 0;
    const attempts = pythonInt(rawAttempts) + 1;
    entry.attempts = attempts;
    entry.next_due = now + this.delay(attempts);
    this.entries.set(token, { key: previous?.key ?? key, entry });
    return entry;
  }

  /** Consume one key after success or when its intent is dropped. */
  noteSuccess(key: RetryKey): void {
    this.entries.delete(keyToken(key));
  }

  /** Whether another attempt may run now, clearing a superseded identity. */
  ready(key: RetryKey, identity: unknown = null): boolean {
    const token = keyToken(key);
    const stored = this.entries.get(token);
    if (stored === undefined) return true;
    if (
      identity !== null &&
      !pythonEqual(stored.entry.identity ?? null, identity)
    ) {
      this.entries.delete(token);
      return true;
    }
    const due = Object.hasOwn(stored.entry, "next_due")
      ? pythonFloat(stored.entry.next_due)
      : 0;
    return this.clock() >= due;
  }

  /** Drop every record (test reset only). */
  clear(): void {
    this.entries.clear();
  }
}

/** Python `max(0, int(value))` with TypeError/ValueError falling back to 0. */
export function attemptOf(value: unknown): number {
  try {
    return Math.max(0, pythonInt(value ?? 0));
  } catch {
    if (typeof value === "number" && Number.isFinite(value))
      return Math.max(0, Math.trunc(value));
    return 0;
  }
}

export interface DeferredReapsDeps {
  conversations: Pick<ConversationStore, "load" | "save">;
  /** prompts._drop_turn_system_prompt(conv). */
  dropTurnSystemPrompt(conv: ConversationRecord): Promise<void>;
  log: RuntimeLogger;
  /** time.time(), seconds. */
  now(): number;
}

export interface ReapRequest {
  by?: string | null;
  [key: string]: unknown;
}

/** The deferred-reap intents and their durable park. */
export class DeferredReaps {
  readonly schedule: RetrySchedule;

  constructor(private readonly deps: DeferredReapsDeps) {
    this.schedule = new RetrySchedule({
      baseDelay: 2.0,
      maxDelay: 60.0,
      clock: () => deps.now(),
    });
  }

  contains(cid: string): boolean {
    return this.schedule.contains(cid);
  }

  snapshot(): Array<[string, RetryEntry]> {
    return this.schedule.snapshot() as Array<[string, RetryEntry]>;
  }

  /** Keep one retry intent per still-live deferred subtree root. */
  queueDeferredReap(
    cid: string,
    options: {
      requestedBy?: string | null;
      attempt?: number;
      retryAt?: number | null;
    } = {},
  ): void {
    this.schedule.queue(cid, {
      by: options.requestedBy ?? null,
      automatic: true,
      attempts: Math.max(0, Math.trunc(options.attempt ?? 0)),
      next_due: options.retryAt ?? this.deps.now(),
    });
  }

  /** Make a failed deletion durable, including its actionable diagnosis. */
  async parkDeferredReap(
    doomed: readonly string[],
    options: {
      reason: string;
      reasonCode?: string;
      requestedBy?: string | null;
    },
  ): Promise<void> {
    const { conversations } = this.deps;
    const reason = options.reason;
    const reasonCode = options.reasonCode ?? "owned_process_cleanup_unverified";
    const requestedBy = options.requestedBy ?? null;
    const now = this.deps.now();
    let rootAttempt = 0;
    for (const cid of doomed) {
      const conv = conversations.load(cid);
      if (conv === null) continue;
      const priorStatus = conv.status;
      const priorReason = conv.status_reason;
      conv.status = "interrupted";
      const parkNote = pySlice(
        `Reap deferred (${reason}); uncommitted turn dropped.`,
        200,
      );
      if (typeof priorReason === "string" && priorReason) {
        const kept = pySlice(priorReason, 250).replaceAll("\n", " ");
        const joined =
          priorStatus !== "interrupted"
            ? `${kept} | ${parkNote}`
            : priorReason.includes("Reap deferred (")
              ? priorReason
              : `${kept} | ${parkNote}`;
        conv.status_reason = pySlice(joined, 500);
      } else conv.status_reason = pySlice(parkNote, 500);
      if (!truthy(conv.reap_deferred)) conv.reap_retry_attempt = 0;
      conv.reap_deferred = true;
      conv.reap_deferred_reason = reason;
      conv.reap_requested_by = requestedBy;
      if (cid === doomed[0]) rootAttempt = attemptOf(conv.reap_retry_attempt);
      logEvent(this.deps.log, WARNING, "agent_reap_deferred", {
        conversation_id: cid,
        run_id: activeRunId(conv),
        fields: {
          requester_id: requestedBy || "operator",
          reason_code: reasonCode,
        },
      });
      await this.deps.dropTurnSystemPrompt(conv);
      conv.active_turn = null;
      conv.draft = null;
      conv.updated = now;
      await conversations.save(conv);
    }
    if (doomed.length)
      this.queueDeferredReap(doomed[0]!, { requestedBy, attempt: rootAttempt });
  }

  /** Consume one parked reap retry (a racer's drain wins). */
  dropReapRetry(cid: string): void {
    this.schedule.noteSuccess(cid);
  }

  /** Drop every parked reap retry (test reset). */
  clearPendingReaps(): void {
    this.schedule.clear();
  }

  /** Replace one failed deletion with its next in-memory retry. */
  async deferReapRetry(
    cid: string,
    req: ReapRequest,
    priorAttempt: number,
    exc: unknown,
    options: { reasonCode: string; level: number },
  ): Promise<void> {
    const attempt = priorAttempt + 1;
    const delay = this.schedule.delayFor(attempt);
    this.queueDeferredReap(cid, {
      requestedBy: req.by ?? null,
      attempt,
      retryAt: this.deps.now() + delay,
    });
    const latest = this.deps.conversations.load(cid, { withPending: false });
    if (latest !== null) {
      latest.reap_retry_attempt = attempt;
      await this.deps.conversations.save(latest);
    }
    logException(this.deps.log, "reap_request_deferred", exc, {
      conversation_id: cid,
      level: options.level,
      fields: {
        requester_id: req.by || "operator",
        reason_code: options.reasonCode,
        retry_attempt: attempt,
        retry_scheduled: true,
      },
    });
  }

  /** Park one unfinished deletion and arm its retry; the caller re-raises. */
  async parkReapRetry(
    cid: string,
    req: ReapRequest,
    priorAttempt: number,
    exc: unknown,
    options: { reasonCode: string; level: number },
  ): Promise<void> {
    try {
      await this.parkDeferredReap([cid], {
        reason: `deletion failed (${exc instanceof Error ? exc.name : typeof exc})`,
        reasonCode: options.reasonCode,
        requestedBy: req.by ?? null,
      });
    } catch (parkFailure) {
      if (parkFailure instanceof Cancelled) throw parkFailure;
      logException(this.deps.log, "reap_park_failed", parkFailure, {
        conversation_id: cid,
        level: ERROR,
      });
    }
    await this.deferReapRetry(cid, req, priorAttempt, exc, options);
  }
}

/** Python str[:n] by code point. */
export function pySlice(text: string, n: number): string {
  const points = Array.from(text);
  return points.length <= n ? text : points.slice(0, n).join("");
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object")
    return Object.keys(value).length > 0;
  return Boolean(value);
}

/** config._TEMP_ID_RE. */
const TEMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type Json = Record<string, any>;

const isDict = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const abort = (signal: AbortSignal | undefined) => {
  if (signal) checkAbort(signal);
};

const rethrowCancelled = (error: unknown) => {
  if (error instanceof Cancelled) throw error;
};

export interface DeferredReapSeedDeps {
  conversations: Pick<ConversationStore, "load" | "save" | "allConvs">;
  deferredReaps: Pick<DeferredReaps, "contains" | "queueDeferredReap">;
  /** AgentTree's spawn shelf and orphan-store retire. */
  tree: {
    readonly pendingSpawns: readonly { cid: unknown }[];
    parkSpawnIntent(cid: string, req: Json): { store_id?: string };
    retireOrphanSpawnStore(cid: string): Promise<boolean>;
  };
  agentStore: {
    allAgentIds(): Promise<string[]>;
    loadPersistedAgent(cid: string): Promise<[Json | null, Json[]]>;
    retire(cid: string, id: string): void;
  };
  /** reconciler.readSpawnOutcome. */
  readSpawnOutcome(cid: string): Promise<Json | null>;
  log: RuntimeLogger;
  /** Abortable sleep in seconds. */
  sleep(seconds: number, signal?: AbortSignal): Promise<void>;
}

/** Startup re-queue of parked deletions and unapplied spawns. */
export class DeferredReapSeed {
  private deferredReapsBaselined = false;

  constructor(private readonly deps: DeferredReapSeedDeps) {}

  /** Re-queue every parked deletion and unapplied spawn from durable intent. */
  async seedDeferredReapRequests(signal?: AbortSignal): Promise<void> {
    if (this.deferredReapsBaselined) return;
    const { conversations, deferredReaps } = this.deps;
    const convs = conversations.allConvs({ withPending: false });
    const deferred = new Set(
      convs.filter((conv) => truthy(conv.reap_deferred)).map((c) => c.id),
    );
    for (const conv of convs) {
      const cid = conv.id;
      if (
        truthy(conv.reap_deferred) &&
        !deferred.has(conv.parent as string) &&
        typeof cid === "string" &&
        TEMP_ID_RE.test(cid) &&
        !deferredReaps.contains(cid)
      ) {
        // Invariant: A restart resets the attempt counter: it likely healed
        // whatever blocked the previous generation.
        deferredReaps.queueDeferredReap(cid, {
          requestedBy: (conv.reap_requested_by as string | null) ?? null,
          attempt: 0,
        });
        const fresh = conversations.load(cid, { withPending: false });
        if (fresh !== null && truthy(fresh.reap_deferred)) {
          fresh.reap_retry_attempt = 0;
          await conversations.save(fresh);
          abort(signal);
        }
      }
    }
    await this.seedSpawnRecords(signal);
    this.deferredReapsBaselined = true;
  }

  // Re-park restart-surviving spawn requests by store ID when no receipt
  // exists.
  // Retire finished/malformed records instead of replaying them.
  async seedSpawnRecords(signal?: AbortSignal): Promise<void> {
    const { tree, agentStore, conversations } = this.deps;
    const parked = new Set(tree.pendingSpawns.map((item) => item.cid));
    const orphans: string[] = [];
    const ids = await agentStore.allAgentIds();
    abort(signal);
    for (const cid of ids) {
      if (parked.has(cid)) continue;
      if (conversations.load(cid, { withPending: false }) !== null) continue;
      let rows: Json[];
      try {
        [, rows] = await agentStore.loadPersistedAgent(cid);
      } catch {
        abort(signal);
        continue;
      }
      abort(signal);
      for (const intent of rows) {
        if (intent.kind !== "spawn") continue;
        const body = intent.body;
        const req = isDict(body) ? body.request : null;
        const outcome = await this.deps.readSpawnOutcome(cid);
        abort(signal);
        const terminal =
          outcome !== null &&
          (outcome.status === "accepted" || outcome.status === "rejected");
        if (!isDict(req) || ("id" in req ? req.id : cid) !== cid || terminal) {
          try {
            agentStore.retire(
              cid,
              intent.id == null ? "None" : String(intent.id),
            );
          } catch {}
          // Invariant: A rejected spawn with no row owns only this record: an
          // orphan.
          if (
            terminal &&
            outcome.status === "rejected" &&
            !orphans.includes(cid)
          )
            orphans.push(cid);
          continue;
        }
        const item = tree.parkSpawnIntent(cid, req);
        item.store_id = intent.id;
      }
    }
    for (const cid of orphans) {
      try {
        await tree.retireOrphanSpawnStore(cid);
      } catch (error) {
        rethrowCancelled(error);
      }
      abort(signal);
    }
  }

  /** The startup seed with three attempts; never the hot watch path. */
  async seedDeferredReapsAtStartup(signal?: AbortSignal): Promise<void> {
    for (let retry = 0; retry < 3; retry++) {
      try {
        await this.seedDeferredReapRequests(signal);
        return;
      } catch (error) {
        rethrowCancelled(error);
        logException(this.deps.log, "deferred_reap_index_failed", error, {
          level: WARNING,
          fields: { retry_attempt: retry + 1 },
        });
        if (retry < 2) {
          await this.deps.sleep(0.05 * 2 ** retry, signal);
          abort(signal);
        }
      }
    }
  }
}
