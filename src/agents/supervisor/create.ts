// Create validates/reserves/claims/publishes under one lifecycle lease.
// Transactions drain despite cancellation; shutdown joins their TaskSet.
// Refresh spawn-workdir before create; bindings retain read-only legacy state.
// DurableHost owns Harness admission; cancellation bypasses failure cleanup.

import type { Config } from "../../config";
import {
  WARNING,
  logEvent,
  type RuntimeLogger,
} from "../../observability/runtime_logging";
import { abortable, checkAbort, type TaskSet } from "../../utils/tasks";
import {
  CID_RE,
  freshPinnedOrder,
  stripPendingKeys,
  validLevel,
  validateExternalKey,
  type ConversationGuardToken,
  type ConversationRecord,
  type ConversationStore,
  type ConversationStoreHooks,
} from "../conversation_store";
import { TreeLifecycleBusy, type TreeLifecycle } from "../mutation_guard";
import {
  KeyError,
  ValueError,
  type AgentNode,
  type NodeStore,
} from "../runtime/agent_node";
import type { AgentNodes } from "../runtime/agent_nodes";
import type { SessionBinding as PiBinding } from "../runtime/pi/session";
import type { ConfigActions } from "../runtime/config_actions";

export const SERVICE_CREATE_BUSY_RETRIES = 20;
export const SERVICE_CREATE_BUSY_RETRY_DELAY_SECONDS = 0.05;

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
  worktrees?: { hold(workdir: string, cid: string): Promise<void> };
  conversations: Pick<
    ConversationStore,
    | "convRowExists"
    | "projectionReady"
    | "load"
    | "save"
    | "newConversationId"
    | "lookupExternalKey"
    | "rollbackServiceConversation"
    | "effectiveWorkdir"
    | "withTitleGuard"
    | "withMuteGuard"
    | "withConfigurationMetadataGuard"
    | "loadCanonicalMetadata"
    | "updateSessionBinding"
    | "invalidateContextUsage"
    | "allConvs"
  >;
  nodes: Pick<
    AgentNodes<AgentNode, NodeStore>,
    "existing" | "node" | "dropNode" | "retiring"
  >;
  lifecycle: Pick<
    TreeLifecycle,
    "guard" | "guardAsync" | "mutateExternalStorage"
  >;
  config: Pick<
    Config,
    | "chatModel"
    | "chatSettings"
    | "resolveEffortLevel"
    | "ladderHome"
    | "defaultEffortLevel"
  >;
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
    newAgentTempKey(cid: string): Promise<string>;
    ensureAgentTemp(
      conv: ConversationRecord,
      options?: { persist?: boolean },
    ): Promise<string>;
  };
  /** agent_tree._bump_tree_topology. */
  bumpTreeTopology(): void;
  log: RuntimeLogger;
  deliverPlatformNote(cid: string, content: string): Promise<string | null>;
  /** time.time(), seconds. */
  now(): number;
  /** Abortable sleep in seconds. */
  sleep(seconds: number, signal: AbortSignal): Promise<void>;
  /** Joins create transactions at shutdown. */
  tasks: TaskSet;
  /** conversation_store._fresh_pinned_order. */
  freshPinnedOrder?: () => string;
}

export interface CreateOptions {
  cid?: string | null;
  title?: string | null;
  parent?: string | null;
  model?: string | null;
  /** undefined inherits; null or "" records the default. */
  workdir?: string | null;
  attachmentDraft?: string | null;
  muted?: boolean;
  pinned?: boolean;
  takenOver?: boolean;
  spawnRequestId?: string | null;
  externalKey?: string | null;
  servicePrincipal?: string | null;
  allowedModels?: readonly string[] | null;
  externalKeyChecked?: boolean;
  effort?: string | null;
  level?: number | null;
  /** The archive id a revive restored (src/agents/supervisor/revive.ts). */
  revivedFrom?: string | null;
  /** Read-only fork of `parent`, hidden from the tree. */
  side?: boolean;
}

type Selection = [number | null, string, string];

const NEVER = new AbortController().signal;

function fullmatch(re: RegExp, value: unknown): value is string {
  return typeof value === "string" && re.test(value);
}

export interface BindingRuntime {
  RuntimeError: new (message: string, options?: ErrorOptions) => Error;
  binding(sessionId: string, sessionFile: string, cwd: string): PiBinding;
}

/** pi/process sameBinding: value equality of the frozen triple. */
export function sameBinding(
  a: PiBinding | null | undefined,
  b: PiBinding | null | undefined,
): boolean {
  if (!a || !b) return a == b;
  return (
    a.sessionId === b.sessionId &&
    a.sessionFile === b.sessionFile &&
    a.cwd === b.cwd
  );
}

