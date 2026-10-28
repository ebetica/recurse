// Composition root binds explicit store/runtime/supervisor dependencies.
// Reject unimported state before building; agent work begins only at start().
// Start storage, verify process cleanup, refresh spawn-workdir, then watcher.
// Old groups must be gone before Durable resume; web app owns HTTP checks.
import { existsSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentStore } from "./agent_store";
import { pruneEmptyOwner } from "../artifacts";
import { AgentTree } from "./agent_tree";
import { WorktreeHolders } from "./worktree_holders";
import { DurableHost } from "./durable/host";
import { PiSwitchover } from "./supervisor/switchover";
import { ParkedActions } from "./compaction";
import {
  assertNoUnimportedLegacyState,
  ConversationStore,
  SET_MODEL_MARKER,
} from "./conversation_store";
import { AgentTools } from "./tools";
import { TreeLifecycle } from "./mutation_guard";
import * as reapHistory from "./reap_history";
import { Reconciler } from "./reconciler";
import { DeferredReaps, DeferredReapSeed } from "./retry_schedule";
import {
  AgentNode,
  type AgentNodeDeps,
  type NodeStore,
} from "./runtime/agent_node";
import { AgentNodes } from "./runtime/agent_nodes";
import { AgentTemp } from "./runtime/agent_temp";
import { AttachmentDrafts } from "./runtime/attachment_drafts";
import { ConfigActions } from "./runtime/config_actions";
import { ContextUsage } from "./runtime/context_usage";
import {
  captureMemorySnapshot,
  renderMemoryPrompt,
} from "./runtime/memory_snapshot";
import { collectionSnapshot } from "./runtime/node_files";
import { piBinding } from "./runtime/pi/session";
import {
  ProcessCleanupPending,
  TakenOverReapBlocked,
} from "./runtime/pi_protocol";
import { Prompts } from "./runtime/prompts";
import { piRuntimeErrors } from "./runtime/runtime_factory";
import { TouchedPrs } from "./touched_prs";
import { timeoutScheduler } from "./runtime/stall_timer";
import { TurnPrep } from "./runtime/turn_prep";
import {
  createStoreHooks,
  SpawnWorkdir,
  SupervisorCreate,
} from "./supervisor/create";
import { deliveryStoreHooks, SupervisorDelivery } from "./supervisor/delivery";
import { SupervisorLifecycle } from "./supervisor/lifecycle";
import { SupervisorReads } from "./supervisor/reads";
import {
  reapStoreHooks,
  reapTempSeams,
  SupervisorReap,
} from "./supervisor/reap";
import { SupervisorRevive } from "./supervisor/revive";
import { projectStatuses, TreeView } from "./tree_view";
import { AnthropicAuth } from "../auth/anthropic";
import { CodexAuth } from "../auth/codex";
import { OAuthStore } from "../auth/oauth";
import { OpenRouterAuth } from "../auth/openrouter";
import { CHECKOUT_ROOT } from "../build_dir";
import { SessionIndex } from "../coding_backend/session_index";
import { buildEnv } from "../coding_backend/launch";
import {
  piSafetyWorkspaceRoot,
  piSafetyWorktreesRoot,
} from "../coding_backend/extensions";
import { listSkills } from "../coding_backend/skills";
import type { Config } from "../config";
import * as deletedBin from "../deleted_bin";
import {
  preparePiAgentDir,
  resolveRoots,
  type Environment,
} from "../local_roots";
import { ShellRegistry } from "../pi_bg_shell";
import { PiSessionRetirement } from "../pi_session_retirement";
import { ProcessLifecycle } from "../process_lifecycle";
import { McpChecks } from "../mcp_checks";
import { MCP_FILE_NAME } from "../mcp_config";
import {
  ERROR,
  INFO,
  WARNING,
  logEvent,
  logException,
  logger,
  type LogSink,
} from "../observability/runtime_logging";
import {
  makeSkillRegistry,
  SkillContext,
  SkillRenderCache,
} from "../skill_context";
import * as startupMetrics from "../observability/startup_metrics";
import { retireConversationDetails } from "../tool_details";
import { abortable, ignoringCancelled, TaskSet } from "../utils/tasks";
import { WorkdirGit } from "../workdir_git";
import { finishedNotice, PushNotifications } from "../push_notifications";

export interface InstanceOptions {
  /** The state-plane configuration; its env is the ambient environment. */
  readonly config: Config;
  /** Where every runtime logger writes. */
  readonly sink: LogSink;
  /** This server's start time, for detached-shell liveness. */
  readonly processStartedMs?: number;
}

const STORE_LEVELS: Record<string, number> = {
  agent_metadata_scan_skipped: 10,
  metadata_enqueue_owner_gone: 10,
  projection_refreshed: INFO,
  external_key_binding_invalid: ERROR,
  projection_refresh_flush_failed: ERROR,
  service_conversation_rollback_failed: WARNING,
};

