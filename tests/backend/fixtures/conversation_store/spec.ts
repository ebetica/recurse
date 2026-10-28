import { seedPiModelList } from "../../pi_model_list_fixture";
import { join } from "node:path";
import {
  ConversationStore,
  type ConversationRecord,
  type ConversationStorePaths,
  type ConversationStoreHooks,
} from "../../../../src/agents/conversation_store";
import { AgentStore } from "../../../../src/agents/agent_store";
import { Config } from "../../../../src/config";

export interface ConversationCase {
  record?: ConversationRecord;
  external_keys?: (string | null)[];
  title_orders?: string[];
  cid?: string;
  title?: string;
  title_order?: string;
  pinned_update?: ConversationRecord;
  stale_pinned?: ConversationRecord;
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
    externalKeyDir: join(root, "external-keys"),
    serviceBindingsDir: join(root, "service-bindings"),
    titleLockDir: join(root, "title-locks"),
    muteLockDir: join(root, "mute-locks"),
  };
}
export function fixtureHooks(root: string): ConversationStoreHooks {
  return {
    nodeInputs: () => null,
    withNodeLock: (_cid, fn, token) => fn(token ?? {}),
    liveStatus: () => ["idle", null],
    hasLiveShell: () => false,
    defaultSpawnWorkdir: () => root,
    treeRefresh: () => {},
    treeRebuild: () => {},
    treeDiscard: () => {},
    safeRemoveTempKey: () => true,
    dropNode: () => {},
    withModelGuard: (_cid, fn) => fn(),
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
