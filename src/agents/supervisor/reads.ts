// Read supplied values under history claims; revalidate after every await.
// Mid-read reap/rebinding fails closed; never create/warm Pi or fetch live RPC.
// Shared projection/reply policies are injected, not independently duplicated.

import { performance } from "node:perf_hooks";
import { claimChecked } from "../claim_checked";
import {
  providerStartingOverlay,
  readMuted,
  readSafetyEffectiveOff,
  readSafetyOff,
} from "../conversation_status";
import {
  activeRunId,
  dedupePendingRows,
  stripPendingKeys,
  type ConversationRecord,
} from "../conversation_store";
import {
  claimHistory,
  historyAlive,
  historyGeneration,
  historyStatus,
  type HistoryClaim,
  type HistoryClaimDeps,
  type HistoryNode,
  type JsonObject,
  type PiBinding,
} from "../history_claim";
import {
  AttachmentError,
  AttachmentNotFound,
} from "../runtime/attachments/base";
import {
  openDownload,
  type OpenedDownload,
} from "../runtime/attachments/preview";
import { removeFile } from "../runtime/attachments/publish";
import { publishedCallFiles } from "../runtime/attachments/published";
import {
  collectionSnapshot,
  type CollectionSnapshot,
} from "../runtime/node_files";
import type { Config } from "../../config";
import { ConversationView } from "../view/conversation";
import {
  applyBatch,
  completedReplyPage,
  CompletedReplyStorageUnavailable,
  markerSummary,
  thinkingText,
  needsOlder,
  parseEventCursor,
  readBatch,
  replyPollWindow,
  SSE_PAGE_LIMIT,
  sseFrame,
  unavailable,
  unboundReplyPage,
  ViewCache,
  window,
  type ReplyReasonPolicy,
  type ViewBatch,
  type ViewFeed,
  type ViewInputs,
} from "../view/reader";
import {
  listPage,
  previewSnippet,
  type FilePage,
  type ReferenceProof,
  type SessionFilesContext,
  type TextSnippet,
} from "../../session_files";
import { pyCompactJson } from "../../utils/py_compact_json";

/** Same cap the resident view enforces on session bytes. */
export const MAX_SESSION_BYTES = 128 * 1024 * 1024;
export const VIEW_WEIGHT_QUIET_SECONDS = 300;
export const VIEW_SESSION_BYTES_WARN = 16 * 1024 * 1024;

/** Provider stop reasons that mean success, interruption or a tool call. */
export const REPLY_REASONS: ReplyReasonPolicy = Object.freeze({
  success: new Set(["stop", "end_turn", "record"]),
  interrupted: new Set(["aborted", "abort"]),
  tool: new Set(["toolUse", "tool_use"]),
});

/** Record keys read_conversation_metadata drops before the overlay. */
const METADATA_PRIVATE_KEYS = [
  "pi_live_draft",
  "draft",
  "pending_report",
  "report_outbox",
  "mute_epoch",
  "explicit_report_outbox",
  "report_segment_outbox",
  "queued_steers",
  "steer_blocked",
];
/** Runner-private active_turn keys. */
const METADATA_PRIVATE_TURN_KEYS = [
  "replay_steers",
  "materialized_replay_ids",
  "provider_phase",
  "core_reused",
  "runtime_switch_seconds",
  "context_lost",
  "session_recovery",
  "report_segment_obligations",
  "tr_operator",
  "tr_agent",
  "tr_from_parent",
  "pi_terminal_count",
  "pi_terminal_reader",
  "completed_report_segments",
  "report_segment_index",
  "report_explicit_shared_with_direct",
  "operator_msg",
];
/** Reap bookkeeping, session bindings and recovery state: runner-private. */
const METADATA_PRIVATE_LATE_KEYS = [
  "reap_requested_by",
  "reap_retry_attempt",
  "stop_cleanup",
  "session_file",
  "session_cwd",
  "session_resolution_error",
  "session_resolution_recovery",
  "pending_session_recovery",
  "session_recovery_once",
  "pending_auto_compaction",
  "auto_retry",
  "clear_action_id",
  "session_recovery_checked",
  "pi_terminal_settlement",
  "pi_entry_cursor",
  "pi_entry_baseline_session",
  "message_log",
];

