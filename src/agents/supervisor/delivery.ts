// Import before replay/retry; bounded history reads. Detached reports join
// shutdown, not HTTP; remote senders keep provenance; replies go to the parent.
// A report waits while its child or a local descendant works or owes a report;
// each holder's end rechecks it, so it is sent once (durable/README.md).
import { lstat } from "node:fs/promises";
import { cleanTitle } from "../../title_text";
import {
  WARNING,
  logException,
  type RuntimeLogger,
} from "../../observability/runtime_logging";
import { Cancelled, checkAbort, type TaskSet } from "../../utils/tasks";
import { AgentClosed } from "../agent_store";
import {
  validLevel,
  type ConversationRecord,
  type ConversationStore,
} from "../conversation_store";
import type { TreeLifecycle } from "../mutation_guard";
import type { AgentNode, NodeStore } from "../runtime/agent_node";
import type { AgentNodes } from "../runtime/agent_nodes";
import type { ConversationStoreHooks } from "../conversation_store";
import type { ConfigActions } from "../runtime/config_actions";
import { promptTokens } from "../runtime/context_usage";
import { resolveTurnDelivery } from "../runtime/turn_report";
import { messageOrigin, stampMessage } from "../runtime/prompt_stamp";
import { turnTrigger } from "../runtime/agent_node";
import type { DurableReport, ReportOutcome } from "../durable/report";
import type { ReportHolds } from "../durable/report_holds";
import {
  describeTurnFailure,
  providerOutageKind,
} from "../view/failure_sentences";
import {
  assistantText,
  groupPiTurns,
  scanSessionTurns,
} from "../view/session_entries";

/** Composer idempotency keys, as the HTTP boundary validates them. */
export const CLIENT_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Cap for the settle report's session-tail read, matching the reply view. */
export const TURN_REPORT_SESSION_MAX_BYTES = 128 * 1024 * 1024;
export const TURN_TAIL_WAIT_SECONDS = 15.0;
export const TURN_TAIL_RETRY_SECONDS = 0.25;
export const TURN_TAIL_RETRY_MAX_SECONDS = 2.0;

export interface DurableDelivery {
  owns(conv: JsonObject | null | undefined): boolean;
  /** The request id, or null when the conversation is being deleted. */
  send(
    cid: string,
    content: string,
    requestId: string,
    options?: {
      note?: boolean;
      attachmentIds?: readonly string[];
      interrupt?: boolean;
    },
  ): Promise<string | null>;
  // Withdraw queued input by request ID; false once in the transcript.
  cancel(cid: string, requestId: string): Promise<boolean>;
  readonly reportHolds: Pick<ReportHolds, "holders">;
}

export interface DeliveryDeps {
  durable?: DurableDelivery;
  conversations: Pick<
    ConversationStore,
    | "convRowExists"
    | "projectionReady"
    | "load"
    | "save"
    | "refreshTreeRow"
    | "withSafetyGuard"
    | "withTitleGuard"
    | "withMuteGuard"
  >;
  nodes: Pick<
    AgentNodes<AgentNode, NodeStore>,
    "existing" | "node" | "admit" | "dropNode" | "retiring"
  >;
  agentStore: NodeStore & { flush(cid: string): Promise<boolean> };
  configActions: Pick<
    ConfigActions,
    "applyPendingMute" | "mutedLocked" | "applyPendingModelAtAdmission"
  >;
  lifecycle: Pick<TreeLifecycle, "guardAsync">;
  /** pi_protocol.build_submission, injected: this module stays off Pi. */
  buildSubmission(
    content: string | string[],
    args: {
      messageId: string;
      arrivalNs: number;
      source?: string;
      sender?: string | null;
      senderTitle?: string | null;
      origin?: string | null;
      interruptId?: string | null;
      attachmentIds?: string[] | null;
      nextTurnOnly?: boolean;
    },
  ): JsonObject;
  /** store_import.import_finalized(). */
  importFinalized(): boolean | null;
  importLegacy(cid: string, signal: AbortSignal): Promise<void>;
  hasActions(cid: string): boolean;
  drainActions(cid: string, signal: AbortSignal): Promise<boolean>;
  /** coding_backend.BACKEND.bound_session_file. */
  boundSessionFile(
    sessionId: string,
    recordedFile: string,
    recordedCwd: string,
  ): Promise<string | null>;
  noteLevelTurnFailure(level: number, kind: string): void;
  noteLevelTurnSuccess(level: number): void;
  // Reports ignore mid-run abort; pre-start abort reaches onError.
  tasks: TaskSet;
  /** Instance shutdown: aborts detached report tasks. */
  signal?: AbortSignal;
  log: RuntimeLogger;
  /** time.time(), time.time_ns(), time.monotonic(): seconds / ns. */
  now(): number;
  timeNs(): number;
  monotonic(): number;
  /** Hex ids; a message id takes its first 12 characters. */
  ids(): string;
  /** Abortable sleep in seconds (the tail-read backoff). */
  sleep(seconds: number, signal: AbortSignal): Promise<void>;
}

