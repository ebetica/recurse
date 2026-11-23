import { seedPiModelList } from "../../pi_model_list_fixture";
import { join } from "node:path";
import {
  ConversationStore,
  type ConversationRecord,
  type ConversationStorePaths,
  type ConversationStoreHooks,
} from "../../../../src/agents/storage/conversation_store";
import { AgentStore } from "../../../../src/agents/storage/agent_store";
import { ServiceBindings } from "../../../../src/agents/storage";
import { Config } from "../../../../src/config";
import { TreeView } from "../../../../src/agents/tree_view";
import { logger } from "../../../../src/observability/runtime_logging";

export interface ConversationCase {
  record?: ConversationRecord;
  external_keys?: (string | null)[];
  title_orders?: string[];
  cid?: string;
  title?: string;
  title_order?: string;
  taken_over_update?: ConversationRecord;
  stale_taken_over?: ConversationRecord;
  model_update?: ConversationRecord;
  volatile?: ConversationRecord;
  pending_update?: ConversationRecord;
  interaction?: ConversationRecord;
  clear_pending?: ConversationRecord;
  session?: ConversationRecord;
  draft?: ConversationRecord;
  unbound?: null;
}
export function paths(root: string): ConversationStorePaths {
  return {
    dataDir: root,
    titleLockDir: join(root, "title-locks"),
    muteLockDir: join(root, "mute-locks"),
  };
}
export function fixtureBindings(
  root: string,
  store: ConversationStore,
): ServiceBindings {
  return new ServiceBindings(
    {
      externalKeyDir: join(root, "external-keys"),
      serviceBindingsDir: join(root, "service-bindings"),
    },
    {
      exists: (cid) => store.convRowExists(cid),
      load: (cid, options) => store.load(cid, options),
      log: store.hooks.log,
    },
    () => store.ids(),
  );
}
export function fixtureHooks(root: string): ConversationStoreHooks {
  return {
    inbox: () => [],
    defaultSpawnWorkdir: () => root,
    onRowsChanged: () => {},
  };
}
export function fixtureStore(root: string): ConversationStore {
  const config = new Config({
    env: {
      CHAT_DATA_DIR: root,
      HOME: root,
      RECURSE_HOME: join(root, "settings"),
    },
  });
  seedPiModelList(config.paths.CONFIG_DIR);
  return new ConversationStore(
    paths(root),
    new AgentStore(join(root, "agents")),
    fixtureHooks(root),
    config,
  );
}

export function fixtureTreeView(store: ConversationStore): TreeView {
  return new TreeView({
    records: store,
    node: () => null,
    liveStatus: () => ["idle", null],
    durableSafetyOff: () => false,
    hasLiveShell: () => false,
    skills: {
      contextForWorkdirLoopSafe: (w) => (w === null ? null : `loop:${w}`),
      renderer: () => async (w) => (w === null ? null : `full:${w}`),
    },
    logger: logger("agents", { write: () => {} }),
  });
}
