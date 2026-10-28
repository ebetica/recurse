// Per-agent SQLite admission precedes every projection swap; no legacy writes.
// Volatile changes never write. Workers scan startup state off-loop.
// Per-cid locks serialize metadata; stale snapshots merge canonical intent.
// An import marker commits the backend before metadata; startup recovers it.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ptr } from "bun:ffi";
import { atomicJson, openPinnedLockFile, readJson } from "./fs_utils";
import { AgentStore, AgentClosed } from "./agent_store";
import {
  Config,
  EFFORT_MIN_LEVEL,
  EFFORT_MAX_LEVEL,
  THINKING_LEVELS,
  Thinking,
} from "../config";
import { flockExclusive } from "../utils/flock";
import { libc } from "../utils/libc";
import { pyCompactJson } from "../utils/py_compact_json";
import { mergeTouchedPrs } from "./touched_prs";

export type ConversationRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is ConversationRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const IMPORT_REV_KEY = "_import_rev";
export const IMPORT_REV_CURRENT = 2;
export const SET_PENDING_MODEL_MARKER = "_set_pending_model";
export const CLEAR_PENDING_MODEL_MARKER = "_clear_pending_model";
export const SET_MODEL_MARKER = "_set_model";
/** A record predating the backend field is a legacy claude session. */
export const LEGACY_BACKEND = "claude";

export const DURABLE_METADATA_KEYS: ReadonlySet<string> = new Set([
  "id",
  "parent",
  "title",
  "title_order",
  "backend",
  "backend_change",
  "model",
  "effort",
  "level",
  "pending_model",
  "workdir",
  "muted",
  "pinned",
  "pinned_order",
  "safety_off",
  "session_id",
  "session_file",
  "session_cwd",
  "diff_base_ref",
  "touched_prs",
  "created",
  "operator_message_at",
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
]);
export const PIGGYBACK_METADATA_KEYS: ReadonlySet<string> = new Set([
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
        key === "pending_model" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
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
const PRINCIPAL_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}${END}`, "u");
const EXTERNAL_KEY_RE = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}${END}`,
  "u",
);
export const TITLE_ORDER_RE = new RegExp(
  `^\\p{Nd}{20}-[A-Za-z0-9_-]{1,64}${END}`,
  "u",
);
export const PIN_ORDER_RE = new RegExp(`^\\p{Nd}{20}-[a-f0-9]{32}${END}`, "u");

export function validateExternalKey(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string")
    throw new TypeError("external_key must be a string");
  if (!value) throw new Error("external_key must not be empty");
  if (value.length > 256)
    throw new Error("external_key must be at most 256 characters");
  if (!EXTERNAL_KEY_RE.test(value))
    throw new Error(
      "external_key must contain only letters, numbers, '.', '_', ':', or '-'",
    );
  return value;
}

// Title/pin stamps preserve ordering even for choices in the same millisecond.
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
export function freshPinnedOrder(
  nowNs: () => bigint = epochNanoseconds,
  id: () => string = () => randomUUID().replaceAll("-", ""),
): string {
  return `${String(nowNs()).padStart(20, "0")}-${id()}`;
}

export class ExternalKeyConflict extends Error {}
export class ServiceStorageUnavailable extends Error {}
export interface ConversationStorePaths {
  dataDir: string;
  externalKeyDir: string;
  serviceBindingsDir: string;
  titleLockDir: string;
  muteLockDir: string;
}
export interface LiveInputs {
  status: unknown;
  runId: unknown;
  muted: boolean;
  safetyOff: boolean;
  safetyOffActive: boolean;
  queued: number;
  activeRunId: string | null;
  hasLiveShells: boolean;
}
export interface NodeInputs {
  muteDesired: boolean | null;
  safetyDesired: boolean | null;
  pendingCount: number;
  inbox: ConversationRecord[];
  /** In-memory last activity, ahead of the piggybacked metadata when live. */
  activityUpdated?: number | null;
}
export interface TreeEntry {
  record: ConversationRecord;
  live: LiveInputs;
  workdir: string;
}
export interface ConversationStoreHooks {
  nodeInputs(cid: string): NodeInputs | null;
  // Runtime node lock; reenter only with its explicit live token.
  withNodeLock<T>(
    cid: string,
    fn: (token: object) => Promise<T>,
    token?: object,
  ): Promise<T>;
  liveStatus(cid: string): [unknown, unknown];
  // recurse.safety state once its Harness has read it.
  durableSafetyOff?(cid: string): boolean | undefined;
  /** Whether the conversation has a live background shell (no I/O). */
  hasLiveShell(cid: string): boolean;
  defaultSpawnWorkdir(): string;
  treeRefresh(entry: TreeEntry): void;
  treeRebuild(entries: TreeEntry[]): void;
  treeDiscard(cid: string): void;
  safeRemoveTempKey(key: string): boolean | Promise<boolean>;
  dropNode(cid: string): void;
  /** config_actions' model guard; `nodeToken` re-enters a held node lock. */
  withModelGuard<T>(
    cid: string,
    fn: () => Promise<T>,
    nodeToken?: object,
  ): Promise<T>;
  log?(event: string, fields: Record<string, unknown>): void;
}