export interface DeliverOptions {
  interrupt?: boolean;
  senderTitle?: string | null;
  start?: boolean;
  source?: string;
  sender?: string | null;
  origin?: string | null;
  messageId?: string | null;
  arrivedNs?: number | null;
  interruptId?: string | null;
  attachmentIds?: string[] | null;
  nextTurnOnly?: boolean;
  first?: boolean;
  clientMessageId?: string | null;
}

export interface TurnReportArgs {
  kind: string;
  runId: string;
  trigger?: unknown;
  turnStarted: unknown;
  aborted: boolean;
  error: string | null;
  settledSample?: JsonObject | null;
}

type JsonObject = Record<string, any>;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const ISO_RE =
  /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?)?(?:([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:\.(\d{1,6}))?)?)?|(Z))?$/;

/** A mixed "2024-0101" is not a form fromisoformat takes. */
function consistentSeparators(text: string): boolean {
  const date = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(date) || /^\d{8}(?!-)/.test(text);
}

function isoEpoch(text: string): number | null {
  const m = ISO_RE.exec(text);
  if (m === null || !consistentSeparators(text)) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  const second = Number(m[6] ?? 0);
  const micros = Number((m[7] ?? "").slice(0, 6).padEnd(6, "0"));
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const monthDays = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (day > (month === 2 ? (leap ? 29 : 28) : monthDays)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (m[8] !== undefined) {
    if (m[4] === undefined) return null;
    const oh = Number(m[9]);
    const om = Number(m[10] ?? 0);
    const os = Number(m[11] ?? 0);
    const ou = Number((m[12] ?? "").padEnd(6, "0"));
    if (oh > 23 || om > 59 || os > 59) return null;
    offset = (m[8] === "-" ? -1 : 1) * (oh * 3600 + om * 60 + os + ou / 1e6);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime() / 1000 + micros / 1e6 - offset;
}

// One session entry's wall-clock time as epoch seconds, if usable. Pi stamps
// ISO-8601 strings; older fixtures carry numeric seconds (values past 1e11 read
// as milliseconds). Unstamped or unparsable entries match nothing.
export function entryEpoch(entry: JsonObject): number | null {
  const ts = entry.timestamp;
  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return null;
    const value = ts > 1e11 ? ts / 1000.0 : ts;
    return value >= 0 ? value : null;
  }
  if (typeof ts === "string") {
    const text = ts.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, "");
    if (!text) return null;
    return isoEpoch(text.endsWith("z") ? `${text.slice(0, -1)}Z` : text);
  }
  return null;
}

/** Admit a trusted link's message with one dedup key across all paths. */
export function deliverRelayed(
  delivery: {
    deliver(
      cid: string,
      content: string,
      options: DeliverOptions,
    ): Promise<string | null>;
  },
  cid: string,
  content: string,
  from: { sender: string; title: string | null },
  clientMessageId: string | null,
  interrupt: boolean,
): Promise<string | null> {
  return delivery.deliver(cid, content, {
    start: false,
    source: "spawn",
    origin: "agent",
    sender: from.sender,
    senderTitle: cleanTitle(from.title),
    interrupt,
    clientMessageId,
  });
}

