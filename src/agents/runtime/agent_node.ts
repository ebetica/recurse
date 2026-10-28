// Admission/config/file/reap fences; import before replay.
// Uncertain dispatch requires explicit Retry or Dismiss.
import type { Config } from "../../config";
import {
  INFO,
  WARNING,
  logEvent,
  logException,
  type RuntimeLogger,
} from "../../observability/runtime_logging";
import {
  AbortScope,
  Cancelled,
  abortable,
  type TaskSet,
} from "../../utils/tasks";
import { AgentClosed } from "../agent_store";
import {
  SET_MODEL_MARKER,
  stripPendingKeys,
  type ConversationRecord,
  type ConversationStore,
} from "../conversation_store";
import { describeSendFailure } from "../view/failure_sentences";
import type { AgentNodes } from "./agent_nodes";
import { ATTACHMENT_REFERENCE_REGEX, FILE_ID_REGEX } from "./attachments/base";
import { removeFile } from "./attachments/publish";
import {
  SAFETY_OFF_NOTICE,
  SAFETY_ON_NOTICE,
  type ConfigActions,
} from "./config_actions";
import { Fence } from "./fence";
import {
  collectionSnapshot,
  FileLeases,
  type CollectionSnapshot,
} from "./node_files";
import {
  StallTimer,
  type StallTimerDeps,
  type TimerHandle,
} from "./stall_timer";

export type Intent = Record<string, unknown>;

/** Message arrival to runtime acceptance past this names itself. */
export const PROMPT_ACCEPT_WARN_SECONDS = 1.0;
/** Composer send receipts remembered per conversation. */
export const ACKED_CLIENT_CAP = 200;
export const FENCE_RETRY_BASE_SECONDS = 0.5;
export const FENCE_RETRY_CAP_SECONDS = 5.0;
export const FENCE_VISIBLE_ERROR_SECONDS = 15.0;
/** A restart survivor whose prompt may have been written to Pi. */
export const RESTART_UNCERTAIN_NOTICE =
  "The server restarted while sending this message, so it may have reached the agent; Retry to send it again or Dismiss it.";
/** Third consecutive strike also closes the durable store row. */
export const SEND_FAIL_CAP = 3;
const DEBUG = 10;

export interface NodeStore {
  submit(cid: string, kind: string, body: Record<string, unknown>): string;
  retire(cid: string, intentId: string): void;
  noteDispatched(cid: string, intentId: string): void;
  noteUndispatched(cid: string, intentId: string): void;
  enqueueMetadata(cid: string, metadata: Record<string, unknown>): void;
  status(cid: string): Record<string, unknown>;
}

export interface RuntimeErrors {
  runtimeError: new (message: string, options?: ErrorOptions) => Error;
  buildSubmission(
    content: string,
    args: {
      messageId: string;
      arrivalNs: number;
      source?: string;
      origin?: string | null;
      nextTurnOnly?: boolean;
    },
  ): Record<string, unknown>;
}

export interface AgentNodeDeps {
  /** Assigned at wiring: the registry is built over this constructor. */
  nodes: Pick<
    AgentNodes<AgentNode, NodeStore>,
    "existing" | "retiring" | "ownerAdmits" | "admit"
  >;
  conversations: Pick<
    ConversationStore,
    | "convRowExists"
    | "projectionReady"
    | "metadataSnapshot"
    | "load"
    | "save"
    | "saveActivity"
    | "refreshTreeRow"
    | "captureDigestInputs"
    | "publishTitle"
    | "withConfigurationMetadataGuard"
    | "withMuteGuard"
    | "invalidateContextUsage"
  >;
  configActions: Pick<
    ConfigActions,
    "safetyOffLocked" | "applyPendingSafety" | "safetyEffectiveOff"
  >;
  config: Pick<
    Config,
    "ladderHome" | "chatSettings" | "agentTempLeaf" | "paths"
  >;
  runtime: RuntimeErrors;
  /** The shared agent store admission binds. */
  agentStore: NodeStore;
  /** store_import.import_finalized(): false refuses admission. */
  importFinalized(): boolean | null;
  /** Authenticated operator control; commit before publishing its notice. */
  setSafetyReviewOff?(cid: string, off: boolean): Promise<void>;
  /** compaction._action_request(kind, cid). */
  actionRequest(kind: "clear" | "compact", cid: string): unknown;
  requestRun(cid: string): void;
  tasks: TaskSet;
  scheduler: StallTimerDeps["scheduler"];
  nodeLog: RuntimeLogger;
  runtimeLog: RuntimeLogger;
  monotonic(): number;
  now(): number;
  timeNs(): number;
  /** Hex ids; a message id takes its first 12 characters. */
  ids(): string;
  fileDrainTimeoutSeconds?: number;
}