// conversation's recorded (id, file, cwd), null when unset; throws when
// partial.
export function recordBinding(
  rt: BindingRuntime,
  conv: ConversationRecord,
): PiBinding | null {
  const id = conv.session_id ?? null;
  const file = conv.session_file ?? null;
  const cwd = conv.session_cwd ?? null;
  if (id === null && file === null && cwd === null) return null;
  if (
    typeof id !== "string" ||
    !id ||
    typeof file !== "string" ||
    !file ||
    typeof cwd !== "string" ||
    !cwd
  )
    throw new rt.RuntimeError(
      "conversation has an incomplete Pi session binding",
    );
  return rt.binding(id, file, cwd);
}

/** Whether the projection still carries the adopted triple; never throws. */
export function projectionMatches(
  rt: BindingRuntime,
  conv: ConversationRecord | null,
  recorded: PiBinding,
): boolean {
  try {
    return sameBinding(recordBinding(rt, conv ?? {}), recorded);
  } catch (error) {
    if (error instanceof rt.RuntimeError) return false;
    throw error;
  }
}

/** The store hooks this PR closes. */
export function createStoreHooks(
  configActions: Pick<ConfigActions, "withModelGuard">,
  spawnWorkdir: SpawnWorkdir,
): Pick<ConversationStoreHooks, "defaultSpawnWorkdir" | "withModelGuard"> {
  return {
    defaultSpawnWorkdir: () => spawnWorkdir.current(),
    withModelGuard: (cid, fn, nodeToken) =>
      configActions.withModelGuard(cid, fn, nodeToken),
  };
}

export class SupervisorCreate {
  constructor(private readonly deps: CreateDeps) {}

  // Create under a lifecycle lease; published spawn/external-key retries
  // return the already live record without duplicating creation.
  async create(
    options: CreateOptions = {},
    signal?: AbortSignal,
  ): Promise<ConversationRecord> {
    const { conversations } = this.deps;
    const cid = options.cid || conversations.newConversationId();
    if (!fullmatch(CID_RE, cid)) throw new ValueError("unsafe conversation id");
    if (
      this.deps.importFinalized() === false ||
      !conversations.projectionReady()
    )
      throw new Error(
        "startup import incomplete; creates refused until it completes",
      );
    const work = (async () => {
      try {
        return await this.deps.lifecycle.guardAsync(
          "create",
          cid,
          () => this.createLocked(cid, options),
          undefined,
          { timeoutSeconds: 3 },
        );
      } finally {
        this.deps.bumpTreeTopology();
      }
    })();
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

  /** A principal-scoped service conversation, converging same-key racers. */
  async createOrRejoinServiceConversation(
    options: {
      title?: string | null;
      servicePrincipal: string;
      externalKey: string | null;
      allowedModels?: readonly string[] | null;
    },
    signal: AbortSignal = NEVER,
  ): Promise<ConversationRecord> {
    const rejoinServiceCreate = async (principal: string, key: string) => {
      const current = await this.deps.conversations.lookupExternalKey(
        principal,
        key,
      );
      if (current !== null) current._external_key_created = false;
      return current;
    };
    let busyAttempts = 0;
    for (;;) {
      try {
        return await this.create(
          {
            title: options.title ?? null,
            parent: null,
            muted: false,
            attachmentDraft: null,
            servicePrincipal: options.servicePrincipal,
            externalKey: options.externalKey,
            allowedModels: options.allowedModels ?? null,
          },
          signal,
        );
      } catch (error) {
        if (!(error instanceof TreeLifecycleBusy)) throw error;
        busyAttempts += 1;
        if (busyAttempts > SERVICE_CREATE_BUSY_RETRIES) {
          logEvent(this.deps.log, WARNING, "service_create_busy", {
            fields: { attempts: busyAttempts },
          });
          throw error;
        }
        if (options.externalKey) {
          const rejoined = await this.deps.lifecycle.mutateExternalStorage(
            rejoinServiceCreate,
            [options.servicePrincipal, options.externalKey],
          );
          checkAbort(signal);
          if (rejoined !== null) return rejoined;
        }
        await this.deps.sleep(SERVICE_CREATE_BUSY_RETRY_DELAY_SECONDS, signal);
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
      want !== null ? want : this.deps.config.chatSettings(modelId)[1],
    ];
  }

  private inheritModelId(parent: ConversationRecord | null): string | null {
    const parentModel = (parent ?? {}).model;
    if (!parentModel) return null;
    try {
      return this.deps.config.chatModel(parentModel as string).id;
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
  ): Selection {
    const { config } = this.deps;
    if (level !== null && model !== null)
      throw new ValueError("conflicting model and effort level; pass only one");
    if (level !== null) {
      if (validLevel(level) === null)
        throw new ValueError(`unsupported effort level: ${pyRepr(level)}`);
      const [m, r] = config.resolveEffortLevel(level);
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
      const selected = config.chatModel(model).id;
      const home = config.ladderHome(selected, want);
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
        reasoning = config.chatSettings(inherit)[1];
      }
      return [null, inherit, reasoning];
    }
    if (parentLevel !== null && want === null) {
      const [m, r] = config.resolveEffortLevel(parentLevel);
      return [parentLevel, m, r];
    }
    const home = config.ladderHome(inherit, want);
    if (home !== null) return home;
    if (inherit !== null) return this.pinLegacy(inherit, want);
    const [m, r] = config.resolveEffortLevel(config.defaultEffortLevel());
    return [config.defaultEffortLevel(), m, r];
  }

  private async createLocked(
    cidArg: string,
    o: CreateOptions,
  ): Promise<ConversationRecord> {
    const { conversations, nodes } = this.deps;
    let cid = cidArg;
    let externalKey: string | null;
    try {
      externalKey = validateExternalKey(o.externalKey ?? null);
    } catch (error) {
      throw new ValueError((error as Error).message);
    }
    const principal = o.servicePrincipal ?? null;
    if (principal !== null && (typeof principal !== "string" || !principal))
      throw new ValueError("invalid service principal");
    if (externalKey && principal === null)
      throw new ValueError("external_key requires a service principal");
    if (externalKey && !o.externalKeyChecked) {
      const existing = await conversations.lookupExternalKey(
        principal!,
        externalKey,
      );
      if (existing !== null) {
        const found = existing.id;
        cid = typeof found === "string" && found ? found : cid;
        const fresh = conversations.load(cid);
        if (fresh === null) throw new ValueError("conversation was deleted");
        nodes.node(cid);
        fresh._external_key_created = false;
        return fresh;
      }
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
        return live;
      }
      throw new ValueError("conversation id already exists");
    }
    const [level, selectedModel, selectedEffort] = this.selectCreateModel(
      o.model ?? null,
      o.effort ?? null,
      o.level ?? null,
      parentConv,
    );
    if (o.allowedModels != null && !o.allowedModels.includes(selectedModel))
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
    nodes.node(cid);
    try {
      await this.deps.worktrees?.hold(workdir, cid);
    } catch (error) {
      nodes.dropNode(cid);
      throw new ValueError((error as Error).message);
    }
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
      pinned: !!(o.takenOver || o.pinned),
      updated: this.deps.now(),
      created: this.deps.now(),
    };
    if (conv.pinned)
      conv.pinned_order = (this.deps.freshPinnedOrder ?? freshPinnedOrder)();
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
    return conversations.withTitleGuard(cid, (titleToken) =>
      conversations.withMuteGuard(cid, async () => {
        try {
          const draftClaim = conv.attachment_draft;
          if (draftClaim)
            await this.deps.drafts.claimAttachmentDraft(draftClaim, cid);
          nodes.node(cid).muteDesired = conv.muted ? true : null;
          try {
            await conversations.save(conv, titleToken);
          } catch (error) {
            await conversations.rollbackServiceConversation(conv);
            throw error;
          }
          if (draftClaim)
            await this.deps.drafts.transferAttachmentDraft(
              draftClaim,
              conv,
              titleToken,
            );
          else
            await this.deps.agentTemp.ensureAgentTemp(conv, { persist: false });
          conv.pending = [];
          if (conv.external_key) conv._external_key_created = true;
          return conv;
        } catch (error) {
          if (conversations.load(cid, { withPending: false }) === null)
            nodes.dropNode(cid);
          throw error;
        }
      }),
    );
  }