export class SupervisorDelivery {
  private readonly reports = new Map<symbol, [string, unknown]>();
  constructor(private readonly deps: DeliveryDeps) {}

  hasReports(cid: string): boolean {
    return [...this.reports.values()].some(
      ([source, parent]) =>
        source === cid ||
        parent === cid ||
        this.deps.conversations.load(source, { withPending: false })?.parent ===
          cid,
    );
  }

  private trackReport(cid: string): () => void {
    const key = Symbol();
    this.reports.set(key, [
      cid,
      this.deps.conversations.load(cid, { withPending: false })?.parent,
    ]);
    return () => void this.reports.delete(key);
  }

  // Admit one input to Durable, importing legacy history first. Returns the
  // message id, or null when the target no longer exists or refuses the
  // message.
  async deliver(
    cid: string,
    content: string | string[],
    options: DeliverOptions = {},
  ): Promise<string | null> {
    const { conversations } = this.deps;
    if (!conversations.convRowExists(cid)) return null;
    if (
      this.deps.importFinalized() === false ||
      !conversations.projectionReady()
    )
      return null;
    if (options.origin === "service") {
      // Invariant: A service request never enters a turn launched with the
      // operator-only unreviewed-tools escape hatch.
      const refused = await conversations.withSafetyGuard(cid, async () => {
        const conv = conversations.load(cid, { withPending: false });
        const active = conv?.active_turn;
        return (
          !!conv?.safety_off ||
          (typeof active === "object" &&
            active !== null &&
            !!(active as Record<string, unknown>).safety_off)
        );
      });
      if (refused) return null;
    }
    const arrival = options.arrivedNs ?? this.deps.timeNs();
    const clientKey = options.clientMessageId ?? null;
    let messageId: string;
    if (clientKey !== null) {
      if (typeof clientKey !== "string" || !CLIENT_KEY_RE.test(clientKey))
        throw new RangeError(
          "client_message_id must match ^[A-Za-z0-9._-]{1,64}$",
        );
      messageId = clientKey;
    } else {
      messageId = options.messageId || `m-${this.deps.ids().slice(0, 12)}`;
    }
    let senderTitle: string | null = options.senderTitle ?? null;
    if (options.sender && options.senderTitle === undefined) {
      const senderConv = conversations.load(options.sender, {
        withPending: false,
      });
      senderTitle = (senderConv?.title ?? null) as string | null;
    }
    const msg = this.deps.buildSubmission(content, {
      messageId,
      arrivalNs: arrival,
      source: options.source ?? "user",
      sender: options.sender ?? null,
      senderTitle,
      origin: options.origin ?? null,
      interruptId: options.interruptId ?? null,
      attachmentIds: options.attachmentIds ?? null,
      nextTurnOnly: options.nextTurnOnly ?? false,
    });
    if (options.interrupt) msg.relay_interrupt = true;
    const durable = this.deps.durable;
    // Invariant: Serialize backend selection and legacy admission with the
    // short switchover commit, not with its background clone. Release before
    // model work/send.
    msg.admitted_at = this.deps.monotonic();
    if (clientKey !== null) msg._client_key = clientKey;
    const selected = await conversations.withSafetyGuard(cid, async () =>
      durable?.owns(conversations.load(cid, { withPending: false })) &&
      !this.deps.nodes.existing(cid)?.pendingIntents().length &&
      !this.deps.nodes.existing(cid)?.turnTask
        ? null
        : this.admit(cid, msg, { first: options.first ?? false }),
    );
    if (selected === null && durable) {
      // Invariant: Durable admits the input itself; a repeated request id is
      // admitted once. The request id names the origin and sender
      // (reportDurableRun reads them back); the content carries the same stamp
      // Pi gets. A next-turn-only message is a note: written, it starts no run.
      const text = Array.isArray(content) ? content.join("\n\n") : content;
      const origin = messageOrigin(msg, cid);
      await this.applyOperatorModel(cid, msg);
      return durable.send(
        cid,
        stampMessage({ ...msg, content: text }, cid),
        `op:${origin}:${options.sender ?? ""}:${messageId}`,
        {
          note: options.nextTurnOnly === true,
          attachmentIds: options.attachmentIds ?? [],
          interrupt: options.interrupt,
        },
      );
    }
    const admitted = await this.finishAdmission(
      cid,
      msg,
      selected!,
      options.start ?? true,
    );
    return admitted === null ? null : (msg.id as string);
  }