const isNumber = (value: unknown): value is number => typeof value === "number";
const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);
const isDict = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const cut = (text: string, n: number) => [...text].slice(0, n).join("");
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const errorName = (error: unknown) =>
  error instanceof Error ? error.constructor.name : typeof error;

/** Whether this intent is platform status, never operator input. */
export function isPlatformNote(entry: Intent): boolean {
  return entry.origin === "platform";
}

/** Name the trusted provenance that admitted one turn intent. */
export function turnTrigger(entry: Intent, parent: unknown): string {
  if (typeof parent === "string" && parent && entry.from === parent)
    return "(turn started by your message)";
  let origin = entry.origin;
  const ingress = entry._ingress;
  if (typeof origin !== "string" && isDict(ingress)) origin = ingress.origin;
  // Invariant: Older durable intents predate `_ingress`; a sender still proves
  // an agent message when it is not this conversation's parent.
  if ((origin === undefined || origin === null) && entry.from) origin = "agent";
  if (origin === "operator") return "(turn started by an operator message)";
  if (origin === "agent") return "(turn started by an agent message)";
  return "(turn started by a system message)";
}

const ATTACH_ALL = new RegExp(ATTACHMENT_REFERENCE_REGEX.source, "g");

/** In-process owner intent for one conversation. */
export class AgentNode {
  muteDesired: boolean | null = null;
  safetyDesired: boolean | null = null;
  turnTask: Promise<void> | null = null;
  private turnScope: AbortScope | null = null;
  private turnStarted: (() => boolean) | null = null;
  readonly fence = new Fence();
  private pending = new Map<string, Intent>();
  private readonly inFlight = new Map<string, Intent>();
  private readonly byMessage = new Map<string, string>();
  private readonly ackedClientKeys = new Map<string, null>();
  pendingBound = 256;
  private readonly commands: Intent[] = [];
  private readonly stall: StallTimer;
  private dispatchRetry: TimerHandle | null = null;
  persistenceError: [string, string] | null = null;
  private readonly files: FileLeases;
  private lockTail: Promise<void> = Promise.resolve();
  private safetyTail: Promise<unknown> = Promise.resolve();
  private readonly lockTokens = new WeakSet<object>();
  private lastActivityAt: number | null = null;

  constructor(
    readonly cid: string,
    private readonly deps: AgentNodeDeps,
    public store: NodeStore | null = null,
  ) {
    this.stall = new StallTimer({
      monotonic: deps.monotonic,
      scheduler: deps.scheduler,
      log: deps.nodeLog,
    });
    this.files = new FileLeases(cid, {
      load: (id) => deps.conversations.load(id, { withPending: false }),
      log: deps.nodeLog,
      drainTimeoutSeconds: deps.fileDrainTimeoutSeconds,
    });
  }

  /** The reentrant config lock: a held token re-enters, others queue FIFO. */
  async withLock<T>(
    fn: (token: object) => Promise<T>,
    token?: object,
  ): Promise<T> {
    if (token !== undefined && this.lockTokens.has(token)) return fn(token);
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    const held = Object.freeze({});
    this.lockTokens.add(held);
    try {
      return await fn(held);
    } finally {
      this.lockTokens.delete(held);
      release();
    }
  }

  /** This conversation's private uploads directory. */
  uploadsDir(conv: ConversationRecord): string {
    const snapshot = this.snapshotOf(conv);
    if (snapshot === null) throw new Error("unsafe temp key");
    return snapshot.collection;
  }

  private snapshotOf(conv: ConversationRecord): CollectionSnapshot | null {
    return collectionSnapshot(conv, this.deps.config);
  }

  private get nodes() {
    return this.deps.nodes;
  }

  private isCurrent(): boolean {
    return this.nodes.existing(this.cid) === this;
  }

  private requireStore(): NodeStore {
    if (this.store === null)
      throw new Error(`node for ${this.cid} has no store bound`);
    return this.store;
  }

  private indexMessage(entry: Intent, storeId: string): void {
    const messageId = entry.id;
    if (typeof messageId === "string") this.byMessage.set(messageId, storeId);
  }