  /** Set the operator Take-over flag (pin and mute together). */
  async setPinned(cid: string, pinned: boolean): Promise<ConversationRecord> {
    const { conversations, nodes } = this.deps;
    return this.deps.lifecycle.guard(
      "set_pinned",
      cid,
      () =>
        conversations.withConfigurationMetadataGuard(
          cid,
          async (titleToken) => {
            const conv = conversations.load(cid);
            if (conv === null) throw new KeyError(cid);
            const takenOver = pinned && !conv.pinned;
            conv.pinned = !!pinned;
            conv.muted = !!pinned;
            conv.pinned_order = (
              this.deps.freshPinnedOrder ?? freshPinnedOrder
            )();
            conv.updated = this.deps.now();
            nodes.node(cid).muteDesired =
              conv.status === "running" ? !!pinned : null;
            await conversations.save(conv, titleToken);
            if (takenOver) this.notifyTakeover(cid, conv);
            const found = nodes.existing(cid);
            const inbox = found !== null ? found.inboxMessages() : [];
            conv.pending = inbox.map((m) => stripPendingKeys(m));
            return conv;
          },
        ),
      { nonblocking: false },
    );
  }

  private notifyTakeover(heldId: string, conv: ConversationRecord): void {
    const content = `User has taken control of the agent, do not message ${conv.title || heldId} (${heldId}).`;
    const recipients = new Set([heldId]);
    if (typeof conv.parent === "string" && conv.parent)
      recipients.add(conv.parent);
    for (const cid of recipients) {
      this.deps.tasks.spawn("takeover_note", async () => {
        try {
          if ((await this.deps.deliverPlatformNote(cid, content)) === null)
            throw new Error("recipient refused take-over note");
        } catch (error) {
          logEvent(this.deps.log, WARNING, "takeover_note_failed", {
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