  // Report across the parent edge under title/mute guards.
  // Resolve pending mute in the delivery section; silent if muted or
  // parentless.
  async deliverUpward(
    conv: ConversationRecord,
    content: string | string[],
    options: {
      source?: string;
      sender?: string | null;
      targetParent?: string | null;
      start?: boolean;
    } = {},
  ): Promise<boolean> {
    return (await this.upward(conv, content, options)) !== "dropped";
  }

  /**
   * deliverUpward's outcome: "dropped" when muted or parentless, "refused"
   * when the parent did not admit a message.
   */
  private async upward(
    conv: ConversationRecord,
    content: string | string[],
    options: {
      source?: string;
      sender?: string | null;
      targetParent?: string | null;
      start?: boolean;
      clientMessageId?: string;
    },
  ): Promise<"sent" | "dropped" | "refused"> {
    const parent = options.targetParent || conv.parent;
    if (!parent) return "dropped";
    const messages = (
      typeof content === "string" ? [content] : [...content]
    ).filter((message) => message);
    if (!messages.length) return "dropped";
    const cid = conv.id as string;
    const { conversations, configActions } = this.deps;
    return conversations.withTitleGuard(cid, (titleToken) =>
      conversations.withMuteGuard(cid, async (muteToken) => {
        const latest = conversations.load(cid);
        // Invariant: Reap notices retain the deleted root snapshot.
        const edge = latest ?? conv;
        const muteChanged = await configActions.applyPendingMute(
          edge,
          muteToken,
        );
        if (latest !== null && muteChanged)
          await conversations.save(edge, titleToken);
        edge.muted = configActions.mutedLocked(edge);
        if (edge.muted) return "dropped";
        const target =
          options.targetParent || (edge.parent as string) || parent;
        if (!target) return "dropped";
        let outcome: "sent" | "refused" = "sent";
        for (const message of messages) {
          const id = await this.deliver(target as string, message, {
            start: options.start ?? true,
            source: options.source ?? "report",
            sender: options.sender ?? null,
            ...(options.clientMessageId === undefined
              ? {}
              : { clientMessageId: options.clientMessageId }),
          });
          if (id === null) outcome = "refused";
        }
        return outcome;
      }),
    );
  }

  // Report a settled Durable run using its report key as request ID.
  // Repeated delivery is admitted once; retry if the parent exists but refuses.
  async reportDurableRun(
    cid: string,
    report: DurableReport,
  ): Promise<ReportOutcome> {
    const { conversations } = this.deps;
    const conv = conversations.load(cid, { withPending: false });
    const parent = conv?.parent;
    if (conv === null || typeof parent !== "string" || !parent) return "done";
    if (this.reportWaits(cid, report.queued)) return "hold";
    // Invariant: The request id is op:<origin>:<sender>:<key> (deliver above).
    const stamp = (requestId: string | undefined) =>
      /^op:([^:]*):([^:]*):/.exec(requestId ?? "") ?? [];
    const [, origin, sender] = stamp(report.requestId);
    const counts = { operator: 0, fromParent: 0, agent: 0 };
    for (const requestId of report.received) {
      const [, from, by] = stamp(requestId);
      if (by === parent) counts.fromParent += 1;
      else if (from === "operator") counts.operator += 1;
      else if (from === "agent" || by) counts.agent += 1;
    }
    const created = conv.created;
    const model =
      typeof conv.model === "string" && conv.model.trim() ? conv.model : null;
    const content = resolveTurnDelivery(
      {
        ...counts,
        earlier: report.earlier,
        trigger: turnTrigger(
          { origin: origin || null, from: sender || null },
          parent,
        ),
        lifetimeSeconds:
          typeof created === "number" ? this.deps.now() - created : null,
        finalText: report.finalText,
        replyUnread: false,
        aborted: report.aborted,
        error:
          report.error === null
            ? null
            : describeTurnFailure(report.error, { model }),
      },
      conv.title,
    );
    const finish = this.trackReport(cid);
    const outcome = await this.upward(conv, content, {
      source: "report",
      sender: cid,
      clientMessageId: report.key,
    }).finally(finish);
    return outcome === "refused" && conversations.convRowExists(parent)
      ? "retry"
      : "done";
  }