/** The resident view cache: 200 projections, evicted after 600 s idle. */
export function createViewCache(): ViewCache {
  return new ViewCache((cid) => new ConversationView(cid, ""), {
    maxViews: 200,
    idleTtl: 600,
  });
}

export interface ReadNode extends HistoryNode {
  inboxMessages(): readonly ConversationRecord[];
}

export interface ReadsDeps {
  readonly claims: HistoryClaimDeps;
  /** Durable conversations' view (src/agents/durable/host.ts). */
  readonly durable?: {
    owns(conv: JsonObject | null | undefined): boolean;
    view(
      cid: string,
      options: {
        after?: string | null;
        before?: string | null;
        limit?: number;
        since?: number | null;
        instance?: string | null;
      },
    ): Promise<JsonObject>;
    thinking(cid: string, offset: number): Promise<JsonObject | null>;
    turnPrompt(cid: string, offset: number): Promise<JsonObject | null>;
    markerSummary(cid: string, offset: number): Promise<JsonObject | null>;
    metadata(cid: string): JsonObject;
    contextUsage(cid: string): Promise<JsonObject>;
    prompt(cid: string): Promise<JsonObject>;
  };
  readonly config: Pick<Config, "agentTempLeaf" | "paths">;
  readonly sessionFiles: SessionFilesContext;
  /** PiBackend.boundSessionFile exact binding check. */
  boundSessionFile(
    sessionId: string,
    recordedFile: string | null,
    recordedCwd: string,
  ): Promise<string | null>;
  /** compaction.pending_actions(cid). */
  pendingActions(cid: string): string[];
  readonly prompts: {
    readTurnPromptValues(input: {
      sessionId: string;
      recordedFile: string;
      recordedCwd: string;
      offset: number;
      conv: JsonObject;
      snap: CollectionSnapshot | null;
      maxSessionBytes: number;
      liveContextMessages?: unknown;
    }): Promise<JsonObject | null>;
    readPromptValues(conv: JsonObject): Promise<Record<string, string>>;
  };
  readonly contextUsage: {
    readContextUsageValues(
      conv: JsonObject,
      liveSample: JsonObject | null,
      sessionId: string,
      recordedFile: string,
      recordedCwd: string,
    ): Promise<JsonObject>;
  };
  /** stat(2) without following symlinks; rejects with the fs error. */
  lstatSize(path: string): Promise<number>;
  /** Warn event sink (runtime_logging.log_event on the agents logger). */
  logWarning(event: string, fields: JsonObject): void;
  /** Seconds, monotonic. */
  monotonic?(): number;
  sleep?(seconds: number): Promise<void>;
  /** ConversationStore.composeLoaded: what load serves, in place. */
  composeLoaded(cid: string, conv: JsonObject, withPending: boolean): void;
  readonly files?: FileOps;
}

export interface FileOps {
  listPage: typeof listPage;
  previewSnippet: typeof previewSnippet;
  openDownload: typeof openDownload;
  removeFile: typeof removeFile;
  publishedCallFiles: typeof publishedCallFiles;
}
const DEFAULT_FILE_OPS: FileOps = {
  listPage,
  previewSnippet,
  openDownload,
  removeFile,
  publishedCallFiles,
};

type Status<T> = [status: number, value: T];

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as { code?: string }).code
    : undefined;
}

export class SupervisorReads {
  readonly viewCache: ViewCache;
  private readonly weightReported = new Map<string, number>();
  private readonly monotonic: () => number;
  private readonly sleep: (seconds: number) => Promise<void>;
  private readonly files: FileOps;

  constructor(
    private readonly deps: ReadsDeps,
    viewCache: ViewCache = createViewCache(),
  ) {
    this.viewCache = viewCache;
    this.files = deps.files ?? DEFAULT_FILE_OPS;
    this.monotonic = deps.monotonic ?? (() => performance.now() / 1000);
    this.sleep =
      deps.sleep ??
      ((seconds) => new Promise((done) => setTimeout(done, seconds * 1000)));
  }

