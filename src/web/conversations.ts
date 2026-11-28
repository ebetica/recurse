// Lifecycle/message/view routes over owner services; focused reads never wait for Git.
// Gate views before existence checks; focused SSE follows durable commits.
// Skills revalidate list and context together; a context change invalidates both.
// Relayed text is always agent input; audit its forwarding key separately.

import { validBackendKeyName } from "../auth/backend_keys";
import { keyedLabel } from "../backends/label";
import { pyStrip, SERVICE_MESSAGE_MAX_CHARS } from "../auth";
import { EFFORT_LEVEL_RANGE, isEffortLevel } from "../effort_levels";
import { cleanTitleOrder, stripPendingKeys } from "../agents/storage";
import type { Tags } from "../agent_metadata/index";
import { TreeLifecycleBusy } from "../agents/lifecycle";
import { AttachmentError } from "../agents/runtime/attachments/base";
import { pyTruthy } from "../agents/runtime";
import {
  INFO,
  WARNING,
  logEvent,
  logException,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { cleanTitle } from "../title_text";
import { conditionalJson } from "./caching";
import { creationTags } from "./tags";
import { compactConversation } from "./compact";
import { conversationEvents } from "./conversation_events";
import {
  codePoints,
  dictBody,
  errorName,
  header,
  isValueError,
  noStore,
  queryStr,
} from "./conversation_request";
import { createLiveSteerCheck, createMessageSender } from "./deliver_message";
import { agentMarked, authMethod, isOperator } from "./request_auth";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";
const SWITCH_TRACE_RE = /^[0-9a-f]{16,64}$/;
/** config._TEMP_ID_RE. */
export const TEMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
type Rec = Record<string, unknown>;
type Status<T> = readonly [number, T];

export interface ConversationsRoutesDeps {
  /** 503 `service_storage_unavailable` + Retry-After: 2 until action-ready. */
  requireActionReady(): void;
  readonly notifications?: { addViewer(cid: string): () => void };
  readonly log: RuntimeLogger;
  /** Monotonic milliseconds. */
  monotonicMs(): number;
  readonly store: {
    convRowExists(cid: string): boolean;
    load(
      cid: string,
      options?: { withPending?: boolean; fields?: readonly string[] },
    ): Rec | null;
    metadataSnapshot(cid: string, fields?: readonly string[]): Rec | null;
    markViewed(cid: string): Promise<() => void>;
    setUnread(cid: string, unread: boolean): Promise<boolean>;
    effectiveWorkdir(conv: Rec): string;
  };
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
    readViewWindow(
      cid: string,
      options: {
        after: string | null;
        before: string | null;
        limit: number;
        since: number | null;
        instance: string | null;
        textDeltas: boolean;
      },
    ): Promise<unknown>;
    readViewEvents(
      cid: string,
      lastEventId: string | null,
      textDeltas: boolean,
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
    readThinkingText(
      cid: string,
      offset: number,
      liveRow?: string,
    ): Promise<unknown>;
    readContextUsage(cid: string): Promise<unknown>;
    readBasePrompt(
      cid: string,
      includeSafetyReview?: boolean,
    ): Promise<unknown>;
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
      tags?: Tags;
      muted: boolean;
      operatorSelectedModel?: boolean;
    }): Promise<Rec>;
    setTakenOver(cid: string, takenOver: boolean): Promise<Rec>;
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
      parent: string | null,
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
      operatorSelectedModel?: boolean,
    ): Promise<Rec | null>;
  };
  readonly compaction: {
    requestCompact(cid: string): Promise<unknown>;
    requestClear(cid: string): Promise<unknown>;
  };
  readonly nodes: {
    existing(cid: string): { inboxMessages(): readonly Rec[] } | null;
    /** agent_nodes.node: throws KeyError for an unknown conversation. */
    node(cid: string): {
      setSafety(off: boolean, onNoticed: () => void): Promise<unknown[]>;
      /** A safety reply's current state; null once deleted. */
      safetyState(): Rec | null;
      renameTitle(title: string, order: string): Rec | null;
      /** The live PiAgent's status, or null without one. */
      piStatus(): string | null;
    };
  };
  /** node_pi.live_run_id. */
  liveRunId(cid: string): string | null;
  /** Durable conversations (src/agents/durable/host). */
  readonly durable?: {
    owns(conv: Rec | null | undefined): boolean;
    subscribeView?(cid: string, listener: () => void): () => void;
    stop(cid: string): Promise<boolean>;
    clear(cid: string): Promise<Rec | null>;
    compact(cid: string): Promise<Rec | null>;
    toolDetails?(
      cid: string,
      artifactId: string,
      includeOperatorFailure?: boolean,
    ): Promise<Rec | null>;
  };
  readonly drafts: {
    recoverTransferredAttachmentDraft(token: unknown): Promise<Rec | null>;
  };
  readonly config: {
    resolveEffortLevel(level: number): [string, string];
    isFileProviderModel(model: string): boolean;
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
  githubRepoUrl(stored: string): Promise<string | null>;
}