  /** Whether `cid` is working, or a local descendant works or owes a report. */
  private reportWaits(cid: string, queued: boolean): boolean {
    const holders = this.deps.durable?.reportHolds.holders(cid, queued) ?? [];
    return holders.some(([other, state]) =>
      other === cid ? state === "turn" : this.below(other, cid),
    );
  }

  /** Whether `cid` descends from `ancestor`; side conversations never do. */
  private below(cid: string, ancestor: string): boolean {
    const load = (id: string) =>
      this.deps.conversations.load(id, {
        withPending: false,
        fields: ["parent", "side_of"],
      });
    const seen = new Set([cid]);
    let conv = load(cid);
    if (conv?.side_of) return false;
    while (typeof conv?.parent === "string" && !seen.has(conv.parent)) {
      if (conv.parent === ancestor) return true;
      seen.add(conv.parent);
      conv = load(conv.parent);
    }
    return false;
  }

  /** The node drive for one conversation, with this supervisor's seams. */
  private drivePending(cid: string): Promise<void> {
    const node = this.deps.nodes.node(cid, this.deps.agentStore);
    return node.startDrive(async (signal) => {
      await this.deps.importLegacy(cid, signal);
      const durable = this.durableOwner(cid);
      if (durable === null) return;
      await this.deps.drainActions(cid, signal);
      if (this.deps.hasActions(cid)) return;
      for (;;) {
        checkAbort(signal);
        const entry = node.oldestSendable();
        if (entry === null) return;
        const storeId = String(entry.store_id);
        if (node.take(storeId) === null) continue;
        try {
          const origin = messageOrigin(entry, cid);
          this.deps.agentStore.noteDispatched(cid, storeId);
          if (!(await this.deps.agentStore.flush(cid)))
            throw new Error("Dispatch mark could not be persisted.");
          checkAbort(signal);
          const accepted = await durable.send(
            cid,
            stampMessage(entry, cid),
            `op:${origin}:${entry.from ?? ""}:${entry.id}`,
            {
              note: entry.next_turn_only === true,
              interrupt: entry.relay_interrupt === true,
              attachmentIds: Array.isArray(entry.attachment_ids)
                ? entry.attachment_ids.filter(
                    (id): id is string => typeof id === "string",
                  )
                : [],
            },
          );
          if (accepted === null) return;
          node.retireIntent(storeId);
        } catch (exc) {
          node.markUncertain(storeId, String(exc));
          checkAbort(signal);
          if (exc instanceof Cancelled) throw exc;
          node.applySendFailure(entry, storeId, exc);
          return;
        } finally {
          node.returnInFlight(storeId);
        }
      }
    });
  }

  /** Queue one explicit-cancel driver command. */
  enqueueCancelCommand(cid: string, mid: string): void {
    this.deps.nodes
      .existing(cid)
      ?.enqueueCommand({ op: "cancel", message_id: mid });
  }

  // Claim client key and admit await-free, preventing reap between them.
  // Return admitted store ID, replayed message ID or null, then drive side
  // effects.
  async admitAndDrive(
    cid: string,
    msg: JsonObject,
    options: { start: boolean; first: boolean },
  ): Promise<string | null> {
    const admitted = await this.deps.conversations.withSafetyGuard(
      cid,
      async () => this.admit(cid, msg, options),
    );
    return this.finishAdmission(cid, msg, admitted, options.start);
  }