/** Seconds from a Python-style float environment value. */
function envSeconds(env: Environment, name: string, fallback: string): number {
  const value = Number.parseFloat(env[name] ?? fallback);
  if (!Number.isFinite(value))
    throw new Error(`could not convert string to float: '${env[name]}'`);
  return value;
}

const sleepFor = (seconds: number, signal?: AbortSignal): Promise<void> =>
  signal === undefined
    ? Bun.sleep(seconds * 1000)
    : abortable(Bun.sleep(seconds * 1000), signal);

const newHexId = (): string => randomUUID().replaceAll("-", "");

function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The backend, assembled. Every member is the real implementation. */
export async function buildInstance(options: InstanceOptions) {
  const { config, sink } = options;
  const paths = config.paths;
  const env = config.env;
  // Invariant: Item 6: nothing is built over an unimported data directory.
  await assertNoUnimportedLegacyState(paths.DATA_DIR);

  const log = {
    agents: logger("agents", sink),
    node: logger("agents.node", sink),
    runtime: logger("agents.runtime", sink),
    store: logger("agents.store", sink),
    mutation: logger("agents.mutation", sink),
    agentTemp: logger("agents.agent_temp", sink),
    reconciler: logger("agents.reconciler", sink),
    retirement: logger("pi_session_retirement", sink),
    reapHistory: logger("reap_history", sink),
  };
  const now = (): number => Date.now() / 1000;
  const monotonic = (): number => performance.now() / 1000;

  // Invariant: The root task sink: a detached failure is logged; Cancelled is
  // the shutdown signal's ordinary outcome, never a failure (PR17 N2).
  const onTaskError = ignoringCancelled((name, error) =>
    logException(log.agents, "detached_task_failed", error, {
      fields: { task: name },
    }),
  );
  const tasks = new TaskSet(onTaskError);
  const createTasks = new TaskSet(onTaskError);
  const shutdownController = new AbortController();

  const shells = new ShellRegistry({
    enabled: paths.PI_BG_SHELL_ENABLED,
    stateDir: paths.PI_BG_SHELL_STATE_DIR,
    processStartedMs: options.processStartedMs ?? Date.now(),
  });
  const processes = new ProcessLifecycle({
    registry: shells,
    shellStateDir: paths.PI_BG_SHELL_STATE_DIR,
    termGraceMs: envSeconds(env, "RECURSE_PROCESS_TERM_GRACE", "2") * 1000,
    killGraceMs: envSeconds(env, "RECURSE_PROCESS_KILL_GRACE", "1") * 1000,
  });
  const workdirGit = new WorkdirGit({
    repoUrl: config.repoUrl,
    repoDir: paths.REPO_DIR,
    dataDir: paths.DATA_DIR,
    env,
    backgroundTask: (name, work) => {
      tasks.spawn(name, work);
    },
  });
  const roots = resolveRoots(env);
  const mcpChecks = new McpChecks({
    configPath: join(roots.piAgent, MCP_FILE_NAME),
    temporaryRoot: paths.DATA_DIR,
    trashDir: paths.TRASH_DIR,
    env: Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value]],
      ),
    ),
    processes,
    tasks,
    signal: shutdownController.signal,
    providerToken: async (provider) => durableHost?.providerToken(provider),
  });
  const backend = new SessionIndex(join(paths.DATA_DIR, "pi_sessions"));
  const lease = new TreeLifecycle({
    dataDir: paths.DATA_DIR,
    muteLockDir: paths.MUTE_LOCK_DIR,
    logger: log.mutation,
  });

  const oauth = new OAuthStore({
    piAgentDir: async () => {
      await preparePiAgentDir(roots);
      return roots.piAgent;
    },
    ambient: env,
    customProviderIds: () => Object.keys(config.customModelProviders()),
    lifecycle: processes,
  });
  const notifiedRuns = new Map<string, string>();
  const notifications = new PushNotifications({
    directory: async () => {
      await preparePiAgentDir(roots);
      return roots.piAgent;
    },
    spawn: (name, work) =>
      void tasks.spawn(name, work, shutdownController.signal).catch(() => {}),
    log: (event, fields, warn) =>
      logEvent(log.agents, warn ? WARNING : INFO, event, { fields }),
  });
  const anthropic = new AnthropicAuth({ store: oauth, ambient: env });
  const codex = new CodexAuth({ store: oauth, ambient: env });
  const openrouter = new OpenRouterAuth({ store: oauth, env });

  // Invariant: Late-bound peers: each closure below reads its peer after
  // construction.
  let nodes!: AgentNodes<AgentNode, NodeStore>;
  let agentTemp!: AgentTemp;
  let treeView!: TreeView;
  let configActions!: ConfigActions;
  let spawnWorkdir!: SpawnWorkdir;
  let tree!: AgentTree;
  let prompts!: Prompts;
  let agentTools!: AgentTools;
  let create!: SupervisorCreate;
  let delivery!: SupervisorDelivery;
  let reap!: SupervisorReap;
  let reads!: SupervisorReads;
  let reconciler!: Reconciler<AgentNode>;
  let lifecycle!: SupervisorLifecycle;
  let durableHost: DurableHost | undefined;
  let retirement!: PiSessionRetirement;

  const agentStore = new AgentStore(join(paths.DATA_DIR, "agents"));
  const conversations = new ConversationStore(
    {
      dataDir: paths.DATA_DIR,
      externalKeyDir: paths.EXTERNAL_KEY_DIR,
      serviceBindingsDir: paths.SERVICE_BINDINGS_DIR,
      titleLockDir: paths.TITLE_LOCK_DIR,
      muteLockDir: paths.MUTE_LOCK_DIR,
    },
    agentStore,
    {
      ...deliveryStoreHooks({
        existing: (cid) => nodes.existing(cid),
        node: (cid) => nodes.node(cid),
      }),
      ...createStoreHooks(
        {
          withModelGuard: (cid, fn, token) =>
            configActions.withModelGuard(cid, fn, token),
        },
        { current: () => spawnWorkdir.current() } as SpawnWorkdir,
      ),
      ...reapStoreHooks(
        { safeRemoveTempKey: (key) => agentTemp.safeRemoveTempKey(key) },
        { dropNode: (cid) => nodes.dropNode(cid) },
      ),
      hasLiveShell: (cid) => (durableHost?.shells(cid).active_count ?? 0) > 0,
      liveStatus: (cid) => {
        if (
          conversations.load(cid, { withPending: false, fields: ["backend"] })
            ?.backend !== "durable"
        )
          return [null, null];
        const live = durableHost?.metadata(cid);
        return [live?.status ?? null, live?.active_run ?? null];
      },
      // Invariant: Read lazily: the store is built before the Durable host.
      durableSafetyOff: (cid): boolean | undefined =>
        durableHost?.safetyReviewOff(cid),
      treeRefresh: (entry) => treeView.refresh(entry),
      treeRebuild: (entries) => treeView.rebuildAll(entries),
      treeDiscard: (cid) => treeView.discard(cid),

      log: (event, fields) => {
        if (event === "conversation_records_scanned")
          return startupMetrics.count(event, Number(fields?.count ?? 0));
        logEvent(log.store, STORE_LEVELS[event] ?? WARNING, event, { fields });
      },
    },
    config,
  );
  retirement = new PiSessionRetirement({
    trashDir: paths.TRASH_DIR,
    sessions: backend,
    logger: log.retirement,
  });
  const skills = new SkillContext(() =>
    makeSkillRegistry(config, roots.piAgent),
  );
  treeView = new TreeView({
    skills: {
      contextForWorkdirLoopSafe: (workdir) =>
        skills.contextForWorkdirLoopSafe(workdir),

      renderer: () => {
        const cache = new SkillRenderCache(
          makeSkillRegistry(config, roots.piAgent),
        );
        return (workdir) => skills.contextForWorkdir(workdir, cache);
      },
    },
    logger: log.agents,
  });
  const deletedPaths = {
    deletedDir: paths.DELETED_DIR,
    trashDir: paths.TRASH_DIR,
    retentionDays: paths.DELETED_RETENTION_DAYS,
    expiryLimit: paths.DELETED_EXPIRY_LIMIT,
  };
  const historyPolicy: reapHistory.ReapHistoryExpiryPolicy = {
    historyDir: paths.AGENT_HISTORY_DIR,
    trashDir: paths.TRASH_DIR,
    get retentionDays() {
      return config.deletedAgentHistoryDays();
    },
    expiryLimit: paths.AGENT_HISTORY_EXPIRY_LIMIT,
    logExpiry: (result) =>
      logEvent(log.reapHistory, INFO, "reap_history_expiry", {
        fields: { ...result },
      }),
  };
  const tempSeams = reapTempSeams({
    prompts: {
      turnPromptSnapshotPath: (conv) => prompts.turnPromptSnapshotPath(conv),
      turnTransportPromptPath: (conv) => prompts.turnTransportPromptPath(conv),
      capturedSystemPromptPath: (conv) =>
        prompts.capturedSystemPromptPath(conv),
    },
    nodes: { allTurnTasks: () => nodes.allTurnTasks() },
    expireHistory: async () => {
      reapHistory.expire(historyPolicy);
      const expired = await durable.archive.expire(
        config.deletedAgentHistoryDays(),
        paths.TRASH_DIR,
        paths.AGENT_HISTORY_EXPIRY_LIMIT,
      );
      if (expired)
        logEvent(log.reapHistory, INFO, "durable_archive_expiry", {
          fields: { expired },
        });
    },
    expireDeletedBin: () => deletedBin.expire(deletedPaths),
  });
  agentTemp = new AgentTemp(config, {
    conversations,
    logger: log.agentTemp,
    ownerAdmits: (cid) => nodes.ownerAdmits(cid),
    hasCollection: (conv) => collectionSnapshot(conv, config) !== null,
    promptSidecarNames: tempSeams.promptSidecarNames,
    expireRetained: tempSeams.expireRetained,
  });
  const drafts = new AttachmentDrafts(config, conversations, agentTemp);
  agentTemp.attachDrafts(drafts);
  const parked = new ParkedActions({
    load: (cid) => conversations.load(cid),
    admitContextAction: async (cid, action, park) => {
      const admitted = await conversations.withSafetyGuard(cid, async () =>
        durable.owns(conversations.load(cid))
          ? { native: true, parked: null }
          : { native: false, parked: await park() },
      );
      if (!admitted.native) return admitted.parked;
      const applied = await (action === "clear"
        ? durable.clear(cid)
        : durable.compact(cid));
      return applied === null
        ? null
        : { id: cid, action, queued: Boolean(applied.queued) };
    },
    requestRun: (cid) => delivery.requestRun(cid),
    newActionId: newHexId,
    now,
  });

  const launch = {
    config,
    gitEnv: () => workdirGit.gitEnv(),
    roots,
    preparePiAgentDir,
    checkoutRoot: CHECKOUT_ROOT,
  };

  agentTools = await AgentTools.create({
    config,
    skills,
    gitReady: () => {
      const local = isDirSync(config.repoUrl);
      if (local && !existsSync(join(config.repoUrl, ".git")))
        return isDirSync(config.repoUrl);
      return existsSync(join(paths.REPO_DIR, ".git"));
    },
    targetIsGitRepo: () =>
      !isDirSync(config.repoUrl) || existsSync(join(config.repoUrl, ".git")),
    loadConversation: async (cid) => conversations.load(cid),
    effectiveWorkdir: (conv) => conversations.effectiveWorkdir(conv),
    agentTempPath: (conv) => agentTemp.agentTempPath(conv),
    listSkills: (o) => listSkills(roots.piAgent, o),
  });
  prompts = new Prompts({
    displayName: config.displayName,
    dataDir: paths.DATA_DIR,
    turnPromptDir: paths.TURN_PROMPT_DIR,
    toolsDir: paths.TOOLS_DIR,
    toolsSection: () => agentTools.toolsSection(),
    conversationEffortLine: (conv) => agentTools.conversationEffortLine(conv),
    projectStatuses,
    effectiveWorkdir: (conv) => conversations.effectiveWorkdir(conv),
    chatSettings: (model) => config.chatSettings(model),
    memoryPrompt: async (cid) =>
      renderMemoryPrompt(
        await captureMemorySnapshot(
          cid,
          paths.DATA_DIR,
          undefined,
          conversations.treeRoot(cid),
        ),
        paths.DATA_DIR,
      ),
    boundSessionFile: (sessionId, file, cwd) =>
      backend.boundSessionFile(sessionId, file, cwd),
    now,
  });
  const contextUsage = new ContextUsage({
    boundSessionFile: (sessionId, file, cwd) =>
      backend.boundSessionFile(sessionId, file, cwd),
    staticSystemPrompt: () => prompts.staticSystemPrompt(),
    readCapturedSystemPrompt: (conv, currentTurn) =>
      prompts.readCapturedSystemPrompt(conv, currentTurn),
    config,
  });
  const turnPrep = new TurnPrep({
    conversations,
    existingNode: (cid) => nodes.existing(cid),
    config,
  });

  const importFinalized = (): boolean | null => lifecycle.importFinal;
  configActions = new ConfigActions({
    store: conversations,
    node: (cid) => nodes.node(cid),
    config,
  });
  const nodeDeps: AgentNodeDeps = {
    nodes: null as never,
    conversations,
    configActions,
    config,
    runtime: piRuntimeErrors,
    agentStore,
    importFinalized,
    setSafetyReviewOff: (cid, off) => durableHost!.setSafetyReviewOff(cid, off),
    actionRequest: (kind, cid) => parked.actionRequest(kind, cid),
    requestRun: (cid) => delivery.requestRun(cid),
    tasks,
    scheduler: timeoutScheduler,
    nodeLog: log.node,
    runtimeLog: log.runtime,
    monotonic,
    now,
    timeNs: () => Number(process.hrtime.bigint()),
    ids: newHexId,
  };
  nodes = new AgentNodes<AgentNode, NodeStore>({
    createNode: (cid, store) => new AgentNode(cid, nodeDeps, store),
    store: conversations,
  });
  nodeDeps.nodes = nodes;
  const safetyRoots = {
    repoUrl: config.repoUrl,
    repoDir: paths.REPO_DIR,
    worktrees: paths.WORKTREES,
    workdirReady: () => workdirGit.ready(),
  };
  const durable: DurableHost = new DurableHost({
    config,
    dataDir: paths.DATA_DIR,
    trashDir: paths.TRASH_DIR,
    piAgentDir: roots.piAgent,
    load: (cid, fields) =>
      conversations.load(cid, { withPending: false, fields }),
    uploadParts: (cid, text, attachmentIds) => {
      const conv = conversations.load(cid, { withPending: false });
      return turnPrep.uploadParts(
        text,
        cid,
        conv === null ? null : collectionSnapshot(conv, config),
        attachmentIds,
      );
    },
    // Invariant: Deepest first, so a resumed descendant's run is live before an
    // ancestor's reporter decides whether its report waits (report_holds.ts);
    // a side conversation opens with its host, so it shares the host's depth.
    liveIds: () => {
      const rows = conversations.allConvs({ withPending: false });
      const byId = new Map(rows.map((c) => [String(c.id), c]));
      const depth = new Map<string, number>();
      for (const id of byId.keys()) {
        let [n, hops, c] = [0, 0, byId.get(id)];
        for (; typeof c?.parent === "string" && hops < byId.size; hops++) {
          if (typeof c.side_of !== "string") n += 1;
          c = byId.get(c.parent);
        }
        depth.set(id, n);
      }
      return [...byId.keys()].sort((a, b) => depth.get(b)! - depth.get(a)!);
    },
    claimWorkdir: (cid, cwd, signal) => worktrees.hold(cwd, cid, signal, true),
    // Invariant: A side conversation runs on its parent's model: the parent's
    // Harness has one compaction policy, sized to the parent's window.
    settings: (conv) =>
      conversations.conversationSettings(
        (typeof conv.side_of === "string"
          ? conversations.load(conv.side_of, {
              withPending: false,
              fields: ["level", "model", "effort"],
            })
          : null) ?? conv,
      ),
    agentEnv: async (conv, recordTiming) => {
      let mark = performance.now();
      const phase = (name: string) => {
        const at = performance.now();
        recordTiming?.(name, at - mark);
        mark = at;
      };
      const agentTmpdir = await agentTemp.agentTempPath(conv);
      const localTmpdir = await agentTemp.agentRuntimePath(conv);
      phase("temp");
      const model = conversations.conversationSettings(conv)[0];
      const safetyOff = Boolean(conv.safety_off);
      phase("settings");
      const workspaceRoot = await piSafetyWorkspaceRoot(safetyRoots);
      const worktreesRoot = await piSafetyWorktreesRoot(safetyRoots);
      phase("safety");
      const env = await buildEnv(launch, {
        cid: String(conv.id),
        agentTmpdir,
        localTmpdir,
        model,
        safetyOff,
        workspaceRoot,
        worktreesRoot,
        workdir: conversations.effectiveWorkdir(conv),
      });
      env.RECURSE_COLLECTION_DIR = agentTemp.uploadsDir(String(conv.tmp_key));
      phase("build");
      return env;
    },

    admitFiles: (conv) =>
      agentTemp.admitUploadsDir(String(conv.id), String(conv.tmp_key)),
    promptSnapshot: async (conv, cwd) => {
      const { snapshotRecursePrompt } =
        await import("./durable/prompt_sections");
      const memory = await prompts.captureMemoryPrompt(conv);
      const resources = await durable.promptResources(cwd, roots.piAgent, []);
      return snapshotRecursePrompt(
        prompts,
        conv,
        conversations.captureDigestInputs(),
        cwd,
        memory,
        resources,
      );
    },
    stopGroup: (group) => processes.stopGroup(group),
    ownProcess: async (proc, cid) =>
      void (await processes.registerProcess(proc, "mcp", cid)),
    releaseProcess: async (proc) =>
      (await processes.cleanupProcessObject(proc)) !== false,
    log: (event, fields, level = INFO) =>
      logEvent(log.agents, level, event, { fields }),
    safetyChanged: (cid) => conversations.refreshTreeRow(cid),
    rowChanged: (cid) => conversations.refreshTreeRow(cid),
    titleSettings: () => config.resolveEffortLevel(1),
    applyTitle: (cid, title) => {
      const current = conversations.metadataSnapshot(cid);
      if (
        current &&
        (!current.parent || current.side_of) &&
        !current.title &&
        !current.title_order
      )
        nodes.node(cid).renameTitle(title, "");
    },
    operatorMessageAdmitted: (cid, at) => {
      conversations.saveActivity(cid, at, at);
    },
    // Invariant: Only top-level and taken-over agents notify, once per run
    // key in this process, after the run is reported and while commits show
    // nothing running or queued. Like reports, a crash before the cursor
    // advance may repeat one.
    report: async (cid, report) => {
      const outcome = await delivery.reportDurableRun(cid, report);
      const row = conversations.metadataSnapshot(cid);
      if (
        outcome === "done" &&
        !report.queued &&
        notifiedRuns.get(cid) !== report.key &&
        row !== null &&
        typeof row.side_of !== "string" &&
        (!row.parent || row.pinned === true) &&
        durable.reportHolds.settled(cid) &&
        nodes.pendingCount(cid) === 0
      ) {
        notifiedRuns.delete(cid);
        notifiedRuns.set(cid, report.key);
        if (notifiedRuns.size > 1000)
          notifiedRuns.delete(notifiedRuns.keys().next().value!);
        notifications.notify(finishedNotice(cid, row.title, report));
      }
      return outcome;
    },
    promotion: (cid, state) =>
      conversations.withConfigurationMetadataGuard(cid, async (token) => {
        const conv = conversations.load(cid, { withPending: false });
        if (conv === null || typeof conv.side_of !== "string") return;
        if (state === "running") {
          conv.promoting = true;
          delete conv.promotion_error;
        } else {
          delete conv.promoting;
          conv.promotion_error = state.failed;
        }
        await conversations.save(conv, token);
      }),
    // Invariant: A promoted subagent keeps the parent's model and effort,
    // which it ran on as a side conversation.
    promoted: async (cid) => {
      await conversations.withConfigurationMetadataGuard(cid, async (token) => {
        const conv = conversations.load(cid, { withPending: false });
        const parent = conv?.side_of;
        if (conv === null || typeof parent !== "string")
          throw new Error("not a side conversation");
        const settings = conversations.load(parent, {
          withPending: false,
          fields: ["level", "model", "effort"],
        });
        for (const key of ["level", "model", "effort"])
          if (settings && key in settings) conv[key] = settings[key];
          else delete conv[key];
        conv[SET_MODEL_MARKER] = true;
        delete conv.side_of;
        delete conv.promoting;
        delete conv.promotion_error;
        conv.updated = now();
        await conversations.save(conv, token);
      });
      tree.bumpTreeTopology();
    },
    // Invariant: A side conversation's main conversation is the one it was
    // forked from; once promoted, it is its parent.
    returnToMain: async (from, message) => {
      const conv = conversations.load(from, {
        withPending: false,
        fields: ["title", "side_of", "parent"],
      });
      const main = conv?.side_of ?? conv?.parent;
      if (typeof main !== "string" || !main) return null;
      return delivery.deliver(main, message, {
        start: false,
        source: "spawn",
        sender: from,
        ...(typeof conv?.side_of === "string" && {
          senderTitle: `Side conversation: ${String(conv.title || from)}`,
        }),
      });
    },
    clearingSides: (cid) => {
      for (const side of conversations.allConvs({ withPending: false }))
        if (side.side_of === cid)
          void reap.requestReap(String(side.id)).catch((error: unknown) =>
            logEvent(log.agents, WARNING, "side_conversation_reap_failed", {
              conversation_id: String(side.id),
              fields: { error: String(error) },
            }),
          );
    },
    maximumContextWindow: () => config.maximumContextWindow(),
    customProviders: () => config.customModelProviders(),
    // Invariant: Only the variable the provider itself names as env_key.
    customProviderEnvValue: (provider) => {
      const providers = config.customModelProviders();
      return Object.hasOwn(providers, provider)
        ? env[providers[provider]!.env_key]
        : undefined;
    },

    warmSettings: () => void (config.effortLevels(), config.chatModels()),
  });
  durableHost = durable;
  const touchedPrs = new TouchedPrs(conversations, tasks);

  spawnWorkdir = new SpawnWorkdir(paths.DATA_DIR, () =>
    workdirGit.defaultSpawnWorkdir(),
  );

  const worktrees = new WorktreeHolders(paths.DATA_DIR);
  create = new SupervisorCreate({
    worktrees,
    conversations,
    nodes,
    lifecycle: lease,
    config,
    importFinalized,
    spawnWorkdir,
    drafts,
    agentTemp,
    bumpTreeTopology: () => tree.bumpTreeTopology(),
    log: log.agents,
    now,
    sleep: sleepFor,
    tasks: createTasks,
    deliverPlatformNote: (cid, content) =>
      delivery.deliver(cid, content, {
        origin: "platform",
        nextTurnOnly: true,
      }),
  });
  delivery = new SupervisorDelivery({
    durable,
    conversations,
    nodes,
    agentStore,
    configActions,
    lifecycle: lease,
    buildSubmission: piRuntimeErrors.buildSubmission,
    importFinalized,
    importLegacy: async (cid, signal) => {
      const conv = conversations.load(cid, { withPending: false });
      if (conv && !durable.owns(conv)) await switchover.attempt(conv, signal);
    },
    hasActions: (cid) => parked.pendingActions(cid).length > 0,
    drainActions: (cid, signal) => tree.drainParkedPlatformActions(cid, signal),
    boundSessionFile: (sessionId, file, cwd) =>
      backend.boundSessionFile(sessionId, file, cwd),
    noteLevelTurnFailure: (level, kind) =>
      config.noteLevelTurnFailure(level, kind),
    noteLevelTurnSuccess: (level) => config.noteLevelTurnSuccess(level),
    tasks,
    signal: shutdownController.signal,
    log: log.agents,
    now,
    timeNs: () => Number(process.hrtime.bigint()),
    monotonic,
    ids: newHexId,
    sleep: sleepFor,
  });
  reads = new SupervisorReads({
    durable,
    claims: {
      metadataSnapshot: (cid) => conversations.metadataSnapshot(cid),
      existing: (cid) => nodes.existing(cid),
      topologyEpoch: () => tree.treeTopologyEpoch,
      dataDir: () => paths.DATA_DIR,
      binding: piBinding,
    },
    config,
    sessionFiles: {
      config,
      boundSessionFile: (sessionId, file, cwd) =>
        backend.boundSessionFile(sessionId, file, cwd),
    },
    boundSessionFile: (sessionId, file, cwd) =>
      backend.boundSessionFile(sessionId, file, cwd),
    pendingActions: (cid) => parked.pendingActions(cid),
    prompts,
    contextUsage,
    lstatSize: async (path) => (await lstat(path)).size,
    logWarning: (event, fields) =>
      logEvent(log.agents, WARNING, event, { fields }),
    composeLoaded: (cid, conv, withPending) =>
      conversations.composeLoaded(cid, conv, withPending),
  });
  const deferredReaps = new DeferredReaps({
    conversations,
    dropTurnSystemPrompt: (conv) => prompts.dropTurnSystemPrompt(conv),
    log: log.agents,
    now,
  });
  tree = new AgentTree({
    conversations,
    nodes,
    agentStore,
    lifecycle: lease,
    parked,
    durable,
    prompts,
    config,
    supervisor: {
      create: (o, signal) => create.create(o, signal),
      deliver: (cid, content, o) => delivery.deliver(cid, content, o),
      requestRun: (cid) => delivery.requestRun(cid),
    },
    spawnOutcomes: {
      read: (cid) => reconciler.spawnOutcomes.read(cid),
      write: (cid, status, o) => reconciler.spawnOutcomes.write(cid, status, o),
    },
    sessions: retirement,
    spawnOutcomeDir: paths.SPAWN_OUTCOME_DIR,
    logger: log.agents,
    now,
    monotonic,
  });
  reap = new SupervisorReap({
    drainTouchedPrs: () => touchedPrs.drain(),
    errors: { ProcessCleanupPending, TakenOverReapBlocked },
    conversations,
    nodes,
    lifecycle: lease,
    tree,
    deferred: deferredReaps,
    processes,
    agentStore,
    agentTemp,
    durable,
    retireLegacySession: (conv, ids, files) =>
      retirement.retireReapedSession(conv, ids, files),
    archiveLiveRecord: (cid, conv, messagePaths, date, key) =>
      reapHistory.archiveLiveRecord(cid, conv, messagePaths, date, key, {
        historyDir: paths.AGENT_HISTORY_DIR,
        trashDir: paths.TRASH_DIR,
      }),
    retireToolDetails: (cid) =>
      retireConversationDetails(cid, paths.TOOL_DETAILS_DIR, paths.TRASH_DIR),
    pruneArtifactOwner: (cid) =>
      pruneEmptyOwner(
        { artifactsDir: paths.ARTIFACTS_DIR, trashDir: paths.TRASH_DIR },
        cid,
      ),
    dropTurnSystemPrompt: (conv, dropCapture) =>
      prompts.dropTurnSystemPrompt(conv, dropCapture),
    viewCache: { drop: (cid) => reads.viewCache.drop(cid) },
    deliver: (cid, content, o) => delivery.deliver(cid, content, o),
    deliverUpward: (conv, content, o) =>
      delivery.deliverUpward(conv, content, o),
    paths: {
      msgDir: paths.MSG_DIR,
      trashDir: paths.TRASH_DIR,
      muteLockDir: paths.MUTE_LOCK_DIR,
      titleLockDir: paths.TITLE_LOCK_DIR,
      reviewerJournalRoot: join(
        env.RECURSE_SAFETY_DIR || paths.DATA_DIR,
        "reviewer-journals",
      ),
    },
    log: log.agents,
    now,
    tasks,
  });
  const revive = new SupervisorRevive({
    archive: durable.archive,
    importFrom: (path) => durable.importArchive(path),
    storageDir: (cid) => join(durable.storagePath(cid), ".."),
    load: (cid) => conversations.load(cid, { withPending: false }),
    create: (o) => create.create(o),
    revived: (cid) => durable.revived(cid),
    deliver: (cid, content, o) => delivery.deliver(cid, content, o),
    log: (event, fields, warning) =>
      logEvent(log.agents, warning ? WARNING : INFO, event, { fields }),
    tasks: createTasks,
  });
  const seed = new DeferredReapSeed({
    conversations,
    deferredReaps,
    tree,
    agentStore,
    readSpawnOutcome: (cid) => reconciler.readSpawnOutcome(cid),
    log: log.agents,
    sleep: sleepFor,
  });
  reconciler = new Reconciler<AgentNode>({
    conversations,
    nodes,
    agentStore,
    supervisor: {
      deliver: (cid, content, o) => delivery.deliver(cid, content, o),
      requestRun: (cid) => delivery.requestRun(cid),
      cancelInboxMessage: (cid, mid) => delivery.cancelInboxMessage(cid, mid),
      launchMaintenanceJob: (name, run) =>
        lifecycle.launchMaintenanceJob(name, run),
      applyReaps: (signal) => reap.applyReaps(signal),
      reconcileWatcherInboxes: (signal) =>
        lifecycle.reconcileWatcherInboxes(signal),
    },
    tree,
    shells,
    lifecycle: processes,
    drainTrash: () => agentTemp.drainTrash(),
    seedDeferredReaps: (signal) => seed.seedDeferredReapsAtStartup(signal),
    countMetric: (key, amount) => startupMetrics.count(key, amount),
    spawnOutcomeDir: paths.SPAWN_OUTCOME_DIR,
    tmpSuffix: () => newHexId().slice(0, 6),
    logger: log.reconciler,
    monotonic,
  });
  const switchover = new PiSwitchover({
    conversations,
    durable,
    nodes,
    parked,
    shells,
    processes,
    hasReports: (cid) => delivery.hasReports(cid),
    now,
    log: (event, fields) => {
      const level = event.endsWith("failed") ? WARNING : INFO;
      logEvent(log.agents, level, event, { fields });
    },
  });
  lifecycle = new SupervisorLifecycle({
    paths: {
      dataDir: paths.DATA_DIR,
      trashDir: paths.TRASH_DIR,
      convDir: paths.CONV_DIR,
    },
    conversations,
    assertLegacyImported: () => assertNoUnimportedLegacyState(paths.DATA_DIR),
    nodes,
    durable,
    switchover,
    reconciler,
    logins: {
      importClaudeCodeLogin: () => anthropic.importClaudeCodeLogin(),
      importCodexCliLogin: () => codex.importCodexCliLogin(),
    },
    agentTemp,
    processes,
    shells,
    agentStore,
    lease,
    tasks,
    joinTaskSets: [createTasks, tasks],
    shutdownController,
    log: log.agents,
    now,
    monotonic,
    sleep: sleepFor,
  });

  return {
    config,
    log,
    tasks,
    createTasks,
    shutdownController,
    shells,
    processes,
    mcpChecks,
    workdirGit,
    touchedPrs,
    backend,
    lease,
    oauth,
    notifications,
    anthropic,
    codex,
    openrouter,
    agentStore,
    conversations,
    retirement,
    skills,
    treeView,
    agentTemp,
    drafts,
    parked,
    agentTools,
    prompts,
    contextUsage,
    turnPrep,
    configActions,
    nodes,
    spawnWorkdir,
    create,
    delivery,
    reads,
    deferredReaps,
    tree,
    reap,
    revive,
    seed,
    reconciler,
    lifecycle,
    durable,
    switchover,
    // Invariant: Return once the watcher launches; its sequence runs detached.
    start: async (
      hooks: {
        /** Runs right after ensure_storage_ready (persisted logging). */
        afterStorage?: () => Promise<void>;
        /** Runs after the startup cleanup (the working-area check). */
        beforeWatcher?: () => Promise<void>;
      } = {},
    ): Promise<void> => {
      await startupMetrics.measure("ensure_storage_ready", async (step) => {
        step.count("calls");
        await lifecycle.ensureStorageReady();
      });
      await hooks.afterStorage?.();
      await startupMetrics.measure("startup_process_cleanup", () =>
        reconciler.startupProcessCleanup(shutdownController.signal),
      );
      await hooks.beforeWatcher?.();
      await spawnWorkdir.refresh();

      lifecycle.startWatcher().catch(() => undefined);
    },
    // Invariant: Shutdown is idempotent and never throws.
    shutdown: (drained?: Promise<unknown>): Promise<void> =>
      lifecycle.shutdown(drained),
  };
}

export type Instance = Awaited<ReturnType<typeof buildInstance>>;