  private claim(cid: string): HistoryClaim | null {
    return claimHistory(this.deps.claims, cid);
  }
  private alive(claim: HistoryClaim): boolean {
    return historyAlive(this.deps.claims, claim);
  }
  private snapshotOf(conv: JsonObject): CollectionSnapshot | null {
    return collectionSnapshot(conv, this.deps.config);
  }

  /** Recorded collection identity for one owner, without creating roots. */
  fileSnapshot(cid: string): CollectionSnapshot | null {
    const conv = this.deps.claims.metadataSnapshot(cid);
    if (conv === null || conv.id !== cid) return null;
    return this.snapshotOf(conv);
  }

  private claimFileOwner(
    cid: string,
  ): [HistoryClaim, CollectionSnapshot] | null {
    const claim = this.claim(cid);
    if (claim === null) return null;
    const snap = this.snapshotOf(claim.conv);
    if (snap === null || snap.owner !== cid) return null;
    return [claim, snap];
  }

  private checked<T>(
    claim: HistoryClaim,
    work: () => Promise<[number | null, T | null]>,
  ): Promise<[number, T | null]> {
    return claimChecked(
      claim,
      work,
      () => this.alive(claim),
      (cid) => this.deps.claims.metadataSnapshot(cid),
    );
  }

  /** 200 page, 400 bad cursor/limit, 404 gone, 409 lost race, 500 corrupt. */
  async composeFilePage(
    cid: string,
    cursor: string | null = null,
    limit: unknown = 1000,
    generation: number | null = null,
  ): Promise<Status<FilePage | null>> {
    const claimed = this.claimFileOwner(cid);
    if (claimed === null) return [404, null];
    const [claim, snap] = claimed;
    const sessionId = claim.binding?.sessionId ?? null;
    return this.checked(claim, async () => {
      try {
        return [
          null,
          await this.files.listPage(
            snap,
            this.deps.sessionFiles,
            sessionId,
            cursor,
            limit,
            generation,
          ),
        ];
      } catch (error) {
        if (error instanceof AttachmentError) return [500, null];
        if (error instanceof TypeError || error instanceof RangeError)
          return [400, null];
        throw error;
      }
    });
  }

  /** Claim-checked text preview with a binding-derived offset proof. */
  async composeFilePreview(
    cid: string,
    storage: string,
    attachmentId: string,
    offset: number | null = null,
  ): Promise<Status<TextSnippet | null>> {
    const claimed = this.claimFileOwner(cid);
    if (claimed === null) return [404, null];
    const [claim, snap] = claimed;
    let proof: ReferenceProof | null = null;
    if (offset !== null) {
      const binding = claim.binding;
      // Invariant: An offset needs the recorded binding; a missing binding
      // refuses.
      if (binding === null) return [404, null];
      proof = [[binding.sessionId, binding.sessionFile, binding.cwd], offset];
    }
    const [status, snippet] = await this.checked(claim, async () => {
      try {
        return [
          null,
          await this.files.previewSnippet(
            snap,
            this.deps.sessionFiles,
            storage,
            attachmentId,
            proof,
          ),
        ];
      } catch (error) {
        if (error instanceof AttachmentError) return [500, null];
        if (error instanceof TypeError || error instanceof RangeError)
          return [400, null];
        throw error;
      }
    });
    if (status !== 200) return [status, null];
    if (snippet === null) return [404, null];
    return [200, snippet];
  }

  /**
   * 200 checked open blob (the caller closes it), 404 gone or missing, 409
   * lost race, 500 corrupt.
   */
  async composeFileDownload(
    cid: string,
    attachmentId: string,
  ): Promise<Status<OpenedDownload | null>> {
    const claimed = this.claimFileOwner(cid);
    if (claimed === null) return [404, null];
    const [claim, snap] = claimed;
    let opened: OpenedDownload | null = null;
    try {
      const [status, downloaded] = await this.checked(claim, async () => {
        try {
          opened = await this.files.openDownload(
            snap.collection,
            snap.owner,
            attachmentId,
          );
          return [null, opened];
        } catch (error) {
          if (error instanceof AttachmentNotFound) return [404, null];
          if (error instanceof AttachmentError) return [500, null];
          throw error;
        }
      });
      if (status === 200 && downloaded !== null) {
        opened = null;
        return [200, downloaded];
      }
      return [status === 200 ? 404 : status, null];
    } finally {
      // Invariant: A claim lost after the open discards the result: close it
      // here.
      await (opened as OpenedDownload | null)?.blob.close();
    }
  }

