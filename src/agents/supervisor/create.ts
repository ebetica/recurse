// Create validates, claims, binds and publishes under one lifecycle lease.
// Transactions drain despite cancellation; shutdown joins their TaskSet.
// Refresh spawn-workdir before create; bindings retain read-only legacy state.
// DurableHost owns Harness admission; cancellation bypasses failure cleanup.

import type { Config } from "../../config";
import type { Tags } from "../../agent_metadata/index";
import {
  WARNING,
  logEvent,
  type RuntimeLogger,
} from "../../observability/runtime_logging";
import { abortable, type TaskSet } from "../../utils/tasks";
import {
  CID_RE,
  ExternalKeyConflict,
  ServiceStorageUnavailable,
  freshTakenOverOrder,
  stripPendingKeys,
  validLevel,
  validateExternalKey,
  type ConversationGuardToken,
  type ConversationRecord,
  type ConversationStore,
  type RowReservation,
  type ServiceBindings,
} from "../storage";
import { TreeLifecycleBusy, type TreeLifecycle } from "../lifecycle";
import {
  KeyError,
  ValueError,
  type AgentNode,
  type NodeStore,
} from "../runtime/agent_node";
import type { AgentNodes } from "../runtime/agent_nodes";
import type { ConfigActions } from "../runtime/config_actions";
import type { WorktreeHolders } from "../worktree_holders";

const SERVICE_CREATE_BUSY_RETRIES = 20;
const SERVICE_CREATE_BUSY_RETRY_DELAY_SECONDS = 0.05;

const THINKING_VALUES: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** workdir_git.default_spawn_workdir, cached for the synchronous hooks. */
export class SpawnWorkdir {
  constructor(
    private value: string,
    private readonly compute: () => Promise<string>,
  ) {}
  current(): string {
    return this.value;
  }
  async refresh(): Promise<string> {
    this.value = await this.compute();
    return this.value;
  }
}

export interface CreateDeps {
  worktrees?: Pick<WorktreeHolders, "hold" | "release">;
  conversations: Pick<
    ConversationStore,
    | "convRowExists"
    | "discardConvProjection"
    | "discardUnpublished"
    | "reserveNewRow"
    | "projectionReady"
    | "load"
    | "save"
    | "newConversationId"
    | "effectiveWorkdir"
    | "withTitleGuard"
    | "loadCanonicalMetadata"
    | "updateSessionBinding"
    | "allConvs"
  >;
  configActions: Pick<
    ConfigActions,
    "withMuteGuard" | "withConfigurationMetadataGuard" | "requestMute"
  >;
  serviceBindings: Pick<
    ServiceBindings,
    | "lookupExternalKey"
    | "serviceOwnedConversationCount"
    | "bindServiceConversation"
    | "bindExternalKey"
    | "unbindExternalKey"
    | "unbindServiceConversation"
  >;
  nodes: Pick<
    AgentNodes<AgentNode, NodeStore>,
    "existing" | "node" | "dropNode" | "retiring"
  >;
  lifecycle: Pick<TreeLifecycle, "guard" | "guardAsync">;
  config: Pick<Config, "models" | "levels">;
  /** store_import.import_finalized(). */
  importFinalized(): boolean | null;
  spawnWorkdir: SpawnWorkdir;
  drafts: {
    claimAttachmentDraft(token: unknown, cid: string): Promise<void>;
    transferAttachmentDraft(
      token: unknown,
      conv: ConversationRecord,
      titleToken?: ConversationGuardToken,
    ): Promise<void>;
  };
  agentTemp: {
    safeRemoveTempKey(key: string): Promise<boolean>;
    newAgentTempKey(cid: string): Promise<string>;
    ensureAgentTemp(
      conv: ConversationRecord,
      options?: { persist?: boolean },
    ): Promise<string>;
  };
  /** agent_tree._bump_tree_topology. */
  bumpTreeTopology(): void;
  log: RuntimeLogger;
  rollbackLog?: RuntimeLogger;
  /** Notes wait for the next turn unless startTurn asks to wake the agent. */
  deliverPlatformNote(
    cid: string,
    content: string,
    options?: { startTurn?: boolean },
  ): Promise<string | null>;
  /** time.time(), seconds. */
  now(): number;
  /** Abortable sleep in seconds. */
  sleep(seconds: number, signal: AbortSignal): Promise<void>;
  /** Joins create transactions at shutdown. */
  tasks: TaskSet;
  /** conversation_store.freshTakenOverOrder. */
  freshTakenOverOrder?: () => string;
}