  /** Admit one intent: store submit first, live note second. */
  recordSubmission(kind: string, body: Intent, first = false): string {
    const entry = { ...body };
    const messageId = entry.id;
    if (typeof messageId === "string" && this.byMessage.has(messageId))
      return this.byMessage.get(messageId)!;
    if (this.pending.size >= this.pendingBound)
      throw new Error(
        `node for ${this.cid} holds ${this.pendingBound} unfinished intents; input not accepted`,
      );
    const storeId = this.requireStore().submit(this.cid, kind, entry);
    this.clearPersistenceError();
    const stored = { ...entry, kind, store_id: storeId };
    if (first) this.pending = new Map([[storeId, stored], ...this.pending]);
    else this.pending.set(storeId, stored);
    this.indexMessage(entry, storeId);
    this.rearmStall();
    return storeId;
  }

  /** Close every uncertain row once a later send was accepted. */
  retireSupersededUncertain(): number {
    const stale = [...this.pending]
      .filter(([, entry]) => entry.uncertain)
      .map(([storeId]) => storeId);
    for (const storeId of stale) this.retireIntent(storeId, false);
    return stale.length;
  }

  private restored(intent: Intent, extra: Intent): [string, Intent] {
    const storeId = String(intent.id);
    const body = intent.body;
    const entry: Intent = isDict(body) ? { ...body } : {};
    Object.assign(entry, {
      kind: intent.kind ?? "submission",
      store_id: storeId,
      ...extra,
    });
    if (this.pending.size >= this.pendingBound)
      throw new Error(
        `node for ${this.cid} holds ${this.pendingBound} unfinished intents; recovery defers to next startup`,
      );
    return [storeId, entry];
  }

  // Re-expose one store survivor as uncertain, with its notice. Startup only.
  restoreUncertain(intent: Intent): string {
    const [storeId, entry] = this.restored(intent, { uncertain: true });
    this.flagError(entry, RESTART_UNCERTAIN_NOTICE, RESTART_UNCERTAIN_NOTICE);
    this.pending.set(storeId, entry);
    this.indexMessage(entry, storeId);
    return storeId;
  }

  /** Re-expose one never-dispatched store survivor as live work. */
  restoreSendable(intent: Intent): string {
    const [storeId, entry] = this.restored(intent, {
      admitted_at: this.deps.monotonic(),
    });
    delete entry.uncertain;
    this.pending.set(storeId, entry);
    this.indexMessage(entry, storeId);
    this.rearmStall();
    return storeId;
  }

  /** Oldest pending intent due for dispatch (never uncertain). */
  oldestSendable(): Intent | null {
    const now = this.deps.monotonic();
    for (const entry of this.pending.values()) {
      if (entry.uncertain) continue;
      const retryAt = entry._dispatch_retry_at;
      if (isNumber(retryAt) && retryAt > now) return null;
      return { ...entry };
    }
    return null;
  }

  private flagError(entry: Intent, error: string, display: string): void {
    entry.error = cut(display, 500);
    entry.error_detail = cut(error, 500);
  }

  /** Flag one intent non-dispatchable after a failed drive. */
  markUncertain(storeId: string, error = ""): boolean {
    const display = error ? describeSendFailure(error) : "";
    let entry = this.pending.get(storeId);
    if (entry === undefined) {
      entry = this.inFlight.get(storeId);
      if (entry === undefined) return false;
      this.inFlight.delete(storeId);
      entry.uncertain = true;
      if (error) this.flagError(entry, error, display);
      else {
        delete entry.error;
        delete entry.error_detail;
      }
      this.pending = new Map([[storeId, entry], ...this.pending]);
    } else {
      entry.uncertain = true;
      if (error) this.flagError(entry, error, display);
    }
    this.rearmStall();
    this.refreshRow();
    return true;
  }

  private gone(): boolean {
    return !this.isCurrent() || this.nodes.retiring(this.cid);
  }

  /** Apply the failed-drive policy (deferred/dropped_gone/dropped/failed). */
  applySendFailure(entry: Intent, storeId: string, exc: unknown): string {
    const log = () =>
      logException(this.deps.nodeLog, "direct_send_failed", exc, {
        conversation_id: this.cid,
        fields: { store_id: storeId },
      });
    const goneText =
      exc instanceof this.deps.runtime.runtimeError ? exc.message : "";
    if (
      this.gone() ||
      goneText === "PiAgent is closed" ||
      goneText === "Pi run identity is malformed" ||
      (goneText.startsWith("conversation ") &&
        (goneText.includes("is gone") || goneText.includes("is being reaped")))
    ) {
      this.retireIntent(storeId, false);
      logEvent(this.deps.nodeLog, INFO, "intent_dropped_agent_gone", {
        conversation_id: this.cid,
        fields: { store_id: storeId },
      });
      return "dropped_gone";
    }
    if (isPlatformNote(entry)) this.retireIntent(storeId, false);
    else {
      const holder = this.pending.get(storeId) ?? this.inFlight.get(storeId);
      let failures: number;
      if (holder === undefined) failures = SEND_FAIL_CAP;
      else {
        const prior = holder.failures;
        failures = isInt(prior) ? prior + 1 : 1;
        holder.failures = failures;
      }
      this.markUncertain(storeId, errorText(exc));
      if (failures >= SEND_FAIL_CAP && this.store !== null) {
        try {
          this.store.retire(this.cid, storeId);
        } catch (storeExc) {
          if (!this.gone())
            this.notePersistenceError("retire", errorText(storeExc));
        }
      }
    }
    log();
    return "failed";
  }

