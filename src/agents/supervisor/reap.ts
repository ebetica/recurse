// Reap checks topology/pins under lease, persists intent, quiesces outside.
// Gate processes; retire files before agent databases, legacy before detach.
// Blocked members keep rows for retry; memory detach is await-free.
// Cancellation propagates unparked; durable fences replay at startup.
import { createHash } from "node:crypto";
import { readdir, stat, unlink } from "node:fs/promises";
import { closeSync, constants, existsSync, openSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENT_TEMP_KEY_RE } from "../../config";
import {
  ERROR,
  INFO,
  WARNING,
  logEvent,
  logException,
  type RuntimeLogger,
} from "../../observability/runtime_logging";
import {
  MAX_REPORTED_PROCESSES,
  type ProcessBlocker,
} from "../../process_lifecycle";
import * as trash from "../../utils/trash";
import {
  Cancelled,
  abortable,
  checkAbort,
  type TaskSet,
} from "../../utils/tasks";
import type {
  ConversationRecord,
  ConversationStore,
  ConversationStoreHooks,
} from "../conversation_store";
import { ServiceStorageUnavailable, activeRunId } from "../conversation_store";
import { TreeLifecycleBusy, type TreeLifecycle } from "../mutation_guard";
import {
  attemptOf,
  pySlice,
  type DeferredReaps,
  type ReapRequest,
} from "../retry_schedule";
import {
  KeyError,
  type AgentNode,
  type NodeStore,
} from "../runtime/agent_node";
import type { AgentNodes } from "../runtime/agent_nodes";

/** Seconds one agent-store close may take inside a reap. */
export const STORE_CLOSE_TIMEOUT = 10.0;
/** Rescans of a mutating topology before the subtree parks as unstable. */
export const REAP_RESCAN_BOUND = 3;

const TEMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NEVER = new AbortController().signal;

export type DoomedScan = [
  epoch: number,
  doomed: string[],
  protectedIds: Set<string>,
  protectedFiles: Set<string>,
];

/** Python's RuntimeError, so logs and park reasons name the same class. */
export class RuntimeError extends Error {
  override name = "RuntimeError";
}

/** The root conversation store failed to retire (Python RuntimeError). */
export class ReapRootRetireFailed extends RuntimeError {}

type SessionTuple = [ConversationRecord, Set<string>, Set<string>];
type TempEntry = [string, string | null];
type MemberOutcome = [
  retired: boolean,
  failureReason: string | null,
  session: SessionTuple | null,
  temp: TempEntry,
];

export interface ReapPaths {
  /** MSG_DIR: per-conversation ledger residue. */
  msgDir: string;
  /** TRASH_DIR. */
  trashDir: string;
  muteLockDir: string;
  titleLockDir: string;
  /** (RECURSE_SAFETY_DIR or DATA_DIR)/reviewer-journals. */
  reviewerJournalRoot: string;
}

export interface ReapErrors {
  ProcessCleanupPending: new (message: string) => Error;
  TakenOverReapBlocked: new (cid: string, title?: string | null) => Error;
}

export interface ReapDeps {
  errors: ReapErrors;
  conversations: Pick<
    ConversationStore,
    | "load"
    | "save"
    | "convRowExists"
    | "discardConvProjection"
    | "unbindExternalKey"
    | "unbindServiceConversation"
    | "withPermanentDeleteStateGuard"
  >;
  nodes: Pick<
    AgentNodes<AgentNode, NodeStore>,
    "existing" | "node" | "dropNode"
  >;
  lifecycle: Pick<TreeLifecycle, "guardAsync">;
  /** agent_tree's reap reads (PR8). */
  tree: {
    /** May be async. */
    doomedScan(cid: string): DoomedScan | Promise<DoomedScan>;
    revalidateScan(
      scan: DoomedScan | null,
    ): [string[], Set<string>, Set<string>] | null;
    takeoverReapBlocker(
      doomed: readonly string[],
    ): [string, string | null] | null;
  };
  deferred: DeferredReaps;
  processes: {
    drainReaps(): Promise<void>;
    cleanupCurrentRecordsFor(cids: Set<string>): Promise<boolean>;
    cleanupBackgroundRecordsFor(cids: Set<string>): Promise<boolean>;
    processRecordBlockersFor(cids: Set<string>): Promise<ProcessBlocker[]>;
    stopIdleShellsFor(cid: string): Promise<[number, number]>;
    hasRetainedShellsFor(cid: string): boolean;
  };
  agentStore: {
    readonly baseDir: string;
    dbPaths(cid: string): string[];
    close(cid: string, timeout?: number): Promise<boolean>;
    forget(cid: string): void;
  };
  agentTemp: {
    newAgentTempKey(cid: string): Promise<string>;
    retireMemberCollection(
      cid: string,
      tempKey: string,
    ): Promise<[boolean, string | null]>;
    cleanupAgentTemps(owners: Array<[string, unknown]>): Promise<void>;
    markTrashDrainDue(): void;
    addConversationUpload(
      cid: string,
      data: Uint8Array,
      filename: string,
    ): Promise<Record<string, unknown>>;
  };
  /** PiSessionRetirement.retireReapedSession; never fails the reap. */
  retireLegacySession(
    conv: ConversationRecord,
    protectedIds: Set<string>,
    protectedFiles: Set<string>,
  ): Promise<unknown>;
  /** reap_history.archive_live_record, bound to its paths. */
  archiveLiveRecord(
    cid: string,
    conv: ConversationRecord,
    messagePaths: readonly string[],
    archiveDate: string,
    conversationKey: string,
  ): unknown;
  /** tool_details.retire_conversation (swallows its own OSError). */
  retireToolDetails(cid: string): void | Promise<void>;
  /** Preserve live Artifacts and receipts; prune empty owner storage. */
  pruneArtifactOwner?(cid: string): Promise<unknown>;
  /** prompts._drop_turn_system_prompt(conv, drop_capture=True). */
  dropTurnSystemPrompt(
    conv: ConversationRecord,
    dropCapture: boolean,
  ): Promise<void>;
  viewCache: { drop(cid: string): unknown };
  /** SupervisorDelivery.deliver. */
  deliver(
    cid: string,
    content: string,
    options: {
      start?: boolean;
      source?: string;
      origin?: string;
      messageId?: string;
    },
  ): Promise<string | null>;
  /** SupervisorDelivery.deliverUpward. */
  deliverUpward(
    conv: ConversationRecord,
    content: string,
    options: { source?: string; start?: boolean },
  ): Promise<boolean>;
  paths: ReapPaths;
  log: RuntimeLogger;
  /** time.time(), seconds. */
  now(): number;
  /** Owns the idle-stop completions. */
  tasks: TaskSet;
  /** Flush observed PR identities to surviving ancestors before retirement. */
  drainTouchedPrs?(): Promise<void>;
  // Stop/close/retire one Durable owner; false defers reap.
  durable?: {
    retire(cid: string): Promise<boolean>;
    /** Parent reports waiting for working conversations. */
    readonly reportHolds: { release(): void };
  };
}

