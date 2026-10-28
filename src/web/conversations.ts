// Thin lifecycle/message/view routes over owner services.
// Gate view/events before existence checks; SSE is one-shot/no-store.
// Bind service creates under lease; roll back lost races.
// Relayed text is always agent input; audit its forwarding key separately.

import { createHash } from "node:crypto";
import { deliverRelayed } from "../agents/supervisor/delivery";
import { validBackendKeyName } from "../auth/backend_keys";

import { pyStrip } from "../auth/provider_store";
import {
  SERVICE_CREATE_MAX_ACTIVE,
  SERVICE_MESSAGE_MAX_CHARS,
  validateServicePolicy,
  type ServicePolicy,
} from "../auth/service";
import { EFFORT_MAX_LEVEL, EFFORT_MIN_LEVEL } from "../config";
import {
  ExternalKeyConflict,
  ServiceStorageUnavailable,
  cleanTitleOrder,
  stripPendingKeys,
  validateExternalKey,
} from "../agents/conversation_store";
import { TreeLifecycleBusy } from "../agents/mutation_guard";
import { AttachmentError } from "../agents/runtime/attachments/base";
import { pyTruthy } from "../agents/runtime/turn_prep";
import { CLIENT_KEY_RE } from "../agents/supervisor/delivery";
import {
  CompletedReplyCursorError,
  CompletedReplyCursorExpired,
  CompletedReplyStorageUnavailable,
} from "../agents/view/reader";
import {
  cleanBaseRef,
  DIFF_REQUEST_TIMEOUT_MS,
  unavailableDiff,
} from "../workdir_git";
import { timed, timingDetail } from "../observability/request_timing";
import { prIdentity } from "../pull_request";
import {
  INFO,
  logEvent,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { cleanTitle } from "../title_text";
import { conditionalJson } from "./caching";
import { parsePythonJson } from "../utils/py_compact_json";
import {
  agentMarked,
  serviceOwnsRequest,
  servicePrincipalOf,
  serviceRequestPolicy,
} from "./request_auth";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";

export const CLIENT_MESSAGE_ID_RE = CLIENT_KEY_RE;
export const SWITCH_TRACE_RE = /^[0-9a-f]{16,64}$/;
/** config._TEMP_ID_RE. */
export const TEMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SERVICE_CREATE_FIELDS = new Set(["title", "external_key"]);
/** Seconds a service create waits for a slot before 429. */
export const SERVICE_CREATE_WAIT_SECONDS = 5;

type Rec = Record<string, unknown>;
type Status<T> = readonly [number, T];

/** asyncio.Semaphore with `wait_for(acquire(), timeout)`. */
export class CreateSlots {
  private waiters: (() => void)[] = [];
  constructor(private free = SERVICE_CREATE_MAX_ACTIVE) {}
  /** True once a slot is held; false when `timeoutMs` passed first. */
  acquire(timeoutMs: number): Promise<boolean> {
    if (this.free > 0 && !this.waiters.length) {
      this.free -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== grant);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(grant);
    });
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free += 1;
  }
  get available(): number {
    return this.free;
  }
}

export interface ConversationsRoutesDeps {
  /** 503 `service_storage_unavailable` + Retry-After: 2 until action-ready. */
  requireActionReady(): void;
  readonly serviceCreateSlots: CreateSlots;
  readonly log: RuntimeLogger;
  /** Monotonic milliseconds. */
  monotonicMs(): number;
  readonly store: {
    load(cid: string, options?: { withPending?: boolean }): Rec | null;
    metadataSnapshot(cid: string): Rec | null;
    save(conv: Rec): Promise<unknown>;
    effectiveWorkdir(conv: Rec): string;
    lookupExternalKey(principal: string, key: string): Promise<Rec | null>;
    serviceOwnedConversationCount(principal: string): Promise<number>;
    bindServiceConversation(principal: string, cid: string): Promise<void>;
    bindExternalKey(principal: string, key: string, cid: string): Promise<void>;
    rollbackServiceConversation(conv: Rec): Promise<void>;
  };
  /** mutation_guard.mutate_external_storage (the lifecycle lease). */
  mutateExternalStorage<T>(
    work: () => Promise<T>,
    rollback?: () => Promise<void>,
  ): Promise<T>;
  readonly delivery: {
    deliver(
      cid: string,
      content: string,
      options: {
        start?: boolean;
        source?: string;
        sender?: string | null;
        senderTitle?: string | null;
        interrupt?: boolean;
        origin?: string | null;
        attachmentIds?: string[] | null;
        clientMessageId?: string | null;
      },
    ): Promise<string | null>;
    requestRun(cid: string): void;
    cancelInboxMessageAsync(cid: string, mid: string): Promise<boolean>;
    retryInboxMessage(cid: string, mid: string): boolean | Promise<boolean>;
  };
  readonly reads: {
    readConversationMetadata(cid: string): Rec | null | Promise<Rec | null>;
    readCompletedReplies(
      cid: string,
      cursor: string | null,
      options: { wait?: unknown },
    ): Promise<Rec | null>;
    readViewWindow(
      cid: string,
      options: {
        after: string | null;
        before: string | null;
        limit: number;
        since: number | null;
        instance: string | null;
      },
    ): Promise<unknown>;
    readViewEvents(
      cid: string,
      lastEventId: string | null,
    ): Promise<readonly [number, Uint8Array]>;
    composeFilePage(
      cid: string,
      cursor: string | null,
      limit: unknown,
      generation: number | null,
    ): Promise<Status<unknown>>;
    composeFilePreview(
      cid: string,
      storage: string,
      attachmentId: string,
      offset: number | null,
    ): Promise<Status<unknown>>;
    readTurnPrompt(cid: string, offset: number): Promise<unknown>;
    readThinkingText(cid: string, offset: number): Promise<unknown>;
    readMarkerSummary(
      cid: string,
      offset: number,
      generation: number | null,
    ): Promise<unknown>;
    readContextUsage(cid: string): Promise<unknown>;
    readBasePrompt(cid: string): Promise<unknown>;
    fileSnapshot(cid: string): { collection: string; owner: string } | null;
  };
  /** attachments.preview.describe; null when the id does not resolve. */
  describeUpload(
    collection: string,
    owner: string,
    aid: string,
  ): Promise<unknown>;
  readonly create: {
    create(options: {
      parent: string | null;
      model: string | null;
      effort: string | null;
      level: number | null;
      attachmentDraft: string | null;
      muted: boolean;
    }): Promise<Rec>;
    createOrRejoinServiceConversation(options: {
      title: string | null;
      servicePrincipal: string;
      externalKey: string | null;
      allowedModels: readonly string[] | null;
    }): Promise<Rec>;
    setPinned(cid: string, pinned: boolean): Promise<Rec>;
  };
  readonly reap: {
    requestReap(cid: string, requestedBy: string | null): Promise<Rec>;
  };
  readonly lifecycle: {
    launchMaintenanceJob(name: string, work: () => Promise<unknown>): void;
  };
  readonly tree: {
    parkSpawnIntent(cid: string, req: Rec): unknown;
    recordSpawnIntent(item: unknown): Promise<void>;
    requestReparent(
      cid: string,
      parent: string,
      options: { by: string | null },
    ): Promise<Rec>;
    requestStop(
      cid: string,
      options: { expectedRun: string | null },
    ): Promise<boolean>;
  };
  /** web/tree `_deliver_stop`: the stop branch of /deliver. */
  deliverStop(cid: string, body: Rec): Promise<Response>;
  readonly configActions: {
    requestModelChange(
      cid: string,
      model: string,
      effort: string | null,
      level: number | null,
    ): Promise<Rec | null>;
    requestMute(cid: string, muted: boolean): Promise<Rec | null>;
    toggleMute(cid: string): Promise<Rec | null>;
  };
  readonly compaction: {
    requestCompact(cid: string): Promise<unknown>;
    requestClear(cid: string): Promise<unknown>;
  };
  readonly nodes: {
    existing(cid: string): { inboxMessages(): readonly Rec[] } | null;
    /** agent_nodes.node: throws KeyError for an unknown conversation. */
    node(cid: string): {
      setSafety(off: boolean): Promise<[Rec, boolean]>;
      renameTitle(title: string, order: string): Rec | null;
      /** The live PiAgent's status, or null without one. */
      piStatus(): string | null;
    };
  };
  /** node_pi.live_run_id. */
  liveRunId(cid: string): string | null;
  /** Durable conversations (src/agents/durable/host.ts). */
  readonly durable?: {
    owns(conv: Rec | null | undefined): boolean;
    stop(cid: string): Promise<boolean>;
    clear(cid: string): Promise<Rec | null>;
    compact(cid: string): Promise<Rec | null>;
    effectiveCwd(cid: string): Promise<string | null>;
    toolDetails?(cid: string, artifactId: string): Promise<Rec | null>;
  };
  readonly drafts: {
    recoverTransferredAttachmentDraft(token: unknown): Promise<Rec | null>;
  };
  readonly config: {
    resolveEffortLevel(level: number): [string, string];
    readonly piBgShellEnabled: boolean;
  };
  readonly agentTools: {
    skillsFor(cid: string): Promise<[unknown[], string] | null>;
  };
  /** The conversation's live background shells (DurableHost.shells). */
  shellView(cid: string): Promise<Rec>;
  readonly spawnOutcomes: {
    read(cid: string): Promise<Rec | null>;
    observe(cid: string): Promise<void>;
  };
  readonly git: {
    /** agent_temp.workdir_file; throws for an unsafe key. */
    workdirFile(tempKey: string): string;
    resolveDiffCwd(
      stored: string,
      persisted: string | null,
      signal?: AbortSignal,
    ): Promise<[string, string]>;
    worktreeDiff(
      cwd: string,
      base: string | null,
      source: string,
      signal?: AbortSignal,
    ): Promise<unknown>;
    diffFile(
      cwd: string,
      path: string,
      base: string | null,
      includeContents: boolean,
    ): Promise<unknown>;
    pullRequestDiff(url: string, path?: string | null): Promise<unknown>;
    diffCandidates(cwd: string): Promise<unknown>;
    pullRequests(cwd: string | null, urls: readonly string[]): unknown;
    githubRepoUrl(
      stored: string,
      workdirFile: string | null,
    ): Promise<string | null>;
  };
}

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : "";
const isValueError = (error: unknown) => errorName(error) === "ValueError";
const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);
const validLevel = (value: unknown): value is number =>
  isInt(value) && value >= EFFORT_MIN_LEVEL && value <= EFFORT_MAX_LEVEL;