  private reviveEntry(entry: Intent): void {
    for (const key of [
      "uncertain",
      "error",
      "error_detail",
      "_dispatch_retry_at",
      "_dispatch_deferred_at",
      "_dispatch_attempts",
    ])
      delete entry[key];
    entry.admitted_at = this.deps.monotonic();
  }

  /** Make one failed (uncertain) intent sendable again by message id. */
  retryQueued(mid: string): boolean {
    const storeId = this.byMessage.get(mid);
    if (storeId === undefined || this.inFlight.has(storeId)) return false;
    const entry = this.pending.get(storeId);
    if (entry === undefined || !entry.uncertain) return false;
    this.reviveEntry(entry);
    this.rearmStall();
    this.refreshRow();
    return true;
  }

  /** Replay one composer send's ack without admitting a second intent. */
  claimClientKey(clientKey: string): [string, boolean] | null {
    let revive = false;
    const storeId = this.byMessage.get(clientKey);
    if (storeId !== undefined) {
      const entry = this.pending.get(storeId);
      if (entry !== undefined && entry.uncertain) {
        this.reviveEntry(entry);
        revive = true;
      }
    } else if (this.ackedClientKeys.has(clientKey)) {
      this.ackedClientKeys.delete(clientKey);
      this.ackedClientKeys.set(clientKey, null);
    } else return null;
    if (revive) this.rearmStall();
    return [clientKey, revive];
  }

  /** Peek the oldest never-sent intent (a copy). */
  oldestPending(): Intent | null {
    for (const entry of this.pending.values()) return { ...entry };
    return null;
  }

  /** Move one intent to in-flight for its single send. null if gone. */
  take(storeId: string): Intent | null {
    const entry = this.pending.get(storeId);
    if (entry === undefined) return null;
    this.pending.delete(storeId);
    this.inFlight.set(storeId, entry);
    const snapshot = { ...entry };
    this.rearmStall();
    return snapshot;
  }

  /** Return one taken-but-unsent intent to the front of pending. */
  returnInFlight(storeId: string): boolean {
    const entry = this.inFlight.get(storeId);
    if (entry === undefined) return false;
    this.inFlight.delete(storeId);
    this.pending = new Map([[storeId, entry], ...this.pending]);
    this.rearmStall();
    // Invariant: Best-effort unmark: a lost unmark keeps the mark (safe:
    // uncertain, explicitly retryable) and never strands work.
    try {
      this.requireStore().noteUndispatched(this.cid, storeId);
    } catch {}
    return true;
  }

  /** Delay one safe retry; false when it has waited long enough to fail. */
  backoffPending(storeId: string): boolean {
    const now = this.deps.monotonic();
    const entry = this.pending.get(storeId);
    if (entry === undefined) return false;
    let started = entry._dispatch_deferred_at;
    if (!isNumber(started)) {
      started = now;
      entry._dispatch_deferred_at = started;
    }
    if (now - (started as number) >= FENCE_VISIBLE_ERROR_SECONDS) {
      delete entry._dispatch_retry_at;
      return false;
    }
    const attempts = entry._dispatch_attempts;
    const count = isInt(attempts) ? attempts + 1 : 1;
    entry._dispatch_attempts = count;
    entry._dispatch_retry_at =
      now +
      Math.min(
        FENCE_RETRY_BASE_SECONDS * 2 ** Math.min(count - 1, 8),
        FENCE_RETRY_CAP_SECONDS,
      );
    this.rearmStall();
    this.scheduleDispatchRetry(
      Math.max(0, (entry._dispatch_retry_at as number) - this.deps.monotonic()),
    );
    return true;
  }

  /** Wake this exact node once; dropping the node cancels the timer. */
  private scheduleDispatchRetry(delay: number): void {
    const scheduler = this.deps.scheduler;
    if (scheduler === null) return;
    this.dispatchRetry?.cancel();
    this.dispatchRetry = scheduler.callLater(delay, () =>
      this.retryDeferredDispatch(),
    );
  }