  private admit(
    cid: string,
    msg: JsonObject,
    options: { first: boolean },
  ): { id: string | null; replayed: boolean } {
    const clientKey = msg._client_key;
    if (typeof clientKey === "string" && clientKey) {
      const found = this.deps.nodes.existing(cid);
      if (found !== null) {
        const claimed = found.claimClientKey(clientKey);
        if (claimed !== null) {
          const [replayId, needsDrive] = claimed;
          if (needsDrive) this.requestRun(cid);
          return { id: replayId, replayed: true };
        }
      }
    }
    let storeId: string | null;
    try {
      storeId = this.deps.nodes.admit(cid, "submission", msg, {
        first: options.first,
        store: this.deps.agentStore,
      });
    } catch (exc) {
      if (exc instanceof AgentClosed) return { id: null, replayed: false };
      throw exc;
    }
    return { id: storeId, replayed: false };
  }

  /** An operator message consumes the conversation's pending model choice. */
  private async applyOperatorModel(cid: string, msg: JsonObject) {
    if (msg.origin !== "operator") return;
    try {
      await this.deps.configActions.applyPendingModelAtAdmission(cid);
    } catch (exc) {
      if (exc instanceof Cancelled) throw exc;
      logException(this.deps.log, "pending_model_apply_failed", exc, {
        conversation_id: cid,
        level: WARNING,
      });
    }
  }

  private async finishAdmission(
    cid: string,
    msg: JsonObject,
    admitted: { id: string | null; replayed: boolean },
    start: boolean,
  ): Promise<string | null> {
    if (admitted.id === null || admitted.replayed) return admitted.id;
    await this.applyOperatorModel(cid, msg);
    this.deps.conversations.refreshTreeRow(cid);
    if (start) this.requestRun(cid);
    return admitted.id;
  }

  /** Completion hook: deferred intents may now send. Never resends. */
  redriveAfterCompletion(cid: string): void {
    this.deps.nodes.existing(cid)?.releaseDispatchBackoff();
    this.deps.conversations.refreshTreeRow(cid);
    this.requestRun(cid);
  }

  /**
   * Node settle hook: report one settled turn to its parent on a detached
   * task. Captures the settled run's context-usage sample first.
   */
  reportTurnToParent(cid: string, args: TurnReportArgs): void {
    const settledSample = null;
    const finish = this.trackReport(cid);
    const task = this.deps.tasks.spawn(
      `turn-report:${cid}`,
      async (signal) => {
        try {
          await this.deliverTurnReport(cid, { ...args, settledSample }, signal);
        } catch (exc) {
          // Invariant: A cancelled task logs nothing; keep it out of onError.
          if (!(exc instanceof Cancelled)) throw exc;
        }
      },
      this.deps.signal,
    );
    void task.then(finish, finish);
  }

  // Read turn-anchored final text with a bounded wait for session flush.
  // Return text and unread status without treating another turn's reply as
  // final.
  async readTurnFinalText(
    conv: ConversationRecord,
    turnStarted: unknown,
    signal: AbortSignal,
  ): Promise<[string | null, boolean]> {
    const sessionId = conv.session_id;
    const recordedFile = conv.session_file;
    const recordedCwd = conv.session_cwd;
    if (
      typeof sessionId !== "string" ||
      typeof recordedFile !== "string" ||
      typeof recordedCwd !== "string"
    )
      return [null, true];
    const path = await this.deps.boundSessionFile(
      sessionId,
      recordedFile,
      recordedCwd,
    );
    if (path === null) return [null, true];
    if (!isFiniteNumber(turnStarted)) {
      const [text] = await this.scanTurnFinalText(
        sessionId,
        path,
        recordedCwd,
        0.0,
      );
      return [text, false];
    }
    const deadline = this.deps.monotonic() + TURN_TAIL_WAIT_SECONDS;
    let delay = TURN_TAIL_RETRY_SECONDS;
    let newerSeen = false;
    for (;;) {
      const [text, newer] = await this.scanTurnFinalText(
        sessionId,
        path,
        recordedCwd,
        turnStarted,
      );
      newerSeen = newerSeen || newer;
      if (text !== null) return [text, false];
      if (this.deps.monotonic() >= deadline) return [null, !newerSeen];
      await this.deps.sleep(delay, signal);
      delay = Math.min(delay * 2.0, TURN_TAIL_RETRY_MAX_SECONDS);
    }
  }