const codePoints = (text: string) => Array.from(text).length;

// Parse only application/json or +json bodies; other bodies fail dict_type.
// Empty/null means absent, preserving required/optional object validation.
async function dictBody(ex: Exchange, required: false): Promise<Rec | null>;
async function dictBody(ex: Exchange, required?: true): Promise<Rec>;
async function dictBody(ex: Exchange, required = true): Promise<Rec | null> {
  const bytes = new Uint8Array(await ex.request.arrayBuffer());
  let body: unknown = null;
  if (bytes.length) {
    const header = ex.request.headers.get("content-type");
    const type = header ? pyStrip(header.split(";")[0]!).toLowerCase() : "";
    // Invariant: Exactly two type parts, as web/login.ts jsonDictBody.
    const parts = type.split("/");
    const [main, sub] = parts;
    if (
      parts.length === 2 &&
      main === "application" &&
      sub &&
      (sub === "json" || sub.endsWith("+json"))
    ) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new HttpError(400, "There was an error parsing the body");
      }
      try {
        body = parsePythonJson(text);
      } catch {
        throw new HttpError(422, [
          {
            type: "json_invalid",
            loc: ["body", 0],
            msg: "JSON decode error",
            input: {},
            ctx: { error: "Expecting value" },
          },
        ]);
      }
    } else body = new TextDecoder().decode(bytes);
  }
  if (body === null) {
    if (!required) return null;
    throw new HttpError(422, [
      { type: "missing", loc: ["body"], msg: "Field required", input: null },
    ]);
  }
  if (typeof body !== "object" || Array.isArray(body))
    throw new HttpError(422, [
      {
        type: "dict_type",
        loc: ["body"],
        msg: "Input should be a valid dictionary",
        input: body,
      },
    ]);
  return body as Rec;
}

const noStore = { "cache-control": "no-store" };
const header = (ex: Exchange, name: string) => ex.request.headers.get(name);
const queryStr = (ex: Exchange, name: string) => {
  const value = ex.query[name];
  return value === null || value === undefined ? null : String(value);
};