export const STRIPPED_PENDING_KEYS: ReadonlySet<string> = new Set([
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
export function validLevel(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= EFFORT_MIN_LEVEL &&
    value <= EFFORT_MAX_LEVEL
    ? value
    : null;
}

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const unreadable = Symbol("unreadable");
const malformed = Symbol("malformed");
type Leaf = ConversationRecord | null | typeof unreadable | typeof malformed;

// The reader requires before/open/after inode identity and O_NOFOLLOW.
async function readExternalLeaf(path: string): Promise<Leaf> {
  let handle: FileHandle | undefined;
  let found = false;
  try {
    const before = await lstat(path);
    found = true;
    if (!before.isFile()) return unreadable;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const after = await lstat(path);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    )
      return unreadable;
    try {
      const data = await handle.readFile();
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(Uint8Array.from(data));
      const parsed: unknown = JSON.parse(text);
      return parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? (parsed as ConversationRecord)
        : malformed;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        return malformed;
      return unreadable;
    }
  } catch (error) {
    return missing(error) && !found ? null : unreadable;
  } finally {
    await handle?.close();
  }
}

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

export class ConversationStore {
  private readonly mutex = new CidMutex();
  private readonly projection = new Map<string, ConversationRecord>();
  private readonly lastSaved = new Map<string, ConversationRecord>();
  private projectionReadyState = true;
  private readonly guardTokens = new WeakMap<
    ConversationGuardToken,
    {
      cid: string;
      kind: "title" | "mute";
      active: boolean;
      nodeToken?: object;
    }
  >();
  constructor(
    readonly paths: ConversationStorePaths,
    readonly agentStore: AgentStore,
    readonly hooks: ConversationStoreHooks,
    readonly config: Config,
    readonly ids: () => string = () => randomUUID().replaceAll("-", ""),
  ) {}

  private externalPath(principal: string, key: string): string {
    if (validateExternalKey(key) === null)
      throw new Error("external_key is required");
    if (typeof principal !== "string" || !principal)
      throw new Error("service principal is required");
    const digest = createHash("sha256")
      .update(`recurse-external-key-v1\0${principal}\0${key}`)
      .digest("hex");
    return join(this.paths.externalKeyDir, `${digest}.json`);
  }
  private conflict(path: string, reason: string): never {
    this.hooks.log?.("external_key_binding_invalid", {
      binding: path.split("/").at(-1)!.slice(0, -5),
      reason,
    });
    throw new ExternalKeyConflict("external_key binding is unavailable");
  }
  async lookupExternalKey(
    principal: string,
    key: string,
  ): Promise<ConversationRecord | null> {
    const path = this.externalPath(principal, key);
    const record = await readExternalLeaf(path);
    if (record === null) return null;
    if (record === malformed) this.conflict(path, "malformed");
    if (record === unreadable) this.conflict(path, "unreadable");
    const cid = record.conversation_id;
    if (
      record.principal !== principal ||
      record.external_key !== key ||
      typeof cid !== "string" ||
      !CID_RE.test(cid)
    )
      this.conflict(path, "record");
    const conv = this.load(cid, { withPending: false });
    if (
      !conv ||
      conv.external_key !== key ||
      conv.service_principal !== principal ||
      !this.convRowExists(cid)
    )
      this.conflict(path, "target");
    return conv;
  }
  async bindExternalKey(
    principal: string,
    key: string,
    cid: string,
  ): Promise<void> {
    const path = this.externalPath(principal, key);
    const record = await readExternalLeaf(path);
    if (record === null) {
      await atomicJson(
        path,
        { principal, external_key: key, conversation_id: cid },
        this.ids,
      );
      return;
    }
    if (record === malformed) this.conflict(path, "malformed");
    if (record === unreadable) this.conflict(path, "unreadable");
    if (
      record.principal === principal &&
      record.external_key === key &&
      record.conversation_id === cid
    )
      return;
    this.conflict(path, "occupied");
  }
  async unbindExternalKey(
    principal: string,
    key: string,
    cid: string,
  ): Promise<void> {
    const path = this.externalPath(principal, key);
    const record = await readExternalLeaf(path);
    if (record === unreadable) {
      this.hooks.log?.("external_key_binding_invalid", {
        binding: path.split("/").at(-1)!.slice(0, -5),
        reason: "unreadable",
      });
      throw new ServiceStorageUnavailable(
        "external_key binding is unavailable",
      );
    }
    if (record === null || record === malformed) {
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
      return;
    }
    const valid =
      typeof record.principal === "string" &&
      typeof record.conversation_id === "string" &&
      CID_RE.test(record.conversation_id) &&
      (() => {
        try {
          return validateExternalKey(record.external_key) !== null;
        } catch {
          return false;
        }
      })();
    if (
      !valid ||
      (record.principal === principal &&
        record.external_key === key &&
        record.conversation_id === cid)
    )
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
  }

  private servicePath(cid: string): string | null {
    return typeof cid === "string" && CID_RE.test(cid)
      ? join(this.paths.serviceBindingsDir, `${cid}.json`)
      : null;
  }
  private async readService(
    path: string,
    strict = false,
  ): Promise<string | null> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY);
      if (!(await handle.stat()).isFile())
        throw new Error("non-regular service binding");
      const buffer = new Uint8Array(513);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 512) throw new Error("oversized service binding");
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, bytesRead),
        ),
      );
      const principal =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as ConversationRecord).principal
          : null;
      if (typeof principal !== "string")
        throw new Error("invalid service binding");
      return principal;
    } catch (error) {
      if (strict)
        throw new ServiceStorageUnavailable("service binding unavailable", {
          cause: error,
        });
      return null;
    } finally {
      await handle?.close();
    }
  }
  async bindServiceConversation(principal: string, cid: string): Promise<void> {
    const path = this.servicePath(cid);
    if (!path || typeof principal !== "string" || !PRINCIPAL_RE.test(principal))
      throw new Error("invalid service conversation binding");
    const existing = await this.readService(path);
    if (existing !== null && existing !== principal)
      throw new Error("conversation is owned by another service");
    await mkdir(this.paths.serviceBindingsDir, { recursive: true });
    const temp = join(
      this.paths.serviceBindingsDir,
      `.${cid}.json.${this.ids()}.tmp`,
    );
    try {
      await Bun.write(temp, pyCompactJson({ principal }));
      await rename(temp, path);
    } finally {
      await unlink(temp).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }
  async serviceOwnsConversation(
    principal: string,
    cid: string,
  ): Promise<boolean> {
    const path = this.servicePath(cid);
    return (
      !!path &&
      typeof principal === "string" &&
      PRINCIPAL_RE.test(principal) &&
      this.convRowExists(cid) &&
      (await this.readService(path)) === principal
    );
  }
  async serviceOwnedConversationCount(principal: string): Promise<number> {
    if (typeof principal !== "string" || !PRINCIPAL_RE.test(principal))
      throw new ServiceStorageUnavailable("invalid service principal");
    let files: string[];
    try {
      files = await readdir(this.paths.serviceBindingsDir);
    } catch (error) {
      if (missing(error)) return 0;
      throw new ServiceStorageUnavailable(
        "service binding directory unavailable",
        { cause: error },
      );
    }
    let count = 0;
    for (const file of files.filter((f) => f.endsWith(".json")))
      if (
        (await this.readService(
          join(this.paths.serviceBindingsDir, file),
          true,
        )) === principal
      )
        count++;
    return count;
  }
  async unbindServiceConversation(cid: string): Promise<void> {
    const path = this.servicePath(cid);
    if (path)
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
  }

  /** Detached database truth; read jobs stay off the event loop. */
  async collectAgentMetadata(): Promise<Record<string, ConversationRecord>> {
    const snapshot: Record<string, ConversationRecord> = {};
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
        this.hooks.log?.("agent_metadata_scan_skipped", {
          conversation_id: cid,
          error_type:
            error instanceof Error ? error.constructor.name : "unknown",
        });
      }
    }
    return snapshot;
  }
  applyConvProjection(snapshot: Record<string, ConversationRecord>): void {
    this.projection.clear();
    for (const [cid, row] of Object.entries(snapshot))
      this.projection.set(cid, row);
    try {
      this.hooks.treeRebuild(
        [...this.projection.values()].map((row) => this.treeEntry(row)),
      );
    } catch (error) {
      this.logFailure("tree_view_replay_failed", error);
    }
  }
  applyAgentMetadata(snapshot: Record<string, ConversationRecord>): void {
    const rows: Record<string, ConversationRecord> = {};
    this.lastSaved.clear();
    for (const [cid, metadata] of Object.entries(snapshot)) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        continue;
      const durable = canonicalMetadata(metadata);
      this.lastSaved.set(cid, durable);
      const row: ConversationRecord = { ...durable };
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
  ): boolean {
    if (this.agentStore.status(cid).closed) {
      this.hooks.log?.("metadata_enqueue_owner_gone", { conversation_id: cid });
      return false;
    }
    const durable = canonicalMetadata(record);
    if (isDeepStrictEqual(durable, this.lastSaved.get(cid) ?? {})) return true;
    const payload: ConversationRecord = {
      ...durable,
      [IMPORT_REV_KEY]: IMPORT_REV_CURRENT,
    };
    for (const key of PIGGYBACK_METADATA_KEYS)
      if (key in record) payload[key] = record[key];
    try {
      this.agentStore.enqueueMetadata(cid, payload);
    } catch (error) {
      if (!(error instanceof AgentClosed)) throw error;
      this.hooks.log?.("metadata_enqueue_owner_gone", { conversation_id: cid });
      return false;
    }
    this.lastSaved.set(cid, durable);
    return true;
  }
  // The projection and queue append are await-free; never put I/O between them.
  publishTitle(cid: string, title: string, order: string): boolean {
    const current = this.projection.get(cid);
    if (!current) return false;
    const next = { ...current, title, title_order: order };
    if (!this.enqueueDurableMetadata(cid, next)) return false;
    this.projection.set(cid, next);
    this.refreshTreeRow(cid);
    return true;
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
    this.refreshTreeRow(cid);
    this.enqueueDurableMetadata(cid, next);
  }
  metadataSnapshot(cid: string): ConversationRecord | null {
    const row = this.projection.get(cid);
    return row ? structuredClone(row) : null;
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
    const payload: ConversationRecord = {
      ...canonicalMetadata(current),
      [IMPORT_REV_KEY]: IMPORT_REV_CURRENT,
    };
    for (const key of PIGGYBACK_METADATA_KEYS)
      if (key in current) payload[key] = current[key];
    payload.updated = updated;
    if (operatorMessageAt !== undefined)
      payload.operator_message_at = operatorMessageAt;
    try {
      this.agentStore.enqueueMetadata(cid, payload);
    } catch (error) {
      if (!(error instanceof AgentClosed)) throw error;
      this.hooks.log?.("metadata_enqueue_owner_gone", { conversation_id: cid });
      return false;
    }
    const next = { ...current, ...canonicalMetadata(payload), updated };
    this.lastSaved.set(cid, canonicalMetadata(next));
    this.projection.set(cid, next);
    this.refreshTreeRow(cid);
    return true;
  }
  displayRecord(record: ConversationRecord): ConversationRecord {
    const view = structuredClone(record);
    if (typeof view.id === "string")
      this.applyLoadDefaults(view.id, view, false);
    return view;
  }
  captureLiveInputs(record: ConversationRecord): LiveInputs {
    const cid = record.id;
    if (typeof cid !== "string")
      throw new Error("live capture record id must be a string");
    const [status, runId] = this.hooks.liveStatus(cid);
    const node = this.hooks.nodeInputs(cid);
    const activity = node?.activityUpdated;
    if (typeof activity === "number") {
      const stored = record.updated;
      if (typeof stored !== "number" || activity > stored)
        record.updated = activity;
    }
    // Invariant: Durable review reads its recurse.safety document, not the
    // record.
    const durableOff =
      record.backend === "durable"
        ? (this.hooks.durableSafetyOff?.(cid) ?? false)
        : undefined;
    const safetyOff = durableOff ?? node?.safetyDesired ?? !!record.safety_off;
    const active = record.active_turn;
    const safetyOffActive =
      durableOff ??
      (record.status === "running" && isRecord(active) && "safety_off" in active
        ? !!active.safety_off
        : safetyOff);
    return {
      status,
      runId,
      muted: node?.muteDesired ?? !!record.muted,
      safetyOff,
      safetyOffActive,
      queued: node?.pendingCount ?? 0,
      activeRunId: activeRunId(record),
      hasLiveShells: this.hooks.hasLiveShell(cid),
    };
  }
  effectiveWorkdir(record: ConversationRecord | null): string {
    if (record === null) return this.paths.dataDir;
    const value = record.workdir;
    if (!value) return this.hooks.defaultSpawnWorkdir();
    if (typeof value !== "string")
      throw new TypeError("invalid conversation workdir");
    return value;
  }
  private treeEntry(record: ConversationRecord): TreeEntry {
    const view = this.displayRecord(record);
    return {
      record: view,
      live: this.captureLiveInputs(view),
      workdir: this.effectiveWorkdir(record),
    };
  }
  private logFailure(event: string, error: unknown, cid?: string): void {
    this.hooks.log?.(event, {
      ...(cid ? { conversation_id: cid } : {}),
      error_type: error instanceof Error ? error.constructor.name : "unknown",
    });
  }
  refreshTreeRow(cid: string): void {
    try {
      const row = this.metadataSnapshot(cid);
      if (row) this.hooks.treeRefresh(this.treeEntry(row));
      else this.hooks.treeDiscard(cid);
    } catch (error) {
      this.logFailure("tree_view_refresh_failed", error, cid);
    }
  }
  /** Shallow digest rows; nested metadata is shared and read-only. */
  captureDigestInputs(): {
    convs: ConversationRecord[];
    live: Record<string, LiveInputs>;
  } {
    const convs: ConversationRecord[] = [];
    const live: Record<string, LiveInputs> = {};
    for (const [cid, projected] of this.projection) {
      const row = { ...projected };
      this.applyLoadDefaults(cid, row, false);
      live[cid] = this.captureLiveInputs(row);
      convs.push(row);
    }
    return { convs, live };
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
    payload[IMPORT_REV_KEY] = IMPORT_REV_CURRENT;
    try {
      this.agentStore.enqueueMetadata(cid, payload);
    } catch (error) {
      if (!(error instanceof AgentClosed)) throw error;
      this.hooks.log?.("metadata_enqueue_owner_gone", { conversation_id: cid });
      return;
    }
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
  discardConvProjection(cid: string): void {
    this.projection.delete(cid);
    this.lastSaved.delete(cid);
    this.hooks.treeDiscard(cid);
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
    if (record.parent || record.pinned) {
      if (!("muted" in record)) record.muted = false;
    } else record.muted = false;
    if (!("safety_off" in record)) record.safety_off = false;
    if (!("pinned" in record)) record.pinned = false;
    // Invariant: Pi is the only backend, but a legacy record keeps its stored
    // provenance for read-only legacy history.
    if (!("backend" in record)) record.backend = LEGACY_BACKEND;
    if (!("msg_count" in record)) record.msg_count = 0;
    if (!("last" in record)) record.last = null;
    if (withPending) {
      const inbox = this.hooks.nodeInputs(cid)?.inbox ?? [];
      record.pending = dedupePendingRows(inbox).map(stripPendingKeys);
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
      record.model = this.config.canonicalModelId(record.model);
    else if ("model" in record && record.model !== null)
      throw new Error("invalid stored model");
    this.applyLoadDefaults(cid, record, withPending);
    // Invariant: Fill missing mirrors without rewriting stored state
    // (_freeze_ladder_fields). A level-less record with a model (an explicit
    // off-ladder create, or legacy) keeps its model and takes the level-less
    // turn path; only a model-less, level-less record takes the default level.
    let level = validLevel(record.level);
    if (level === null) {
      if ("model" in record) {
        if (!("effort" in record)) {
          const stored = record.model;
          record.effort = this.config.chatSettings(
            typeof stored === "string" ? stored : null,
          )[1];
        }
        return;
      }
      level = this.config.defaultEffortLevel();
      if (!("level" in record)) record.level = level;
    }
    if (!("model" in record) || !("effort" in record)) {
      const [model, effort] = this.config.resolveEffortLevel(level);
      if (!("model" in record)) record.model = model;
      if (!("effort" in record)) record.effort = effort;
    }
  }
  private carryForwardChoice(
    current: ConversationRecord | undefined,
    record: ConversationRecord,
    caller: ConversationRecord,
    field: "title" | "pinned",
    order: "title_order" | "pinned_order",
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
    if (field === "pinned" || field in current!) {
      record[field] = field === "pinned" ? !!current![field] : current![field];
      caller[field] = record[field];
    } else {
      delete record[field];
      delete caller[field];
    }
    record[order] = stored;
    caller[order] = stored;
  }
  async addTouchedPrs(cid: string, urls: readonly string[]): Promise<void> {
    const admitted = await this.withTitleGuard(cid, async () => {
      const current = this.projection.get(cid);
      if (!current) return false;
      const next = {
        ...current,
        touched_prs: mergeTouchedPrs(current.touched_prs, urls),
      };
      if (!this.enqueueDurableMetadata(cid, next)) return false;
      this.projection.set(cid, next);
      return true;
    });
    if (!admitted) return;
    if (!(await this.agentStore.flush(cid)))
      throw new Error(`PR metadata flush failed: ${cid}`);
  }
  // Admit durable metadata before replacing projection; a rejected enqueue
  // swaps nothing.
  async save(
    conv: ConversationRecord,
    titleToken?: ConversationGuardToken,
  ): Promise<void> {
    const cid = conv.id;
    if (typeof cid !== "string" || !CID_RE.test(cid))
      throw new Error("unsafe conversation id for save");
    const level = validLevel(conv.level);
    if (level !== null && (!("model" in conv) || !("effort" in conv))) {
      const [model, effort] = this.config.resolveEffortLevel(level);
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
      if (
        key !== "pending" &&
        key !== "messages" &&
        key !== "_external_key_created"
      )
        record[key] = value;
    await this.withTitleGuard(
      cid,
      async () => {
        const current = this.projection.get(cid);
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
            "pinned",
            "pinned_order",
            PIN_ORDER_RE,
          );
          if (!setModel && current.backend === record.backend) {
            for (const key of ["model", "effort", "level"]) {
              if (key in current) record[key] = structuredClone(current[key]);
              else delete record[key];
            }
          }
        }
        // Invariant: Only addTouchedPrs owns this field; stale turn/settings
        // snapshots must never erase observations admitted while they were
        // running.
        if (current?.touched_prs)
          record.touched_prs = [...(current.touched_prs as string[])];
        if (typeof current?.operator_message_at === "number")
          record.operator_message_at = current.operator_message_at;
        if (clearPending) delete record.pending_model;
        else if (!setPending) {
          if (current && "pending_model" in current)
            record.pending_model = structuredClone(current.pending_model);
          else delete record.pending_model;
        }
        if (!this.enqueueDurableMetadata(cid, record)) return;
        this.projection.set(cid, structuredClone(record));
        this.refreshTreeRow(cid);
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
  cliIndex(): ConversationRecord[] {
    const keys = new Set([
      "id",
      "parent",
      "title",
      "muted",
      "pinned",
      "workdir",
      "session_id",
      "msg_count",
      "status",
      "active_turn",
      "draft",
      "compacting",
      "pending_auto_compaction",
      "backend",
    ]);
    return this.allConvs({ withPending: false }).map((row) => {
      const [status] = this.hooks.liveStatus(String(row.id));
      if (status === "running" || status === "interrupting")
        row.status = status;
      return Object.fromEntries(
        Object.entries(row).filter(([key]) => keys.has(key)),
      );
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
    const kids = new Map<string, string[]>();
    for (const row of convs) {
      const parent = row.parent;
      if (parent === null || parent === undefined) continue;
      if (typeof parent !== "string")
        throw new TypeError("invalid conversation parent");
      if (typeof row.id !== "string")
        throw new TypeError("invalid conversation id");
      const siblings = kids.get(parent) ?? [];
      siblings.push(row.id);
      kids.set(parent, siblings);
    }
    const out: string[] = [],
      seen = new Set([cid]);
    const stack = [...(kids.get(cid) ?? [])].reverse();
    while (stack.length) {
      const child = stack.pop()!;
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(...[...(kids.get(child) ?? [])].reverse());
    }
    return out;
  }
  conversationSettings(record: ConversationRecord): [string, string] {
    const level = validLevel(record.level);
    if (level !== null) return this.config.resolveEffortLevel(level);
    // Invariant: A record without a level (an explicit off-ladder model, or
    // legacy) runs its stored model; a valid stored effort wins, and a corrupt
    // one resolves live rather than failing the turn (conversation_settings).
    const stored = record.model;
    const [model, effort] = this.config.chatSettings(
      typeof stored === "string" ? stored : null,
    );
    const storedEffort = record.effort;
    if (
      typeof storedEffort === "string" &&
      THINKING_LEVELS.includes(storedEffort as Thinking)
    )
      return [model, storedEffort];
    return [model, effort];
  }
  newConversationId(): string {
    for (let i = 0; i < 100; i++) {
      const cid = this.ids().slice(0, 12);
      if (CID_RE.test(cid) && !this.convRowExists(cid)) return cid;
    }
    throw new Error("could not allocate conversation id");
  }
  invalidateContextUsage(record: ConversationRecord): void {
    record.latest_context_usage = null;
    delete record.latest_context_prompt_capture;
    delete record.context_usage_estimate;
    delete record.context_tokens_at_last_digest;
  }
  async rollbackServiceConversation(conv: ConversationRecord): Promise<void> {
    const cid = conv.id;
    if (typeof cid !== "string" || !CID_RE.test(cid))
      throw new Error("unsafe conversation id for rollback");
    const cleanup = async (
      step: string,
      action: () => void | Promise<void>,
    ): Promise<void> => {
      try {
        await action();
      } catch (error) {
        this.hooks.log?.("service_conversation_rollback_failed", {
          conversation_id: cid,
          step,
          error_type:
            error instanceof Error ? error.constructor.name : "unknown",
        });
      }
    };
    this.discardConvProjection(cid);
    await cleanup("service_binding", () => this.unbindServiceConversation(cid));
    if (
      typeof conv.external_key === "string" &&
      typeof conv.service_principal === "string"
    )
      await cleanup("external_key", () =>
        this.unbindExternalKey(
          conv.service_principal as string,
          conv.external_key as string,
          cid,
        ),
      );
    await cleanup("temp", async () => {
      if (!(await this.hooks.safeRemoveTempKey(String(conv.tmp_key || ""))))
        throw new Error("temp cleanup incomplete");
    });
    this.hooks.dropNode(cid);
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
      await mkdir(dir, { recursive: true });
      const parent = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
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
          await handle.close();
        }
      } finally {
        await parent.close();
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
    fn: (token: ConversationGuardToken, nodeToken: object) => Promise<T>,
    token?: ConversationGuardToken,
  ): Promise<T> {
    if (typeof cid !== "string" || !CID_RE.test(cid))
      throw new Error("invalid conversation id for guard");
    const nodeToken =
      token === undefined ? undefined : this.guardTokens.get(token)?.nodeToken;
    return this.hooks.withNodeLock(
      cid,
      (heldNode) =>
        this.guarded(
          "mute",
          cid,
          (heldMute) => {
            const owner = this.guardTokens.get(heldMute)!;
            owner.nodeToken = heldNode;
            return fn(heldMute, heldNode);
          },
          token,
        ),
      nodeToken,
    );
  }
  withSafetyGuard<T>(
    cid: string,
    fn: () => Promise<T>,
    nodeToken?: object,
  ): Promise<T> {
    if (typeof cid !== "string" || !CID_RE.test(cid))
      throw new Error("invalid conversation id for guard");
    return this.hooks.withNodeLock(cid, () => fn(), nodeToken);
  }
  // Configuration writers acquire in the same title/mute/safety/model order.
  withConfigurationMetadataGuard<T>(
    cid: string,
    fn: (
      titleToken: ConversationGuardToken,
      muteToken: ConversationGuardToken,
      nodeToken: object,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withTitleGuard(cid, (titleToken) =>
      this.withMuteGuard(cid, (muteToken, nodeToken) =>
        this.withSafetyGuard(
          cid,
          () =>
            this.hooks.withModelGuard(
              cid,
              () => fn(titleToken, muteToken, nodeToken),
              nodeToken,
            ),
          nodeToken,
        ),
      ),
    );
  }
  withPermanentDeleteStateGuard<T>(
    cid: string,
    fn: (
      titleToken: ConversationGuardToken,
      muteToken: ConversationGuardToken,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withConfigurationMetadataGuard(cid, fn);
  }
  readBoundedJsonObject(
    path: string,
    maxBytes: number,
  ): Promise<ConversationRecord | null> {
    return readJson(path, maxBytes);
  }
}
