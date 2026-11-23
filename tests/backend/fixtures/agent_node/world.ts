// Wiring for AgentNode tests: the real AgentStore, ConversationStore,
// ConfigActions and AgentNodes over one private root, with explicit clocks,
// ids, loggers and scheduler for admission/config/registry/supervisor tests.
import { seedPiModelList } from "../../pi_model_list_fixture";
import { fixtureBindings } from "../conversation_store/spec";
import { join } from "node:path";
import { AgentStore } from "../../../../src/agents/storage/agent_store";
import {
  ConversationStore,
  type ConversationStoreHooks,
} from "../../../../src/agents/storage/conversation_store";
import {
  AgentNode,
  type AgentNodeDeps,
  type NodeStore,
} from "../../../../src/agents/runtime/agent_node";
import { AgentNodes } from "../../../../src/agents/runtime/agent_nodes";
import { ConfigActions } from "../../../../src/agents/runtime/config_actions";
import { piRuntimeErrors } from "../../../../src/agents/runtime/runtime_factory";
import { Config } from "../../../../src/config";
import {
  RuntimeLogger,
  type LogSink,
} from "../../../../src/observability/runtime_logging";
import { TaskSet } from "../../../../src/utils/tasks";

interface Clock {
  mono: number;
  wall: number;
}

interface WorldOptions {
  root: string;
  lockPaths?: Pick<ConversationStore["paths"], "titleLockDir" | "muteLockDir">;
  clock?: Clock;
  storeIds?: () => string;
  /** A test Worker module for the agent store; see fixtures/agent_store. */
  storeWorkerUrl?: string;
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

interface World {
  agentStore: AgentStore;
  conversations: ConversationStore;
  serviceBindings: ReturnType<typeof fixtureBindings>;
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
    workerUrl: options.storeWorkerUrl,
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
    inbox: (cid) => nodes.existing(cid)?.inboxMessages() ?? [],
    defaultSpawnWorkdir: () => options.defaultSpawnWorkdir ?? root,
    onRowsChanged: () => {},
  };
  const conversations = new ConversationStore(
    {
      dataDir: root,
      titleLockDir: join(root, "title-locks"),
      muteLockDir: join(root, "mute-locks"),
      ...options.lockPaths,
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
    refreshTreeRow: () => {},
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
    serviceBindings: fixtureBindings(root, conversations),
    nodes,
    configActions,
    config,
    deps,
    tasks,
  };
}