  /** 200 deleted, 404 gone or missing, 409 lost race, 500 corrupt. */
  async composeFileDelete(
    cid: string,
    attachmentId: string,
  ): Promise<Status<boolean>> {
    const claimed = this.claimFileOwner(cid);
    if (claimed === null) return [404, false];
    const [claim, snap] = claimed;
    const [status, removed] = await this.checked(claim, async () => {
      try {
        return [
          null,
          await this.files.removeFile(
            snap.collection,
            snap.owner,
            attachmentId,
          ),
        ];
      } catch (error) {
        if (error instanceof AttachmentError) return [500, null];
        throw error;
      }
    });
    if (status !== 200) return [status, false];
    if (!removed) return [404, false];
    return [200, true];
  }

  /** Warn once per quiet period when one view's session is exceptional. */
  reportViewWeight(cid: string, sessionBytes: number): void {
    if (sessionBytes < VIEW_SESSION_BYTES_WARN) return;
    const now = this.monotonic();
    if (now - (this.weightReported.get(cid) ?? 0) < VIEW_WEIGHT_QUIET_SECONDS)
      return;
    for (const [key, seen] of [...this.weightReported])
      if (now - seen >= VIEW_WEIGHT_QUIET_SECONDS)
        this.weightReported.delete(key);
    this.weightReported.set(cid, now);
    this.deps.logWarning("view_weight_heavy", {
      conversation_id: cid,
      session_bytes: sessionBytes,
    });
  }

  viewInputs(
    cid: string,
    conv: JsonObject,
    node: ReadNode | null,
    binding: PiBinding | null,
  ): ViewInputs {
    const activeRun =
      "pi_terminal_settlement" in conv ? null : activeRunId(conv);
    const status = conv.status ?? "idle";
    const sid = binding !== null ? binding.sessionId : "";
    const pending = dedupePendingRows(
      node !== null ? [...node.inboxMessages()] : [],
    );
    const envelope = {
      generation: historyGeneration(sid),
      turn_status: typeof status === "string" ? status : "idle",
      retry_notice: null,
      active_run: activeRun,
      pending: pending.map((message) => stripPendingKeys(message)),
      pending_actions: this.deps.pendingActions(cid),
    };
    return {
      cid,
      sessionId: sid,
      sessionFile: binding !== null ? binding.sessionFile : null,
      sessionCwd: binding !== null ? binding.cwd : "",
      live: "[]",
      envelope: pyCompactJson(envelope, { separators: "default" }),
      files: "{}",
      maxSessionBytes: MAX_SESSION_BYTES,
      unbound: binding === null && !conv.session_id && !conv.session_file,
    };
  }

