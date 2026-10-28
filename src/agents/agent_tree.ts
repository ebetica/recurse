// Tree moves and parked spawn/clear/compact drains hold lifecycle leases.
// Reap revalidates topology/subtree; retries use per-slot backoff.
// Explicit abort points bypass failure catches; interrupted receipts survive.
// Retried delivery may repeat notices, never lose them.
import { lstat, open, opendir, stat, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { EFFORT_MAX_LEVEL, EFFORT_MIN_LEVEL, type Config } from "../config";
import {
  ERROR,
  WARNING,
  logEvent,
  logException,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { cleanTitle } from "../title_text";
import { Cancelled, checkAbort } from "../utils/tasks";
import { retireWithinParent } from "../utils/trash";
import { AgentClosed, MailboxFull, type AgentStore } from "./agent_store";
import type { ActionRequest, ParkedActions } from "./compaction";
import {
  CID_RE,
  validLevel,
  type ConversationRecord,
  type ConversationStore,
} from "./conversation_store";
import { TreeLifecycleBusy, type TreeLifecycle } from "./mutation_guard";
import { RetrySchedule } from "./retry_schedule";
import type { AgentNode, NodeStore } from "./runtime/agent_node";
import type { AgentNodes } from "./runtime/agent_nodes";
import type { DurableHost } from "./durable/host";
import type { Prompts } from "./runtime/prompts";
import type { CreateOptions } from "./supervisor/create";
import type { DeliverOptions } from "./supervisor/delivery";

export const SPAWN_NOTICE_DELAY = 6.0;
export const SPAWN_REQUEST_MAX_ROWS = 256;
export const SPAWN_REQUEST_MAX_BYTES = 1024 * 1024;
export const SPAWN_OUTCOME_MAX_ROWS = 256;
export const SPAWN_OUTCOME_MAX_BYTES = 8 * 1024;
export const SPAWN_ACCEPTED_TTL = 60.0;
export const SPAWN_OUTCOME_TICK_INTERVAL = 3.0;
export const PARKED_ACTION_VISIBLE_AFTER = 5;

export const SPAWN_REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  worktree_not_shareable:
    "The parent's projected worktree is no longer active or shareable. " +
    "Let its pending worktree change settle (or enter the intended " +
    "worktree again), then retry create.",
  parent_missing:
    "The parent conversation no longer exists; create from a live agent.",
  parent_deleting:
    "The parent is being deleted; choose a live parent and retry.",
  unsupported_model:
    "The requested model is not available. Choose a listed model and retry.",
  unsupported_effort:
    "The requested effort level is not 1-5. Retry with --effort 1-5 or omit it to inherit.",
  rejected:
    "The server could not safely accept this spawn. Check that the parent " +
    "and its working directory are still active, then retry.",
};

type Json = Record<string, unknown>;
export type SpawnItem = { cid: unknown; req: unknown; store_id?: string };
export type DoomedScan = [
  epoch: number,
  doomed: string[],
  protectedIds: Set<string>,
  protectedFiles: Set<string>,
];
export type SpawnOutcome = Json & { id: string; status?: unknown };

export interface TreeSupervisor {
  create(
    options: CreateOptions,
    signal?: AbortSignal,
  ): Promise<ConversationRecord>;
  deliver(
    cid: string,
    content: string,
    options?: DeliverOptions,
  ): Promise<string | null>;
  requestRun(cid: string): void;
}

export interface SpawnOutcomes {
  read(cid: string): Promise<SpawnOutcome | null>;
  write(
    cid: string,
    status: "accepted" | "rejected",
    options: { parent: unknown; code?: string; message?: string },
  ): Promise<unknown>;
}

export interface AgentTreeDeps {
  conversations: Pick<
    ConversationStore,
    | "load"
    | "save"
    | "allConvs"
    | "descendants"
    | "effectiveWorkdir"
    | "invalidateContextUsage"
  >;
  nodes: Pick<
    AgentNodes<AgentNode, NodeStore>,
    "existing" | "retiring" | "uncertainIntents"
  >;
  agentStore: Pick<
    AgentStore,
    "submit" | "retire" | "close" | "dbPaths" | "forget"
  > & { readonly baseDir: string };
  lifecycle: Pick<TreeLifecycle, "guardAsync" | "withLease">;
  parked: Pick<
    ParkedActions,
    | "actionRequest"
    | "consumeActionBatch"
    | "dropParkedAction"
    | "parkedActionCids"
  >;
  durable: Pick<DurableHost, "owns" | "stop" | "clear" | "compact">;
  prompts: Pick<Prompts, "dropTurnSystemPrompt">;
  config: Pick<Config, "chatModel" | "credentialRevision">;
  supervisor: TreeSupervisor;
  spawnOutcomes: SpawnOutcomes;
  /** pi_session_retirement, injected (runtime_boundary.test.ts). */
  sessions: {
    sessionReferences(rows: ConversationRecord[]): [Set<string>, Set<string>];
  };
  spawnOutcomeDir: string;
  logger: RuntimeLogger;
  /** Wall-clock seconds (time.time). */
  now(): number;
  /** Monotonic seconds. */
  monotonic(): number;
}

const isDict = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fullmatch = (value: unknown): value is string =>
  typeof value === "string" && CID_RE.test(value);

/** Python truthiness for JSON values. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python repr for the JSON values a spawn request can carry. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string")
    return value.includes("'") && !value.includes('"')
      ? `"${value.replaceAll("\\", "\\\\")}"`
      : `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(value as Json)
    .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
    .join(", ")}}`;
}

const isValueError = (error: unknown): error is Error =>
  error instanceof Error && error.name === "ValueError";

class ValueError extends Error {
  override name = "ValueError";
}

class RuntimeError extends Error {
  override name = "RuntimeError";
}

const isOsError = (error: unknown): boolean =>
  error instanceof Error &&
  typeof (error as NodeJS.ErrnoException).code === "string";

/** Path.unlink(missing_ok=True). */
async function unlinkMissingOk(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Path.is_file() and not Path.is_symlink(): a regular, non-link file. */
async function plainFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const stem = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** Python type(exc).__name__: the set name, else the class name. */
const errorName = (error: unknown) =>
  error instanceof Error
    ? error.name !== "Error"
      ? error.name
      : error.constructor.name
    : typeof error;

/** Map internal failures to bounded actionable text with no raw details. */
export function safeSpawnRejection(error: unknown): [string, string] {
  const text = errorText(error);
  let code: string;
  if (isValueError(error) && text.toLowerCase().includes("conflicting"))
    code = "rejected";
  else if (isValueError(error) && text === "parent conversation not found")
    code = "parent_missing";
  else if (isValueError(error) && text === "parent deletion is pending")
    code = "parent_deleting";
  else if (isValueError(error) && text.toLowerCase().includes("effort"))
    code = "unsupported_effort";
  else if (isValueError(error) && text.toLowerCase().includes("model"))
    code = "unsupported_model";
  else code = "rejected";
  return [code, SPAWN_REJECTION_MESSAGES[code]!];
}

export class AgentTree {
  /** Lease-busy spawns for the tick shelf. */
  readonly pendingSpawns: SpawnItem[] = [];
  private lastSpawnOutcomePass = 0.0;
  private spawnOutcomesDue = false;
  private topologyEpoch = 0;
  readonly parkedActionSchedule: RetrySchedule;

  constructor(private readonly deps: AgentTreeDeps) {
    this.parkedActionSchedule = new RetrySchedule({
      baseDelay: 1.0,
      maxDelay: 60.0,
      clock: () => deps.monotonic(),
    });
  }

  /** A receipt was published or observed: the next tick scans for it. */
  markSpawnOutcomesDue(): void {
    this.spawnOutcomesDue = true;
  }

  get treeTopologyEpoch(): number {
    return this.topologyEpoch;
  }

  /** Advance once a new or moved parent edge is readable. */
  bumpTreeTopology(): void {
    this.topologyEpoch += 1;
  }

  /** Trust an unleased scan only while the topology is unchanged. */
  revalidateScan(
    scan: DoomedScan | null,
  ): [string[], Set<string>, Set<string>] | null {
    if (scan !== null && scan[0] === this.topologyEpoch)
      return [[...scan[1]], new Set(scan[2]), new Set(scan[3])];
    return null;
  }

  /** Scan the subtree and survivor session bindings outside the tree lease. */
  doomedScan(cid: string): DoomedScan {
    const epoch = this.topologyEpoch;
    const { conversations } = this.deps;
    const all = conversations.allConvs({ withPending: false });
    const doomed = [cid, ...conversations.descendants(cid, all)];
    const surviving = all.filter((conv) => !doomed.includes(conv.id as never));
    const [ids, files] = this.deps.sessions.sessionReferences(surviving);
    return [epoch, doomed, ids, files];
  }

  /** First explicitly pinned member of a doomed subtree, if any. */
  takeoverReapBlocker(
    doomed: readonly string[],
  ): [string, string | null] | null {
    for (const id of doomed) {
      const conv = this.deps.conversations.load(id, { withPending: false });
      if (conv !== null && conv.pinned === true) {
        const title = conv.title;
        return [id, typeof title === "string" ? title : null];
      }
    }
    return null;
  }

  /** A human-readable reason the move is invalid, or null when legal. */
  reparentError(
    cid: string,
    newParent: unknown,
    convs?: ConversationRecord[],
  ): string | null {
    if (typeof newParent !== "string" || !newParent)
      return "a target parent id is required.";
    if (newParent === cid) return "an agent cannot be moved under itself.";
    const { conversations } = this.deps;
    const rows = convs ?? conversations.allConvs({ withPending: false });
    const ids = new Set(rows.map((c) => c.id));
    if (!ids.has(cid)) return `no such agent '${cid}'.`;
    if (!ids.has(newParent)) return `no such target agent '${newParent}'.`;
    const side = (id: string) =>
      typeof rows.find((c) => c.id === id)?.side_of === "string";
    if (side(cid) || side(newParent))
      return "side conversations cannot be moved or receive agents.";
    if (conversations.descendants(cid, rows).includes(newParent))
      return (
        `'${newParent}' is a descendant of '${cid}'; moving there would ` +
        "create a cycle."
      );
    return null;
  }

  /** Validate a move and apply it as one direct edge write. */
  async requestReparent(
    cid: string,
    newParent: string,
    _options: { by?: string | null } = {},
  ): Promise<Json> {
    const { conversations } = this.deps;
    const conv = conversations.load(cid, { withPending: false });
    if (conv === null) return { ok: false, error: `no such agent '${cid}'.` };
    const err = this.reparentError(cid, newParent);
    if (err) return { ok: false, error: err };
    const oldParent = conv.parent ?? null;
    if (oldParent === newParent)
      return { ok: true, from: oldParent, to: newParent, moved: false };
    conv.parent = newParent;
    conv.updated = this.deps.now();
    await conversations.save(conv);
    this.bumpTreeTopology();
    return { ok: true, from: oldParent, to: newParent, moved: true };
  }

  /** Abort one live run directly. Thin route to the node's abort. */
  requestStop(
    cid: string,
    options: { expectedRun?: string | null; stopId?: string | null } = {},
  ): Promise<boolean> {
    return this.deps.durable.stop(cid, options.expectedRun ?? undefined);
  }

  /** Park one lease-busy spawn for the tick retry shelf. */
  parkSpawnIntent(cid: string, req: Json): SpawnItem {
    const item: SpawnItem = { cid, req };
    this.pendingSpawns.push(item);
    return item;
  }

  /** Drop every parked control intent (test reset). */
  clearPendingIntents(): void {
    this.pendingSpawns.length = 0;
  }

  /** File one parked spawn's request in the store mailbox. */
  async recordSpawnIntent(item: SpawnItem): Promise<void> {
    const { cid, req } = item;
    if (typeof cid !== "string" || !isDict(req)) return;
    if ((await this.deps.spawnOutcomes.read(cid)) !== null) return;
    const parent = req.parent;
    if (typeof parent === "string") {
      const parentConv = this.deps.conversations.load(parent, {
        withPending: false,
      });
      if (
        parentConv === null ||
        truthy(parentConv.reap_deferred) ||
        this.deps.nodes.retiring(parent)
      )
        return;
    }
    try {
      item.store_id = this.deps.agentStore.submit(cid, "spawn", {
        request: { ...req },
      });
    } catch (error) {
      if (!(error instanceof AgentClosed)) throw error;
    }
  }

  /** Quiesce and trash one conversation-less spawn-record database. */
  async retireOrphanSpawnStore(cid: string): Promise<boolean> {
    const { agentStore } = this.deps;
    if (this.deps.conversations.load(cid, { withPending: false }) !== null)
      return false;
    let quiesced: boolean;
    try {
      quiesced = await agentStore.close(cid, 10.0);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      return false;
    }
    if (!quiesced) return false;
    let handle;
    try {
      handle = await open(
        agentStore.baseDir,
        fsConstants.O_RDONLY |
          fsConstants.O_DIRECTORY |
          fsConstants.O_NOFOLLOW |
          ((fsConstants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0),
      );
    } catch {
      return false;
    }
    try {
      let retired = true;
      for (const path of agentStore.dbPaths(cid)) {
        const name = path.slice(path.lastIndexOf("/") + 1);
        try {
          if (!retireWithinParent(handle.fd, name, ".trash")) {
            if (await plainFileFollow(path)) retired = false;
          }
        } catch {
          retired = false;
        }
      }
      if (retired) agentStore.forget(cid);
      return retired;
    } finally {
      await handle.close();
    }
  }

  /** Trash one rejected spawn's orphan database when nothing published. */
  async cleanupRejectedSpawnStore(
    cid: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!fullmatch(cid)) return;
    const outcome = await this.deps.spawnOutcomes.read(cid);
    if (!isDict(outcome) || outcome.status !== "rejected") return;
    if (this.deps.conversations.load(cid, { withPending: false }) !== null)
      return;
    let retired: boolean;
    try {
      retired = await this.retireOrphanSpawnStore(cid);
    } catch (error) {
      if (signal) checkAbort(signal);
      logException(this.deps.logger, "spawn_orphan_retire_failed", error, {
        conversation_id: cid,
        level: WARNING,
      });
      return;
    }
    if (signal) checkAbort(signal);
    if (!retired)
      logEvent(this.deps.logger, WARNING, "spawn_orphan_retire_incomplete", {
        conversation_id: cid,
      });
  }

  /** Enqueue removal of one finished spawn's stored record. */
  retireSpawnRecord(item: SpawnItem): void {
    const { cid, store_id: storeId } = item;
    if (typeof cid !== "string" || typeof storeId !== "string" || !storeId)
      return;
    try {
      this.deps.agentStore.retire(cid, storeId);
    } catch (error) {
      logException(this.deps.logger, "spawn_record_retire_failed", error, {
        conversation_id: cid,
        level: WARNING,
      });
    }
  }

  /** The holder-registered directory a create --worktree spawn carries. */
  async explicitSpawnWorkdir(req: Json): Promise<string | null> {
    const workdir = req.workdir;
    if (workdir === undefined || workdir === null) return null;
    if (typeof workdir !== "string" || !workdir || !isAbsolute(workdir))
      throw new ValueError("spawn workdir must be an absolute path");
    if (!(await isDir(workdir)))
      throw new ValueError("spawn workdir is not a directory");
    return workdir;
  }

  /** Validate one spawn request and build its create options. */
  async prepareSpawnInputs(
    req: Json,
    cid: string,
    parent: string | null,
  ): Promise<CreateOptions> {
    const title = cleanTitle(req.title);
    if (title === null) throw new ValueError("spawn title required");
    const extra: { workdir?: string; level?: number } = {};
    let model = (req.model ?? null) as string | null;
    if (req.sibling === true) {
      const creator = req.creator ?? null;
      if (creator === null) {
        if (parent !== null) throw new ValueError("spawn creator not found");
      } else {
        const creatorConv = this.deps.conversations.load(creator as string, {
          withPending: false,
        });
        if (creatorConv === null)
          throw new ValueError("spawn creator not found");
        if ((creatorConv.parent ?? null) !== parent)
          throw new ValueError("spawn creator parent changed");
        if ((req.model ?? null) === null && (req.effort ?? null) === null) {
          const level = validLevel(creatorConv.level);
          if (level !== null) extra.level = level;
          else {
            let creatorModel: string;
            try {
              creatorModel = this.deps.config.chatModel(
                (creatorConv.model ?? null) as string | null,
              ).id;
            } catch (error) {
              if (!isValueError(error)) throw error;
              creatorModel = this.deps.config.chatModel().id;
            }
            model = creatorModel;
          }
        }
        extra.workdir = this.deps.conversations.effectiveWorkdir(creatorConv);
      }
    }
    const explicit = await this.explicitSpawnWorkdir(req);
    if (explicit !== null) extra.workdir = explicit;
    const effort = req.effort ?? null;
    if (effort !== null) {
      if (
        typeof effort !== "number" ||
        !Number.isInteger(effort) ||
        !(EFFORT_MIN_LEVEL <= effort && effort <= EFFORT_MAX_LEVEL)
      )
        throw new ValueError(
          `unsupported spawn effort level: ${pyRepr(effort)}`,
        );
      extra.level = effort;
    }
    return {
      cid,
      title,
      parent,
      model,
      takenOver: req.taken_over === true,
      muted: truthy(req.muted),
      pinned: truthy(req.pinned),
      spawnRequestId: cid,
      ...extra,
    };
  }

  siblingNotice(req: Json, cid: string, title: string): string {
    const creator = req.creator as string;
    const creatorConv = this.deps.conversations.load(creator, {
      withPending: false,
    });
    const creatorTitle = creatorConv?.title;
    const name =
      typeof creatorTitle === "string" && creatorTitle.trim()
        ? `${creatorTitle} (${creator})`
        : creator;
    return `[Sibling created] ${name} created ${title} (${cid}) as your child.`;
  }

  /**
   * Resolve, publish and deliver one spawn request. True when finished
   * (accepted-and-delivered, or rejected/consumed); false keeps it parked.
   */
  async spawnOne(
    req: Json,
    cid: unknown,
    options: { sibling: boolean; parent: unknown; creator: unknown },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { parent, creator, sibling } = options;
    const { conversations, supervisor, spawnOutcomes } = this.deps;
    if (
      !fullmatch(cid) ||
      (parent !== null && parent !== undefined && !fullmatch(parent)) ||
      (creator !== null && creator !== undefined && !fullmatch(creator))
    )
      return true;
    const parentId = (parent ?? null) as string | null;
    const creatorId = (creator ?? null) as string | null;
    const prior = await spawnOutcomes.read(cid);
    if (prior !== null && prior.status === "rejected") return true;
    if (
      prior !== null &&
      prior.status === "accepted" &&
      conversations.load(cid, { withPending: false }) === null
    )
      return true;
    let conv: ConversationRecord;
    try {
      const inputs = await this.deps.lifecycle.guardAsync(
        "create",
        cid,
        async (token) => {
          if (signal) checkAbort(signal);
          return this.deps.lifecycle.withLease(token, () =>
            this.prepareSpawnInputs(req, cid, parentId),
          );
        },
      );
      if (signal) checkAbort(signal);
      conv = await supervisor.create(inputs, signal);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      if (error instanceof TreeLifecycleBusy) return false;
      const [code, message] = safeSpawnRejection(error);
      await spawnOutcomes.write(cid, "rejected", {
        parent: parentId,
        code,
        message,
      });
      logException(this.deps.logger, "spawn_request_rejected", error, {
        conversation_id: cid,
        level: WARNING,
        fields: { reason_code: code },
      });
      return true;
    }
    await spawnOutcomes.write(cid, "accepted", { parent: parentId });
    if (sibling && parentId !== null) {
      try {
        await supervisor.deliver(
          parentId,
          this.siblingNotice(req, cid, conv.title as string),
          { source: "platform", origin: "platform" },
        );
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        logException(this.deps.logger, "spawn_sibling_notice_failed", error, {
          conversation_id: cid,
          level: ERROR,
        });
        return false;
      }
    }
    const prompt = truthy(req.prompt)
      ? (req.prompt as string)
      : "You were spawned without a prompt.";
    const replay = this.deps.nodes
      .uncertainIntents(cid)
      .filter((e) => e.source === "spawn" && e.content === prompt);
    let delivered: unknown;
    if (replay.length) delivered = replay[0]!.id ?? null;
    else {
      try {
        delivered = await supervisor.deliver(cid, prompt, {
          start: false,
          source: "spawn",
          sender: (req.remote_sender as string | null) ?? creatorId,
        });
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        if (error instanceof MailboxFull || error instanceof AgentClosed) {
          logException(this.deps.logger, "spawn_delivery_parked", error, {
            conversation_id: cid,
            level: WARNING,
          });
          return false;
        }
        logException(this.deps.logger, "spawn_delivery_failed", error, {
          conversation_id: cid,
          level: ERROR,
        });
        return true;
      }
    }
    if (delivered !== null && delivered !== undefined)
      supervisor.requestRun(cid);
    return true;
  }

  /** Resolve parked tool-spawn intents; each re-runs to completion. */
  async applySpawns(signal?: AbortSignal): Promise<void> {
    for (const item of [...this.pendingSpawns]) {
      const req = item.req;
      if (!isDict(req)) {
        this.dropSpawnIntent(item);
        continue;
      }
      const cid = truthy(req.id) ? req.id : item.cid;
      const parent = req.parent ?? null;
      const sibling = req.sibling === true;
      const creator = sibling ? (req.creator ?? null) : parent;
      if (await this.spawnOne(req, cid, { sibling, parent, creator }, signal)) {
        this.dropSpawnIntent(item);
        this.retireSpawnRecord(item);
        await this.cleanupRejectedSpawnStore(cid, signal);
      }
    }
  }

  /** Consume one parked spawn by identity (a racer's apply wins). */
  dropSpawnIntent(item: SpawnItem): void {
    const index = this.pendingSpawns.indexOf(item);
    if (index >= 0) this.pendingSpawns.splice(index, 1);
  }

  /** At most SPAWN_OUTCOME_MAX_ROWS receipts and observed markers. */
  async boundedSpawnOutcomeEntries(): Promise<[string[], string[], boolean]> {
    const dir = this.deps.spawnOutcomeDir;
    try {
      let link = false;
      try {
        link = (await lstat(dir)).isSymbolicLink();
      } catch {}
      if (link || !(await isDir(dir))) return [[], [], false];
      const selected: [string, string][] = [];
      const split = (overflow: boolean): [string[], string[], boolean] => [
        selected.filter(([k]) => k === "outcome").map(([, p]) => p),
        selected.filter(([k]) => k === "observed").map(([, p]) => p),
        overflow,
      ];
      // Invariant: opendir streams entries, so the cap bounds the scan like
      // scandir.
      const handle = await opendir(dir);
      try {
        for await (const entry of handle) {
          const name = entry.name;
          const kind = name.endsWith(".json")
            ? "outcome"
            : name.endsWith(".observed")
              ? "observed"
              : null;
          if (kind === null) continue;
          selected.push([kind, join(dir, name)]);
          if (selected.length > SPAWN_OUTCOME_MAX_ROWS) {
            selected.length = SPAWN_OUTCOME_MAX_ROWS;
            return split(true);
          }
        }
      } finally {
        // Invariant: for-await closes the directory, including on an early
        // return.
      }
      return split(false);
    } catch (error) {
      if (isOsError(error)) return [[], [], false];
      throw error;
    }
  }

  /** Consume observed receipts or deliver one delayed rejection notice. */
  async processSpawnOutcomes(signal?: AbortSignal): Promise<void> {
    if (
      !this.spawnOutcomesDue &&
      this.deps.monotonic() - this.lastSpawnOutcomePass <
        SPAWN_OUTCOME_TICK_INTERVAL
    )
      return;
    this.lastSpawnOutcomePass = this.deps.monotonic();
    this.spawnOutcomesDue = false;
    const now = this.deps.now();
    const dir = this.deps.spawnOutcomeDir;
    const [outcomes, observedEntries, overflow] =
      await this.boundedSpawnOutcomeEntries();
    if (signal) checkAbort(signal);
    if (overflow)
      this.deps.logger.warning(
        "spawn outcome scan reached its bounded row limit",
      );
    for (const path of outcomes) {
      const cid = stem(path.slice(path.lastIndexOf("/") + 1));
      const observed = join(dir, `${cid}.observed`);
      const outcome = CID_RE.test(cid)
        ? await this.deps.spawnOutcomes.read(cid)
        : null;
      if (
        outcome === null ||
        (outcome.status !== "accepted" && outcome.status !== "rejected")
      ) {
        await unlinkMissingOk(path);
        await unlinkMissingOk(observed);
        continue;
      }
      if (await plainFile(observed)) {
        await unlinkMissingOk(path);
        await unlinkMissingOk(observed);
        continue;
      }
      let age: number;
      try {
        age = Math.max(0.0, now - (await lstat(path)).mtimeMs / 1000);
      } catch {
        continue;
      }
      if (outcome.status === "accepted") {
        if (age >= SPAWN_ACCEPTED_TTL) await unlinkMissingOk(path);
        continue;
      }
      if (age < SPAWN_NOTICE_DELAY) continue;
      const parent = outcome.parent;
      const code = outcome.code;
      const message =
        typeof code === "string" &&
        Object.hasOwn(SPAWN_REJECTION_MESSAGES, code)
          ? SPAWN_REJECTION_MESSAGES[code]
          : undefined;
      if (
        fullmatch(parent) &&
        this.deps.conversations.load(parent, { withPending: false }) !== null &&
        message !== undefined
      ) {
        const delivered = await this.deps.supervisor.deliver(
          parent,
          `[Subagent creation failed] ${cid}: ${message}`,
          { source: "platform", origin: "platform" },
        );
        if (signal) checkAbort(signal);
        if (delivered === null) continue;
      }
      await unlinkMissingOk(path);
      await unlinkMissingOk(observed);
    }
    for (const observed of observedEntries) {
      const name = observed.slice(observed.lastIndexOf("/") + 1);
      const outcome = join(dir, `${stem(name)}.json`);
      let age: number;
      try {
        age = Math.max(0.0, now - (await lstat(observed)).mtimeMs / 1000);
      } catch {
        continue;
      }
      if (!(await exists(outcome)) && age >= SPAWN_ACCEPTED_TTL)
        await unlinkMissingOk(observed);
    }
  }

  /** Commit the retained clear follow-ups after the new binding published. */
  async clearConversationMetadata(cid: string): Promise<void> {
    const { conversations } = this.deps;
    const conv = conversations.load(cid, { withPending: false });
    if (conv === null) return;
    await this.deps.prompts.dropTurnSystemPrompt(conv);
    conversations.invalidateContextUsage(conv);
    delete conv.settled_attachment_ids;
    conv.status = "idle";
    conv.active_turn = null;
    delete conv.status_reason;
    conv.draft = null;
    conv.identity_block_pending = true;
    conv.updated = this.deps.now();
    await conversations.save(conv);
  }

  async applyNodeClear(
    cid: string,
    conv: ConversationRecord,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal) checkAbort(signal);
    if (!this.deps.durable.owns(conv)) return false;
    return (await this.deps.durable.clear(cid)) !== null;
  }

  async applyNodeCompact(
    cid: string,
    conv: ConversationRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal) checkAbort(signal);
    if (!this.deps.durable.owns(conv))
      throw new RuntimeError("Conversation history import is pending.");
    if ((await this.deps.durable.compact(cid)) === null)
      throw new RuntimeError("Conversation is unavailable.");
  }

  // Apply this agent's parked /clear and /compact requests
  // (DriveSeams.drainParked).
  async drainParkedPlatformActions(
    cid: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let progressed = false;
    for (const action of ["clear", "compact"] as const) {
      const request = this.deps.parked.actionRequest(action, cid);
      if (request === null) continue;
      if (await this.drainOneParkedAction(action, request, cid, signal))
        progressed = true;
    }
    return progressed;
  }

  /** Drop every parked-action backoff record (test reset only). */
  clearParkedActionBackoff(): void {
    this.parkedActionSchedule.clear();
  }

  private static identity(request: ActionRequest): unknown[] {
    return [request.action_id ?? null, request.requested_at ?? null];
  }

  parkedBackoffReady(
    action: string,
    cid: string,
    request: ActionRequest,
  ): boolean {
    return this.parkedActionSchedule.ready(
      [cid, action],
      AgentTree.identity(request),
    );
  }

  noteParkedActionSuccess(action: string, cid: string): void {
    this.parkedActionSchedule.noteSuccess([cid, action]);
  }

  // Record one failed attempt; surface it after PARKED_ACTION_VISIBLE_AFTER.
  async noteParkedActionFailure(
    action: string,
    cid: string,
    request: ActionRequest,
    note: string,
  ): Promise<void> {
    const entry = this.parkedActionSchedule.noteFailure(
      [cid, action],
      AgentTree.identity(request),
    );
    const failures = Math.trunc(Number(entry.attempts ?? 0));
    if (failures < PARKED_ACTION_VISIBLE_AFTER || truthy(entry.surfaced))
      return;
    const { conversations } = this.deps;
    const latest = conversations.load(cid, { withPending: false });
    if (latest === null) return;
    latest.status = "error";
    latest.status_reason = [
      ...`${action} parked action failed (${failures} attempts): ${note}; retrying with backoff`,
    ]
      .slice(0, 500)
      .join("");
    latest.updated = this.deps.now();
    await conversations.save(latest);
    entry.surfaced = true;
  }

  private async attemptParkedAction(
    action: string,
    request: ActionRequest,
    cid: string,
    conv: ConversationRecord,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { parked } = this.deps;
    if (action === "compact") {
      await this.applyNodeCompact(cid, conv, signal);
      parked.consumeActionBatch(request);
    } else if (await this.applyNodeClear(cid, conv, signal))
      parked.consumeActionBatch(request);
    return parked.actionRequest(action, cid) === null;
  }

  /** Apply one parked platform action; true when its slot moved. */
  async drainOneParkedAction(
    action: "clear" | "compact",
    request: ActionRequest,
    cid: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { conversations, parked, nodes } = this.deps;
    const conv = conversations.load(cid, { withPending: false });
    if (conv === null || nodes.retiring(cid)) {
      parked.dropParkedAction(action, cid);
      this.noteParkedActionSuccess(action, cid);
      return true;
    }
    if (!this.parkedBackoffReady(action, cid, request)) return false;
    let landed: boolean;
    try {
      landed = await this.attemptParkedAction(
        action,
        request,
        cid,
        conv,
        signal,
      );
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      logException(this.deps.logger, "platform_action_failed", error, {
        conversation_id: cid,
      });
      if (parked.actionRequest(action, cid) === null) {
        this.noteParkedActionSuccess(action, cid);
        return true;
      }
      await this.noteParkedActionFailure(
        action,
        cid,
        request,
        `${errorName(error)}: ${errorText(error)}`,
      );
      return false;
    }
    if (landed) {
      this.noteParkedActionSuccess(action, cid);
      return true;
    }
    await this.noteParkedActionFailure(
      action,
      cid,
      request,
      `${action} attempt did not land; request stays parked`,
    );
    return false;
  }

  /** Kick agents with a parked /compact or /clear so their runner drains it. */
  processPlatformActions(): void {
    const { conversations, parked, nodes, supervisor } = this.deps;
    for (const action of ["clear", "compact"] as const) {
      for (const cid of parked.parkedActionCids(action).sort()) {
        const conv = conversations.load(cid, { withPending: false });
        if (!truthy(conv)) {
          parked.dropParkedAction(action, cid);
          this.noteParkedActionSuccess(action, cid);
          continue;
        }
        if (nodes.retiring(cid)) {
          parked.dropParkedAction(action, cid);
          this.noteParkedActionSuccess(action, cid);
          continue;
        }
        const request = parked.actionRequest(action, cid);
        if (request === null) {
          this.noteParkedActionSuccess(action, cid);
          continue;
        }
        if (!this.parkedBackoffReady(action, cid, request)) continue;
        supervisor.requestRun(cid);
      }
    }
  }
}

/** Path.is_file(): follows symlinks. */
async function plainFileFollow(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