  private retryDeferredDispatch(): void {
    this.dispatchRetry = null;
    for (const entry of this.pending.values())
      if (!entry.uncertain) {
        delete entry._dispatch_retry_at;
        break;
      }
    this.deps.requestRun(this.cid);
  }

  /** Make safe deferred work due immediately at a turn boundary. */
  releaseDispatchBackoff(): void {
    this.dispatchRetry?.cancel();
    this.dispatchRetry = null;
    for (const entry of this.pending.values()) {
      delete entry._dispatch_retry_at;
      delete entry._dispatch_deferred_at;
      delete entry._dispatch_attempts;
    }
    this.rearmStall();
  }

  /** Queued plus in-flight intents, for stall diagnostics. */
  pendingDepth(): number {
    return this.pending.size + this.inFlight.size;
  }

  /** Atomically mark the current sendable head's stall as logged. */
  claimStall(storeId: string): Intent | null {
    const now = this.deps.monotonic();
    for (const [currentId, entry] of this.pending) {
      if (entry.uncertain) continue;
      const retryAt = entry._dispatch_retry_at;
      if (isNumber(retryAt) && retryAt > now) return null;
      if (currentId !== storeId || entry._stall_logged) return null;
      entry._stall_logged = true;
      return { ...entry };
    }
    return null;
  }

  /** Close one intent after its ack (or explicit cancel). */
  retireIntent(storeId: string, acked = true): boolean {
    let entry = this.pending.get(storeId);
    if (entry === undefined) {
      entry = this.inFlight.get(storeId);
      this.inFlight.delete(storeId);
    } else {
      this.pending.delete(storeId);
      this.inFlight.delete(storeId);
    }
    for (const [messageId, mapped] of [...this.byMessage])
      if (mapped === storeId) this.byMessage.delete(messageId);
    const clientKey = entry?._client_key;
    if (acked && typeof clientKey === "string" && clientKey) {
      this.ackedClientKeys.delete(clientKey);
      this.ackedClientKeys.set(clientKey, null);
      while (this.ackedClientKeys.size > ACKED_CLIENT_CAP)
        this.ackedClientKeys.delete(this.ackedClientKeys.keys().next().value!);
    }
    this.rearmStall();
    try {
      this.requireStore().retire(this.cid, storeId);
    } catch (exc) {
      if (this.gone()) {
        this.deps.nodeLog.log(DEBUG, "store retire dropped with owner");
        return false;
      }
      this.notePersistenceError("retire", errorText(exc));

      this.deps.nodeLog.log(WARNING, "store retire failed");
      return true;
    }
    this.clearPersistenceError();
    return false;
  }

  /** Retire every never-sent intent (reap-fence path). */
  retireQueuedIntents(): number {
    const storeIds = [...this.pending.keys()];
    for (const storeId of storeIds) this.retireIntent(storeId, false);
    return storeIds.length;
  }

  /** Unfinished pending intents, oldest first (copies). */
  pendingIntents(): Intent[] {
    return [...this.pending.values()].map((entry) => ({ ...entry }));
  }

  /** Republish this agent's cached display row. */
  refreshRow(): void {
    this.deps.conversations.refreshTreeRow(this.cid);
  }

  // Last admitted/start/settled activity, including live unpersisted activity.
  activityUpdated(): number | null {
    const updated = this.deps.conversations.load(this.cid, {
      withPending: false,
      fields: ["updated"],
    })?.updated;
    if (this.lastActivityAt === null)
      return typeof updated === "number" ? updated : null;
    return typeof updated === "number"
      ? Math.max(this.lastActivityAt, updated)
      : this.lastActivityAt;
  }

  // Note activity immediately; only turn settlement writes the piggyback stamp.
  private noteActivity(persist = false): void {
    const now = this.deps.now();
    const previous = this.activityUpdated();
    this.lastActivityAt = previous === null ? now : Math.max(previous, now);
    this.refreshRow();
    if (persist)
      this.deps.conversations.saveActivity(this.cid, this.lastActivityAt);
  }

  /** Surviving unfinished work: pending plus sent-but-unacked. */
  uncertainIntents(): Intent[] {
    return [
      ...this.pendingIntents(),
      ...[...this.inFlight.values()].map((entry) => ({
        ...entry,
        uncertain: true,
      })),
    ];
  }

  /** Queue one driver command (explicit cancel). */
  enqueueCommand(command: Intent): void {
    this.commands.push({ ...command });
  }