/**
 * The work always finishes; a cancel that arrives meanwhile wins afterwards
 * as Cancelled.
 */
async function fenced<T>(
  fn: () => Promise<T>,
  signal: AbortSignal = NEVER,
): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    checkAbort(signal);
    throw error;
  }
  checkAbort(signal);
  return result;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object")
    return Object.keys(value).length > 0;
  return Boolean(value);
}

function isSystemError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

async function unlinkMissingOk(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function utcDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Python sorted() over names: code-point order. */
function sortedNames(names: string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const RETIRE_STAGES: ReadonlyArray<[string, string]> = [
  ["agent database quiesce failed", "agent_database_quiesce_failed"],
  ["agent database retirement failed", "agent_database_retirement_failed"],
  [
    "durable conversation quiesce failed",
    "durable_conversation_quiesce_failed",
  ],
  ["live-archive failed", "live_archive_failed"],
  ["external key unbind failed", "external_key_unbind_failed"],
  ["service unbind failed", "service_unbind_failed"],
  ["file collection retirement failed", "file_collection_retirement_failed"],
  ["pi session retirement failed", "pi_session_retirement_failed"],
];

/** A safe stage label for a failed retirement diagnostic. */
export function retireReasonCode(reason: string): string {
  for (const [prefix, code] of RETIRE_STAGES)
    if (reason === prefix || reason.startsWith(prefix + ":")) return code;
  return "retirement_failed";
}

/** The parent notice for a completed subtree deletion. */
export function deletionNotice(
  cid: string,
  root: ConversationRecord,
  deleted: readonly string[],
  sessions: readonly SessionTuple[],
): string {
  const n = deleted.filter((x) => x !== cid).length;
  const extra = n
    ? `, along with ${n} descendant agent${n === 1 ? "" : "s"}`
    : "";
  const errored: Array<[unknown, string]> = [];
  for (const [c] of sessions)
    if (
      c.status === "error" &&
      typeof c.status_reason === "string" &&
      c.status_reason
    )
      errored.push([c.id, c.status_reason]);
  let errorTail = "";
  if (errored.length) {
    const [firstId, firstReason] = errored[0]!;
    const excerpt = pySlice(firstReason, 200).replaceAll("\n", " ");
    errorTail = ` Last error (${pyStr(firstId)}): ${excerpt}.`;
    if (errored.length > 1) errorTail += ` (+${errored.length - 1} more).`;
  }
  const label = truthy(root.title) ? pyStr(root.title) : cid;

  const revive =
    root.backend === "durable" && root.service_principal == null
      ? ` Revive the agent via subagent revive ${cid}.`
      : "";
  return `[Subagent "${label}" (id ${cid}) was deleted${extra}.${errorTail}${revive}]`;
}

function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** The idle-stop row text, or null when nothing is reported. */
export function stopProcessesMessage(
  stopped: number,
  pending: number,
  convStatus: string | null,
): string | null {
  if (!stopped && !pending) {
    return convStatus !== "idle" ? null : "No running processes.";
  }
  let message = stopped
    ? `Stopped ${stopped} running process${stopped !== 1 ? "es" : ""}.`
    : "No running processes were stopped.";
  if (pending)
    message += ` ${pending} process${pending !== 1 ? "es are" : " is"} still running.`;
  return message;
}

export class SupervisorReap {
  /** In-flight idle-stop completions by cid/stopId (O(live intents)). */
  private readonly stopActive = new Set<string>();

  constructor(private readonly deps: ReapDeps) {}

  /** Retire one quiesced agent database beside itself. */
  retireAgentStoreFiles(cid: string): boolean {
    let dirFd: number;
    try {
      dirFd = openSync(
        this.deps.agentStore.baseDir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch {
      return false;
    }
    try {
      let retired = true;
      let paths: string[];
      try {
        paths = this.deps.agentStore.dbPaths(cid);
      } catch {
        return false;
      }
      for (const path of paths) {
        try {
          if (!trash.retireWithinParent(dirFd, basename(path), ".trash")) {
            // Invariant: Already gone only if nothing live recreates it: the
            // fence holds, so absence is final.
            if (existsSync(path) && statSync(path).isFile()) retired = false;
          }
        } catch {
          retired = false;
        }
      }
      return retired;
    } finally {
      closeSync(dirFd);
    }
  }

  /** Retire only the journal selected by this validated conversation id. */
  retireReviewerJournal(cid: string): void {
    if (!TEMP_ID_RE.test(cid)) return;
    const key = createHash("sha256").update(cid).digest("hex");
    trash.retireAll(
      [join(this.deps.paths.reviewerJournalRoot, key)],
      this.deps.paths.trashDir,
      (exc) =>
        logException(this.deps.log, "tree_retire_failed", exc, {
          level: WARNING,
        }),
    );
  }

  /** Retire one cid's frozen ledger residue through the trash. */
  async retireLedgerResidue(d: string): Promise<void> {
    const generation = new RegExp(`^${escapeRe(d)}\\.g[0-9]{6}\\.jsonl$`);
    const temp = new RegExp(
      `^\\.${escapeRe(d)}\\.g[0-9]{6}\\.jsonl\\.[a-f0-9]{32}\\.tmp$`,
    );
    const names = await listNames(this.deps.paths.msgDir);
    const paths = [
      `${d}.jsonl`,
      ...sortedNames(names.filter((n) => generation.test(n))),
      ...sortedNames(names.filter((n) => temp.test(n))),
    ].map((name) => join(this.deps.paths.msgDir, name));
    trash.retireAll(paths, this.deps.paths.trashDir, (exc) =>
      logException(this.deps.log, "ledger_residue_retire_failed", exc, {
        level: WARNING,
      }),
    );
  }

  private async unlinkLockFiles(d: string): Promise<void> {
    await unlinkMissingOk(join(this.deps.paths.muteLockDir, `${d}.lock`));
    await unlinkMissingOk(join(this.deps.paths.titleLockDir, `${d}.lock`));
  }

  /** Retire cid-keyed files for a conversation with no record. */
  async retireOrphanFiles(d: string): Promise<void> {
    await this.deps.retireToolDetails(d);
    await this.deps.pruneArtifactOwner?.(d);
    this.retireReviewerJournal(d);
    await this.deps.conversations.unbindServiceConversation(d);
    await this.retireLedgerResidue(d);
    await this.unlinkLockFiles(d);
  }

  /** Required pre-database ownership releases: failure reason or null. */
  async retireRequiredReleases(
    d: string,
    conv: ConversationRecord,
    conversationKey: string,
  ): Promise<string | null> {
    const principal = conv.service_principal;
    const key = conv.external_key;
    if (typeof principal === "string" && typeof key === "string") {
      try {
        await this.deps.conversations.unbindExternalKey(principal, key, d);
      } catch (exc) {
        if (exc instanceof ServiceStorageUnavailable || isSystemError(exc))
          return `external key unbind failed: ${(exc as Error).message}`;
        throw exc;
      }
    }
    try {
      await this.deps.conversations.unbindServiceConversation(d);
    } catch (exc) {
      if (isSystemError(exc))
        return `service unbind failed: ${(exc as Error).message}`;
      throw exc;
    }
    const [retired, reason] = await this.deps.agentTemp.retireMemberCollection(
      d,
      conversationKey,
    );
    if (!retired)
      return `file collection retirement failed: ${reason || "unverified"}`;
    return null;
  }

  private async ledgerPaths(d: string): Promise<string[]> {
    const { msgDir } = this.deps.paths;
    const out: string[] = [];
    const head = join(msgDir, `${d}.jsonl`);
    if (await isFile(head)) out.push(head);
    const generation = new RegExp(`^${escapeRe(d)}\\.g[0-9]{6}\\.jsonl$`);
    for (const name of sortedNames(
      (await listNames(msgDir)).filter((n) => generation.test(n)),
    )) {
      const path = join(msgDir, name);
      if (await isFile(path)) out.push(path);
    }
    return out;
  }

  /** Retire one member's files with the agent database last. */
  async retireMemberWorld(
    d: string,
    archiveDate: string,
    protectedIds: Set<string>,
    protectedFiles: Set<string>,
    requestedBy: string | null,
  ): Promise<MemberOutcome> {
    const { conversations, agentStore } = this.deps;
    try {
      const outcome = await conversations.withPermanentDeleteStateGuard(
        d,
        async (titleToken): Promise<MemberOutcome> => {
          const conv = conversations.load(d, { withPending: false });
          const tempEntry: TempEntry = [
            d,
            conv && truthy(conv.tmp_key) ? pyStr(conv.tmp_key) : null,
          ];
          if (conv === null) return [true, null, null, tempEntry];
          const rawKey = conv.tmp_key;
          let conversationKey: string;
          if (typeof rawKey !== "string" || !AGENT_TEMP_KEY_RE.test(rawKey)) {
            conversationKey = await this.deps.agentTemp.newAgentTempKey(d);
            conv.tmp_key = conversationKey;
            await conversations.save(conv, titleToken);
          } else conversationKey = rawKey;
          const paths = await this.ledgerPaths(d);
          let archived: unknown;
          try {
            archived = await this.deps.archiveLiveRecord(
              d,
              conv,
              paths,
              archiveDate,
              conversationKey,
            );
          } catch (exc) {
            if (exc instanceof Cancelled) throw exc;
            archived = false;
          }
          if (!archived) return [false, "live-archive failed", null, tempEntry];
          if (!truthy(conv.reap_deferred)) conv.reap_retry_attempt = 0;
          conv.reap_deferred = true;
          conv.reap_deferred_reason = "agent deletion started";
          conv.reap_requested_by = requestedBy;
          await conversations.save(conv, titleToken);
          // Invariant: Before the agent database closes, so a refusal can still
          // park.
          if (this.deps.durable && !(await this.deps.durable.retire(d)))
            return [
              false,
              "durable conversation quiesce failed",
              null,
              tempEntry,
            ];
          let quiesced: boolean;
          try {
            quiesced = await agentStore.close(d, STORE_CLOSE_TIMEOUT);
          } catch (exc) {
            if (exc instanceof Cancelled) throw exc;
            logException(this.deps.log, "agent_store_close_raised", exc, {
              conversation_id: d,
            });
            quiesced = false;
          }
          if (!quiesced)
            return [false, "agent database quiesce failed", null, tempEntry];
          const releaseFailure = await this.retireRequiredReleases(
            d,
            conv,
            conversationKey,
          );
          if (releaseFailure !== null)
            return [false, releaseFailure, null, tempEntry];
          if (!this.retireAgentStoreFiles(d))
            return [false, "agent database retirement failed", null, tempEntry];
          agentStore.forget(d);
          await this.deps.retireToolDetails(d);
          this.retireReviewerJournal(d);
          await this.deps.dropTurnSystemPrompt(conv, true);
          await this.retireLedgerResidue(d);
          await this.deps.retireLegacySession(
            conv,
            protectedIds,
            protectedFiles,
          );
          return [true, null, [conv, protectedIds, protectedFiles], tempEntry];
        },
      );
      if (outcome[0]) await this.deps.pruneArtifactOwner?.(d);
      return outcome;
    } finally {
      await this.unlinkLockFiles(d);
    }
  }

  /** Revalidate the pre-scan and fence the subtree. Fenced data or null. */
  async reapFence(
    cid: string,
    scan: DoomedScan,
    req: ReapRequest,
    signal: AbortSignal = NEVER,
  ): Promise<
    | [
        string[],
        Set<string>,
        Set<string>,
        ConversationRecord | null,
        string | null,
      ]
    | null
  > {
    const { tree, nodes, conversations, deferred } = this.deps;
    let current = scan;
    for (let i = 0; i < REAP_RESCAN_BOUND; i++) {
      const fencedOut = await this.deps.lifecycle.guardAsync(
        "supervisor.reap",
        cid,
        async () => {
          checkAbort(signal);
          const revalidated = tree.revalidateScan(current);
          if (revalidated === null) return null;
          const [doomed, protectedIds, protectedFiles] = revalidated;
          if (req.by !== null && req.by !== undefined) {
            const blocker = tree.takeoverReapBlocker(doomed);
            if (blocker !== null)
              throw new this.deps.errors.TakenOverReapBlocked(...blocker);
          }
          for (const d of doomed) {
            const node = nodes.existing(d);
            if (node !== null) {
              node.beginReap();
              node.retireQueuedIntents();
            }
          }
          const root = conversations.load(cid, { withPending: false });
          const parent = root?.parent;
          const notifyParent =
            root && truthy(parent) ? (parent as string) : null;
          return [doomed, protectedIds, protectedFiles, root, notifyParent] as [
            string[],
            Set<string>,
            Set<string>,
            ConversationRecord | null,
            string | null,
          ];
        },
      );
      if (fencedOut !== null) return fencedOut;
      current = await tree.doomedScan(cid);
      checkAbort(signal);
    }
    await deferred.parkDeferredReap(current[1], {
      reason: "subtree topology unstable",
      reasonCode: "reap_scan_unstable",
      requestedBy: req.by ?? null,
    });
    await deferred.deferReapRetry(
      cid,
      req,
      0,
      new RuntimeError("subtree topology unstable"),
      { level: WARNING, reasonCode: "reap_scan_unstable" },
    );
    return null;
  }

  /** Persist the deletion intent before any wait or effect. */
  async admitDeletionIntent(
    doomed: readonly string[],
    requestedBy: string | null,
  ): Promise<string> {
    const { conversations } = this.deps;
    let archiveDate = utcDate(this.deps.now());
    for (const d of doomed) {
      const conv = conversations.load(d, { withPending: false });
      if (conv === null) continue;
      let mutated = false;
      if (d === doomed[0]) {
        const existing = conv.reap_archive_date;
        if (typeof existing === "string" && /^[0-9]{8}$/.test(existing))
          archiveDate = existing;
        else {
          conv.reap_archive_date = archiveDate;
          mutated = true;
        }
      }
      if (!truthy(conv.reap_deferred)) {
        conv.reap_retry_attempt = 0;
        conv.reap_deferred = true;
        conv.reap_deferred_reason = "agent deletion admitted";
        conv.reap_requested_by = requestedBy;
        conv.updated = this.deps.now();
        mutated = true;
      }
      if (mutated) await conversations.save(conv);
    }
    return archiveDate;
  }

  /** Stamp one row's deletion request; the status state or null. */
  async stampDeletionRequested(
    cid: string,
    requestedBy: string | null,
  ): Promise<{ cid: string; status: string; reason: string } | null> {
    const conv = this.deps.conversations.load(cid, { withPending: false });
    if (conv === null) return null;
    const reason = "Deletion requested; the backend is removing this agent.";
    conv.reap_retry_attempt = 0;
    conv.reap_deferred = true;
    conv.reap_deferred_reason = "agent deletion requested";
    conv.reap_requested_by = requestedBy;
    conv.status = "deleting";
    conv.status_reason = reason;
    conv.updated = this.deps.now();
    await this.deps.conversations.save(conv);
    return { cid, status: "deleting", reason };
  }

  /** Record one subtree's deletion intent and schedule its execution. */
  async requestReap(
    cid: string,
    requestedBy: string | null = null,
  ): Promise<Record<string, unknown>> {
    logEvent(this.deps.log, INFO, "agent_reap_requested", {
      conversation_id: cid,
      fields: { requester_id: requestedBy || "operator" },
    });
    if (requestedBy !== null) {
      const [, rows] = await this.deps.tree.doomedScan(cid);
      const blocker = this.deps.tree.takeoverReapBlocker(rows);
      if (blocker !== null)
        throw new this.deps.errors.TakenOverReapBlocked(...blocker);
    }
    const state = await this.stampDeletionRequested(cid, requestedBy);
    if (state === null) throw new KeyError(cid);
    this.deps.deferred.queueDeferredReap(cid, { requestedBy, attempt: 0 });
    return { ok: true, ...state };
  }

  /** Enqueue an idle conversation's owned-process stop; acceptance now. */
  requestStopProcesses(
    cid: string,
    stopId: string,
    options: { expected?: string | null; convStatus?: string | null } = {},
  ): Record<string, unknown> | null {
    const expected = options.expected ?? null;
    const convStatus = options.convStatus ?? null;
    if (convStatus !== "idle" && !this.deps.processes.hasRetainedShellsFor(cid))
      return null;
    const requestedAt = this.deps.now();
    void this.deps.tasks.spawn(`stop-processes:${cid}`, () =>
      this.completeIdleProcessStop(cid, expected, stopId, convStatus),
    );
    return {
      ok: true,
      run_id: expected,
      stop_id: stopId,
      status: "stopped_processes",
      updated: requestedAt,
    };
  }

  /** Kill idle-owned groups off the handler, then deliver one row. */
  async completeIdleProcessStop(
    cid: string,
    expected: string | null,
    stopId: string,
    convStatus: string | null,
  ): Promise<void> {
    const key = JSON.stringify([cid, stopId]);
    if (this.stopActive.has(key)) return;
    this.stopActive.add(key);
    try {
      await this.completeIdleProcessStopOnce(cid, expected, stopId, convStatus);
    } finally {
      this.stopActive.delete(key);
    }
  }

  private async completeIdleProcessStopOnce(
    cid: string,
    expected: string | null,
    stopId: string,
    convStatus: string | null,
  ): Promise<void> {
    let stopped: number;
    let pending: number;
    try {
      [stopped, pending] = await this.deps.processes.stopIdleShellsFor(cid);
    } catch (exc) {
      if (exc instanceof Cancelled) throw exc;
      logException(this.deps.log, "stop_processes_failed", exc, {
        conversation_id: cid,
      });
      return;
    }
    const message = stopProcessesMessage(stopped, pending, convStatus);
    if (message === null) return;
    try {
      await this.deps.deliver(cid, message, {
        start: false,
        source: "platform",
        origin: "platform",
        messageId: `stop-processes-${stopId}`,
      });
    } catch (exc) {
      if (exc instanceof Cancelled) throw exc;
      logException(this.deps.log, "stop_processes_deliver_failed", exc, {
        conversation_id: cid,
      });
      return;
    }
    let current: ConversationRecord | null;
    try {
      current = this.deps.conversations.load(cid, { withPending: false });
    } catch (exc) {
      if (exc instanceof Cancelled) throw exc;
      current = null;
    }
    const row = current ?? {};
    const activeRun = activeRunId(row);
    logEvent(this.deps.log, INFO, "stop_processes_completed", {
      conversation_id: cid,
      run_id: expected,
      fields: {
        stop_id: stopId,
        status: "stopped_processes",
        stopped,
        pending,
        running: row.status === "running",
        active_run_id: activeRun,
        session_id: row.session_id ?? null,
      },
    });
  }

  /** Await-free memory detach of one retired subtree. */
  detachDeleted(
    doomed: readonly string[],
    deletedIds: readonly string[],
  ): string[] {
    const deletedSet = new Set(deletedIds);
    for (const d of doomed) {
      this.deps.nodes.dropNode(d);
      if (!deletedSet.has(d)) continue;
      this.deps.conversations.discardConvProjection(d);
      this.deps.viewCache.drop(d);
    }
    return doomed.filter((d) => deletedSet.has(d));
  }

  private async quiesceOne(
    d: string,
    signal: AbortSignal,
    backgroundHoldReleased = false,
  ): Promise<boolean> {
    const node = this.deps.nodes.existing(d);
    const [clean] =
      node !== null
        ? await node.quiesceMember({ backgroundHoldReleased, signal })
        : [true, null];
    return clean;
  }

  /** Quiesce and retire one fenced subtree: [deleted, cleanup, sessions]. */
  async reapRetire(args: {
    cid: string;
    doomed: string[];
    protectedIds: Set<string>;
    protectedFiles: Set<string>;
    requestedBy: string | null;
    notifyParent: string | null;
    root: ConversationRecord | null;
    archiveDate: string;
    signal?: AbortSignal;
  }): Promise<[string[], TempEntry[], SessionTuple[]]> {
    const { cid, doomed, requestedBy, notifyParent, root, archiveDate } = args;
    const signal = args.signal ?? NEVER;
    const { processes, deferred } = this.deps;
    const doomedSet = () => new Set(doomed);
    let processCleanupComplete = true;
    const blockers = new Set<string>();
    for (const d of doomed) {
      if (!(await this.quiesceOne(d, signal))) {
        processCleanupComplete = false;
        blockers.add(d);
      }
    }
    // Invariant: K4: abortable waits over the drain, cleanups and blocker scan.
    await abortable(processes.drainReaps(), signal);
    let recordsComplete = await abortable(
      processes.cleanupCurrentRecordsFor(doomedSet()),
      signal,
    );
    const shellsComplete = await abortable(
      processes.cleanupBackgroundRecordsFor(doomedSet()),
      signal,
    );
    if (shellsComplete && !recordsComplete)
      recordsComplete = await abortable(
        processes.cleanupCurrentRecordsFor(doomedSet()),
        signal,
      );
    if (blockers.size && recordsComplete && shellsComplete) {
      for (const d of doomed) {
        if (!blockers.has(d)) continue;
        if (await this.quiesceOne(d, signal, true)) blockers.delete(d);
      }
      if (!blockers.size) processCleanupComplete = true;
    }
    const recordBlockers = await abortable(
      processes.processRecordBlockersFor(doomedSet()),
      signal,
    );
    if (
      !processCleanupComplete ||
      !recordsComplete ||
      !shellsComplete ||
      recordBlockers.length
    ) {
      const details = recordBlockers
        .slice(0, MAX_REPORTED_PROCESSES)
        .map(
          (b) =>
            `cid ${b.cid}: instance ${b.instanceId}, record ${b.recordId}` +
            (b.pid !== null ? `, pid ${b.pid}` : "") +
            ` (${b.reason})`,
        );
      for (const blocked of sortedNames([...blockers]))
        details.push(
          `cid ${blocked}: current in-memory process could not be reaped`,
        );
      if (recordBlockers.length > MAX_REPORTED_PROCESSES)
        details.push(
          `and ${recordBlockers.length - MAX_REPORTED_PROCESSES} more tracked records`,
        );
      const diagnostic =
        details.join("; ") ||
        "the current process ownership could not be read safely";
      await fenced(
        () =>
          deferred.parkDeferredReap(doomed, {
            reason: diagnostic,
            requestedBy,
          }),
        signal,
      );
      throw new this.deps.errors.ProcessCleanupPending(
        "agent processes could not be safely stopped; deletion was deferred: " +
          diagnostic,
      );
    }
    await this.deps.drainTouchedPrs?.();
    const deletedIds: string[] = [];
    const cleanup: TempEntry[] = [];
    const sessions: SessionTuple[] = [];
    for (const d of [...doomed].reverse()) {
      const [retired, failureReason, session, temp] = await fenced(
        () =>
          this.retireMemberWorld(
            d,
            archiveDate,
            args.protectedIds,
            args.protectedFiles,
            requestedBy,
          ),
        signal,
      );
      cleanup.push(temp);
      if (retired) {
        if (session !== null) sessions.push(session);
        deletedIds.push(d);
        continue;
      }
      const reason = failureReason!;
      logEvent(this.deps.log, ERROR, "agent_store_retire_failed", {
        conversation_id: d,
        fields: { reason: retireReasonCode(reason) },
      });
      const conv = this.deps.conversations.load(d, { withPending: false });
      const attempt = attemptOf((conv ?? {}).reap_retry_attempt ?? 0);
      await deferred.parkDeferredReap([d], {
        reason,
        reasonCode: "store_retire_unverified",
        requestedBy,
      });
      await deferred.deferReapRetry(
        d,
        { by: requestedBy },
        attempt,
        new RuntimeError(reason),
        { reasonCode: "store_retire_unverified", level: ERROR },
      );
      if (d === cid)
        throw new ReapRootRetireFailed(
          `root conversation store failed to retire: ${d} (${reason})`,
        );
    }
    const deleted = this.detachDeleted(doomed, deletedIds);
    if (
      notifyParent &&
      notifyParent !== requestedBy &&
      root &&
      typeof root.side_of !== "string" &&
      deleted.includes(cid)
    ) {
      await fenced(
        () =>
          this.deps.deliverUpward(
            root,
            deletionNotice(cid, root, deleted, sessions),
            { source: "report", start: false },
          ),
        signal,
      );
    }
    this.deps.durable?.reportHolds.release();
    await this.unlinkLockFiles(cid);
    return [deleted, cleanup, sessions];
  }

  /** Store one conversation upload under a loop-owned node lease. */
  async admitConversationUpload(
    owner: string | null,
    data: Uint8Array,
    filename: string,
  ): Promise<Record<string, unknown>> {
    if (!owner) throw new KeyError("attachment owner not found");
    let node = this.deps.nodes.existing(owner);
    if (node === null) {
      if (!this.deps.conversations.convRowExists(owner))
        throw new KeyError("attachment owner not found");
      node = this.deps.nodes.node(owner);
    }
    if (!node.tryAdmitFileOp())
      throw new KeyError("attachment owner not found");
    let saved: unknown;
    try {
      saved = await fenced(() =>
        this.deps.agentTemp.addConversationUpload(owner, data, filename),
      );
    } finally {
      node.releaseFileOp();
    }
    if (saved === null || typeof saved !== "object" || Array.isArray(saved))
      throw new RuntimeError(`upload worker returned ${typeof saved}`);
    return { ...(saved as Record<string, unknown>) };
  }

  /** Delete one root and every reachable child. Returns deleted ids. */
  async reap(
    cid: string,
    requestedBy: string | null = null,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const signal = options.signal ?? NEVER;
    const { tree, deferred, agentTemp } = this.deps;
    const requester = requestedBy || "operator";
    logEvent(this.deps.log, INFO, "agent_reap_requested", {
      conversation_id: cid,
      fields: { requester_id: requester },
    });
    const req: ReapRequest = { cid, by: requestedBy };
    const scan = await tree.doomedScan(cid);
    checkAbort(signal);
    if (requestedBy !== null) {
      const blocker = tree.takeoverReapBlocker(scan[1]);
      if (blocker !== null)
        throw new this.deps.errors.TakenOverReapBlocked(...blocker);
    }
    const fencedOut = await this.reapFence(cid, scan, req, signal);
    if (fencedOut === null) return [];
    const [doomed, protectedIds, protectedFiles, root, notifyParent] =
      fencedOut;
    if (root === null) {
      await fenced(() => this.retireOrphanFiles(cid), signal);
      agentTemp.markTrashDrainDue();
      return [];
    }
    const archiveDate = await fenced(
      () => this.admitDeletionIntent(doomed, requestedBy),
      signal,
    );
    let result: [string[], TempEntry[], SessionTuple[]];
    try {
      result = await this.reapRetire({
        cid,
        doomed,
        protectedIds,
        protectedFiles,
        requestedBy,
        notifyParent,
        root,
        archiveDate,
        signal,
      });
    } catch (exc) {
      if (
        exc instanceof Cancelled ||
        exc instanceof this.deps.errors.ProcessCleanupPending
      )
        throw exc;
      if (exc instanceof ReapRootRetireFailed && deferred.contains(cid))
        throw exc;
      await deferred.parkReapRetry(cid, req, 0, exc, {
        level: ERROR,
        reasonCode: "reap_failed_unexpectedly",
      });
      throw exc;
    }
    const [deleted, cleanup] = result;
    await fenced(() => this.cleanupAgentTemps(cleanup), signal);
    if (deleted.length) agentTemp.markTrashDrainDue();
    for (const deletedId of deleted)
      logEvent(this.deps.log, INFO, "agent_reaped", {
        conversation_id: deletedId,
        fields: {
          requester_id: requester,
          subtree_root: cid,
          deleted_count: deleted.length,
        },
      });
    return deleted;
  }

  /** Drop registered uploads/private scratch after durable deletion. */
  async cleanupAgentTemps(cleanup: TempEntry[]): Promise<void> {
    try {
      await this.deps.agentTemp.cleanupAgentTemps(cleanup);
    } catch (exc) {
      if (exc instanceof Cancelled) throw exc;
      logException(this.deps.log, "temporary_cleanup_deferred", exc, {
        level: WARNING,
      });
    }
  }

  /** Drain explicit deletions and bounded retries of safely parked ones. */
  async applyReaps(signal: AbortSignal = NEVER): Promise<void> {
    const { deferred, conversations } = this.deps;
    const now = this.deps.now();
    for (const [cid, req] of deferred.snapshot()) {
      checkAbort(signal);
      if (req === null || typeof req !== "object" || Array.isArray(req)) {
        deferred.dropReapRetry(cid);
        continue;
      }
      if (!conversations.load(cid, { withPending: false })) {
        deferred.dropReapRetry(cid);
        continue;
      }
      const retryAt = pyFloat("next_due" in req ? req.next_due : 0);
      const priorRaw = pyIntStrict("attempts" in req ? req.attempts : 0);
      if (retryAt === null || priorRaw === null) {
        deferred.dropReapRetry(cid);
        continue;
      }
      const priorAttempt = Math.max(0, priorRaw);
      if (retryAt > now) continue;
      const by = (req.by ?? null) as string | null;
      try {
        await this.reap(cid, by, { signal });
      } catch (exc) {
        if (exc instanceof Cancelled) throw exc;
        if (exc instanceof this.deps.errors.TakenOverReapBlocked) {
          deferred.dropReapRetry(cid);
          if (
            typeof by === "string" &&
            conversations.load(by, { withPending: false }) !== null
          ) {
            try {
              await this.deps.deliver(by, `[Deletion refused] ${exc.message}`, {
                source: "platform",
                origin: "platform",
              });
            } catch (deliveryExc) {
              logException(
                this.deps.log,
                "pinned_reap_notice_failed",
                deliveryExc,
                {
                  conversation_id: cid,
                  level: WARNING,
                  fields: { requester_id: by },
                },
              );
            }
          }
        } else if (exc instanceof this.deps.errors.ProcessCleanupPending) {
          await deferred.deferReapRetry(cid, req, priorAttempt, exc, {
            level: WARNING,
            reasonCode: "owned_process_cleanup_unverified",
          });
        } else if (exc instanceof TreeLifecycleBusy) {
          continue;
        } else {
          await deferred.parkReapRetry(cid, req, priorAttempt, exc, {
            level: ERROR,
            reasonCode: "reap_failed_unexpectedly",
          });
        }
        continue;
      }
      deferred.dropReapRetry(cid);
    }
  }
}

/** Python float(value) or null on TypeError/ValueError. */
function pyFloat(value: unknown): number | null {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (/^[+-]?(inf|infinity|nan)$/.test(t))
      return t.includes("nan") ? NaN : t.startsWith("-") ? -Infinity : Infinity;
    if (t && /^[+-]?(\d[\d_]*)?(\.\d*)?(e[+-]?\d+)?$/.test(t)) {
      const n = Number(t.replaceAll("_", ""));
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

/** Python int(value) or null on TypeError/ValueError. */
function pyIntStrict(value: unknown): number | null {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value))
    return Number(value.trim());
  return null;
}

/**
 * The store hooks this PR closes: safeRemoveTempKey (agent_temp) and
 * dropNode (agent_nodes.drop_node).
 */
export function reapStoreHooks(
  agentTemp: { safeRemoveTempKey(key: string): Promise<boolean> },
  nodes: Pick<AgentNodes<AgentNode, NodeStore>, "dropNode">,
): Pick<ConversationStoreHooks, "safeRemoveTempKey" | "dropNode"> {
  return {
    safeRemoveTempKey: (key) => agentTemp.safeRemoveTempKey(key),
    dropNode: (cid) => nodes.dropNode(cid),
  };
}

export function reapTempSeams(inputs: {
  prompts: {
    turnPromptSnapshotPath(conv: ConversationRecord): string | null;
    turnTransportPromptPath(conv: ConversationRecord): string | null;
    capturedSystemPromptPath(conv: ConversationRecord): string | null;
  };
  nodes: Pick<AgentNodes<AgentNode, NodeStore>, "allTurnTasks">;
  expireHistory(): unknown;
  expireDeletedBin(): unknown;
}): {
  promptSidecarNames(conv: ConversationRecord): string[];
  turnTasksInFlight(): boolean;
  expireRetained(): Promise<void>;
} {
  return {
    promptSidecarNames: (conv) =>
      [
        inputs.prompts.turnPromptSnapshotPath(conv),
        inputs.prompts.turnTransportPromptPath(conv),
        inputs.prompts.capturedSystemPromptPath(conv),
      ]
        .filter((path): path is string => path !== null)
        .map((path) => basename(path)),
    turnTasksInFlight: () => inputs.nodes.allTurnTasks().length > 0,
    expireRetained: async () => {
      await inputs.expireHistory();
      await inputs.expireDeletedBin();
    },
  };
}