export interface CreateOptions {
  cid?: string | null;
  title?: string | null;
  parent?: string | null;
  model?: string | null;
  /** Only HTTP authentication may authorize a raw file-endpoint selection. */
  operatorSelectedModel?: boolean;
  /** undefined inherits; null or "" records the default. */
  workdir?: string | null;
  attachmentDraft?: string | null;
  muted?: boolean;
  /** Validated operator tags, saved before the conversation is published. */
  tags?: Tags;
  takenOver?: boolean;
  spawnRequestId?: string | null;
  effort?: string | null;
  level?: number | null;
  /** The archive id a revive restored (src/agents/supervisor/revive.ts). */
  revivedFrom?: string | null;
  /** Read-only fork of `parent`, hidden from the tree. */
  side?: boolean;
}

interface ServiceCreateOptions {
  title: string | null;
  servicePrincipal: string;
  externalKey: string | null;
  allowedModels: readonly string[] | null;
  ownedLimit: number | null;
}

interface ServiceAttempt {
  cid: string;
  principal: string;
  externalKey: string | null;
  workdir: string;
  /** The attempt's temp key, recorded in the bindings it writes. */
  token: string;
  /** The stamp of the worktree hold it took, if any. */
  hold: number | null;
  row: RowReservation | null;
}

interface ServiceCreateResult {
  conversation: ConversationRecord;
  created: boolean;
}

export class ServiceCreateRefusal extends Error {
  constructor(
    readonly reason: "quota_exceeded" | "service_storage_unavailable",
  ) {
    super(reason);
  }
}

type Selection = [number | null, string, string];

const NEVER = new AbortController().signal;

function fullmatch(re: RegExp, value: unknown): value is string {
  return typeof value === "string" && re.test(value);
}

export class SupervisorCreate {
  constructor(private readonly deps: CreateDeps) {}

  async create(
    options: CreateOptions = {},
    signal?: AbortSignal,
  ): Promise<ConversationRecord> {
    const cid = options.cid || this.deps.conversations.newConversationId();
    const work = this.createTransaction(cid, options, null);
    return (await this.waitForCreate(cid, work, signal)).conversation;
  }

  /** A principal-scoped service conversation, converging same-key racers. */
  async createOrRejoinServiceConversation(
    options: ServiceCreateOptions,
    signal?: AbortSignal,
  ): Promise<ServiceCreateResult> {
    const cid = this.deps.conversations.newConversationId();
    return this.waitForCreate(
      cid,
      this.createServiceWithRetry(cid, options),
      signal,
    );
  }

  private async createTransaction(
    cid: string,
    options: CreateOptions,
    service: ServiceCreateOptions | null,
  ): Promise<ServiceCreateResult> {
    const { conversations } = this.deps;
    if (!fullmatch(CID_RE, cid)) throw new ValueError("unsafe conversation id");
    if (
      this.deps.importFinalized() === false ||
      !conversations.projectionReady()
    )
      throw new Error(
        "startup import incomplete; creates refused until it completes",
      );
    try {
      return await this.deps.lifecycle.guardAsync(
        "create",
        cid,
        () => this.createLocked(cid, options, service),
        undefined,
        { timeoutSeconds: 3 },
      );
    } finally {
      this.deps.bumpTreeTopology();
    }
  }