  /** Take the oldest driver command. */
  takeCommand(): Intent | null {
    return this.commands.shift() ?? null;
  }

  /** Drop one never-sent intent by message id: [storeId, entry]. */
  revokeLive(messageId: string): [string, Intent] | null {
    const storeId = this.byMessage.get(messageId);
    if (storeId === undefined || this.inFlight.has(storeId)) return null;
    this.byMessage.delete(messageId);
    const entry = this.pending.get(storeId);
    if (entry === undefined) return null;
    this.pending.delete(storeId);
    return [storeId, entry];
  }

  notePersistenceError(op: string, error: string): void {
    this.persistenceError = [op, cut(error, 300)];
  }

  clearPersistenceError(): void {
    this.persistenceError = null;
  }

  rearmStall(): void {
    this.stall.rearm(this);
  }

  dropStall(): void {
    this.stall.drop();
    this.dispatchRetry?.cancel();
    this.dispatchRetry = null;
  }

  /** Admit one intent: revalidate, then store-submit, with no await between. */
  submit(kind: string, body: Intent, first = false): string | null {
    const { conversations } = this.deps;
    if (!conversations.convRowExists(this.cid)) return null;
    if (
      this.deps.importFinalized() === false ||
      !conversations.projectionReady()
    )
      return null;
    if (!this.fence.admits(this.isCurrent(), this.nodes.retiring(this.cid)))
      return null;
    const storeId = this.recordSubmission(kind, body, first);
    this.noteActivity();
    const ingress = isDict(body._ingress) ? body._ingress : {};
    logEvent(this.deps.nodeLog, INFO, "message_admitted", {
      conversation_id: this.cid,
      fields: {
        store_id: storeId,
        kind,
        origin: ingress.origin ?? null,
        source: ingress.source ?? null,
        first,
      },
    });
    return storeId;
  }

  private ownerLive(): boolean {
    return !this.reaping && !this.nodes.retiring(this.cid) && this.isCurrent();
  }

  /** Apply a deliberate rename for the owned conversation. */
  renameTitle(
    title: string,
    order: string,
  ): { title: string; superseded: boolean; pending: boolean } | null {
    if (!this.deps.conversations.convRowExists(this.cid)) return null;
    if (!this.ownerLive()) return null;
    if (!this.deps.conversations.publishTitle(this.cid, title, order))
      return null;
    return { title, superseded: false, pending: false };
  }

  /** Un-driven intents, oldest first (read-only peek). */
  inboxMessages(): Intent[] {
    return this.pendingIntents();
  }

  static messageAttachmentIds(message: Intent): Set<string> {
    const structured = message.attachment_ids;
    const names = [
      ...(Array.isArray(structured) ? structured : []),
      ...[...String(message.content || "").matchAll(ATTACH_ALL)].map(
        (m) => m[1],
      ),
    ];
    return new Set(
      names.filter(
        (name): name is string =>
          typeof name === "string" && FILE_ID_REGEX.test(name),
      ),
    );
  }

  private fileOwnerLive(): boolean {
    return (
      !this.reaping && this.isCurrent() && this.nodes.ownerAdmits(this.cid)
    );
  }

  /** Explicitly delete one owned file. */
  async releaseAttachment(attachmentId: string): Promise<boolean> {
    if (!this.fileOwnerLive()) return false;
    if (!FILE_ID_REGEX.test(attachmentId || "")) return false;
    const conv = this.deps.conversations.load(this.cid);
    if (conv === null) return false;
    const snapshot = this.snapshotOf(conv);
    if (snapshot === null) return false;
    if (!this.fileOwnerLive()) return false;
    return removeFile(snapshot.collection, this.cid, attachmentId);
  }

  /** Whether cancelling this queued row will touch the shared upload store. */
  cancellationReleasesUploads(mid: string): boolean {
    return this.inboxMessages().some(
      (message) =>
        message.id === mid && AgentNode.messageAttachmentIds(message).size > 0,
    );
  }

