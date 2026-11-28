// Per-agent SQLite admission precedes projection swaps; no legacy or volatile writes.
// Startup scans off-loop and recovers backend imports committed before metadata.
// Per-cid locks serialize metadata; stale snapshots merge canonical intent.
// Legacy pinned holds read as taken over unless a current value is stored.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ptr } from "bun:ffi";
import {
  flockExclusive,
  libc,
  openPinnedLockFile,
  readJson,
} from "../../utils";
import { AgentStore, AgentClosed } from "./agent_store";
import { Config } from "../../config";
import { slowSpan } from "../../observability";
import { applyTagChange, type TagChange } from "../../agent_metadata/index";
import {
  conversationModelSettings,
  migrateConversationModelChoices,
  validLevel,
} from "./conversation_model_choices";
export { validLevel } from "./conversation_model_choices";

export type ConversationRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is ConversationRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const IMPORT_REV_KEY = "_import_rev";
const IMPORT_REV_CURRENT = 2;
export const SET_PENDING_MODEL_MARKER = "_set_pending_model";
export const CLEAR_PENDING_MODEL_MARKER = "_clear_pending_model";
export const SET_MODEL_MARKER = "_set_model";
/** A record predating the backend field is a legacy claude session. */
export const LEGACY_BACKEND = "claude";

const DURABLE_METADATA_KEYS: ReadonlySet<string> = new Set([
  "id",
  "parent",
  "title",
  "title_order",
  "backend",
  "backend_change",
  "model",
  "effort",
  "level",
  "model_choice_version",
  "pending_model",
  "workdir",
  "muted",
  "taken_over",
  "taken_over_order",
  "safety_off",
  "safety_rev",
  "session_id",
  "session_file",
  "session_cwd",
  "diff_base_ref",
  "prs",
  "created",
  "operator_message_at",
  "replied_at",
  "replied_run",
  "finished_run",
  "unread",
  "tags",
  "tmp_key",
  "external_key",
  "service_principal",
  "settled_attachment_ids",
  "reap_deferred",
  "reap_deferred_reason",
  "reap_requested_by",
  "reap_retry_attempt",
  "context_tokens_at_last_digest",
  "side_of",
  "promoting",
  "promotion_error",
  "revived_from",
]);
const MODEL_CHOICE_KEYS = [
  "model",
  "effort",
  "level",
  "pending_model",
  "model_choice_version",
] as const;
const PIGGYBACK_METADATA_KEYS: ReadonlySet<string> = new Set([
  "updated",
  "last_interaction",
]);

/** Detached durable subset: mutable values must not alias a live record. */
export function canonicalMetadata(
  record: ConversationRecord,
): ConversationRecord {
  const projected: ConversationRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (DURABLE_METADATA_KEYS.has(key))
      projected[key] =
        (key === "pending_model" || key === "tags") && isRecord(value)
          ? structuredClone(value)
          : Array.isArray(value)
            ? [...value]
            : value;
  }
  return projected;
}