export function registerConversationRoutes(
  router: Router,
  deps: ConversationsRoutesDeps,
): void {
  const { store } = deps;

  const messageIsLiveSteer = (cid: string): boolean => {
    if (deps.liveRunId(cid) === null) return false;
    try {
      const status = deps.nodes.node(cid).piStatus();
      return status !== null && status !== "interrupting";
    } catch {
      return false;
    }
  };

  const uploadsAvailable = async (cid: string, ids: string[]) => {
    const snap = deps.reads.fileSnapshot(cid);
    if (snap === null) return false;
    for (const aid of ids) {
      try {
        if (
          (await deps.describeUpload(snap.collection, snap.owner, aid)) == null
        )
          return false;
      } catch (error) {
        if (error instanceof AttachmentError) return false;
        throw error;
      }
    }
    return true;
  };

  const requireServicePrincipal = (ex: Exchange): [string, ServicePolicy] => {
    const principal = servicePrincipalOf(ex);
    const policy = serviceRequestPolicy(ex);
    if (principal === null)
      throw new HttpError(401, "service authentication required");
    if (policy === null) throw new HttpError(403, "service policy unavailable");
    return [principal, policy];
  };

  const agentHeader = (ex: Exchange): string | null => {
    if (typeof ex.state.backend_agent === "string")
      return ex.state.backend_agent;
    const by = header(ex, "x-recurse-agent");
    return by !== null && TEMP_ID_RE.test(by) ? by : null;
  };

  const createServiceConversation = async (
    principal: string,
    rawBody: Rec | null,
    rawPolicy: ServicePolicy,
  ): Promise<Rec> => {
    const policy = validateServicePolicy(rawPolicy);
    if (policy === null) throw new HttpError(403, "service policy unavailable");
    const body = rawBody ?? {};
    if (Object.keys(body).some((key) => !SERVICE_CREATE_FIELDS.has(key)))
      throw new HttpError(422, "unsupported service create field");
    const title = body.title ?? null;
    if (
      title !== null &&
      (typeof title !== "string" || !pyStrip(title) || codePoints(title) > 200)
    )
      throw new HttpError(422, "invalid title");
    let externalKey: string | null;
    try {
      externalKey = validateExternalKey(body.external_key ?? null);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    const ownedLimit = policy.quotas?.max_owned_conversations ?? null;
    const allowedModels = policy.allowed_models;
    let published: Rec | null = null;
    const rollbackPublished = async () => {
      if (published === null) return;
      try {
        await store.rollbackServiceConversation(published);
      } finally {
        published = null;
      }
    };
    const checkQuota = async () => {
      if (ownedLimit === null) return;
      let owned: number;
      try {
        owned = await store.serviceOwnedConversationCount(principal);
      } catch (error) {
        if (error instanceof ServiceStorageUnavailable)
          throw new ServiceRefusal("service_storage_unavailable");
        throw error;
      }
      if (owned >= ownedLimit) throw new ServiceRefusal("quota_exceeded");
    };
    // Invariant: Leased advisory gate before the phased create: a bound address
    // returns its conversation and an over-quota principal fails before
    // anything publishes. Both are rechecked under the bind lease below.
    const precheck = async (): Promise<Rec | null> => {
      if (externalKey) {
        const existing = await store.lookupExternalKey(principal, externalKey);
        if (existing !== null) return { ...existing, _created: false };
      }
      await checkQuota();
      return null;
    };
    // Invariant: Authoritative address resolution under the same lease as the
    // binds: a key bound mid-flight rejoins its owner instead of conflicting.
    const bind = async (conv: Rec): Promise<Rec> => {
      if (externalKey) {
        const current = await store.lookupExternalKey(principal, externalKey);
        if (current !== null && current.id !== conv.id) {
          await rollbackPublished();
          return { ...current, _created: false };
        }
      }
      await checkQuota();
      try {
        await store.bindServiceConversation(principal, String(conv.id));
        if (externalKey)
          await store.bindExternalKey(principal, externalKey, String(conv.id));
      } catch (error) {
        if (!(error instanceof ExternalKeyConflict) || !externalKey)
          throw error;
        // Invariant: Lost the bind race after the lookup: rejoin the winner, or
        // fail closed on a dangling leaf.
        const current = await store.lookupExternalKey(principal, externalKey);
        if (current === null) throw error;
        await rollbackPublished();
        return { ...current, _created: false };
      }
      return conv;
    };
    const storage = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (isOsError(error))
          throw new ServiceRefusal("service_storage_unavailable");
        throw error;
      }
    };
    if (
      !(await deps.serviceCreateSlots.acquire(
        SERVICE_CREATE_WAIT_SECONDS * 1000,
      ))
    )
      throw new HttpError(429, "service create is busy");
    let conv: Rec;
    try {
      const existing = await storage(() =>
        deps.mutateExternalStorage(precheck),
      );
      if (existing !== null) conv = existing;
      else {
        // Invariant: Service threads are isolated top-level rows: a
        // caller-selected parent would be an IDOR path.
        conv = await storage(() =>
          deps.create.createOrRejoinServiceConversation({
            title: title as string | null,
            servicePrincipal: principal,
            externalKey,
            allowedModels: allowedModels ?? null,
          }),
        );
        if (conv._external_key_created !== false) {
          published = conv;
          const fresh = conv;
          conv = await storage(() =>
            deps.mutateExternalStorage(() => bind(fresh), rollbackPublished),
          );
        } else conv = { ...conv, _created: false };
      }
    } catch (error) {
      if (error instanceof ExternalKeyConflict)
        throw new HttpError(409, error.message);
      if (error instanceof TreeLifecycleBusy)
        throw new HttpError(429, "service create is busy");
      if (error instanceof ServiceRefusal || isValueError(error)) {
        const text = (error as Error).message;
        if (text === "model_not_allowed")
          throw new HttpError(403, "model_not_allowed");
        if (text === "quota_exceeded")
          throw new HttpError(429, "max_owned_conversations exceeded");
        if (text === "service_storage_unavailable")
          throw new HttpError(503, "service_storage_unavailable");
        throw new HttpError(422, "service conversation creation rejected");
      }
      throw error;
    } finally {
      deps.serviceCreateSlots.release();
    }
    return {
      id: conv.id,
      status: conv.status,
      title: conv.title ?? null,
      created: conv._created !== false,
    };
  };

  router.post(
    "/api/service/conversations",
    async (ex) => {
      // Invariant: FastAPI validates the body before the handler runs.
      const body = await dictBody(ex, false);
      const [principal, policy] = requireServicePrincipal(ex);
      return jsonResponse(
        await createServiceConversation(principal, body, policy),
      );
    },
    { longRunning: true },
  );

  router.post(
    "/api/conversations",
    async (ex) => {
      const body = (await dictBody(ex, false)) ?? {};
      if (["fork_of", "sibling_of", "context"].some((key) => key in body))
        throw new HttpError(
          422,
          "fork and sibling agent creation are no longer supported",
        );
      const muted = body.muted ?? false;
      if (typeof muted !== "boolean")
        throw new HttpError(422, "muted must be a boolean");
      const draft = body.attachment_draft;
      if (pyTruthy(draft)) {
        // Invariant: A transferred draft token is the durable receipt that
        // recovers the already-created conversation when the browser retries.
        const recovered =
          await deps.drafts.recoverTransferredAttachmentDraft(draft);
        if (recovered !== null) {
          const node = deps.nodes.existing(String(recovered.id));
          const inbox = node !== null ? node.inboxMessages() : [];
          recovered.pending = inbox.map((message) => stripPendingKeys(message));
          return jsonResponse(recovered);
        }
      }
      const parent = body.parent ?? null;
      if (parent !== null && !pyTruthy(store.load(parent as string)))
        throw new HttpError(404, "parent agent not found");
      const level = body.level ?? null;
      if (level !== null && !validLevel(level))
        throw new HttpError(422, "level must be 1-5");
      try {
        return jsonResponse(
          await deps.create.create({
            parent: parent as string | null,
            model: (body.model ?? null) as string | null,
            effort: (body.effort ?? null) as string | null,
            level,
            attachmentDraft: (draft ?? null) as string | null,
            muted,
          }),
        );
      } catch (error) {
        if (error instanceof TreeLifecycleBusy)
          throw new HttpError(
            503,
            "Agent creation is busy. Try again shortly.",
          );
        if (isValueError(error))
          throw new HttpError(422, (error as Error).message);
        throw error;
      }
    },
    { longRunning: true },
  );

  router.post("/api/conversations/spawn", async (ex) => {
    const body = (await dictBody(ex, false)) ?? {};
    const cid = body.id;
    if (typeof cid !== "string" || !TEMP_ID_RE.test(cid))
      throw new HttpError(422, "a valid agent id is required");
    const parent = body.parent ?? null;
    if (
      parent !== null &&
      (typeof parent !== "string" || !TEMP_ID_RE.test(parent))
    )
      throw new HttpError(422, "parent must be an agent id");
    const prompt = body.prompt ?? null;
    if (prompt !== null && typeof prompt !== "string")
      throw new HttpError(422, "prompt must be text");
    const effort = body.effort ?? null;
    if (effort !== null && !validLevel(effort))
      throw new HttpError(422, "effort must be 1-5");
    if (Object.keys(body).some((key) => key.startsWith("safety")))
      throw new HttpError(422, "spawn cannot change safety review");
    if (body.backend !== undefined)
      throw new HttpError(422, "backend selection is not supported");

    if (body.taken_over !== undefined && typeof body.taken_over !== "boolean")
      throw new HttpError(422, "taken_over must be a boolean");
    body.remote_sender = ex.state.backend_agent ?? null;
    const item = deps.tree.parkSpawnIntent(cid, body);
    deps.lifecycle.launchMaintenanceJob(`spawn-record-${cid}`, () =>
      deps.tree.recordSpawnIntent(item),
    );
    return jsonResponse({ ok: true, id: cid, queued: true });
  });

  router.get("/api/conversations/{cid}/spawn-outcome", async (ex) => {
    const cid = ex.params.cid!;
    if (!TEMP_ID_RE.test(cid)) throw new HttpError(422);
    return jsonResponse((await deps.spawnOutcomes.read(cid)) ?? {});
  });

  router.post("/api/conversations/{cid}/spawn-outcome/observe", async (ex) => {
    const cid = ex.params.cid!;
    if (!TEMP_ID_RE.test(cid)) throw new HttpError(422);
    await deps.spawnOutcomes.observe(cid);
    // Invariant: FastAPI's status_code=204 JSONResponse keeps its media type.
    return new Response(null, {
      status: 204,
      headers: { "content-type": "application/json" },
    });
  });

  router.get(
    "/api/conversations/{cid}",
    async (ex) => {
      const cid = ex.params.cid!;
      const focused = ex.query.focused === true;
      const rawTrace = queryStr(ex, "switch_trace");
      const traceId =
        rawTrace !== null && SWITCH_TRACE_RE.test(rawTrace) ? rawTrace : null;
      let dispatchMs: number | null = null;
      const rawDispatch = queryStr(ex, "client_dispatch_ms");
      if (traceId && rawDispatch !== null && pyFloatText(rawDispatch)) {
        const value = Number(rawDispatch.trim().replaceAll("_", ""));
        dispatchMs =
          Number.isFinite(value) && value >= 0 && value <= 60_000
            ? value
            : null;
      }
      const started = deps.monotonicMs();
      if (traceId)
        logEvent(deps.log, INFO, "conversation_switch_request_started", {
          conversation_id: cid,
          fields: { trace_id: traceId, client_dispatch_ms: dispatchMs },
        });
      const finish = (
        status: number | string,
        storage?: number,
        shell?: number,
      ) => {
        if (!traceId) return;
        const fields: Rec = {
          trace_id: traceId,
          status,
          total_ms: deps.monotonicMs() - started,
        };
        if (storage !== undefined) fields.storage_ms = storage;
        if (shell !== undefined) fields.shell_ms = shell;
        logEvent(deps.log, INFO, "conversation_switch_request_finished", {
          conversation_id: cid,
          fields,
        });
      };
      const storageStarted = deps.monotonicMs();
      let conv: Rec | null;
      try {
        conv = await deps.reads.readConversationMetadata(cid);
      } catch (error) {
        finish("failure");
        throw error;
      }
      const storageMs = deps.monotonicMs() - storageStarted;
      if (!pyTruthy(conv)) {
        finish(404, storageMs);
        throw new HttpError(404);
      }
      const record = conv!;
      record.github_repo_url = null;
      try {
        record.github_repo_url = await deps.git.githubRepoUrl(
          store.effectiveWorkdir(record),
          typeof record.tmp_key === "string"
            ? deps.git.workdirFile(record.tmp_key)
            : null,
        );
      } catch {}

      const shellsStarted = deps.monotonicMs();
      const empty = (): Rec => ({
        status: deps.config.piBgShellEnabled ? "ready" : "disabled",
        items: [],
        truncated: false,
        active_count: 0,
        background_count: 0,
      });
      let shells: Rec;
      try {
        shells = focused ? await deps.shellView(cid) : empty();
      } catch (error) {
        finish("failure", storageMs);
        throw error;
      }
      const shellMs = deps.monotonicMs() - shellsStarted;
      Object.assign(shells, {
        scope: "selected_agent_current_session",
        agent_id: cid,
        agent_title: pyTruthy(record.title) ? record.title : cid,
      });
      record.shells = shells;
      for (const key of ["session_id", "session_file", "session_cwd"])
        delete record[key];
      const extra: Record<string, string> = {};
      if (focused)
        extra["server-timing"] =
          `conversation-storage;dur=${storageMs.toFixed(3)}, ` +
          `conversation-shells;dur=${shellMs.toFixed(3)}, ` +
          `conversation-total;dur=${(deps.monotonicMs() - started).toFixed(3)}`;
      if (traceId) {
        extra["x-recurse-switch-trace"] = traceId;
        finish(200, storageMs, shellMs);
      }
      return conditionalJson(ex.request, record, { extraHeaders: extra });
    },
    {
      query: {
        focused: { type: "bool", default: false },
        switch_trace: { type: "str" },
        client_dispatch_ms: { type: "str" },
      },
    },
  );

  router.get(
    "/api/service/conversations/{cid}/replies",
    async (ex) => {
      // Invariant: Service-owned completed turns with an at-least-once cursor;
      // the read never records delivery.
      requireServicePrincipal(ex);
      const cid = ex.params.cid!;
      if (!serviceOwnsRequest(ex, cid))
        throw new HttpError(404, "conversation not found");
      let page: Rec | null;
      try {
        page = await deps.reads.readCompletedReplies(
          cid,
          queryStr(ex, "after"),
          {
            wait: ex.query.wait,
          },
        );
      } catch (error) {
        if (error instanceof CompletedReplyCursorExpired)
          return jsonResponse(
            { error: { code: "cursor_expired", message: error.message } },
            410,
            noStore,
          );
        if (error instanceof CompletedReplyStorageUnavailable)
          throw new HttpError(503, "reply storage unavailable");
        if (
          error instanceof CompletedReplyCursorError ||
          isValueError(error) ||
          error instanceof RangeError
        )
          throw new HttpError(422, (error as Error).message);
        throw error;
      }
      if (page === null) throw new HttpError(404, "conversation not found");
      return jsonResponse(page, 200, noStore);
    },
    {
      query: { after: { type: "str" }, wait: { type: "float", default: 0 } },
      longRunning: true,
    },
  );

  const readToolDetail = async (ex: Exchange): Promise<Rec> => {
    const cid = ex.params.cid!;
    if (!deps.durable?.owns(store.load(cid))) throw new HttpError(404);
    const artifact = await deps.durable.toolDetails?.(
      cid,
      ex.params.artifact_id!,
    );
    if (!artifact) throw new HttpError(404);
    return artifact;
  };
  const artifactEvents = (artifact: Rec) =>
    [artifact.input, artifact.latest_update, artifact.result].filter(
      (event) => event != null,
    );
  router.get(
    "/api/conversations/{cid}/tool-details/{artifact_id}",
    async (ex) => jsonResponse(await readToolDetail(ex), 200, noStore),
  );
  router.get(
    "/api/conversations/{cid}/tool-details/{artifact_id}/events",
    async (ex) => {
      const artifact = await readToolDetail(ex);
      const cursor = Number(ex.query.cursor);
      const limit = Number(ex.query.limit);
      if (cursor < 0 || limit < 1 || limit > 100) throw new HttpError(422);
      const events = artifactEvents(artifact);
      return jsonResponse(
        {
          artifact_id: artifact.artifact_id,
          events: events.slice(cursor, cursor + limit),
          next_cursor: Math.min(events.length, cursor + limit),
          has_more: cursor + limit < events.length,
        },
        200,
        noStore,
      );
    },
    {
      query: {
        cursor: { type: "int", default: 0 },
        limit: { type: "int", default: 50 },
      },
    },
  );
  router.get(
    "/api/conversations/{cid}/tool-details/{artifact_id}/raw",
    async (ex) => {
      const artifact = await readToolDetail(ex);
      return new Response(
        artifactEvents(artifact)
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
        {
          headers: {
            ...noStore,
            "content-type": "application/x-ndjson",
            "content-disposition": `attachment; filename="${artifact.artifact_id}.jsonl"`,
          },
        },
      );
    },
  );

  router.get(
    "/api/conversations/{cid}/skills",
    async (ex) => {
      let result: [unknown[], string] | null;
      try {
        result = await deps.agentTools.skillsFor(ex.params.cid!);
      } catch {
        throw new HttpError(502, "skills unavailable");
      }
      if (result === null) throw new HttpError(404);
      const [skills, context] = result;
      const canonical = pySortedJson({ context, skills });
      const etag = `"${createHash("sha256").update(canonical).digest("hex")}"`;
      const headers = {
        "cache-control": "private, no-cache",
        etag,
        "x-recurse-skill-context": context,
      };
      if (header(ex, "if-none-match") === etag)
        return new Response(null, { status: 304, headers });
      return jsonResponse({ skills, context }, 200, headers);
    },
    { longRunning: true },
  );

  router.get("/api/conversations/{cid}/context-usage", async (ex) => {
    const view = await deps.reads.readContextUsage(ex.params.cid!);
    if (view == null) throw new HttpError(404);
    return conditionalJson(ex.request, view);
  });

  router.get("/api/conversations/{cid}/prompt", async (ex) => {
    const view = await deps.reads.readBasePrompt(ex.params.cid!);
    if (view == null) throw new HttpError(404);
    return jsonResponse(view);
  });

  router.get(
    "/api/conversations/{cid}/turn-prompt",
    async (ex) => {
      const view = await deps.reads.readTurnPrompt(
        ex.params.cid!,
        ex.query.offset as number,
      );
      if (view == null) throw new HttpError(404);
      return jsonResponse(view, 200, noStore);
    },
    { query: { offset: { type: "int", required: true } } },
  );

  router.get(
    "/api/conversations/{cid}/thinking",
    async (ex) => {
      const view = await deps.reads.readThinkingText(
        ex.params.cid!,
        ex.query.offset as number,
      );
      if (view == null) throw new HttpError(404);
      return jsonResponse(view, 200, noStore);
    },
    { query: { offset: { type: "int", required: true } } },
  );

  router.get(
    "/api/conversations/{cid}/marker-summary",
    async (ex) => {
      const view = await deps.reads.readMarkerSummary(
        ex.params.cid!,
        ex.query.offset as number,
        ex.query.generation as number,
      );
      if (view == null) throw new HttpError(404);
      return jsonResponse(view, 200, noStore);
    },
    {
      query: {
        offset: { type: "int", required: true },
        generation: { type: "int", required: true },
      },
    },
  );

  router.post("/api/conversations/{cid}/model", async (ex) => {
    // Invariant: Record the next model/effort choice; the next admitted message
    // consumes it and a running turn keeps its launched model.
    const cid = ex.params.cid!;
    if (typeof store.load(cid)?.side_of === "string")
      throw new HttpError(409, "a side conversation uses its parent's model");
    const body = await dictBody(ex);
    const level = body.level ?? null;
    let model = body.model ?? null;
    let effort = body.effort ?? null;
    if (level !== null) {
      if (!validLevel(level)) throw new HttpError(422, "level must be 1-5");
      if (model === null) {
        let reasoning: string;
        try {
          [model, reasoning] = deps.config.resolveEffortLevel(level);
        } catch (error) {
          if (!isValueError(error)) throw error;
          throw new HttpError(422, (error as Error).message);
        }

        if (effort === null) effort = reasoning;
      }
    }
    if (typeof model !== "string" || !model)
      throw new HttpError(422, "model required");
    if (effort !== null && (typeof effort !== "string" || !effort))
      throw new HttpError(422, "effort must be a non-empty string");
    const conv = store.load(cid);
    if (!pyTruthy(conv)) throw new HttpError(404, "conversation not found");
    const applied = await deps.configActions.requestModelChange(
      cid,
      model,
      effort as string | null,
      level as number | null,
    );
    if (applied === null) throw new HttpError(409, "unknown model");
    return jsonResponse({
      id: cid,
      model: applied.model,
      effort: applied.effort,
      level: applied.level,
      pending_model: applied.pending_model,
      backend: conv!.backend,
    });
  });

  router.post("/api/conversations/{cid}/safety", async (ex) => {
    // Invariant: Durable commits the per-action review state before queuing its
    // notice; the next tool call follows the operator's setting.
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    const off = body.off;
    if (typeof off !== "boolean")
      throw new HttpError(422, "off must be a boolean");
    if (!pyTruthy(store.load(cid))) throw new HttpError(404);
    let conv: Rec;
    let submitted: boolean;
    try {
      [conv, submitted] = await deps.nodes.node(cid).setSafety(off);
    } catch (error) {
      if (errorName(error) === "KeyError")
        throw new HttpError(404, "conversation not found");
      if (isValueError(error))
        throw new HttpError(409, (error as Error).message);
      throw error;
    }
    if (submitted) deps.delivery.requestRun(cid);
    return jsonResponse({
      id: conv.id,
      safety_off: pyTruthy(conv.safety_off),
      safety_off_active: pyTruthy(conv.safety_off_active),
    });
  });

  router.post("/api/conversations/{cid}/rename", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    if (!pyTruthy(store.load(cid))) throw new HttpError(404);
    const cleaned = cleanTitle(body.title ?? "");
    if (!cleaned) throw new HttpError(422, "title required");
    const order = cleanTitleOrder(body.title_order);
    const applied = deps.nodes.node(cid).renameTitle(cleaned, order);
    if (applied === null) {
      if (!pyTruthy(store.load(cid))) throw new HttpError(404);
      throw new HttpError(422, "title required");
    }
    return jsonResponse({ id: cid, ...applied });
  });

  router.post("/api/conversations/{cid}/pin", async (ex) => {
    if (agentMarked(ex))
      throw new HttpError(403, "only the operator can change Take over");
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    const pinned = body.pinned;
    if (typeof pinned !== "boolean")
      throw new HttpError(422, "pinned must be a boolean");
    let conv: Rec;
    try {
      conv = await deps.create.setPinned(cid, pinned);
    } catch (error) {
      if (error instanceof TreeLifecycleBusy)
        throw new HttpError(
          503,
          "Take-over change is busy. Try again shortly.",
        );
      if (errorName(error) === "KeyError")
        throw new HttpError(404, "conversation not found");
      throw error;
    }
    return jsonResponse({ id: cid, pinned: pyTruthy(conv.pinned) });
  });

  const requireChild = (cid: string) => {
    const conv = store.load(cid);
    if (!pyTruthy(conv)) throw new HttpError(404);
    if (!pyTruthy(conv!.parent))
      throw new HttpError(403, "a top-level agent has no parent to mute");
  };

  router.post("/api/conversations/{cid}/mute", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    requireChild(cid);
    const muted = body.muted;
    if (typeof muted !== "boolean")
      throw new HttpError(422, "muted must be a boolean");
    const applied = await deps.configActions.requestMute(cid, muted);
    if (applied === null) throw new HttpError(404);
    return jsonResponse(applied);
  });

  router.post("/api/conversations/{cid}/mute-toggle", async (ex) => {
    // Invariant: The /mute composer command: a platform action, never a model
    // prompt.
    const cid = ex.params.cid!;
    requireChild(cid);
    const applied = await deps.configActions.toggleMute(cid);
    if (applied === null) throw new HttpError(404);
    return jsonResponse({ ...applied, action: "mute" });
  });

  router.post("/api/conversations/{cid}/compact", async (ex) => {
    const cid = ex.params.cid!;
    const conv = store.load(cid);
    if (!pyTruthy(conv)) throw new HttpError(404);
    const applied = deps.durable?.owns(conv)
      ? await deps.durable.compact(cid)
      : await deps.compaction.requestCompact(cid);
    if (applied == null) throw new HttpError(404);
    return jsonResponse(applied);
  });

  router.post("/api/conversations/{cid}/clear", async (ex) => {
    const cid = ex.params.cid!;
    const conv = store.load(cid);
    if (!pyTruthy(conv)) throw new HttpError(404);
    const applied = deps.durable?.owns(conv)
      ? await deps.durable.clear(cid)
      : await deps.compaction.requestClear(cid);
    if (applied == null) throw new HttpError(404);
    return jsonResponse(applied);
  });

  router.post("/api/conversations/{cid}/reparent", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    if (!pyTruthy(store.load(cid))) throw new HttpError(404);
    const parent = body.parent;
    if (typeof parent !== "string" || !parent)
      throw new HttpError(422, "parent must be an agent id");
    const result = await deps.tree.requestReparent(cid, parent, {
      by: agentHeader(ex),
    });
    if (!pyTruthy(result.ok))
      throw new HttpError(
        409,
        "error" in result ? (result.error ?? undefined) : "invalid move",
      );
    return jsonResponse(result);
  });

  router.get(
    "/api/conversations/{cid}/view",
    async (ex) => {
      // Invariant: One immutable window over resident Pi history. Before the
      // startup replay a missing record reads as loading (503), never as
      // deleted.
      deps.requireActionReady();
      const cid = ex.params.cid!;
      if (!pyTruthy(store.metadataSnapshot(cid))) throw new HttpError(404);
      const window = await deps.reads.readViewWindow(cid, {
        after: queryStr(ex, "after"),
        before: queryStr(ex, "before"),
        limit: ex.query.limit as number,
        since: (ex.query.since ?? null) as number | null,
        instance: queryStr(ex, "instance"),
      });
      return conditionalJson(ex.request, window);
    },
    {
      query: {
        after: { type: "str" },
        before: { type: "str" },
        limit: { type: "int", default: 50 },
        since: { type: "int" },
        instance: { type: "str" },
      },
    },
  );

  router.get(
    "/api/conversations/{cid}/events",
    async (ex) => {
      // Invariant: One-shot SSE: a snapshot frame, or a rows delta when
      // Last-Event-ID still fits; the transport reconnects at the retry
      // cadence.
      deps.requireActionReady();
      const cid = ex.params.cid!;
      if (store.metadataSnapshot(cid) === null) throw new HttpError(404);
      const [status, body] = await deps.reads.readViewEvents(
        cid,
        header(ex, "last-event-id"),
      );
      if (status !== 200) throw new HttpError(status);
      return new Response(body as Uint8Array<ArrayBuffer>, {
        headers: {
          "cache-control": "no-store",
          "x-accel-buffering": "no",
          "content-length": String(body.byteLength),
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    },
    { longRunning: true },
  );

  router.get(
    "/api/conversations/{cid}/files",
    async (ex) => {
      const [status, value] = await deps.reads.composeFilePage(
        ex.params.cid!,
        queryStr(ex, "cursor"),
        ex.query.limit,
        (ex.query.generation ?? null) as number | null,
      );
      if (status !== 200 || value == null) {
        if (status === 400) throw new HttpError(400, "bad files cursor");
        throw new HttpError(status);
      }
      return jsonResponse(value, 200, noStore);
    },
    {
      query: {
        cursor: { type: "str" },
        limit: { type: "int", default: 1000 },
        generation: { type: "int" },
      },
    },
  );

  router.get(
    "/api/conversations/{cid}/files/{storage}/{attachment_id}/preview",
    async (ex) => {
      const [status, value] = await deps.reads.composeFilePreview(
        ex.params.cid!,
        ex.params.storage!,
        ex.params.attachment_id!,
        (ex.query.offset ?? null) as number | null,
      );
      if (status !== 200 || value == null) {
        if (status === 404)
          throw new HttpError(404, "text preview not available");
        throw new HttpError(status);
      }
      return jsonResponse(value, 200, {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      });
    },
    { query: { offset: { type: "int" } } },
  );

  router.delete("/api/conversations/{cid}", async (ex) => {
    // Invariant: Asynchronous intent: record durably and return before any
    // retire. An agent-requested delete carries its requester.
    let state: Rec;
    try {
      state = await deps.reap.requestReap(ex.params.cid!, agentHeader(ex));
    } catch (error) {
      if (errorName(error) === "TakenOverReapBlocked")
        throw new HttpError(403, (error as Error).message);
      if (errorName(error) === "KeyError") throw new HttpError(404);
      throw error;
    }
    return jsonResponse(state, 202);
  });

  router.post("/api/service/conversations/{cid}/messages", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    const [, policy] = requireServicePrincipal(ex);
    const ownership = ex.state.service_conversation_ownership;
    if (
      !Array.isArray(ownership) ||
      ownership.length !== 2 ||
      !ownership.every((value) => typeof value === "string")
    )
      throw new HttpError(403, "service ownership unavailable");
    if (!serviceOwnsRequest(ex, cid))
      throw new HttpError(404, "conversation not found");
    const conv = store.load(cid, { withPending: false });
    if (!pyTruthy(conv)) throw new HttpError(404, "conversation not found");
    const allowed = policy.allowed_models;
    if (allowed !== null && !allowed.includes(conv!.model as string))
      throw new HttpError(403, "model_not_allowed");
    const active = (conv!.active_turn ?? {}) as Rec;
    if (pyTruthy(conv!.safety_off) || pyTruthy(active.safety_off))
      throw new HttpError(403, "service safety review is required");
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "content")
      throw new HttpError(422, "service message accepts only content");
    const raw = body.content;
    if (
      raw !== null &&
      raw !== undefined &&
      typeof raw !== "string" &&
      pyTruthy(raw)
    )
      throw new TypeError("service message content must be text");
    const content = pyTruthy(raw) ? pyStrip(raw as string) : "";
    if (!content) throw new HttpError(422, "empty message");
    if (codePoints(content) > SERVICE_MESSAGE_MAX_CHARS)
      throw new HttpError(413, "message is too large");
    const steer = messageIsLiveSteer(cid);
    const messageId = await deps.delivery.deliver(cid, content, {
      start: false,
      origin: "service",
    });
    if (messageId === null) throw new HttpError(404, "conversation not found");
    deps.delivery.requestRun(cid);
    const latest = store.load(cid, { withPending: false });
    return jsonResponse({
      ok: true,
      status: (latest ?? conv!).status,
      message_id: messageId,
      steer,
    });
  });

  router.post("/api/conversations/{cid}/deliver", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    let relayed: { sender: string; title: string | null } | null = null;
    if ("relayed_from" in body) {
      const method = String(ex.state.auth_method);
      if (!["cookie", "tailscale", "local", "backend-key"].includes(method))
        throw new HttpError(
          403,
          "relayed_from requires an operator session or backend key",
        );
      const from = body.relayed_from as Record<string, unknown> | null;
      const label =
        from?.backend !== undefined
          ? from.backend
          : method === "backend-key"
            ? String(ex.state.principal).slice("backend-key:".length)
            : undefined;
      if (
        !from ||
        typeof from !== "object" ||
        Array.isArray(from) ||
        typeof from.agent !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(from.agent) ||
        !validBackendKeyName(label) ||
        (from.title !== undefined && typeof from.title !== "string")
      )
        throw new HttpError(422, "invalid relayed_from");
      if (typeof body.content !== "string" || !body.content.trim())
        throw new HttpError(422, "empty message");
      if (codePoints(body.content) > SERVICE_MESSAGE_MAX_CHARS)
        throw new HttpError(413, "message is too large");
      if ("attachment_ids" in body || "attachments" in body)
        throw new HttpError(422, "relayed messages are text only");
      if (method === "backend-key")
        logEvent(deps.log, INFO, "forwarded_agent_message", {
          fields: {
            forwarded_by: String(ex.state.principal).slice(
              "backend-key:".length,
            ),
            backend: label,
            agent: from.agent,
          },
        });
      relayed = {
        sender: `${from.agent}@${label}`,
        title: cleanTitle(from.title),
      };
    }
    const durable = deps.durable?.owns(store.load(cid)) ? deps.durable : null;
    if (typeof body.content !== "string" || !pyStrip(body.content)) {
      if (pyTruthy(body.interrupt))
        throw new HttpError(
          422,
          "interrupt needs a message; stop with run_id instead",
        );
      return deps.deliverStop(cid, body);
    }
    const conv = store.load(cid);
    if (!pyTruthy(conv)) throw new HttpError(404);
    const content = pyStrip(body.content);
    const rawIds = body.attachment_ids ?? [];
    if (
      !Array.isArray(rawIds) ||
      rawIds.length > 50_000 ||
      rawIds.some((value) => typeof value !== "string")
    )
      throw new HttpError(422, "invalid attachment references");
    const attachmentIds = [...new Set(rawIds as string[])];
    if (attachmentIds.length && !(await uploadsAvailable(cid, attachmentIds)))
      throw new HttpError(422, "attachment is unavailable");
    // Invariant: One idempotency key per composer job: a retry replays the
    // first ack.
    const clientMessageId = body.client_message_id ?? null;
    if (
      clientMessageId !== null &&
      (typeof clientMessageId !== "string" ||
        !CLIENT_MESSAGE_ID_RE.test(clientMessageId))
    )
      throw new HttpError(422, "invalid client_message_id");
    const statusOf = () => (store.load(cid) ?? conv!).status;
    // Invariant: A local tool announcing its identity sends as that agent, so
    // the reply routes back to it; otherwise this is trusted direct-operator
    // input.
    const sender = header(ex, "x-recurse-agent");

    const send = () =>
      relayed
        ? deliverRelayed(
            deps.delivery,
            cid,
            content,
            relayed,
            clientMessageId as string | null,
            pyTruthy(body.interrupt),
          )
        : deps.delivery.deliver(
            cid,
            content,
            sender && store.load(sender) !== null
              ? {
                  start: false,
                  source: "spawn",
                  sender,
                  attachmentIds,
                  clientMessageId: clientMessageId as string | null,
                }
              : {
                  start: false,
                  origin: "operator",
                  attachmentIds,
                  clientMessageId: clientMessageId as string | null,
                },
          );
    if (pyTruthy(body.interrupt)) {
      // Invariant: Fence first: the replacement then defers to the new run
      // instead of racing the abort. Legacy sessions are read-only; only
      // Durable can own a live turn.
      const interrupted = relayed
        ? false
        : ((await durable?.stop(cid)) ?? false);
      const mid = await send();
      if (mid === null) throw new HttpError(404);
      deps.delivery.requestRun(cid);
      return jsonResponse({
        ok: true,
        status: statusOf(),
        message_id: mid,
        ...(!relayed ? { interrupted } : {}),
      });
    }

    const steer = messageIsLiveSteer(cid);
    const messageId = await send();
    if (messageId === null) throw new HttpError(404);
    deps.delivery.requestRun(cid);
    return jsonResponse({
      ok: true,
      status: statusOf(),
      message_id: messageId,
      steer,
    });
  });

  router.delete("/api/conversations/{cid}/messages/{mid}", async (ex) => {
    const cid = ex.params.cid!;
    if (!pyTruthy(store.load(cid))) throw new HttpError(404);
    if (!(await deps.delivery.cancelInboxMessageAsync(cid, ex.params.mid!)))
      throw new HttpError(404, "message not queued");
    return jsonResponse({ ok: true });
  });

  router.post("/api/conversations/{cid}/messages/{mid}/retry", async (ex) => {
    const cid = ex.params.cid!;
    if (!pyTruthy(store.load(cid))) throw new HttpError(404);
    if (!(await deps.delivery.retryInboxMessage(cid, ex.params.mid!)))
      throw new HttpError(404, "message not retryable");
    return jsonResponse({ ok: true });
  });

  const diffScope = async (
    conv: Rec,
    signal?: AbortSignal,
  ): Promise<[string, string, string | null]> => {
    let stored: string;
    try {
      stored = store.effectiveWorkdir(conv);
    } catch {
      throw new HttpError(404, "unknown workdir");
    }
    const [cwd, source] = await timed("diff.scope", async () => {
      const persisted = deps.durable?.owns(conv)
        ? await deps.durable.effectiveCwd(String(conv.id))
        : null;
      return deps.git.resolveDiffCwd(stored, persisted, signal);
    });
    return [cwd, source, cleanBaseRef(conv.diff_base_ref)];
  };

  const loadOr404 = (cid: string): Rec => {
    const conv = store.load(cid);
    if (!pyTruthy(conv)) throw new HttpError(404);
    return conv!;
  };

  router.get("/api/conversations/{cid}/prs", async (ex) => {
    const conv = loadOr404(ex.params.cid!);
    let cwd: string | null = null;
    try {
      [cwd] = await diffScope(conv);
    } catch {}
    const urls = Array.isArray(conv.touched_prs)
      ? conv.touched_prs
          .filter((url): url is string => typeof url === "string")
          .slice(-50)
      : [];
    return jsonResponse(deps.git.pullRequests(cwd, urls));
  });

  router.get(
    "/api/conversations/{cid}/diff",
    async (ex) => {
      const conv = loadOr404(ex.params.cid!);
      const pr = queryStr(ex, "pr");
      if (pr !== null) {
        if (!prIdentity(pr))
          throw new HttpError(422, "invalid pull request URL");
        return jsonResponse(await deps.git.pullRequestDiff(pr));
      }
      const base = queryStr(ex, "base");
      if (base !== null && cleanBaseRef(base) === null)
        throw new HttpError(422, "invalid base ref");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (ex.request.signal.aborted) abort();
      else ex.request.signal.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(() => {
        timingDetail("diff_result", "deadline");
        abort();
      }, DIFF_REQUEST_TIMEOUT_MS);
      const signal = controller.signal;
      let cwd: string | null = null;
      let source = "stored";
      let onAbort!: () => void;
      const aborted = new Promise<Response>((resolve) => {
        onAbort = () =>
          resolve(jsonResponse(unavailableDiff("diff-failed", cwd, source)));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      const work = async () => {
        const [resolved, resolvedSource, stored] = await diffScope(
          conv,
          signal,
        );
        cwd = resolved;
        source = resolvedSource;
        return jsonResponse(
          await deps.git.worktreeDiff(cwd, base ?? stored, source, signal),
        );
      };
      try {
        return await Promise.race([work(), aborted]);
      } catch {
        return jsonResponse(unavailableDiff("diff-failed", cwd, source));
      } finally {
        clearTimeout(deadline);
        ex.request.signal.removeEventListener("abort", abort);
        signal.removeEventListener("abort", onAbort);
      }
    },
    {
      query: { base: { type: "str" }, pr: { type: "str" } },
      longRunning: true,
    },
  );

  router.add(["PATCH"], "/api/conversations/{cid}/diff/base", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    const conv = loadOr404(cid);
    if (!("base" in body)) throw new HttpError(422, "base required");
    const raw = body.base;
    if (raw === null || (typeof raw === "string" && !pyStrip(raw)))
      delete conv.diff_base_ref;
    else {
      const ref = cleanBaseRef(raw);
      if (ref === null) throw new HttpError(422, "invalid base ref");
      conv.diff_base_ref = ref;
    }
    await store.save(conv);
    return jsonResponse({ id: cid, diff_base_ref: conv.diff_base_ref ?? null });
  });

  router.get(
    "/api/conversations/{cid}/diff/files",
    async (ex) => {
      const conv = loadOr404(ex.params.cid!);
      const path = queryStr(ex, "path");
      if (!path) throw new HttpError(422, "path required");
      const pr = queryStr(ex, "pr");
      if (pr !== null) {
        if (!prIdentity(pr))
          throw new HttpError(422, "invalid pull request URL");
        return jsonResponse(await deps.git.pullRequestDiff(pr, path));
      }
      const base = queryStr(ex, "base");
      if (base !== null && cleanBaseRef(base) === null)
        throw new HttpError(422, "invalid base ref");
      const [cwd, , stored] = await diffScope(conv);
      try {
        return jsonResponse(
          await deps.git.diffFile(
            cwd,
            path,
            base ?? stored,
            ex.query.contents === true,
          ),
        );
      } catch {
        return jsonResponse({ available: false, reason: "diff-failed", path });
      }
    },
    {
      query: {
        path: { type: "str" },
        pr: { type: "str" },
        base: { type: "str" },
        contents: { type: "bool", default: false },
      },
      longRunning: true,
    },
  );

  router.get(
    "/api/conversations/{cid}/diff/candidates",
    async (ex) => {
      const conv = loadOr404(ex.params.cid!);
      const [cwd] = await diffScope(conv);
      try {
        return jsonResponse(await deps.git.diffCandidates(cwd));
      } catch {
        return jsonResponse({ branches: [], commits: [], tags: [] });
      }
    },
    { longRunning: true },
  );
}

/** A named refusal inside a service create. */
class ServiceRefusal extends Error {
  override name = "ValueError";
}

const isOsError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string" &&
  /^E[A-Z]+$/.test((error as { code: string }).code);

/** Python float(text) accepts this spelling. */
function pyFloatText(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return (
    /^[+-]?(nan|inf|infinity)$/.test(trimmed) ||
    /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?$/.test(
      trimmed,
    )
  );
}

/** json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False). */
export function pySortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pySortedJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${pySortedJson((value as Rec)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