  /** Queue one explicit cancel for a never-sent intent. */
  async cancelQueued(mid: string, mayReleaseUploads = true): Promise<boolean> {
    const queued = await this.deps.conversations.withMuteGuard(
      this.cid,
      async () => {
        const found = this.pendingIntents().find((entry) => entry.id === mid);
        if (found === undefined) return null;
        const revoked = this.revokeLive(mid);
        if (revoked === null) return null;
        this.retireIntent(revoked[0], false);
        this.refreshRow();
        return found;
      },
    );
    if (queued === null) return false;
    const attachmentIds = AgentNode.messageAttachmentIds(queued);
    if (attachmentIds.size && !mayReleaseUploads) {
      logEvent(
        this.deps.nodeLog,
        WARNING,
        "inbox_cancel_upload_release_skipped",
        {
          conversation_id: this.cid,
          fields: { attachment_count: attachmentIds.size },
        },
      );
      return true;
    }
    const remaining = new Set<string>();
    for (const message of this.uncertainIntents())
      for (const id of AgentNode.messageAttachmentIds(message))
        remaining.add(id);
    for (const aid of attachmentIds)
      if (!remaining.has(aid)) await this.releaseAttachment(aid);
    return true;
  }

  private requireOwner(): void {
    if (!this.deps.conversations.convRowExists(this.cid) || !this.ownerLive())
      throw new KeyError(this.cid);
  }

  private withPending(conv: ConversationRecord): ConversationRecord {
    conv.pending = this.inboxMessages().map(stripPendingKeys);
    return conv;
  }

  /** Switch an IDLE conversation's model for its NEXT turn. */
  async setModel(resolved: string): Promise<ConversationRecord> {
    this.requireOwner();
    const { conversations, config } = this.deps;
    return conversations.withConfigurationMetadataGuard(
      this.cid,
      async (titleToken) => {
        const conv = conversations.load(this.cid);
        if (conv === null) throw new KeyError(this.cid);
        if (conv.status === "running")
          throw new ValueError(
            "finish or stop the current turn before switching model",
          );
        if (conv.model !== resolved) {
          const home = config.ladderHome(resolved);
          if (home !== null) [conv.level, conv.model, conv.effort] = home;
          else {
            const previous = conv.model;
            delete conv.level;
            if (typeof previous === "string" && previous !== resolved)
              conv.legacy_model = previous;
            conv.model = resolved;
            conv.effort = config.chatSettings(resolved)[1];
          }
          conversations.invalidateContextUsage(conv);
          conv[SET_MODEL_MARKER] = true;
        }
        conv.updated = this.deps.now();
        await conversations.save(conv, titleToken);
        return this.withPending(conv);
      },
    );
  }

  /** Set the DESIRED per-action safety-review state; [conv, noteSubmitted]. */
  setSafety(off: boolean): Promise<[ConversationRecord, boolean]> {
    this.requireOwner();
    // Invariant: One toggle at a time, so Durable's review state and the node's
    // desired state change in the same order.
    const result = this.safetyTail.then(() => this.applySafety(Boolean(off)));
    this.safetyTail = result.catch(() => undefined);
    return result;
  }

  private async applySafety(
    off: boolean,
  ): Promise<[ConversationRecord, boolean]> {
    for (;;) {
      // Invariant: Durable commits its review state before the guard is taken:
      // the commit may open the Harness, and an open takes this conversation's
      // guards.
      const durable =
        this.deps.conversations.load(this.cid)?.backend === "durable";
      if (durable) await this.deps.setSafetyReviewOff!(this.cid, off);
      const applied = await this.applySafetyGuarded(off, durable);
      if (applied !== null) return applied;
    }
  }

  private applySafetyGuarded(
    off: boolean,
    durableCommitted: boolean,
  ): Promise<[ConversationRecord, boolean] | null> {
    const { conversations, configActions } = this.deps;
    return conversations.withConfigurationMetadataGuard(
      this.cid,
      async (titleToken, _muteToken, nodeToken) => {
        const conv = conversations.load(this.cid);
        if (conv === null) throw new KeyError(this.cid);
        // Invariant: An import made it Durable after the check: commit there
        // first.
        if (conv.backend === "durable" && !durableCommitted) return null;
        const changed = configActions.safetyOffLocked(conv) !== off;
        const running = conv.status === "running";
        this.safetyDesired = off;
        if (
          conv.status !== "running" &&
          (await configActions.applyPendingSafety(conv, nodeToken))
        ) {
          conv.updated = this.deps.now();
          await conversations.save(conv, titleToken);
        }
        conv.safety_off = configActions.safetyOffLocked(conv);
        conv.safety_off_active = configActions.safetyEffectiveOff(conv);
        let submitted = false;
        if (changed) {
          const msg = this.deps.runtime.buildSubmission(
            off ? SAFETY_OFF_NOTICE : SAFETY_ON_NOTICE,
            {
              messageId: `m-${this.deps.ids().slice(0, 12)}`,
              arrivalNs: this.deps.timeNs(),
              source: "user",
              origin: "platform",
              nextTurnOnly: running,
            },
          );
          msg.admitted_at = this.deps.monotonic();
          try {
            submitted =
              this.nodes.admit(this.cid, "submission", msg, {
                store: this.deps.agentStore,
              }) !== null;
          } catch (error) {
            if (!(error instanceof AgentClosed)) throw error;
            submitted = false;
          }
          this.refreshRow();
        }
        this.refreshRow();
        return [this.withPending(conv), submitted];
      },
    );
  }