// JavaScript '$' can match before a final newline; Python fullmatch cannot.
const END = "(?![\\s\\S])";
export const CID_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}${END}`, "u");
export const TITLE_ORDER_RE = new RegExp(
  `^\\p{Nd}{20}-[A-Za-z0-9_-]{1,64}${END}`,
  "u",
);
const TAKEN_OVER_ORDER_RE = new RegExp(`^\\p{Nd}{20}-[a-f0-9]{32}${END}`, "u");

// Title and take-over stamps order even choices in the same millisecond.
function epochNanoseconds(): bigint {
  const stamp = new BigInt64Array(2);
  if (libc.clock_gettime(0, ptr(stamp)) !== 0)
    throw new Error("clock_gettime(CLOCK_REALTIME) failed");
  return stamp[0]! * 1_000_000_000n + stamp[1]!;
}

export function cleanTitleOrder(
  value: unknown,
  fresh: () => string = () =>
    `${String(epochNanoseconds()).padStart(20, "0")}-${randomUUID().replaceAll("-", "")}`,
): string {
  return typeof value === "string" && TITLE_ORDER_RE.test(value)
    ? value
    : fresh();
}
export function freshTakenOverOrder(
  nowNs: () => bigint = epochNanoseconds,
  id: () => string = () => randomUUID().replaceAll("-", ""),
): string {
  return `${String(nowNs()).padStart(20, "0")}-${id()}`;
}

export interface ConversationStorePaths {
  dataDir: string;
  titleLockDir: string;
  muteLockDir: string;
}
export interface ConversationStoreHooks {
  inbox(cid: string): ConversationRecord[];
  defaultSpawnWorkdir(): string;
  mayHaveUnreportedReply?(cid: string): boolean;
  /** Synchronous notification after publication; null replaces the projection. */
  onRowsChanged(cid: string | null): void;
  log?(event: string, fields: Record<string, unknown>): void;
}

const STRIPPED_PENDING_KEYS: ReadonlySet<string> = new Set([
  "_delivery_id",
  "_ingress",
  "_steer_boundary_sha256",
  "_client_key",
  "_dispatch_retry_at",
  "_dispatch_deferred_at",
  "_dispatch_attempts",
]);
export function stripPendingKeys(
  message: ConversationRecord,
): ConversationRecord {
  return Object.fromEntries(
    Object.entries(message).filter(([key]) => !STRIPPED_PENDING_KEYS.has(key)),
  );
}
export function dedupePendingRows(
  messages: ConversationRecord[],
): ConversationRecord[] {
  const seen = new Set<string>();
  const unique: ConversationRecord[] = [];
  for (const message of messages) {
    const replay = "replay_id" in message ? message.replay_id : message.id;
    const id = typeof replay === "string" && replay ? replay : null;
    if (!id || !seen.has(id)) {
      if (id) seen.add(id);
      unique.push(message);
    }
  }
  return unique;
}
export function activeRunId(record: ConversationRecord | null): string | null {
  if (!record) return null;
  const active = isRecord(record.active_turn) ? record.active_turn : {};
  for (const key of ["run_id", "started_at"]) {
    const value = active[key];
    if (
      (typeof value === "string" || typeof value === "number") &&
      value !== ""
    )
      return key === "run_id" ? String(value) : `legacy:${String(value)}`;
  }
  return Object.keys(active).length || record.status === "running"
    ? "legacy:running"
    : null;
}
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Fail startup instead of silently losing a legacy tree or record. */
export async function assertNoUnimportedLegacyState(
  dataDir: string,
): Promise<void> {
  try {
    const marker = join(dataDir, "agents-import-v2.json");
    const stat = await lstat(marker);
    if (!stat.isFile()) throw new Error("Invalid agents-import-v2.json marker");
    if (!(await readJson(marker)))
      throw new Error("Invalid agents-import-v2.json marker");
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const legacyDb = join(dataDir, "tree.db");
  try {
    await lstat(legacyDb);
    throw new Error(
      "Unimported legacy conversation state (tree.db); start the last Python-based Recurse release to complete agents-import-v2.json before upgrading",
    );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let files: string[];
  try {
    files = await readdir(join(dataDir, "conversations"));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (files.some((file) => file.endsWith(".json")))
    throw new Error(
      "Unimported legacy conversation records; start the last Python-based Recurse release to complete agents-import-v2.json before upgrading",
    );
}

// Every async task queues, including children spawned under a holder. Never
// inherit ownership implicitly: AsyncLocalStorage propagates to sibling tasks
// and would let one bypass a parent's flock while it remains held. Nested
// awaited operations must explicitly pass the holder's opaque guard token.
class CidMutex {
  private readonly tails = new Map<string, Promise<void>>();
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, next);
    await prior;
    try {
      return await fn();
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
      release();
    }
  }
}

export type ConversationGuardToken = object;

export interface RowReservation {
  readonly cid: string;
}

interface SafetyRequest {
  /** Newer than every earlier request's revision for the record. */
  rev: number;
  /** Whether it changes the recorded request. */
  changed: boolean;
  /** False when its record write was refused. */
  recorded: boolean;
  /** Shared by the requests for one record; a revived record gets a new one. */
  life: object;
}

export class ConversationStore {
  private readonly mutex = new CidMutex();
  private readonly projection = new Map<string, ConversationRecord>();
  private readonly lastSaved = new Map<string, ConversationRecord>();
  private readonly viewedTimes = new Map<string, number>();
  private readonly manualUnreadMarks = new Map<string, object>();
  private readonly reservedRows = new Map<string, RowReservation>();
  // Retired agent databases whose record is not yet discarded.
  private readonly ended = new Set<string>();
  private readonly safetyRequests = new Map<string, SafetyRequest>();
  private lastScanComplete = false;
  private projectionReadyState = true;
  private readonly guardTokens = new WeakMap<
    ConversationGuardToken,
    {
      cid: string;
      kind: "title" | "mute";
      active: boolean;
    }
  >();
  constructor(
    readonly paths: ConversationStorePaths,
    readonly agentStore: AgentStore,
    readonly hooks: ConversationStoreHooks,
    readonly config: Config,
    readonly ids: () => string = () => randomUUID().replaceAll("-", ""),
  ) {}

  /** Detached database truth; read jobs stay off the event loop. */
  async collectAgentMetadata(): Promise<Record<string, ConversationRecord>> {
    const snapshot: Record<string, ConversationRecord> = {};
    this.lastScanComplete = true;
    for (const cid of await this.agentStore.allAgentIds()) {
      try {
        const [metadata] = await this.agentStore.loadPersistedAgent(cid);
        if (metadata) {
          const row = { ...metadata };
          if (row.backend !== "durable" && typeof row.session_id === "string") {
            const marker = await this.readBoundedJsonObject(
              join(this.config.paths.CONV_DIR, cid, "durable/import.json"),
              4096,
            );
            if (
              marker?.version === 1 &&
              marker.backend === "durable" &&
              marker.sessionId === row.session_id
            ) {
              row.backend = "durable";
              delete row.backend_change;
            }
          }
          snapshot[cid] = row;
        }
      } catch (error) {
        this.lastScanComplete = false;
        this.hooks.log?.("agent_metadata_scan_skipped", {
          conversation_id: cid,
          error_type:
            error instanceof Error ? error.constructor.name : "unknown",
        });
      }
    }
    return snapshot;
  }
  private applyConvProjection(
    snapshot: Record<string, ConversationRecord>,
  ): void {
    this.projection.clear();
    for (const [cid, row] of Object.entries(snapshot))
      this.projection.set(cid, row);
    for (const cid of this.ended)
      if (!this.projection.has(cid)) this.ended.delete(cid);
    this.notifyRowsChanged(null);
  }
  private notifyRowsChanged(cid: string | null): void {
    try {
      this.hooks.onRowsChanged(cid);
    } catch (error) {
      try {
        this.hooks.log?.("conversation_row_listener_failed", {
          ...(cid === null ? {} : { conversation_id: cid }),
          error_type:
            error instanceof Error ? error.constructor.name : "unknown",
        });
      } catch {}
    }
  }
  applyAgentMetadata(snapshot: Record<string, ConversationRecord>): void {
    const rows: Record<string, ConversationRecord> = {};
    this.lastSaved.clear();
    this.viewedTimes.clear();
    this.manualUnreadMarks.clear();
    for (const [cid, metadata] of Object.entries(snapshot)) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        continue;
      const durable = canonicalMetadata(metadata);
      this.lastSaved.set(cid, durable);
      if (typeof metadata.viewed_at === "number")
        this.viewedTimes.set(cid, metadata.viewed_at);
      const row: ConversationRecord = { ...durable };
      if (!("taken_over" in row) && metadata.pinned === true)
        row.taken_over = true;
      for (const key of PIGGYBACK_METADATA_KEYS)
        if (key in metadata) row[key] = metadata[key];
      if (!("status" in row)) row.status = "idle";
      if (!("draft" in row)) row.draft = null;
      rows[cid] = row;
    }
    this.applyConvProjection(rows);
  }
  async refreshProjection(): Promise<Record<
    string,
    ConversationRecord
  > | null> {
    await assertNoUnimportedLegacyState(this.paths.dataDir);
    if (!(await this.agentStore.flushAll(30))) {
      this.hooks.log?.("projection_refresh_flush_failed", {
        note: "scan skipped; unflushed rows stay live, converge on retry",
      });
      return null;
    }
    const snapshot = await this.collectAgentMetadata();
    this.applyAgentMetadata(snapshot);
    this.hooks.log?.("projection_refreshed", {
      agents: Object.keys(snapshot).length,
    });
    return snapshot;
  }
  /** Freeze live ladder choices once, before startup admits turns. */
  migrateModelChoices(): Promise<number> {
    return migrateConversationModelChoices({
      dataDir: this.paths.dataDir,
      complete: this.lastScanComplete,
      rows: this.projection,
      config: this.config,
      save: async (cid, row) => {
        // Invariant: Only the model choice is merged, into the row current at
        // each write, so a change made during the flush is kept.
        const merged = (base: ConversationRecord) => {
          const next = { ...base };
          for (const key of MODEL_CHOICE_KEYS)
            if (key in row) next[key] = row[key];
          return next;
        };
        const current = this.projection.get(cid);
        if (!current) return;
        if (
          !this.enqueueDurableMetadata(cid, merged(current)) ||
          !(await this.agentStore.flush(cid, 30))
        )
          throw new Error(
            "conversation model choices incomplete; restart to retry",
          );
        const latest = this.projection.get(cid);
        if (!latest) return;
        const next = merged(latest);
        this.enqueueDurableMetadata(cid, next);
        this.projection.set(cid, next);
        this.notifyRowsChanged(cid);
      },
    });
  }
  noteProjectionStale(): void {
    this.projectionReadyState = false;
  }
  noteProjectionReady(): void {
    this.projectionReadyState = true;
  }
  projectionReady(): boolean {
    return this.projectionReadyState;
  }

  private enqueueDurableMetadata(
    cid: string,
    record: ConversationRecord,
    viewedAt?: number,
  ): boolean {
    if (this.agentStore.status(cid).closed) {
      this.hooks.log?.("metadata_enqueue_owner_gone", { conversation_id: cid });
      return false;
    }
    const durable = canonicalMetadata(record);
    if (
      viewedAt === undefined &&
      isDeepStrictEqual(durable, this.lastSaved.get(cid) ?? {})
    )
      return true;
    const payload = { ...durable };
    for (const key of PIGGYBACK_METADATA_KEYS)
      if (key in record) payload[key] = record[key];
    if (!this.admitMetadata(cid, payload, viewedAt)) return false;
    this.lastSaved.set(cid, durable);
    return true;
  }
  private admitMetadata(
    cid: string,
    payload: ConversationRecord,
    viewedAt = this.viewedAt(cid),
  ): boolean {
    payload[IMPORT_REV_KEY] = IMPORT_REV_CURRENT;
    if (viewedAt !== undefined) payload.viewed_at = viewedAt;
    try {
      this.agentStore.enqueueMetadata(cid, payload);
    } catch (error) {
      if (!(error instanceof AgentClosed)) throw error;
      this.hooks.log?.("metadata_enqueue_owner_gone", { conversation_id: cid });
      return false;
    }
    return true;
  }
  // The projection and queue append are await-free; never put I/O between them.
  publishTitle(cid: string, title: string, order: string): boolean {
    return this.patch(cid, { title, title_order: order });
  }
  private patch(cid: string, fields: ConversationRecord): boolean {
    const current = this.projection.get(cid);
    if (!current) return false;
    const next = { ...current, ...fields };
    if (!this.enqueueDurableMetadata(cid, next)) return false;
    this.projection.set(cid, next);
    this.notifyRowsChanged(cid);
    return true;
  }
  /**
   * Accept and record a safety request at once, without a guard, under a newer
   * revision; null when `cid` has no writable record.
   */
  writeSafety(cid: string, off: boolean, now: number): SafetyRequest | null {
    const current = this.projection.get(cid);
    if (!current || this.ended.has(cid)) return null;
    const rev = Math.max(
      (Number(current.safety_rev) || 0) + 1,
      (this.safetyRequests.get(cid)?.rev ?? 0) + 1,
      Math.floor(now * 1000),
    );
    const request = {
      rev,
      changed: !!current.safety_off !== off,
      recorded: false,
      life: this.safetyRequests.get(cid)?.life ?? {},
    };
    // Invariant: A request supersedes older ones on acceptance, before its
    // record write, which may be refused. Tokens are objects, so a request
    // from before a reap never matches one for a revived record, even with an
    // equal revision.
    this.safetyRequests.set(cid, request);
    try {
      request.recorded = this.patch(cid, {
        safety_off: off,
        safety_rev: rev,
        updated: now,
      });
    } catch (error) {
      this.hooks.log?.("safety_record_write_refused", {
        conversation_id: cid,
        error: String(error),
      });
    }
    return request;
  }
  /** The newest safety request accepted for `cid` since its record loaded. */
  newestSafety(cid: string): SafetyRequest | undefined {
    return this.safetyRequests.get(cid);
  }
  /** Caller holds configuration guards and has committed the import marker. */
  publishImportedBackend(cid: string): void {
    const row = this.projection.get(cid);
    if (!row) return;
    const next: ConversationRecord = { ...row, backend: "durable" };
    delete next.backend_change;
    // Invariant: The marker already admitted this backend. A metadata-writer
    // failure must not allow another Pi turn to diverge from its committed
    // history.
    this.projection.set(cid, next);
    this.notifyRowsChanged(cid);
    this.enqueueDurableMetadata(cid, next);
  }
  /** Copies of `cid`'s live descendant conversations, parents first. */
  subtree(cid: string): ConversationRecord[] {
    return this.walkDescendants(cid, this.projection.values(), "breadth").map(
      (row) => structuredClone(row),
    );
  }
  metadataSnapshot(
    cid: string,
    fields?: readonly string[],
  ): ConversationRecord | null {
    const row = this.projection.get(cid);
    if (!row) return null;
    return structuredClone(
      fields === undefined
        ? row
        : Object.fromEntries(
            fields.filter((key) => key in row).map((key) => [key, row[key]]),
          ),
    );
  }
  /** Shallow copies; nested values are shared and read-only. */
  *metadataRows(): IterableIterator<[string, ConversationRecord]> {
    for (const [cid, row] of this.projection) yield [cid, { ...row }];
  }
  // Persist a live activity stamp without making piggyback fields write
  // triggers.
  saveActivity(
    cid: string,
    updated: number,
    operatorMessageAt?: number,
  ): boolean {
    const current = this.projection.get(cid);
    if (!current) return false;
    const payload = canonicalMetadata(current);
    for (const key of PIGGYBACK_METADATA_KEYS)
      if (key in current) payload[key] = current[key];
    payload.updated = updated;
    if (operatorMessageAt !== undefined)
      payload.operator_message_at = operatorMessageAt;
    if (!this.admitMetadata(cid, payload)) return false;
    const next = { ...current, ...canonicalMetadata(payload), updated };
    this.lastSaved.set(cid, canonicalMetadata(next));
    this.projection.set(cid, next);
    this.notifyRowsChanged(cid);
    return true;
  }
  effectiveWorkdir(record: ConversationRecord | null): string {
    if (record === null) return this.paths.dataDir;
    const value = record.workdir;
    if (!value) return this.hooks.defaultSpawnWorkdir();
    if (typeof value !== "string")
      throw new TypeError("invalid conversation workdir");
    return value;
  }
  async loadCanonicalMetadata(cid: string): Promise<ConversationRecord | null> {
    try {
      const [metadata] = await this.agentStore.loadPersistedAgent(cid);
      return metadata ? { ...metadata } : null;
    } catch {
      return null;
    }
  }
  // Read stored metadata off-loop, then atomically admit and merge only the
  // session triple.
  async updateSessionBinding(
    cid: string,
    fresh: ConversationRecord | null,
  ): Promise<void> {
    const stored = (await this.loadCanonicalMetadata(cid)) ?? {};
    // Invariant: Disk I/O above may overlap a newer save/title admission. The
    // projection is the newest admitted durable set; use it as a whole-row
    // baseline, not the stale SQLite read, or this binding would REPLACE-wipe
    // newer fields.
    const projected = this.projection.get(cid);
    const current: ConversationRecord = projected
      ? canonicalMetadata(projected)
      : canonicalMetadata(stored);
    for (const key of PIGGYBACK_METADATA_KEYS) {
      if (projected && key in projected) current[key] = projected[key];
      else if (key in stored) current[key] = stored[key];
    }
    const triple = ["session_id", "session_file", "session_cwd"] as const;
    if (fresh === null && !triple.some((key) => key in current)) return;
    if (
      fresh !== null &&
      Object.entries(fresh).every(([key, value]) =>
        isDeepStrictEqual(current[key], value),
      )
    )
      return;
    const payload: ConversationRecord = { ...current };
    if (fresh === null) for (const key of triple) delete payload[key];
    else Object.assign(payload, fresh);
    if (!this.admitMetadata(cid, payload)) return;
    this.lastSaved.set(cid, canonicalMetadata(payload));
    const row = this.projection.get(cid);
    if (row) {
      const next = { ...row };
      if (fresh === null) for (const key of triple) delete next[key];
      else Object.assign(next, fresh);
      this.projection.set(cid, next);
    }
  }
  convRowExists(cid: string): boolean {
    return (
      typeof cid === "string" && CID_RE.test(cid) && this.projection.has(cid)
    );
  }
  /** Refuse guard-free record writes once `cid`'s agent database is retired. */
  endRecordWrites(cid: string): void {
    this.ended.add(cid);
    this.safetyRequests.delete(cid);
  }
  discardConvProjection(cid: string): void {
    this.ended.delete(cid);
    this.safetyRequests.delete(cid);
    this.projection.delete(cid);
    this.lastSaved.delete(cid);
    this.viewedTimes.delete(cid);
    this.manualUnreadMarks.delete(cid);
    this.notifyRowsChanged(cid);
  }
  // Claim a new row whose storage does not exist yet; null when a row, mailbox
  // or file does. Only the claim may publish it (commit-first) or discard it.
  async reserveNewRow(cid: string): Promise<RowReservation | null> {
    const taken = () => this.projection.has(cid) || this.reservedRows.has(cid);
    if (taken() || (await this.agentStore.storageExists(cid)) || taken())
      return null;
    const reservation = { cid };
    this.reservedRows.set(cid, reservation);
    return reservation;
  }
  /** Drop and trash a reserved row a commit-first save never published. */
  async discardUnpublished(reservation: RowReservation): Promise<boolean> {
    const { cid } = reservation;
    if (this.reservedRows.get(cid) !== reservation || this.projection.has(cid))
      return false;
    this.lastSaved.delete(cid);
    if (!(await this.agentStore.discard(cid))) return false;
    this.reservedRows.delete(cid);
    return true;
  }

  /** Default only volatile fields; inbox is derived and never persisted. */
  applyLoadDefaults(
    cid: string,
    record: ConversationRecord,
    withPending = true,
  ): void {
    if (!("parent" in record)) record.parent = null;
    if (!("status" in record)) record.status = "idle";
    if (!("draft" in record)) record.draft = null;
    if (record.parent || record.taken_over) {
      if (!("muted" in record)) record.muted = false;
    } else record.muted = false;
    if (!("safety_off" in record)) record.safety_off = false;
    if (!("taken_over" in record)) record.taken_over = false;
    // Invariant: Pi is the only backend, but a legacy record keeps its stored
    // provenance for read-only legacy history.
    if (!("backend" in record)) record.backend = LEGACY_BACKEND;
    if (!("msg_count" in record)) record.msg_count = 0;
    if (!("last" in record)) record.last = null;
    if (withPending) {
      record.pending = dedupePendingRows(this.hooks.inbox(cid)).map(
        stripPendingKeys,
      );
    }
  }
  /** Return owned values; selecting fields avoids cloning unrelated state. */
  load(
    cid: string,
    options: { withPending?: boolean; fields?: readonly string[] } = {},
  ): ConversationRecord | null {
    const projected = this.projection.get(cid);
    if (!projected) return null;
    const record = options.fields
      ? { ...projected }
      : structuredClone(projected);
    this.composeLoaded(cid, record, options.withPending ?? true);
    if (!options.fields) return record;
    return Object.fromEntries(
      options.fields
        .filter((field) => field in record)
        .map((field) => {
          const value = record[field];
          return [
            field,
            value !== null && typeof value === "object"
              ? structuredClone(value)
              : value,
          ];
        }),
    );
  }
  // What load serves, in place over an owned copy (the metadata read shares
  // it).
  composeLoaded(
    cid: string,
    record: ConversationRecord,
    withPending: boolean,
  ): void {
    if (typeof record.model === "string")
      record.model = this.config.models.canonicalModelId(record.model);
    else if ("model" in record && record.model !== null)
      throw new Error("invalid stored model");
    this.applyLoadDefaults(cid, record, withPending);
    if (validLevel(record.level) === null && !("effort" in record)) {
      const stored = record.model;
      record.effort = this.config.models.chatSettings(
        typeof stored === "string" ? stored : null,
      )[1];
    }
  }
  private carryForwardChoice(
    current: ConversationRecord | undefined,
    record: ConversationRecord,
    caller: ConversationRecord,
    field: "title" | "taken_over",
    order: "title_order" | "taken_over_order",
    valid: RegExp,
  ): void {
    const stored = current?.[order],
      candidate = record[order];
    if (
      typeof stored !== "string" ||
      !valid.test(stored) ||
      (typeof candidate === "string" &&
        valid.test(candidate) &&
        stored < candidate)
    )
      return;
    if (field === "taken_over" || field in current!) {
      record[field] =
        field === "taken_over" ? !!current![field] : current![field];
      caller[field] = record[field];
    } else {
      delete record[field];
      delete caller[field];
    }
    record[order] = stored;
    caller[order] = stored;
  }
  /** Replace the linked pull requests (`prs`, conversation_prs.ts). */
  async updatePrs(
    cid: string,
    update: (prs: unknown) => unknown[],
  ): Promise<void> {
    await this.withTitleGuard(cid, async () => {
      const current = this.projection.get(cid);
      if (!current) return;
      const next = { ...current, prs: update(current.prs) };
      if (isDeepStrictEqual(next.prs, current.prs)) return;
      if (!this.enqueueDurableMetadata(cid, next)) return;
      this.projection.set(cid, next);
      this.notifyRowsChanged(cid);
    });
  }
  /**
   * Persist when run `key` was first reported (epoch s); a repeated report of
   * the same run keeps its first stamp.
   */
  async stampReply(cid: string, key: string, at: number): Promise<void> {
    const current = this.projection.get(cid);
    if (!current) return;
    // Invariant: A retried report flushes again: its stamp may be admitted
    // but unpersisted.
    const fresh = current.replied_run !== key;
    if (fresh && !this.patch(cid, { replied_at: at, replied_run: key })) return;
    if (!(await this.agentStore.flush(cid)))
      throw new Error("reply stamp flush failed");
  }
  /** Record unread state once per reply report, even if it is replayed. */
  async finishUnread(cid: string, key: string, unread: boolean): Promise<void> {
    const current = this.projection.get(cid);
    if (!current) return;
    if (
      current.finished_run !== key &&
      !this.patch(cid, { finished_run: key, unread })
    )
      return;
    if (!(await this.agentStore.flush(cid)))
      throw new Error("finished state flush failed");
  }
  /** Set the operator's unread mark without acknowledging future replies. */
  async setUnread(cid: string, unread: boolean): Promise<boolean> {
    const current = this.projection.get(cid);
    if (!current || this.ended.has(cid) || typeof current.side_of === "string")
      return false;
    if ((current.unread === true) !== unread && !this.patch(cid, { unread }))
      return false;
    if (unread) this.manualUnreadMarks.set(cid, {});
    if (!(await this.agentStore.flush(cid)))
      throw new Error("unread state flush failed");
    return true;
  }
  viewedAt(cid: string): number | undefined {
    return this.viewedTimes.get(cid);
  }
  /** Admit a view acknowledgement; return whether it cleared a dot. */
  private recordViewed(cid: string): boolean {
    const current = this.projection.get(cid);
    if (!current || this.ended.has(cid) || typeof current.side_of === "string")
      return false;
    const unread = current.unread === true;
    if (!unread && !this.hooks.mayHaveUnreportedReply?.(cid)) return false;
    const previous = this.viewedAt(cid);
    const viewedAt = Math.max(previous ?? 0, Date.now());
    if (!unread && previous === viewedAt) return false;
    const next = unread ? { ...current, unread: false } : current;
    if (!this.enqueueDurableMetadata(cid, next, viewedAt)) return false;
    this.viewedTimes.set(cid, viewedAt);
    if (unread) {
      this.projection.set(cid, next);
      this.notifyRowsChanged(cid);
    }
    return unread;
  }
  /** A closing viewer cannot acknowledge a newer manual unread mark. */
  async markViewed(cid: string): Promise<() => void> {
    const mark = this.manualUnreadMarks.get(cid);
    if (this.recordViewed(cid) && !(await this.agentStore.flush(cid)))
      throw new Error("viewed state flush failed");
    return () => {
      if (this.manualUnreadMarks.get(cid) === mark) this.recordViewed(cid);
    };
  }
  /**
   * Apply one tag change for `by` to each of `cids`; returns the ids not
   * found. A TagRefused for any conversation changes none of them.
   */
  async changeTags(
    cids: readonly string[],
    change: TagChange,
    by: string,
    now: number,
  ): Promise<string[]> {
    // Invariant: Validation and admission are await-free, so no concurrent
    // change can refuse a batch after part of it was admitted.
    const next = cids.flatMap((cid) => {
      const current = this.projection.get(cid);
      if (!current) return [];
      return [[cid, applyTagChange(current.tags, change, by, now)] as const];
    });
    const changed = next
      .filter(([cid, tags]) => this.patch(cid, { tags }))
      .map(([cid]) => cid);
    const flushed = await Promise.all(
      changed.map((cid) => this.agentStore.flush(cid)),
    );
    if (flushed.includes(false)) throw new Error("tag change flush failed");
    return cids.filter((cid) => !changed.includes(cid));
  }
  // Admit durable metadata before replacing projection; a rejected enqueue
  // swaps nothing. A reserved new row is published only once it is committed,
  // so no reader sees, or opens a Harness for, a row a crash can lose.
  async save(
    conv: ConversationRecord,
    titleToken?: ConversationGuardToken,
    reservation?: RowReservation,
  ): Promise<void> {
    const cid = conv.id;
    if (typeof cid !== "string" || !CID_RE.test(cid))
      throw new Error("unsafe conversation id for save");
    const level = validLevel(conv.level);
    if (level !== null && (!("model" in conv) || !("effort" in conv))) {
      const [model, effort] = this.config.levels.resolveEffortLevel(level);
      if (!("model" in conv)) conv.model = model;
      if (!("effort" in conv)) conv.effort = effort;
    }
    if (
      "model" in conv &&
      conv.model !== null &&
      typeof conv.model !== "string"
    )
      throw new Error("invalid stored model");
    const setPending = !!conv[SET_PENDING_MODEL_MARKER];
    const clearPending = !!conv[CLEAR_PENDING_MODEL_MARKER];
    const setModel = !!conv[SET_MODEL_MARKER];
    delete conv[SET_PENDING_MODEL_MARKER];
    delete conv[CLEAR_PENDING_MODEL_MARKER];
    delete conv[SET_MODEL_MARKER];
    const record: ConversationRecord = {};
    for (const [key, value] of Object.entries(conv))
      if (key !== "pending" && key !== "messages") record[key] = value;
    await this.withTitleGuard(
      cid,
      async () => {
        const current = this.projection.get(cid);
        if (!current || setModel) record.model_choice_version = 1;
        // Invariant: A published Durable backend is final; a stale snapshot
        // never restores the Pi backend.
        if (current?.backend === "durable") {
          record.backend = "durable";
          delete record.backend_change;
        }
        if (current) {
          this.carryForwardChoice(
            current,
            record,
            conv,
            "title",
            "title_order",
            TITLE_ORDER_RE,
          );
          this.carryForwardChoice(
            current,
            record,
            conv,
            "taken_over",
            "taken_over_order",
            TAKEN_OVER_ORDER_RE,
          );
          if (!setModel && current.backend === record.backend) {
            for (const key of [
              "model",
              "effort",
              "level",
              "model_choice_version",
            ]) {
              if (key in current) record[key] = structuredClone(current[key]);
              else delete record[key];
            }
          }
        }
        // Invariant: Dedicated metadata writers own these fields; creation
        // may supply initial tags. Stale snapshots never erase admitted values.
        for (const key of [
          "prs",
          "replied_at",
          "replied_run",
          "finished_run",
          "unread",
          "tags",
        ])
          if (current && key in current)
            record[key] = structuredClone(current[key]);
          else if (current || key !== "tags") delete record[key];
        // Invariant: Only writeSafety changes a stored safety request.
        if (current)
          for (const key of ["safety_off", "safety_rev"])
            if (key in current) record[key] = current[key];
            else delete record[key];
        if (typeof current?.operator_message_at === "number")
          record.operator_message_at = current.operator_message_at;
        if (clearPending) delete record.pending_model;
        else if (!setPending) {
          if (current && "pending_model" in current)
            record.pending_model = structuredClone(current.pending_model);
          else delete record.pending_model;
        }
        if (
          reservation &&
          (current || this.reservedRows.get(cid) !== reservation)
        )
          throw new Error("commit-first save needs its reserved new row");
        if (!this.enqueueDurableMetadata(cid, record)) return;
        if (reservation && !(await this.agentStore.flush(cid))) {
          this.lastSaved.delete(cid);
          return;
        }
        if (reservation) this.reservedRows.delete(cid);
        this.projection.set(cid, structuredClone(record));
        this.notifyRowsChanged(cid);
      },
      titleToken,
    );
  }
  /** Detached legacy records only; native Durable rows need no import scan. */
  legacyConvs(): ConversationRecord[] {
    const records: ConversationRecord[] = [];
    for (const [cid, row] of this.projection) {
      if (row.backend === "durable") continue;
      const conv = this.load(cid, { withPending: false });
      if (conv) records.push(conv);
    }
    return records;
  }
  allConvs(options: { withPending?: boolean } = {}): ConversationRecord[] {
    this.hooks.log?.("conversation_records_scanned", {
      count: this.projection.size,
    });
    return [...this.projection.keys()].flatMap((cid) => {
      const row = this.load(cid, options);
      return row ? [row] : [];
    });
  }
  /** Find the tree root through live parents, without scanning history. */
  treeRoot(cid: string): string {
    const seen = new Set<string>();
    while (!seen.has(cid)) {
      seen.add(cid);
      const parent = this.projection.get(cid)?.parent;
      if (typeof parent !== "string" || !this.projection.has(parent))
        return cid;
      cid = parent;
    }
    throw new Error("cycle in agent tree");
  }
  descendants(
    cid: string,
    convs = this.allConvs({ withPending: false }),
  ): string[] {
    return this.walkDescendants(cid, convs, "depth").map(
      (row) => row.id as string,
    );
  }
  private walkDescendants(
    cid: string,
    rows: Iterable<ConversationRecord>,
    order: "breadth" | "depth",
  ): ConversationRecord[] {
    const kids = new Map<unknown, ConversationRecord[]>();
    for (const row of rows) {
      const parent = row.parent;
      if (order === "depth") {
        if (parent == null) continue;
        if (typeof parent !== "string")
          throw new TypeError("invalid conversation parent");
        if (typeof row.id !== "string")
          throw new TypeError("invalid conversation id");
      }
      if (kids.get(parent)?.push(row) === undefined) kids.set(parent, [row]);
    }
    const out: ConversationRecord[] = [];
    const seen = new Set([cid]);
    const pending: ConversationRecord[] = [];
    const appendChildren = (parent: unknown) => {
      const children = kids.get(parent);
      if (!children) return;
      if (order === "breadth") {
        for (const row of children) pending.push(row);
      } else {
        for (let i = children.length - 1; i >= 0; i--)
          pending.push(children[i]!);
      }
    };
    appendChildren(cid);
    let next = 0;
    while (next < pending.length) {
      const row = order === "breadth" ? pending[next++]! : pending.pop()!;
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(row);
      appendChildren(row.id);
    }
    return out;
  }
  conversationSettings(record: ConversationRecord): [string, string] {
    return conversationModelSettings(this.config, record);
  }
  newConversationId(): string {
    for (let i = 0; i < 100; i++) {
      const cid = this.ids().slice(0, 12);
      if (CID_RE.test(cid) && !this.convRowExists(cid)) return cid;
    }
    throw new Error("could not allocate conversation id");
  }
  private async guarded<T>(
    kind: "title" | "mute",
    cid: string,
    fn: (token: ConversationGuardToken) => Promise<T>,
    token?: ConversationGuardToken,
  ): Promise<T> {
    if (typeof cid !== "string" || !CID_RE.test(cid))
      throw new Error("invalid conversation id for guard");
    if (token !== undefined) {
      const owner = this.guardTokens.get(token);
      if (!owner?.active || owner.cid !== cid || owner.kind !== kind)
        throw new Error("inactive or mismatched conversation guard");
      return fn(token);
    }
    const key = `${kind}:${cid}`;
    return this.mutex.withLock(key, async () => {
      const dir =
        kind === "title" ? this.paths.titleLockDir : this.paths.muteLockDir;
      await slowSpan("metadata_lock_dir_call", cid, () =>
        mkdir(dir, { recursive: true }),
      );
      const parent = await slowSpan("metadata_lock_parent_call", cid, () =>
        open(
          dir,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
      try {
        const handle = await openPinnedLockFile(`${cid}.lock`, parent);
        try {
          const release = await flockExclusive(
            handle.fd,
            join(dir, `${cid}.lock`),
          );
          const held = Object.freeze({});
          const owner = { cid, kind, active: true };
          this.guardTokens.set(held, owner);
          try {
            return await fn(held);
          } finally {
            owner.active = false;
            release();
          }
        } finally {
          await slowSpan("metadata_lock_close_call", cid, () => handle.close());
        }
      } finally {
        await slowSpan("metadata_parent_close_call", cid, () => parent.close());
      }
    });
  }
  withTitleGuard<T>(
    cid: string,
    fn: (token: ConversationGuardToken) => Promise<T>,
    token?: ConversationGuardToken,
  ): Promise<T> {
    return this.guarded("title", cid, fn, token);
  }
  withMuteGuard<T>(
    cid: string,
    fn: (token: ConversationGuardToken) => Promise<T>,
    token?: ConversationGuardToken,
  ): Promise<T> {
    return this.guarded("mute", cid, fn, token);
  }
  readBoundedJsonObject(
    path: string,
    maxBytes: number,
  ): Promise<ConversationRecord | null> {
    return readJson(path, maxBytes);
  }
}