  /** One turn-anchored tail scan: [qualifying text, turn-newer rows seen]. */
  async scanTurnFinalText(
    sessionId: string,
    path: string,
    sessionCwd: string,
    turnEpoch: number,
  ): Promise<[string | null, boolean]> {
    let size: number;
    try {
      size = (await lstat(path)).size;
    } catch {
      return [null, false];
    }
    const [rows, , , ok] = scanSessionTurns(
      sessionId,
      path,
      sessionCwd,
      size,
      1,
      { maxSessionBytes: TURN_REPORT_SESSION_MAX_BYTES },
    );
    if (!ok || !rows.length) return [null, false];
    const groups = groupPiTurns([...rows].sort((a, b) => a[0] - b[0]));
    if (!groups.length) return [null, false];
    let newer = false;
    outer: for (const group of groups)
      for (const [, , entry] of group.rows) {
        const epoch = entryEpoch(entry);
        if (epoch !== null && epoch >= turnEpoch) {
          newer = true;
          break outer;
        }
      }
    let final: string | null = null;
    for (const [, , entry] of [...groups.at(-1)!.rows].sort(
      (a, b) => a[0] - b[0],
    )) {
      const text = assistantText(entry);
      if (text === null) continue;
      const epoch = entryEpoch(entry);
      if (epoch !== null && epoch >= turnEpoch) final = text;
    }
    return [final || null, newer];
  }

  /** Mark or clear the conversation's effort level after one settled turn. */
  updateLevelReachability(
    conv: ConversationRecord,
    error: string | null,
    aborted: boolean,
  ): void {
    try {
      const level = validLevel(conv.level);
      if (level === null) return;
      if (typeof error === "string" && error.trim()) {
        const stored = conv.model;
        const kind = providerOutageKind(error, {
          model: typeof stored === "string" ? stored : null,
        });
        if (kind !== null) this.deps.noteLevelTurnFailure(level, kind);
      } else if (!aborted) this.deps.noteLevelTurnSuccess(level);
    } catch (exc) {
      logException(this.deps.log, "level_reachability_update_failed", exc, {
        conversation_id: String(conv.id || ""),
      });
    }
  }

  /** Resolve one settled turn's parent delivery. Never raises but Cancelled. */
  async deliverTurnReport(
    cid: string,
    args: TurnReportArgs,
    signal: AbortSignal,
  ): Promise<void> {
    const { conversations } = this.deps;
    try {
      const conv = conversations.load(cid, { withPending: false });
      checkAbort(signal);
      if (conv === null) return;
      this.updateLevelReachability(conv, args.error, args.aborted);
      checkAbort(signal);
      const sample = args.settledSample;
      if (sample !== null && sample !== undefined) {
        // Invariant: Memory-only: a restart re-derives from the session tail.
        const stored = sample.usage;
        if (
          stored === null ||
          stored === undefined ||
          promptTokens(stored) !== null
        ) {
          conv.latest_context_usage =
            stored === undefined ? null : structuredClone(stored);
          await conversations.save(conv);
        }
      }
      const parent = conv.parent;
      if (typeof parent !== "string" || !parent) return;
      const [finalText, replyUnread] = await this.readTurnFinalText(
        conv,
        args.turnStarted,
        signal,
      );
      checkAbort(signal);
      const created = conv.created;
      const lifetime =
        typeof created === "number" ? this.deps.now() - created : null;
      const model =
        typeof conv.model === "string" && conv.model.trim() ? conv.model : null;
      const content = resolveTurnDelivery(
        {
          trigger: (args.trigger ??
            "(turn started by a system message)") as string,
          lifetimeSeconds: lifetime,
          finalText,
          replyUnread,
          aborted: args.aborted,
          error:
            typeof args.error === "string" && args.error.trim()
              ? describeTurnFailure(args.error, { model })
              : null,
          kind: args.kind,
        },
        conv.title,
      );
      checkAbort(signal);
      await this.deliverUpward(conv, content, {
        source: "report",
        sender: cid,
      });
    } catch (exc) {
      if (exc instanceof Cancelled) throw exc;
      logException(this.deps.log, "turn_report_failed", exc, {
        conversation_id: cid,
        run_id: args.runId,
      });
    }
  }

