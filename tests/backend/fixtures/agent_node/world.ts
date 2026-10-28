// Wiring for AgentNode tests: the real AgentStore, ConversationStore,
// ConfigActions and AgentNodes over one private root, with explicit clocks,
// ids, loggers and scheduler for admission/config/registry/supervisor tests.
import { seedPiModelList } from "../../pi_model_list_fixture";
import { join } from "node:path";
import { AgentStore } from "../../../../src/agents/agent_store";
import {
  ConversationStore,
  type ConversationStoreHooks,
} from "../../../../src/agents/conversation_store";
import {
  AgentNode,
  type AgentNodeDeps,
  type NodeStore,
} from "../../../../src/agents/runtime/agent_node";
import { AgentNodes } from "../../../../src/agents/runtime/agent_nodes";
import { ConfigActions } from "../../../../src/agents/runtime/config_actions";
import { piRuntimeErrors } from "../../../../src/agents/runtime/runtime_factory";
import type { TimerHandle } from "../../../../src/agents/runtime/stall_timer";
import { Config } from "../../../../src/config";
import {
  RuntimeLogger,
  type LogSink,
} from "../../../../src/observability/runtime_logging";
import { TaskSet } from "../../../../src/utils/tasks";

export interface Clock {
  mono: number;
  wall: number;
}

export interface WorldOptions {
  root: string;
  clock?: Clock;
  storeIds?: () => string;
  msgIds?: () => string;
  sink: LogSink;
  scheduler: AgentNodeDeps["scheduler"];
  importFinalized?: () => boolean | null;
  actionRequest?: AgentNodeDeps["actionRequest"];
  requestRun?: (cid: string) => void;
  defaultSpawnWorkdir?: string;
  /** false leaves Pi's model list unknown, so a scripted test model runs. */
  seedPiModels?: boolean;
}

export function counter(prefix: string, width: number): () => string {
  let n = 0;
  return () => `${prefix}${(++n).toString(16).padStart(width, "0")}`;
}

export interface World {
  agentStore: AgentStore;
  conversations: ConversationStore;
  nodes: AgentNodes<AgentNode, NodeStore>;
  configActions: ConfigActions;
  config: Config;
  deps: AgentNodeDeps;
  tasks: TaskSet;
}

export function buildWorld(options: WorldOptions): World {
  const { root } = options;
  const clock = options.clock;
  const monotonic = clock ? () => clock.mono : () => performance.now() / 1000;
  const now = clock ? () => clock.wall : () => Date.now() / 1000;
  const agentStore = new AgentStore(join(root, "agents"), {
    ids: options.storeIds,
    now,
  });
  const config = new Config({
    env: {
      CHAT_DATA_DIR: root,
      HOME: root,
      RECURSE_HOME: join(root, "settings"),
    },
  });
  if (options.seedPiModels !== false) seedPiModelList(config.paths.CONFIG_DIR);
  let nodes!: AgentNodes<AgentNode, NodeStore>;
  const hooks: ConversationStoreHooks = {
    nodeInputs: (cid) => {
      const node = nodes.existing(cid);
      return node === null
        ? null
        : {
            muteDesired: node.muteDesired,
            safetyDesired: node.safetyDesired,
            pendingCount: node.pendingIntents().length,
            inbox: node.inboxMessages(),
            activityUpdated: node.activityUpdated(),
          };
    },
    withNodeLock: (cid, fn, token) => nodes.node(cid).withLock(fn, token),
    liveStatus: () => ["idle", null],
    hasLiveShell: () => false,
    defaultSpawnWorkdir: () => options.defaultSpawnWorkdir ?? root,
    treeRefresh: () => {},
    treeRebuild: () => {},
    treeDiscard: () => {},
    safeRemoveTempKey: () => true,
    dropNode: (cid) => nodes.dropNode(cid),
    withModelGuard: (_cid, fn) => fn(),
  };
  const conversations = new ConversationStore(
    {
      dataDir: root,
      externalKeyDir: join(root, "external-keys"),
      serviceBindingsDir: join(root, "service-bindings"),
      titleLockDir: join(root, "title-locks"),
      muteLockDir: join(root, "mute-locks"),
    },
    agentStore,
    hooks,
    config,
  );
  const configActions = new ConfigActions({
    store: conversations,
    node: (cid) => nodes.node(cid),
    config,
  });
  const tasks = new TaskSet(() => {});
  const nodeLog = new RuntimeLogger("recurse.agents.node", options.sink, 10);
  const runtimeLog = new RuntimeLogger(
    "recurse.agents.runtime",
    options.sink,
    10,
  );
  const deps: AgentNodeDeps = {
    nodes: null as never,
    conversations,
    configActions,
    config,
    runtime: piRuntimeErrors,
    agentStore,
    importFinalized: options.importFinalized ?? (() => true),
    actionRequest: options.actionRequest ?? (() => null),
    requestRun: options.requestRun ?? (() => {}),
    tasks,
    scheduler: options.scheduler,
    nodeLog,
    runtimeLog,
    monotonic,
    now,
    timeNs: () => Math.trunc(now()) * 1_000_000_000,
    ids: options.msgIds ?? (() => crypto.randomUUID().replaceAll("-", "")),
  };
  nodes = new AgentNodes<AgentNode, NodeStore>({
    createNode: (cid, store) => new AgentNode(cid, deps, store),
    store: conversations,
  });
  deps.nodes = nodes;
  return {
    agentStore,
    conversations,
    nodes,
    configActions,
    config,
    deps,
    tasks,
  };
}

/** A recording call_later over no real timers. */
export class FakeScheduler {
  timers: { delay: number; fn: () => void; cancelled: boolean }[] = [];
  callLater(delay: number, fn: () => void): TimerHandle {
    const entry = {
      delay: Math.round(delay * 1e6) / 1e6,
      fn,
      cancelled: false,
    };
    this.timers.push(entry);
    return { cancel: () => void (entry.cancelled = true) };
  }
}