  /** A bound session whose file was never created: ready-empty. */
  private async missingSessionFile(inputs: ViewInputs): Promise<boolean> {
    if (!(inputs.sessionId && inputs.sessionFile && inputs.sessionCwd))
      return false;
    try {
      await this.deps.lstatSize(inputs.sessionFile);
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
    return false;
  }

  /** Binding/file reads over supplied values, no owner discovery. */
  async readViewValues(
    inputs: ViewInputs,
    feed: ViewFeed,
    collection: [string, string] | null,
    older: boolean | null,
    callIds: readonly string[] = [],
  ): Promise<[ViewBatch | null, string]> {
    let batch: ViewBatch | null;
    if (inputs.unbound) {
      batch = {
        feed: {
          sessionKey: "unbound",
          position: 0,
          oldest: 0,
          tip: null,
          parent: null,
        },
        entries: "[]",
        reset: feed.sessionKey !== "unbound",
        caughtUp: true,
        older: false,
      };
    } else if (older === null) {
      batch = null;
    } else {
      const path = await this.deps.boundSessionFile(
        inputs.sessionId,
        inputs.sessionFile,
        inputs.sessionCwd,
      );
      if (path === null) {
        if (!(await this.missingSessionFile(inputs)))
          throw new Error("session binding unavailable");
        // Invariant: Same empty thread as unbound; the placeholder key stays
        // steady until the first real write reseeds the view.
        const key = `missing:${inputs.sessionId}`;
        batch = {
          feed: {
            sessionKey: key,
            position: 0,
            oldest: 0,
            tip: null,
            parent: null,
          },
          entries: "[]",
          reset: feed.sessionKey !== key,
          caughtUp: true,
          older: false,
        };
      } else {
        try {
          this.reportViewWeight(inputs.cid, await this.deps.lstatSize(path));
        } catch {}
        batch = await readBatch(inputs, feed, { older });
      }
    }
    const files = collection
      ? await this.files.publishedCallFiles(collection[0], collection[1])
      : {};
    const picked: Record<string, unknown> = {};
    for (const key of callIds)
      if (Object.hasOwn(files, key)) picked[key] = files[key];
    return [batch, pyCompactJson(picked, { separators: "default" })];
  }

  /** Read bounded history without creating, warming or waiting for Pi. */
  async readViewWindow(
    cid: string,
    options: {
      after?: string | null;
      before?: string | null;
      limit?: number;
      since?: number | null;
      instance?: string | null;
    } = {},
  ): Promise<JsonObject> {
    const before = options.before ?? null;
    const limit = options.limit ?? 50;
    const durable = this.deps.durable;
    if (durable?.owns(this.deps.claims.metadataSnapshot(cid)))
      return durable.view(cid, { ...options, limit });
    for await (const view of this.viewCache.acquire(cid)) {
      const claim = this.claim(cid);
      if (view === null || claim === null) {
        if (claim === null) this.viewCache.drop(cid);
        return unavailable();
      }
      const node = claim.node as ReadNode | null;
      let inputs = this.viewInputs(cid, claim.conv, node, claim.binding);
      let caughtUp = false;
      for (const older of [false, true, null] as const) {
        const callIds = older === null ? view.unresolvedAttachments() : [];
        if (
          (older === true && !needsOlder(view, before, limit)) ||
          (older === null && callIds.length === 0)
        )
          continue;
        const snapshot = callIds.length ? this.snapshotOf(claim.conv) : null;
        const collection: [string, string] | null =
          snapshot !== null ? [snapshot.collection, snapshot.owner] : null;
        const generation = view.instanceId;
        let batch: ViewBatch | null;
        let files: string;
        try {
          [batch, files] = await this.readViewValues(
            inputs,
            view.feed,
            collection,
            older,
            callIds,
          );
        } catch (error) {
          // Invariant: Python catches (OSError, ValueError); the TS readers
          // raise plain Error/SyntaxError/TypeError/RangeError or fs errors.
          if (!(error instanceof Error)) throw error;
          return unavailable();
        }
        if (
          !this.alive(claim) ||
          view.evictPending ||
          view.instanceId !== generation
        ) {
          this.viewCache.drop(cid);
          return unavailable("stale");
        }
        if (batch !== null) {
          if (!applyBatch(view, generation, batch)) return unavailable("stale");
          if (!batch.older) caughtUp = batch.caughtUp;
        }
        inputs = { ...inputs, files };
      }
      return window(view, inputs, {
        caughtUp,
        after: options.after ?? null,
        before,
        limit,
        since: options.since ?? null,
        instance: options.instance ?? null,
      });
    }
    return unavailable(); // Invariant: Unreachable: acquire always yields once.
  }

  /** One-shot focused SSE response; disconnect never controls execution. */
  async readViewEvents(
    cid: string,
    lastEventId: string | null,
  ): Promise<[number, Uint8Array]> {
    const [instance, since] = parseEventCursor(lastEventId);
    const page = await this.readViewWindow(cid, {
      limit: SSE_PAGE_LIMIT,
      since,
      instance,
    });
    if (page.status !== "ready") return [503, new Uint8Array()];
    const snapshot =
      instance === null ||
      since === null ||
      Boolean(page.reset) ||
      page.instance_id !== instance;
    return [200, sseFrame(snapshot ? "snapshot" : "rows", page)];
  }

  /** Bounded completed-turn poll over a supervisor-resolved binding. */
  async readCompletedReplies(
    cid: string,
    cursor: string | null,
    options: { wait?: unknown; batchLimit?: unknown } = {},
  ): Promise<JsonObject | null> {
    const [waitSeconds, limit] = replyPollWindow(
      options.wait ?? 0,
      options.batchLimit ?? 20,
    );
    const claim = this.claim(cid);
    const named = (conv: JsonObject): boolean =>
      typeof conv.session_id === "string" && Boolean(conv.session_id);
    if (claim === null) return null;
    const status = historyStatus(claim.conv.status);
    const binding = claim.binding;
    if (binding === null)
      return unboundReplyPage(cursor, named(claim.conv), status);
    const deadline = this.monotonic() + waitSeconds;
    let current = cursor;
    for (;;) {
      const path = await this.deps.boundSessionFile(
        binding.sessionId,
        binding.sessionFile,
        binding.cwd,
      );
      const page =
        path === null
          ? null
          : await completedReplyPage(
              cid,
              binding.sessionId,
              path,
              binding.cwd,
              current,
              {
                status,
                maxSessionBytes: MAX_SESSION_BYTES,
                reasons: REPLY_REASONS,
              },
              limit,
            );
      if (!this.alive(claim)) throw new CompletedReplyStorageUnavailable();
      if (page === null)
        return unboundReplyPage(cursor, named(claim.conv), status);
      if ((page.replies as unknown[]).length || page.has_more) return page;
      const remaining = deadline - this.monotonic();
      if (waitSeconds <= 0 || remaining <= 0) return page;
      await this.sleep(Math.min(0.25, remaining));
      if (!this.alive(claim)) throw new CompletedReplyStorageUnavailable();
      current = typeof page.next_cursor === "string" ? page.next_cursor : null;
    }
  }

  /** One compaction-marker summary over a supervisor-resolved binding. */
  async readMarkerSummary(
    cid: string,
    offset: number,
    generation: number | null = null,
  ): Promise<JsonObject | null> {
    const claim = this.claim(cid);
    if (claim !== null && this.deps.durable?.owns(claim.conv))
      return this.deps.durable.markerSummary(cid, offset);
    if (claim === null || claim.binding === null) return null;
    const binding = claim.binding;
    if (
      generation !== null &&
      generation !== historyGeneration(binding.sessionId)
    )
      return null;
    const path = await this.deps.boundSessionFile(
      binding.sessionId,
      binding.sessionFile,
      binding.cwd,
    );
    const view = path === null ? null : await markerSummary(path, offset);
    if (view === null || !this.alive(claim)) return null;
    return view;
  }

  /** One bounded thinking read over a supervisor-resolved binding. */
  async readThinkingText(
    cid: string,
    offset: number,
  ): Promise<JsonObject | null> {
    const claim = this.claim(cid);
    if (claim !== null && this.deps.durable?.owns(claim.conv))
      return this.deps.durable.thinking(cid, offset);
    if (claim === null || claim.binding === null) return null;
    const binding = claim.binding;
    // Invariant: Only Durable has a live answer.
    if (offset === -1) return null;
    const path = await this.deps.boundSessionFile(
      binding.sessionId,
      binding.sessionFile,
      binding.cwd,
    );
    const view = path === null ? null : await thinkingText(path, offset);
    if (view === null || !this.alive(claim)) return null;
    return view;
  }

  /** The model input/reply at a Durable entry id or legacy byte offset. */
  async readTurnPrompt(
    cid: string,
    offset: number,
  ): Promise<JsonObject | null> {
    const claim = this.claim(cid);
    if (claim !== null && this.deps.durable?.owns(claim.conv)) {
      const view = await this.deps.durable.turnPrompt(cid, offset);
      return this.alive(claim) ? view : null;
    }
    if (claim === null || claim.binding === null) return null;
    const binding = claim.binding;
    const snap = this.snapshotOf(claim.conv);
    const view = await this.deps.prompts.readTurnPromptValues({
      sessionId: binding.sessionId,
      recordedFile: binding.sessionFile,
      recordedCwd: binding.cwd,
      offset,
      conv: claim.conv,
      snap,
      maxSessionBytes: MAX_SESSION_BYTES,
      liveContextMessages: null,
    });
    if (!this.alive(claim)) return null;
    return view;
  }

  /** Measured occupancy plus estimated split over a supervisor claim. */
  async readContextUsage(cid: string): Promise<JsonObject | null> {
    const claim = this.claim(cid);
    if (claim === null) return null;
    const conv = claim.conv;
    const binding = claim.binding;
    let view: JsonObject;
    try {
      const sample = this.deps.durable?.owns(conv)
        ? await this.deps.durable.contextUsage(cid)
        : null;
      view = await this.deps.contextUsage.readContextUsageValues(
        conv,
        sample,
        binding?.sessionId ?? "",
        binding?.sessionFile ?? "",
        binding?.cwd ?? "",
      );
    } catch (error) {
      if (!this.alive(claim)) return null;
      throw error;
    }
    if (!this.alive(claim)) return null;
    return view;
  }

  // Sanitized conversation controls; message content lives in /view.
  // Composition over the claimed metadata snapshot and live node values: no
  // warming, no snapshot RPC, no node created on a cold read.
  readConversationMetadata(cid: string): JsonObject | null {
    const claim = this.claim(cid);
    if (claim === null) return null;
    const conv = claim.conv;
    const node = claim.node as
      | (ReadNode & {
          muteDesired: boolean | null;
          safetyDesired: boolean | null;
        })
      | null;

    this.deps.composeLoaded(cid, conv, true);
    const activeRun = activeRunId(conv);
    for (const key of METADATA_PRIVATE_KEYS) delete conv[key];
    const turn = conv.active_turn;
    const active: JsonObject =
      typeof turn === "object" && turn !== null && !Array.isArray(turn)
        ? (turn as JsonObject)
        : {};
    providerStartingOverlay(conv, active);
    for (const key of METADATA_PRIVATE_TURN_KEYS) delete active[key];
    for (const key of METADATA_PRIVATE_LATE_KEYS) delete conv[key];
    conv.pending_actions = this.deps.pendingActions(cid);
    conv.restart_parked =
      !!conv.restart_parked && conv.status === "interrupted";
    const desires =
      node !== null
        ? { muteDesired: node.muteDesired, safetyDesired: node.safetyDesired }
        : null;
    conv.muted = readMuted(conv, desires);
    conv.safety_off = readSafetyOff(conv, desires);
    conv.safety_off_active = readSafetyEffectiveOff(conv, desires);
    delete conv.external_key;
    delete conv.service_principal;
    delete conv.title_order;
    conv.active_run = activeRun;
    const sessionId = conv.session_id;
    conv.message_log_generation =
      typeof sessionId === "string" ? historyGeneration(sessionId) : 0;
    if (this.deps.durable?.owns(conv)) {
      const pending = Array.isArray(conv.pending) ? conv.pending : [];
      Object.assign(conv, this.deps.durable.metadata(cid));
      conv.pending = [
        ...pending,
        ...(Array.isArray(conv.pending) ? conv.pending : []),
      ];
    }
    return conv;
  }

  /** Captured prompt view over a supervisor claim. */
  async readBasePrompt(cid: string): Promise<JsonObject | null> {
    const durable = this.deps.durable;
    if (durable?.owns(this.deps.claims.metadataSnapshot(cid)))
      return durable.prompt(cid);
    const claim = this.claim(cid);
    if (claim === null) return null;
    let view: Record<string, string>;
    try {
      view = await this.deps.prompts.readPromptValues(claim.conv);
    } catch (error) {
      if (!this.alive(claim)) return null;
      throw error;
    }
    if (!this.alive(claim)) return null;
    return view;
  }
}
