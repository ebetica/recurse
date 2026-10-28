// Never replay/heal uncertain sends: dispatched work needs Retry/Dismiss.
// Never-dispatched work rejoins. Clean groups before Durable resume.
// Startup notices use stable IDs; explicit abort points bypass failure catches.
import { mkdir, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CleanupNotice, ProcessHandle } from "../process_lifecycle";
import {
  INFO,
  WARNING,
  logEvent,
  logException,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { parsePythonJson, pyCompactJson } from "../utils/py_compact_json";
import { Cancelled, checkAbort } from "../utils/tasks";
import type { SpawnOutcome, SpawnOutcomes } from "./agent_tree";
import { SPAWN_OUTCOME_MAX_BYTES } from "./agent_tree";
import type { ConversationRecord } from "./conversation_store";
import type { DeliverOptions } from "./supervisor/delivery";
import { entryEpoch } from "./supervisor/delivery";
import { AsyncJsonlRangeReader, HEADER_BYTES } from "./view/session_entries";

type Json = Record<string, any>;

/** One in-memory tick should take milliseconds; slower names its sections. */
export const WATCH_TICK_SLOW_SECONDS = 1.0;
export const RESTART_RESUME_JOB = "turn_resume_after_restart";
export const RESTART_RESUME_NOTE_PREFIX =
  "Recurse restarted while you were working";
const MAX_PY_EPOCH = 253402300800;
const RESTART_RESUME_TAIL_BYTES = 64 * 1024;
const RESTART_RESUME_TAIL_ROWS = 50;
const RESTART_RESUME_TOOL_REASONS = new Set(["toolUse", "tool_use"]);

export interface ReconcileNode {
  readonly turnTask: Promise<void> | null;
  inboxMessages(): Json[];
  oldestSendable(): Json | null;
  restoreUncertain(intent: Json): string;
  restoreSendable(intent: Json): string;
}

export interface ReconcileSupervisor {
  deliver(
    cid: string,
    content: string,
    options?: DeliverOptions,
  ): Promise<string | null>;
  requestRun(cid: string): void;
  cancelInboxMessage(cid: string, mid: string): Promise<boolean>;
  /** Single-flight detached job by name; false when not started. */
  launchMaintenanceJob(
    name: string,
    run: (signal: AbortSignal) => Promise<unknown>,
  ): boolean;
  applyReaps(signal?: AbortSignal): Promise<unknown>;
  reconcileWatcherInboxes(signal?: AbortSignal): Promise<void>;
}

export interface ReconcilerDeps<N extends ReconcileNode = ReconcileNode> {
  conversations: {
    load(
      cid: string,
      options?: { withPending?: boolean },
    ): ConversationRecord | null;
    allConvs(options?: { withPending?: boolean }): ConversationRecord[];
    save(conv: ConversationRecord): Promise<unknown> | unknown;
    readBoundedJsonObject(
      path: string,
      maxBytes: number,
    ): Promise<ConversationRecord | null>;
  };
  nodes: {
    existing(cid: string): N | null;
    node(cid: string, store?: any): N;
  };
  agentStore: {
    loadPersistedAgent(cid: string): Promise<[Json | null, Json[]]>;
    retire(cid: string, id: string): void;
  };
  supervisor: ReconcileSupervisor;
  /** AgentTree tick entries plus the outcome due flag. */
  tree: {
    markSpawnOutcomesDue(): void;
    applySpawns(signal?: AbortSignal): Promise<void>;
    processSpawnOutcomes(signal?: AbortSignal): Promise<void>;
    processPlatformActions(): void;
  };
  /** pi_bg_shell restart notices for one session. */
  shells: {
    restartNotices(
      sessionId: string | null | undefined,
    ): Promise<{ id: string; message: string; updatedAt: unknown }[]>;
  };
  lifecycle: {
    startupCleanup(): Promise<CleanupNotice[]>;
    runtimeShellCleanupNotice(
      handle: ProcessHandle,
      cid: string,
      sessionId: string,
      reason: string,
    ): Promise<CleanupNotice | null>;
    startupAllowsTempSweep(): boolean;
  };
  /** agent_temp.drain_trash. */
  drainTrash(): Promise<unknown>;
  /** retry_schedule.ts DeferredReapSeed.seedDeferredReapsAtStartup. */
  seedDeferredReaps(signal?: AbortSignal): Promise<void>;
  /** startup_metrics.count. */
  countMetric(key: string, amount: number): void;
  spawnOutcomeDir: string;
  /** Six hex characters for a temp-file name (uuid4().hex[:6]). */
  tmpSuffix(): string;
  logger: RuntimeLogger;
  /** Monotonic seconds. */
  monotonic(): number;
}

const isDict = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const truthy = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : isDict(value)
      ? Object.keys(value).length > 0
      : Boolean(value);

const abort = (signal: AbortSignal | undefined) => {
  if (signal) checkAbort(signal);
};

const rethrowCancelled = (error: unknown) => {
  if (error instanceof Cancelled) throw error;
};

/** The platform-origin note that resumes one interrupted turn. */
export function restartResumeNote(interruptedAt: string): string {
  return (
    `${RESTART_RESUME_NOTE_PREFIX}; your turn was interrupted ` +
    `at ${interruptedAt}. Continue from where you left off \u2014 ` +
    "check the state of any files or shells you were using " +
    "before assuming a step finished."
  );
}

/** One session timestamp as ``HH:MM UTC`` for the resume note. */
export function resumeInterruptionTime(value: unknown): string {
  const epoch = entryEpoch({ timestamp: value });
  if (epoch === null || epoch < 0) return "an unknown time";
  // Invariant: datetime.fromtimestamp raises past 9999-12-31T23:59:59 UTC.
  if (epoch >= MAX_PY_EPOCH)
    throw Object.assign(new Error("year is out of range"), {
      name: "ValueError",
    });
  const date = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** Whether this intent body or live entry is a restart-resume note. */
export function isRestartResumeNote(entry: unknown): boolean {
  if (!isDict(entry)) return false;
  const content = entry.content;
  if (
    typeof content !== "string" ||
    !content.startsWith(RESTART_RESUME_NOTE_PREFIX)
  )
    return false;
  if (entry.origin !== "platform" && entry.source !== "platform") return false;
  const messageId = entry.id;
  return (
    typeof messageId === "string" && messageId.startsWith("restart-resume-")
  );
}

// Detect interrupted turns in bounded tails: unanswered user/tool results
// or assistant tools without results. Unreadable, foreign or completed tails
// return false with no entry/time.
export async function resumeTailState(
  sessionFile: string,
  sessionId: string,
): Promise<[boolean, string | null, unknown]> {
  const none: [boolean, string | null, unknown] = [false, null, null];
  let ranged: Array<[number, number, Uint8Array]>;
  try {
    const reader = new AsyncJsonlRangeReader(sessionFile);
    const { size } = await reader.sessionInfo();
    if (size <= 0) return none;
    const header = await reader.entryAt(0, HEADER_BYTES);
    if (header === null) return none;
    if (header.type !== "session" || header.id !== sessionId) return none;
    [ranged] = await reader.backwardLines(size, 0, RESTART_RESUME_TAIL_BYTES);
  } catch {
    // Invariant: Python catches OSError; every reader failure here is an OS
    // condition (the async reader throws plain Errors for a non-regular or
    // changed file, which Python raises as OSError).
    return none;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [, , raw] of ranged.slice(0, RESTART_RESUME_TAIL_ROWS)) {
    let entry: unknown;
    try {
      entry = parsePythonJson(decoder.decode(raw));
    } catch {
      continue;
    }
    if (!isDict(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isDict(message)) continue;
    const role = message.role;
    if (typeof role !== "string") continue;
    const stop = message.stopReason;
    if (
      role === "user" ||
      role === "toolResult" ||
      (role === "assistant" &&
        typeof stop === "string" &&
        RESTART_RESUME_TOOL_REASONS.has(stop))
    )
      return [
        true,
        typeof entry.id === "string" ? entry.id : null,
        entry.timestamp ?? null,
      ];
    return none;
  }
  return none;
}

function restartShellNoticeTarget(conv: ConversationRecord | null): boolean {
  return Boolean(
    conv &&
    !truthy(conv.active_turn) &&
    conv.status !== "running" &&
    !truthy(conv.reap_deferred) &&
    !["stopped", "deleted", "quiet-only"].includes(conv.status as string),
  );
}

function restartShellDelivered(conv: ConversationRecord | null): Json {
  const delivered = conv?.shell_restart_delivered;
  return isDict(delivered) ? { ...delivered } : {};
}

export class Reconciler<N extends ReconcileNode = ReconcileNode> {
  /** agent_tree's SpawnOutcomes seam. */
  readonly spawnOutcomes: SpawnOutcomes = {
    read: (cid) => this.readSpawnOutcome(cid),
    write: (cid, status, options) =>
      this.writeSpawnOutcome(cid, status, options),
  };
  /** AgentTempDeps.startupAllowsTempSweep. */
  readonly startupAllowsTempSweepSeam = (): boolean =>
    this.deps.lifecycle.startupAllowsTempSweep();

  constructor(private readonly deps: ReconcilerDeps<N>) {}

  /** Read every selected live record plus its runtime queue (memory). */
  reconcileScan(
    options: { pendingCids?: Set<string> | null } = {},
  ): ConversationRecord[] {
    const { conversations, nodes } = this.deps;
    const pending = options.pendingCids ?? null;
    const convs =
      pending === null
        ? conversations.allConvs({ withPending: false })
        : [...pending]
            .sort()
            .map((cid) => conversations.load(cid, { withPending: false }))
            .filter((conv): conv is ConversationRecord => conv !== null);
    for (const conv of convs) {
      const found = nodes.existing(conv.id as string);
      conv.pending = found !== null ? found.inboxMessages() : [];
    }
    return convs;
  }

  /** Re-expose store survivors: dispatched as uncertain, the rest live. */
  async startupRecover(signal?: AbortSignal): Promise<{
    agents: number;
    intents: number;
    errors: number;
    redrive: string[];
  }> {
    const { conversations, agentStore, nodes, logger } = this.deps;
    let agents = 0;
    let intents = 0;
    let errors = 0;
    const redrive: string[] = [];
    const failed = (error: unknown, cid: string) => {
      logException(logger, "startup_recover_failed", error, {
        conversation_id: cid,
      });
      errors += 1;
    };
    for (const conv of conversations.allConvs({ withPending: false })) {
      const cid = conv.id;
      if (typeof cid !== "string") continue;
      let metadata: Json | null;
      let rows: Json[];
      try {
        [metadata, rows] = await agentStore.loadPersistedAgent(cid);
      } catch (error) {
        abort(signal);
        failed(error, cid);
        continue;
      }
      abort(signal);
      if (metadata === null && rows.length === 0) continue;
      let node: N;
      try {
        node = nodes.node(cid, agentStore);
      } catch (error) {
        failed(error, cid);
        continue;
      }
      agents += 1;
      for (const intent of rows) {
        if (intent.kind === "spawn" || isRestartResumeNote(intent.body)) {
          // Invariant: An applied spawn whose retire never flushed, or a stale
          // resume note: retire the durable row instead of parking it.
          try {
            agentStore.retire(cid, pyStr(intent.id));
          } catch {}
          continue;
        }
        try {
          if (truthy(intent.dispatched)) node.restoreUncertain(intent);
          else {
            node.restoreSendable(intent);
            if (!redrive.includes(cid)) redrive.push(cid);
          }
          intents += 1;
        } catch (error) {
          failed(error, cid);
        }
      }
    }
    return { agents, intents, errors, redrive };
  }

  // Seed deferred reaps/spawns, re-expose survivors, kick never-sent work,
  // and launch the restart-resume pass.
  async recoverAtStartup(signal?: AbortSignal): Promise<void> {
    await this.deps.seedDeferredReaps(signal);
    abort(signal);
    const recovered = await this.startupRecover(signal);
    abort(signal);
    logEvent(this.deps.logger, INFO, "startup_recover", {
      fields: {
        agents: recovered.agents,
        intents: recovered.intents,
        errors: recovered.errors,
      },
    });
    for (const cid of recovered.redrive) this.deps.supervisor.requestRun(cid);
    this.scheduleTurnResumeAfterRestart();
  }

  private resumeHasPending(cid: string): boolean {
    const found = this.deps.nodes.existing(cid);
    if (found === null) return false;
    return found.inboxMessages().some((entry) => !isRestartResumeNote(entry));
  }

  /** Note one interrupted turn; true when a resume note was enqueued. */
  async resumeOneTurn(
    conv: ConversationRecord,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const cid = conv.id;
    if (typeof cid !== "string") return false;
    if (
      truthy(conv.reap_deferred) ||
      conv.status === "deleted" ||
      conv.status === "deleting"
    )
      return false;
    const sessionId = conv.session_id;
    const sessionFile = conv.session_file;
    if (typeof sessionId !== "string" || !sessionId) return false;
    if (typeof sessionFile !== "string" || !sessionFile) return false;
    if (this.resumeHasPending(cid)) return false;
    const [interrupted, entryId, stamp] = await resumeTailState(
      sessionFile,
      sessionId,
    );
    abort(signal);
    // Invariant: The second queue read rechecks after the tail read: a racing
    // send owns this conversation now.
    if (!interrupted || this.resumeHasPending(cid)) return false;
    const when = resumeInterruptionTime(stamp);
    await this.deps.supervisor.deliver(cid, restartResumeNote(when), {
      source: "platform",
      origin: "platform",
      messageId: entryId !== null ? `restart-resume-${entryId}` : null,
    });
    abort(signal);
    logEvent(this.deps.logger, INFO, "turn_resumed_after_restart", {
      conversation_id: cid,
      fields: { interrupted_at: when },
    });
    return true;
  }

  /** Note every turn a restart interrupted. Startup only, detached. */
  async resumeInterruptedTurnsAfterRestart(
    signal?: AbortSignal,
  ): Promise<{ checked: number; resumed: number; errors: number }> {
    const outcome = { checked: 0, resumed: 0, errors: 0 };
    for (const conv of this.deps.conversations.allConvs({
      withPending: false,
    })) {
      const cid = conv.id;
      if (typeof cid !== "string") continue;
      outcome.checked += 1;
      try {
        if (await this.resumeOneTurn(conv, signal)) outcome.resumed += 1;
      } catch (error) {
        rethrowCancelled(error);
        logException(
          this.deps.logger,
          "turn_resume_after_restart_failed",
          error,
          { conversation_id: cid },
        );
        outcome.errors += 1;
      }
    }
    logEvent(this.deps.logger, INFO, "turn_resume_after_restart_summary", {
      fields: { ...outcome },
    });
    return outcome;
  }

  /** Launch the detached restart-resume pass; single-flight by job name. */
  scheduleTurnResumeAfterRestart(): boolean {
    return this.deps.supervisor.launchMaintenanceJob(
      RESTART_RESUME_JOB,
      (jobSignal) => this.resumeInterruptedTurnsAfterRestart(jobSignal),
    );
  }

  /**
   * Drive conversations with pending sendable work; nothing else. A live
   * driver owns its queue; reaped records and uncertain intents never drive.
   */
  reconcile(
    options: {
      pendingCids?: Set<string> | null;
      convs?: ConversationRecord[] | null;
    } = {},
  ): void {
    const { nodes, conversations, supervisor } = this.deps;
    const convs =
      options.convs ??
      this.reconcileScan({ pendingCids: options.pendingCids ?? null });
    for (const scanned of convs) {
      const cid = scanned.id as string;
      const owner = nodes.existing(cid);
      // Invariant: A fenced retry carries a due time; the node decides.
      if (owner === null || owner.oldestSendable() === null) continue;
      const conv = conversations.load(cid, { withPending: false });
      if (conv === null || truthy(conv.reap_deferred)) continue;
      if (nodes.node(cid).turnTask !== null) continue;
      supervisor.requestRun(cid);
    }
  }

  private spawnOutcomePath(cid: string): string {
    return join(this.deps.spawnOutcomeDir, `${cid}.json`);
  }

  async readSpawnOutcome(cid: string): Promise<SpawnOutcome | null> {
    const value = await this.deps.conversations.readBoundedJsonObject(
      this.spawnOutcomePath(cid),
      SPAWN_OUTCOME_MAX_BYTES,
    );
    return value !== null && value.id === cid ? (value as SpawnOutcome) : null;
  }

  /** One CLI saw the terminal result: the delayed parent notice is off. */
  async observeSpawnOutcome(cid: string): Promise<void> {
    await mkdir(this.deps.spawnOutcomeDir, { recursive: true });

    const path = join(this.deps.spawnOutcomeDir, `${cid}.observed`);
    await writeFile(path, "", { flag: "a" });
    const now = new Date();
    await utimes(path, now, now);
    this.deps.tree.markSpawnOutcomesDue();
  }

  /** Publish one idempotent terminal receipt before retiring its request. */
  async writeSpawnOutcome(
    cid: string,
    status: string,
    options: { parent: unknown; code?: string | null; message?: string | null },
  ): Promise<Json> {
    const dir = this.deps.spawnOutcomeDir;
    await mkdir(dir, { recursive: true });
    const existing = await this.readSpawnOutcome(cid);
    if (
      existing !== null &&
      (existing.status === "accepted" || existing.status === "rejected")
    )
      // Invariant: A published acceptance and its conversation are
      // authoritative.
      return existing;
    const outcome: Json = { id: cid, status, parent: options.parent ?? null };
    if (options.code) outcome.code = options.code;
    if (options.message) outcome.message = options.message;
    const tmp = join(dir, `.${cid}.${this.deps.tmpSuffix()}.tmp`);
    await writeFile(tmp, pyCompactJson(outcome));
    await rename(tmp, this.spawnOutcomePath(cid));
    this.deps.tree.markSpawnOutcomesDue();
    return outcome;
  }

  private async commitProcessCleanupNotice(
    notice: CleanupNotice,
    target: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Invariant: next_turn_only parks the note for the next opening batch; the
    // stable row id makes a second startup run file nothing.
    await this.deps.supervisor.deliver(target, notice.content, {
      start: false,
      source: "platform",
      origin: "platform",
      nextTurnOnly: true,
      messageId: `cleanup-${notice.eventId}`,
    });
    abort(signal);
    const current = this.deps.conversations.load(target, {
      withPending: false,
    });
    return (
      current !== null &&
      !(current.status === "running" && truthy(current.active_turn))
    );
  }

  async deliverRuntimeProcessCleanupNotice(
    notice: CleanupNotice,
    signal?: AbortSignal,
  ): Promise<void> {
    const target =
      notice.cid && this.deps.conversations.load(notice.cid) !== null
        ? notice.cid
        : null;
    if (
      target !== null &&
      (await this.commitProcessCleanupNotice(notice, target, signal))
    )
      this.deps.supervisor.requestRun(target);
  }

  /** Enqueue durable platform notes from process lifecycle startup. */
  async startupProcessCleanup(signal?: AbortSignal): Promise<void> {
    let notices: CleanupNotice[];
    try {
      notices = await this.deps.lifecycle.startupCleanup();
    } catch (error) {
      abort(signal);
      logException(
        this.deps.logger,
        "startup_process_cleanup_deferred",
        error,
        {
          level: WARNING,
        },
      );
      return;
    }
    abort(signal);
    this.deps.countMetric("cleanup_notices", notices.length);
    const wakeTargets = new Set<string>();
    for (const notice of notices) {
      const target =
        notice.cid &&
        this.deps.conversations.load(notice.cid, { withPending: false }) !==
          null
          ? notice.cid
          : null;
      if (target === null) continue;
      const wake = await this.commitProcessCleanupNotice(
        notice,
        target,
        signal,
      );
      abort(signal);
      if (wake) wakeTargets.add(target);
    }
    for (const target of wakeTargets) this.deps.supervisor.requestRun(target);
  }

  async queueRestartShellNotices(
    cid: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { conversations, supervisor, shells } = this.deps;
    const conv = conversations.load(cid, { withPending: false });
    if (conv === null || !restartShellNoticeTarget(conv)) return false;
    const sessionId = conv.session_id;
    if (typeof sessionId !== "string") return false;
    let queued = false;
    const delivered = restartShellDelivered(conv);
    const sentMids: string[] = [];
    const notices = await shells.restartNotices(sessionId);
    abort(signal);
    for (const notice of notices) {
      const shellId = notice.id;
      if (typeof shellId !== "string") continue;
      const ackKey = `${shellId}\0${pyStr(notice.updatedAt)}`;
      if (ackKey in delivered) continue;
      // Invariant: Redelivery across a crash appends a harmless duplicate row.
      const mid = await supervisor.deliver(cid, notice.message, {
        start: false,
        source: "platform",
        origin: "platform",
        nextTurnOnly: true,
      });
      abort(signal);
      if (!mid) continue;
      delivered[ackKey] = mid;
      sentMids.push(mid);
      queued = true;
    }
    if (queued) {
      conv.shell_restart_delivered = delivered;
      try {
        await conversations.save(conv);
      } catch (error) {
        rethrowCancelled(error);
        for (const mid of sentMids) {
          await supervisor.cancelInboxMessage(cid, mid);
          abort(signal);
        }
        return false;
      }
      abort(signal);
    }
    return queued;
  }

  /** Queue restart shell notices for every candidate. Startup only. */
  async queueStartupShellNotices(
    convs: ConversationRecord[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const conv of convs) {
      const cid = conv.id;
      if (typeof cid !== "string") continue;
      try {
        await this.queueRestartShellNotices(cid, signal);
      } catch (error) {
        rethrowCancelled(error);
        logException(this.deps.logger, "startup_shell_notice_failed", error, {
          conversation_id: cid,
        });
      }
    }
  }

  // One watcher pass: launch disk work detached and single-flight.
  // Await only the in-memory inbox pass; run the platform pass synchronously.
  async watchOnce(signal?: AbortSignal): Promise<void> {
    const { supervisor, tree, logger } = this.deps;
    const started = this.deps.monotonic();
    const launch = (name: string, run: (s: AbortSignal) => Promise<unknown>) =>
      supervisor.launchMaintenanceJob(name, run);
    const sections: Record<string, number> = {};
    const round3 = (value: number) => Math.round(value * 1000) / 1000;
    try {
      launch("trash_drain", () => this.deps.drainTrash());
      launch("reaps", (s) => supervisor.applyReaps(s));
      let t0 = this.deps.monotonic();
      try {
        await supervisor.reconcileWatcherInboxes(signal);
      } finally {
        sections.inboxes = round3(this.deps.monotonic() - t0);
      }
      abort(signal);
      launch("spawns", (s) => tree.applySpawns(s));
      launch("spawn_outcomes", (s) => tree.processSpawnOutcomes(s));
      t0 = this.deps.monotonic();
      try {
        tree.processPlatformActions();
      } finally {
        sections.platform = round3(this.deps.monotonic() - t0);
      }
    } catch (error) {
      rethrowCancelled(error);
      logException(logger, "watcher_error", error);
    }
    const elapsed = this.deps.monotonic() - started;
    if (elapsed > WATCH_TICK_SLOW_SECONDS) {
      const fields: Json = { elapsed_seconds: round3(elapsed) };
      for (const [name, secs] of Object.entries(sections))
        fields[`${name}_seconds`] = secs;
      logEvent(logger, WARNING, "watch_tick_slow", { fields });
    }
  }

  /** Runtime shell cleanup notifier (session or model change). */
  async enqueueShellCleanup(
    handle: ProcessHandle,
    cid: string,
    sessionId: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const notice = await this.deps.lifecycle.runtimeShellCleanupNotice(
        handle,
        cid,
        sessionId,
        reason,
      );
      abort(signal);
      if (notice !== null) {
        await this.deliverRuntimeProcessCleanupNotice(notice, signal);
        abort(signal);
      }
    } catch (error) {
      rethrowCancelled(error);
      logException(
        this.deps.logger,
        "runtime_process_cleanup_notice_deferred",
        error,
        { conversation_id: cid, level: WARNING },
      );
    }
  }
}

/** Python str() for the JSON values a shell record's updatedAt can carry. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : JSON.stringify(value);
}