  /** The reap fence flag. */
  get reaping(): boolean {
    return this.fence.fenced;
  }

  set reaping(value: boolean) {
    this.fence.fenced = Boolean(value);
  }

  /** Fence this node against new admission for permanent deletion. */
  beginReap(): boolean {
    return this.fence.beginReap();
  }

  /** Admit one file operation against this owner. */
  tryAdmitFileOp(): boolean {
    return this.files.tryAdmit(
      this.fence.admits(this.isCurrent(), this.nodes.retiring(this.cid)),
    );
  }

  releaseFileOp(): void {
    this.files.release();
  }

  private async quiesceSubordinates(
    signal?: AbortSignal,
  ): Promise<[boolean, string | null]> {
    return this.files.drain(signal);
  }

  // Stop activity for permanent deletion; return clean status and diagnostic.
  // Honor the reap's own cancellation signal while abandoned work drains.
  async quiesceMember(
    options: { backgroundHoldReleased?: boolean; signal?: AbortSignal } = {},
  ): Promise<[boolean, string | null]> {
    const { signal } = options;
    // Invariant: Every await below (aborted-driver join, file-work drain)
    // honours the reap's own signal; abandoned work finishes on its own.
    const task = this.turnTask;
    const scope = this.turnScope;
    this.turnTask = null;
    this.turnScope = null;
    if (task !== null) {
      scope?.abort(new Cancelled());
      try {
        await (signal ? abortable(task, signal) : task);
      } catch (exc) {
        if (exc instanceof Cancelled) {
          if (signal?.aborted || !scope?.signal.aborted) throw exc;
        } else return [false, `turn task raised ${errorName(exc)}`];
      }
    }
    const [clean, diagnostic] = await this.quiesceSubordinates(signal);
    if (!clean) return [false, diagnostic];
    this.muteDesired = null;
    this.safetyDesired = null;
    return [true, null];
  }

  /** Apply one driver command. Cancels drop+retire adjacently. */
  applyCommand(command: Intent): void {
    if (command.op !== "cancel") {
      logEvent(this.deps.nodeLog, WARNING, "unknown_driver_command", {
        conversation_id: this.cid,
      });
      return;
    }
    const messageId = command.message_id;
    if (typeof messageId !== "string") return;
    const revoked = this.revokeLive(messageId);
    if (revoked === null) return;
    if (this.isCurrent() && this.nodes.ownerAdmits(this.cid))
      this.retireIntent(revoked[0], false);
    this.refreshRow();
  }

  /** Start the conversation's driver task under its own abort scope. */
  startDrive(drive: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const scope = new AbortScope();
    let started = false;
    const task = this.deps.tasks.spawn(
      `drive:${this.cid}`,
      async (signal) => {
        started = true;
        try {
          await drive(signal);
        } finally {
          // Invariant: Untrack before the task reads as done.
          if (this.turnScope === scope) {
            this.untrack(this.turnTask!);
          }
        }
      },
      scope.signal,
    );
    this.track(task, scope);
    this.turnStarted = () => started;
    return task;
  }

  /**
   * Abort the driver at its next abort point
   * and return it to join (it rejects Cancelled), or null when none runs.
   */
  cancelDrive(): Promise<void> | null {
    const task = this.turnTask;
    const started = this.turnStarted?.() ?? true;
    this.turnScope?.abort(new Cancelled());
    // Invariant: S5: a driver cancelled before its first step never reaches its
    // own finally. Python's task is done at once, so untrack now: a later
    // start() or cancelQueued sees no live driver.
    if (task !== null && !started) this.untrack(task);
    return task;
  }

  track(task: Promise<void>, scope: AbortScope | null = null): void {
    this.turnTask = task;
    this.turnScope = scope;
    this.turnStarted = null;
  }

  untrack(task: Promise<void>): void {
    if (this.turnTask === task) {
      this.turnTask = null;
      this.turnScope = null;
      this.turnStarted = null;
    }
  }
}

/** Python KeyError: the conversation is gone or owned by a reap. */
export class KeyError extends Error {
  override name = "KeyError";
}

/** Python ValueError: a refused switch. */
export class ValueError extends Error {
  override name = "ValueError";
}