  /** Ensure the conversation's driver task is running. */
  ensureDriver(cid: string): void {
    // Invariant: Once shutdown begins no driver starts; the pending intent
    // stays in the store and the next server's startup redrives it.
    if (this.deps.signal?.aborted) return;
    const { conversations, nodes } = this.deps;
    const conv = conversations.load(cid, { withPending: false });
    if (conv === null) {
      nodes.dropNode(cid);
      return;
    }
    if (conv.reap_deferred || nodes.retiring(cid)) return;
    const owner = nodes.node(cid, this.deps.agentStore);
    // Invariant: A null turnTask is exactly a done or absent task.
    if (owner.turnTask !== null) return;
    this.drivePending(cid);
  }

  /** Drive a conversation's pending intents, oldest first. */
  requestRun(cid: string): void {
    if (
      this.deps.nodes.existing(cid)?.oldestSendable() == null &&
      !this.deps.hasActions(cid)
    )
      return;
    this.ensureDriver(cid);
  }

  /** Remove one queued message. */
  cancelInboxMessage(cid: string, mid: string): Promise<boolean> {
    const found = this.deps.nodes.existing(cid);
    if (found?.inboxMessages().some((entry) => entry.id === mid))
      return found.cancelQueued(mid);
    const durable = this.durableOwner(cid);
    if (durable !== null) return durable.cancel(cid, mid);
    if (found === null) return Promise.resolve(false);
    return found.cancelQueued(mid);
  }

  private durableOwner(cid: string): DurableDelivery | null {
    const durable = this.deps.durable;
    return durable?.owns(
      this.deps.conversations.load(cid, { withPending: false }),
    )
      ? durable
      : null;
  }

  /** Redeliver one failed (uncertain) queued message under its own id. */
  retryInboxMessage(cid: string, mid: string): boolean {
    const found = this.deps.nodes.existing(cid);
    if (found === null || !found.retryQueued(mid)) return false;
    this.requestRun(cid);
    return true;
  }

  /** Remove one queued message; upload releases run under the tree lease. */
  async cancelInboxMessageAsync(
    cid: string,
    mid: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const durable = this.durableOwner(cid);
    if (
      durable !== null &&
      !this.deps.nodes
        .existing(cid)
        ?.inboxMessages()
        .some((entry) => entry.id === mid)
    )
      return durable.cancel(cid, mid);
    const releases =
      this.deps.nodes.existing(cid)?.cancellationReleasesUploads(mid) ?? false;
    if (signal) checkAbort(signal);
    if (releases)
      return this.deps.lifecycle.guardAsync("inbox_cancel", cid, async () => {
        if (signal) checkAbort(signal);
        return this.unlinkQueued(cid, mid, true);
      });
    return this.unlinkQueued(cid, mid, false);
  }

  private async unlinkQueued(
    cid: string,
    mid: string,
    mayReleaseUploads: boolean,
  ): Promise<boolean> {
    const found = this.deps.nodes.existing(cid);
    if (found === null) return false;
    return found.cancelQueued(mid, mayReleaseUploads);
  }
}

export function deliveryStoreHooks(
  nodes: Pick<AgentNodes<AgentNode, NodeStore>, "existing" | "node">,
): Pick<ConversationStoreHooks, "nodeInputs" | "withNodeLock"> {
  return {
    nodeInputs: (cid) => {
      const node = nodes.existing(cid);
      return node === null
        ? null
        : {
            muteDesired: node.muteDesired,
            safetyDesired: node.safetyDesired,
            pendingCount: node.pendingIntents().length,
            inbox: node.inboxMessages(),
            activityUpdated: node.activityUpdated(),
          };
    },
    withNodeLock: (cid, fn, token) => nodes.node(cid).withLock(fn, token),
  };
}