  private waitForCreate(
    cid: string,
    work: Promise<ServiceCreateResult>,
    signal?: AbortSignal,
  ): Promise<ServiceCreateResult> {
    // Invariant: The shutdown join owns the transaction even when its caller
    // left; the caller sees its errors.
    void this.deps.tasks.spawn(`create:${cid}`, () =>
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    // Invariant: CR1: the caller's wait is abortable; the transaction is not.
    return signal ? abortable(work, signal) : work;
  }

  private async createServiceWithRetry(
    cid: string,
    options: ServiceCreateOptions,
  ): Promise<ServiceCreateResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        // Service callers cannot supply a parent or agent ID.
        return await this.createTransaction(
          cid,
          { title: options.title },
          options,
        );
      } catch (error) {
        if (error instanceof TreeLifecycleBusy) {
          if (attempt <= SERVICE_CREATE_BUSY_RETRIES) {
            await this.deps.sleep(
              SERVICE_CREATE_BUSY_RETRY_DELAY_SECONDS,
              NEVER,
            );
            continue;
          }
          logEvent(this.deps.log, WARNING, "service_create_busy", {
            fields: { attempts: attempt },
          });
        }
        if (
          error instanceof ServiceStorageUnavailable ||
          (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            /^E[A-Z]+$/.test(error.code))
        )
          throw new ServiceCreateRefusal("service_storage_unavailable");
        throw error;
      }
    }
  }

  private thinking(effort: unknown): string {
    if (typeof effort === "string" && THINKING_VALUES.has(effort))
      return effort;
    throw new ValueError("not a Thinking value");
  }

  private pinLegacy(modelId: string, want: string | null): Selection {
    return [
      null,
      modelId,
      want !== null ? want : this.deps.config.models.chatSettings(modelId)[1],
    ];
  }

  private inheritModelId(parent: ConversationRecord | null): string | null {
    const parentModel = (parent ?? {}).model;
    if (!parentModel) return null;
    try {
      const model = this.deps.config.models.chatModel(parentModel as string).id;
      return this.deps.config.models.isFileProviderModel(model) ? null : model;
    } catch (error) {
      if ((error as Error)?.name === "ValueError") return null;
      throw error;
    }
  }

  /** The (level, model, reasoning) one create runs with. */
  selectCreateModel(
    model: string | null,
    effort: string | null,
    level: number | null,
    parentConv: ConversationRecord | null,
    operatorSelectedModel = false,
  ): Selection {
    const { config } = this.deps;
    if (level !== null && model !== null)
      throw new ValueError("conflicting model and effort level; pass only one");
    if (level !== null) {
      if (validLevel(level) === null)
        throw new ValueError(`unsupported effort level: ${pyRepr(level)}`);
      const [m, r] = config.levels.resolveEffortLevel(level);
      return [level, m, r];
    }
    let want: string | null = null;
    if (effort !== null) {
      try {
        want = this.thinking(effort);
      } catch {
        throw new ValueError(`unsupported reasoning effort: ${pyRepr(effort)}`);
      }
    }
    if (model !== null) {
      if (config.models.isFileProviderModel(model) && !operatorSelectedModel)
        throw new ValueError(
          "unsupported raw file-defined model selection; choose an effort level saved in Settings",
        );
      const selected = config.models.chatModel(model).id;
      const home = config.levels.ladderHome(selected, want);
      if (home === null) return this.pinLegacy(selected, want);
      return home;
    }
    const parentLevel = validLevel((parentConv ?? {}).level);
    const inherit = this.inheritModelId(parentConv);
    if (parentLevel === null && parentConv !== null && inherit !== null) {
      if (want !== null) return [null, inherit, want];
      let reasoning: string;
      try {
        reasoning = this.thinking(parentConv.effort);
      } catch {
        reasoning = config.models.chatSettings(inherit)[1];
      }
      return [null, inherit, reasoning];
    }
    if (parentLevel !== null && want === null) {
      const [m, r] = config.levels.resolveEffortLevel(parentLevel);
      return [parentLevel, m, r];
    }
    const home = config.levels.ladderHome(inherit, want);
    if (home !== null) return home;
    if (inherit !== null) return this.pinLegacy(inherit, want);
    const [m, r] = config.levels.resolveEffortLevel(
      config.levels.defaultEffortLevel(),
    );
    return [config.levels.defaultEffortLevel(), m, r];
  }

  private async createLocked(
    cid: string,
    o: CreateOptions,
    service: ServiceCreateOptions | null,
  ): Promise<ServiceCreateResult> {
    const { conversations, nodes, serviceBindings } = this.deps;
    let externalKey: string | null;
    try {
      externalKey = validateExternalKey(service?.externalKey ?? null);
    } catch (error) {
      throw new ValueError((error as Error).message);
    }
    const principal = service?.servicePrincipal ?? null;
    if (service !== null) {
      if (typeof principal !== "string" || !principal)
        throw new ValueError("invalid service principal");
      const existing =
        externalKey &&
        (await serviceBindings.lookupExternalKey(principal, externalKey));
      if (existing) return { conversation: existing, created: false };
      const limit = service.ownedLimit;
      if (
        limit !== null &&
        (await serviceBindings.serviceOwnedConversationCount(principal)) >=
          limit
      )
        throw new ServiceCreateRefusal("quota_exceeded");
    }
    const parent = o.parent ?? null;
    const parentConv = parent ? conversations.load(parent) : null;
    if (parent !== null && parentConv === null)
      throw new ValueError("parent conversation not found");
    if (parentConv && parentConv.reap_deferred)
      throw new ValueError("parent deletion is pending");
    if (parent !== null && nodes.retiring(parent))
      throw new ValueError("parent deletion is pending");
    const muted = o.takenOver || (parent !== null && (o.muted ?? false));
    if (!fullmatch(CID_RE, cid)) throw new ValueError("unsafe conversation id");
    const spawnRequestId = o.spawnRequestId ?? null;
    const live = conversations.load(cid);
    if (live !== null) {
      if (spawnRequestId !== null && live.spawn_request_id === spawnRequestId) {
        nodes.node(cid);
        return { conversation: live, created: false };
      }
      throw new ValueError("conversation id already exists");
    }
    const [level, selectedModel, selectedEffort] = this.selectCreateModel(
      o.model ?? null,
      o.effort ?? null,
      o.level ?? null,
      parentConv,
      o.operatorSelectedModel === true,
    );
    if (
      service?.allowedModels != null &&
      !service.allowedModels.includes(selectedModel)
    )
      throw new ValueError("model_not_allowed");
    let workdir: string;
    if (o.workdir === undefined) {
      if (parentConv !== null) {
        // Invariant: effectiveWorkdir falls back to the cached spawn default
        // for a workdir-less parent: refresh first so Git is asked fresh.
        if (!parentConv.workdir) await this.deps.spawnWorkdir.refresh();
        workdir = conversations.effectiveWorkdir(parentConv);
      } else workdir = await this.deps.spawnWorkdir.refresh();
    } else if (!o.workdir) {
      workdir = await this.deps.spawnWorkdir.refresh();
    } else {
      workdir = String(o.workdir);
    }
    // Invariant: Validate before creating the node or claiming its managed
    // worktree, so a refusal leaks neither.
    if (spawnRequestId !== null && !fullmatch(CID_RE, spawnRequestId))
      throw new ValueError("unsafe spawn request id");
    const conv: ConversationRecord = {
      id: cid,
      title: o.title ?? null,
      parent,
      backend: "durable",
      model: selectedModel,
      effort: selectedEffort,
      workdir,
      tmp_key: await this.deps.agentTemp.newAgentTempKey(cid),
      session_id: null,
      msg_count: 0,
      last: null,
      draft: null,
      latest_context_usage: null,
      status: "idle",
      muted: !!muted,
      taken_over: !!o.takenOver,
      updated: this.deps.now(),
      created: this.deps.now(),
    };
    if (o.tags) conv.tags = o.tags;
    if (conv.taken_over)
      conv.taken_over_order = (
        this.deps.freshTakenOverOrder ?? freshTakenOverOrder
      )();
    if (level !== null) conv.level = level;
    if (externalKey) conv.external_key = externalKey;
    if (principal !== null) conv.service_principal = principal;
    if (o.attachmentDraft) conv.attachment_draft = o.attachmentDraft;
    if (parent) {
      conv.origin_id = parent;
      conv.origin_kind = "parent";
    }
    if (spawnRequestId !== null) conv.spawn_request_id = spawnRequestId;
    if (o.revivedFrom) conv.revived_from = o.revivedFrom;
    if (o.side) {
      if (!parent) throw new ValueError("a side conversation needs a parent");
      conv.side_of = parent;
    }
    if (principal !== null)
      return this.createServiceLocked(conv, principal, externalKey, workdir);
    nodes.node(cid);
    try {
      await this.deps.worktrees?.hold(workdir, cid);
    } catch (error) {
      nodes.dropNode(cid);
      throw new ValueError((error as Error).message);
    }
    return conversations.withTitleGuard(cid, (titleToken) =>
      this.deps.configActions.withMuteGuard(
        cid,
        async (_muteToken, nodeToken) => {
          try {
            const draftClaim = conv.attachment_draft;
            if (draftClaim)
              await this.deps.drafts.claimAttachmentDraft(draftClaim, cid);
            this.deps.configActions.requestMute(conv, !!conv.muted, nodeToken);
            try {
              await conversations.save(conv, titleToken);
            } catch (error) {
              await this.rollbackConversation(conv);
              throw error;
            }
            if (draftClaim)
              await this.deps.drafts.transferAttachmentDraft(
                draftClaim,
                conv,
                titleToken,
              );
            else
              await this.deps.agentTemp.ensureAgentTemp(conv, {
                persist: false,
              });
            conv.pending = [];
            return { conversation: conv, created: true };
          } catch (error) {
            if (conversations.load(cid, { withPending: false }) === null)
              nodes.dropNode(cid);
            throw error;
          }
        },
      ),
    );
  }

  // Invariant: a service attempt binds before its row exists and publishes the
  // row only once committed, so no reader sees an unbound or losable row. Its
  // bindings carry its temp key, so rollback removes only what it wrote.
  private async createServiceLocked(
    conv: ConversationRecord,
    principal: string,
    externalKey: string | null,
    workdir: string,
  ): Promise<ServiceCreateResult> {
    const { conversations, nodes, serviceBindings } = this.deps;
    const cid = String(conv.id);
    const attempt: ServiceAttempt = {
      cid,
      principal,
      externalKey,
      workdir,
      token: String(conv.tmp_key),
      hold: null,
      row: null,
    };
    nodes.node(cid);
    try {
      try {
        attempt.hold = (await this.deps.worktrees?.hold(workdir, cid)) ?? null;
      } catch (error) {
        throw new ValueError((error as Error).message);
      }
      return await conversations.withTitleGuard(cid, (titleToken) =>
        this.deps.configActions.withMuteGuard(cid, async () => {
          nodes.node(cid).muteDesired = conv.muted ? true : null;
          await this.deps.agentTemp.ensureAgentTemp(conv, { persist: false });
          attempt.row = await conversations.reserveNewRow(cid);
          if (attempt.row === null)
            throw new ServiceCreateRefusal("service_storage_unavailable");
          await serviceBindings.bindServiceConversation(
            principal,
            cid,
            attempt.token,
          );
          if (externalKey) {
            try {
              await serviceBindings.bindExternalKey(
                principal,
                externalKey,
                cid,
                attempt.token,
              );
            } catch (error) {
              if (!(error instanceof ExternalKeyConflict)) throw error;
              const winner = await serviceBindings.lookupExternalKey(
                principal,
                externalKey,
              );
              if (winner === null) throw error;
              return { conversation: winner, created: false };
            }
          }
          await conversations.save(conv, titleToken, attempt.row);
          if (!conversations.convRowExists(cid))
            throw new ServiceCreateRefusal("service_storage_unavailable");
          conv.pending = [];
          return { conversation: conv, created: true };
        }),
      );
    } finally {
      if (!conversations.convRowExists(cid)) {
        await this.rollbackServiceAttempt(attempt);
        nodes.dropNode(cid);
      }
    }
  }

  private async rollbackConversation(conv: ConversationRecord): Promise<void> {
    const { conversations, serviceBindings, agentTemp, nodes } = this.deps;
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
        logEvent(
          this.deps.rollbackLog ?? this.deps.log,
          WARNING,
          "service_conversation_rollback_failed",
          {
            conversation_id: cid,
            fields: {
              step,
              error_type:
                error instanceof Error ? error.constructor.name : "unknown",
            },
          },
        );
      }
    };
    conversations.discardConvProjection(cid);
    await cleanup("service_binding", () =>
      serviceBindings.unbindServiceConversation(cid),
    );
    const { external_key: key, service_principal: principal } = conv;
    if (typeof key === "string" && typeof principal === "string")
      await cleanup("external_key", () =>
        serviceBindings.unbindExternalKey(principal, key, cid),
      );
    await cleanup("temp", async () => {
      if (!(await agentTemp.safeRemoveTempKey(String(conv.tmp_key || ""))))
        throw new Error("temp cleanup incomplete");
    });
    nodes.dropNode(cid);
  }

  // Undo an unpublished attempt under its own lease. Bindings, scratch and the
  // hold go only once its row is known gone, and only what this attempt wrote.
  private async rollbackServiceAttempt(attempt: ServiceAttempt): Promise<void> {
    const { cid, principal, externalKey, token, row, hold } = attempt;
    const { conversations, serviceBindings, agentTemp, worktrees } = this.deps;
    if (
      row !== null &&
      !(await this.cleanupStep(cid, "row", async () => {
        if (!(await conversations.discardUnpublished(row)))
          throw new Error("row files not retired");
      }))
    )
      return;
    if (externalKey !== null)
      await this.cleanupStep(cid, "external_key", () =>
        serviceBindings.unbindExternalKey(principal, externalKey, cid, token),
      );
    await this.cleanupStep(cid, "service_binding", () =>
      serviceBindings.unbindServiceConversation(cid, {
        principal,
        createToken: token,
      }),
    );
    await this.cleanupStep(cid, "temp", async () => {
      if (!(await agentTemp.safeRemoveTempKey(token)))
        throw new Error("temp cleanup incomplete");
    });
    if (hold !== null && worktrees)
      await this.cleanupStep(cid, "worktree", () =>
        worktrees.release(attempt.workdir, cid, hold),
      );
  }

  private async cleanupStep(
    cid: string,
    step: string,
    action: () => void | Promise<void>,
  ): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      logEvent(
        this.deps.rollbackLog ?? this.deps.log,
        WARNING,
        "service_conversation_rollback_failed",
        {
          conversation_id: cid,
          fields: {
            step,
            error_type:
              error instanceof Error ? error.constructor.name : "unknown",
          },
        },
      );
      return false;
    }
  }

  /** Set the operator Take-over flag and mute; notify on control changes. */
  async setTakenOver(
    cid: string,
    takenOver: boolean,
  ): Promise<ConversationRecord> {
    const { conversations, nodes } = this.deps;
    return this.deps.lifecycle.guard(
      "set_taken_over",
      cid,
      () =>
        this.deps.configActions.withConfigurationMetadataGuard(
          cid,
          async (titleToken, _muteToken, nodeToken) => {
            const conv = conversations.load(cid);
            if (conv === null) throw new KeyError(cid);
            const controlChanged = !!conv.taken_over !== takenOver;
            conv.taken_over = takenOver;
            conv.muted = takenOver;
            conv.taken_over_order = (
              this.deps.freshTakenOverOrder ?? freshTakenOverOrder
            )();
            conv.updated = this.deps.now();
            this.deps.configActions.requestMute(conv, takenOver, nodeToken);
            await conversations.save(conv, titleToken);
            if (controlChanged) this.notifyControlChange(cid, conv);
            const found = nodes.existing(cid);
            const inbox = found !== null ? found.inboxMessages() : [];
            conv.pending = inbox.map((m) => stripPendingKeys(m));
            return conv;
          },
        ),
      { nonblocking: false },
    );
  }

  private notifyControlChange(heldId: string, conv: ConversationRecord): void {
    const agent = `${conv.title || heldId} (${heldId})`;
    const content = conv.taken_over
      ? `User has taken control of ${agent}; do not message it.`
      : `User has returned control of ${agent}; you can message it again.`;
    const recipients = new Set([heldId]);
    if (typeof conv.parent === "string" && conv.parent)
      recipients.add(conv.parent);
    // Invariant: a return of control starts a parent turn so it can direct the
    // child; every other control note waits for the recipient's next turn.
    for (const cid of recipients) {
      const startTurn = !conv.taken_over && cid !== heldId;
      this.deps.tasks.spawn("control_note", async () => {
        try {
          if (
            (await this.deps.deliverPlatformNote(cid, content, {
              startTurn,
            })) === null
          )
            throw new Error("recipient refused control-change note");
        } catch (error) {
          logEvent(this.deps.log, WARNING, "control_note_failed", {
            conversation_id: cid,
            fields: { held_agent: heldId, error: String(error) },
          });
        }
      });
    }
  }
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}