export function registerConversationRoutes(
  router: Router,
  deps: ConversationsRoutesDeps,
): ReturnType<typeof createMessageSender> {
  const { store } = deps;
  const githubRepos = new Map<
    string,
    { url: string | null; pending: boolean }
  >();
  function githubRepoForRead(
    cid: string,
    stored: string,
    focused: boolean,
  ): string | null {
    const key = JSON.stringify([cid, stored]);
    const entry = githubRepos.get(key) ?? { url: null, pending: false };
    if (focused && !entry.pending) {
      githubRepos.delete(key);
      githubRepos.set(key, entry);
      if (githubRepos.size > 100)
        githubRepos.delete(githubRepos.keys().next().value!);
      entry.pending = true;
      // The next ordinary read gets the result.
      void deps
        .githubRepoUrl(stored)
        .catch(() => null)
        .then((url) => {
          entry.url = url;
          entry.pending = false;
        });
    }
    return entry.url;
  }
  const operatorSelectedFileModel = (ex: Exchange, model: unknown): boolean => {
    const fileModel =
      typeof model === "string" && deps.config.isFileProviderModel(model);
    if (fileModel && (!isOperator(ex) || agentMarked(ex)))
      throw new HttpError(
        403,
        "Choose file-defined models through an effort level saved in Settings",
      );
    return fileModel;
  };

  const messageIsLiveSteer = createLiveSteerCheck(deps);

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
  const sendMessage = createMessageSender(
    deps,
    uploadsAvailable,
    messageIsLiveSteer,
  );

  const agentHeader = (ex: Exchange): string | null => {
    if (typeof ex.state.backend_agent === "string")
      return ex.state.backend_agent;
    const by = header(ex, "x-recurse-agent");
    return by !== null && TEMP_ID_RE.test(by) ? by : null;
  };

  router.post(
    "/api/conversations",
    async (ex) => {
      const body = (await dictBody(ex, false)) ?? {};
      const operatorSelectedModel = operatorSelectedFileModel(ex, body.model);
      if (["fork_of", "sibling_of", "context"].some((key) => key in body))
        throw new HttpError(
          422,
          "fork and sibling agent creation are no longer supported",
        );
      const tags = creationTags(ex, body.tags);
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
      if (parent !== null && !store.convRowExists(parent as string))
        throw new HttpError(404, "parent agent not found");
      const level = body.level ?? null;
      if (level !== null && !isEffortLevel(level))
        throw new HttpError(422, `level must be ${EFFORT_LEVEL_RANGE}`);
      try {
        return jsonResponse(
          await deps.create.create({
            parent: parent as string | null,
            model: (body.model ?? null) as string | null,
            effort: (body.effort ?? null) as string | null,
            level,
            attachmentDraft: (draft ?? null) as string | null,
            tags,
            muted,
            operatorSelectedModel,
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
    const operatorSelectedModel = operatorSelectedFileModel(ex, body.model);
    delete body.operator_selected_model;
    if (operatorSelectedModel) body.operator_selected_model = true;
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
    if (effort !== null && !isEffortLevel(effort))
      throw new HttpError(422, `effort must be ${EFFORT_LEVEL_RANGE}`);
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
      // Invariant: Switch timing travels in headers so the URL stays stable
      // and a revisit revalidates with If-None-Match instead of a full read.
      // Only a read carrying the dispatch time is a switch; other interaction
      // reads (such as Stop's) also carry x-recurse-trace.
      const rawTrace = ex.request.headers.get("x-recurse-trace");
      const rawDispatch = ex.request.headers.get(
        "x-recurse-client-dispatch-ms",
      );
      const traceId =
        rawDispatch !== null &&
        rawTrace !== null &&
        SWITCH_TRACE_RE.test(rawTrace)
          ? rawTrace
          : null;
      let dispatchMs: number | null = null;
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
      const runStateClock = record.run_state_clock;
      delete record.run_state_clock;
      record.github_repo_url = null;
      try {
        record.github_repo_url = githubRepoForRead(
          cid,
          store.effectiveWorkdir(record),
          focused,
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
      if (Array.isArray(runStateClock) && runStateClock.length === 2)
        extra["x-recurse-run-state-clock"] =
          `${runStateClock[0]}:${runStateClock[1]}`;
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
      },
    },
  );

  const readToolDetail = async (
    ex: Exchange,
    includeOperatorFailure = false,
  ): Promise<Rec> => {
    const cid = ex.params.cid!;
    if (!deps.durable?.owns(store.load(cid))) throw new HttpError(404);
    const artifact = await deps.durable.toolDetails?.(
      cid,
      ex.params.artifact_id!,
      includeOperatorFailure,
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
    async (ex) =>
      jsonResponse(
        await readToolDetail(
          ex,
          isOperator(ex, { allowBackendKey: true }) && !agentMarked(ex),
        ),
        200,
        noStore,
      ),
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
      return conditionalJson(
        ex.request,
        { skills, context },
        {
          extraHeaders: { "x-recurse-skill-context": context },
        },
      );
    },
    { longRunning: true },
  );

  router.get("/api/conversations/{cid}/context-usage", async (ex) => {
    const view = await deps.reads.readContextUsage(ex.params.cid!);
    if (view == null) throw new HttpError(404);
    return conditionalJson(ex.request, view);
  });

  router.get("/api/conversations/{cid}/prompt", async (ex) => {
    const view = await deps.reads.readBasePrompt(
      ex.params.cid!,
      isOperator(ex, { allowBackendKey: true }) && !agentMarked(ex),
    );
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
        typeof ex.query.live_row === "string" ? ex.query.live_row : undefined,
      );
      if (view == null) throw new HttpError(404);
      return jsonResponse(view, 200, noStore);
    },
    {
      query: {
        offset: { type: "int", required: true },
        live_row: { type: "str" },
      },
    },
  );

  router.post("/api/conversations/{cid}/model", async (ex) => {
    // Invariant: Record the next model/effort choice; the next admitted message
    // consumes it and a running turn keeps its launched model.
    const cid = ex.params.cid!;
    if (typeof store.metadataSnapshot(cid, ["side_of"])?.side_of === "string")
      throw new HttpError(409, "a side conversation uses its parent's model");
    const body = await dictBody(ex);
    const operatorSelectedModel = operatorSelectedFileModel(ex, body.model);
    const level = body.level ?? null;
    let model = body.model ?? null;
    let effort = body.effort ?? null;
    if (level !== null) {
      if (!isEffortLevel(level))
        throw new HttpError(422, `level must be ${EFFORT_LEVEL_RANGE}`);
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
    const conv = store.load(cid, { withPending: false, fields: ["backend"] });
    if (conv === null) throw new HttpError(404, "conversation not found");
    const applied = await deps.configActions.requestModelChange(
      cid,
      model,
      effort as string | null,
      level as number | null,
      operatorSelectedModel,
    );
    if (applied === null) throw new HttpError(409, "unknown model");
    return jsonResponse({
      id: cid,
      model: applied.model,
      effort: applied.effort,
      level: applied.level,
      pending_model: applied.pending_model,
      backend: conv.backend,
    });
  });

  router.post("/api/conversations/{cid}/safety", async (ex) => {
    // Invariant: Durable commits the per-action review state before queuing its
    // notice; the next tool call follows the operator's setting. Refused until
    // startup has migrated the records it rewrites.
    deps.requireActionReady();
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    const off = body.off;
    if (typeof off !== "boolean")
      throw new HttpError(422, "off must be a boolean");
    if (!store.convRowExists(cid)) throw new HttpError(404);
    const safety = (conv: Rec) => ({
      id: cid,
      safety_off: pyTruthy(conv.safety_off),
      safety_off_active: pyTruthy(conv.safety_off_active),
      safety_rev: typeof conv.safety_rev === "number" ? conv.safety_rev : null,
    });
    let conv: Rec;
    try {
      // Invariant: The reply does not wait for the notice; its run starts
      // once the notice is admitted.
      [conv] = (await deps.nodes
        .node(cid)
        .setSafety(off, () => deps.delivery.requestRun(cid))) as [Rec];
    } catch (error) {
      if (errorName(error) === "KeyError")
        throw new HttpError(404, "conversation not found");
      if (!isValueError(error)) throw error;
      // Invariant: A refused request still reports the current state, so the
      // browser shows the server's state rather than its previous one.
      const current = store.load(cid)
        ? deps.nodes.node(cid).safetyState()
        : null;
      if (!current) throw new HttpError(409, (error as Error).message);
      return jsonResponse(
        { error: (error as Error).message, ...safety(current) },
        409,
      );
    }
    return jsonResponse(safety(conv));
  });

  router.post("/api/conversations/{cid}/rename", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    if (!store.convRowExists(cid)) throw new HttpError(404);
    const cleaned = cleanTitle(body.title ?? "");
    if (!cleaned) throw new HttpError(422, "title required");
    const order = cleanTitleOrder(body.title_order);
    const applied = deps.nodes.node(cid).renameTitle(cleaned, order);
    if (applied === null) {
      if (!store.convRowExists(cid)) throw new HttpError(404);
      throw new HttpError(422, "title required");
    }
    return jsonResponse({ id: cid, ...applied });
  });

  router.post("/api/conversations/{cid}/take-over", async (ex) => {
    if (agentMarked(ex))
      throw new HttpError(403, "only the operator can change Take over");
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    const takenOver = body.taken_over;
    if (typeof takenOver !== "boolean")
      throw new HttpError(422, "taken_over must be a boolean");
    let conv: Rec;
    try {
      conv = await deps.create.setTakenOver(cid, takenOver);
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
    return jsonResponse({ id: cid, taken_over: pyTruthy(conv.taken_over) });
  });

  router.post("/api/conversations/{cid}/unread", async (ex) => {
    if (!isOperator(ex, { allowBackendKey: true }) || agentMarked(ex))
      throw new HttpError(403, "only the operator can change unread state");
    deps.requireActionReady();
    const { unread } = await dictBody(ex);
    if (typeof unread !== "boolean")
      throw new HttpError(422, "unread must be a boolean");
    if (!(await store.setUnread(ex.params.cid!, unread)))
      throw new HttpError(404);
    return jsonResponse({ unread });
  });

  router.post("/api/conversations/{cid}/compact", async (ex) =>
    jsonResponse(await compactConversation(deps, ex.params.cid!)),
  );

  router.post("/api/conversations/{cid}/clear", async (ex) => {
    const cid = ex.params.cid!;
    const conv = store.metadataSnapshot(cid, ["backend"]);
    if (conv === null) throw new HttpError(404);
    const applied = deps.durable?.owns(conv)
      ? await deps.durable.clear(cid)
      : await deps.compaction.requestClear(cid);
    if (applied == null) throw new HttpError(404);
    return jsonResponse(applied);
  });

  router.post("/api/conversations/{cid}/reparent", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    if (!store.convRowExists(cid)) throw new HttpError(404);
    const parent = body.parent;
    if (parent !== null && (typeof parent !== "string" || !parent))
      throw new HttpError(422, "parent must be an agent id or null");
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
      if (!store.convRowExists(cid)) throw new HttpError(404);
      const window = await deps.reads.readViewWindow(cid, {
        after: queryStr(ex, "after"),
        before: queryStr(ex, "before"),
        limit: ex.query.limit as number,
        since: (ex.query.since ?? null) as number | null,
        instance: queryStr(ex, "instance"),
        textDeltas: ex.query.text_deltas === true,
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
        text_deltas: { type: "bool", default: false },
      },
    },
  );

  router.get(
    "/api/conversations/{cid}/events",
    async (ex) => {
      deps.requireActionReady();
      const cid = ex.params.cid!;
      const conv = store.metadataSnapshot(cid, ["backend"]);
      if (conv === null) throw new HttpError(404);
      const durable = deps.durable;
      let acknowledgeClose: (() => void) | undefined;
      return conversationEvents(
        header(ex, "last-event-id"),
        async (cursor) => {
          if (ex.query.viewing === true)
            acknowledgeClose ??= await store.markViewed(cid);
          return deps.reads.readViewEvents(
            cid,
            cursor,
            ex.query.text_deltas === true,
          );
        },
        durable?.owns(conv) && durable.subscribeView
          ? (wake) => {
              const unsubscribe = durable.subscribeView!(cid, wake);
              const stopViewing =
                ex.query.viewing === true
                  ? deps.notifications?.addViewer(cid)
                  : undefined;
              return () => {
                stopViewing?.();
                unsubscribe();
                try {
                  acknowledgeClose?.();
                } catch (error) {
                  logException(
                    deps.log,
                    "conversation_view_ack_failed",
                    error,
                    { conversation_id: cid, level: WARNING },
                  );
                }
              };
            }
          : null,
        ex.request.signal,
      );
    },
    {
      longRunning: true,
      query: {
        text_deltas: { type: "bool", default: false },
        viewing: { type: "bool", default: false },
      },
    },
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

  router.post("/api/conversations/{cid}/deliver", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    let relayed: { sender: string; title: string | null } | null = null;
    if ("relayed_from" in body) {
      const method = String(authMethod(ex));
      if (!isOperator(ex, { allowBackendKey: true }))
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
        (from.title != null && typeof from.title !== "string")
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
        sender: `${from.agent}@${method === "backend-key" ? keyedLabel(label, String(ex.state.backend_key_id)) : label}`,
        title: cleanTitle(from.title),
      };
    }
    if (typeof body.content !== "string" || !pyStrip(body.content)) {
      if (pyTruthy(body.interrupt))
        throw new HttpError(
          422,
          "interrupt needs a message; stop with run_id instead",
        );
      return deps.deliverStop(cid, body);
    }
    return jsonResponse(await sendMessage(cid, body, ex, relayed));
  });

  router.delete("/api/conversations/{cid}/messages/{mid}", async (ex) => {
    const cid = ex.params.cid!;
    if (!store.convRowExists(cid)) throw new HttpError(404);
    if (!(await deps.delivery.cancelInboxMessageAsync(cid, ex.params.mid!)))
      throw new HttpError(404, "message not queued");
    return jsonResponse({ ok: true });
  });

  router.post("/api/conversations/{cid}/messages/{mid}/retry", async (ex) => {
    const cid = ex.params.cid!;
    if (!store.convRowExists(cid)) throw new HttpError(404);
    if (!(await deps.delivery.retryInboxMessage(cid, ex.params.mid!)))
      throw new HttpError(404, "message not retryable");
    return jsonResponse({ ok: true });
  });
  return sendMessage;
}

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
