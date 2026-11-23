// Mute desires park on the node while its runner owns disk state.
// Model/effort stays pending until the next operator message is admitted.
// Nested guards require explicit live tokens, never ambient ownership; a node
// token names the node that issued it. Locks go title → node → mute.
import {
  THINKING_LEVELS,
  type EffortLadder,
  type ModelCatalog,
  type Thinking,
} from "../../models";
import {
  CID_RE,
  CLEAR_PENDING_MODEL_MARKER,
  SET_MODEL_MARKER,
  SET_PENDING_MODEL_MARKER,
  validLevel,
  type ConversationGuardToken,
  type ConversationRecord,
  type ConversationStore,
} from "../storage";
import type { AgentNode } from "./agent_node";
import { invalidateContextUsage } from "./context_usage";

type ConfigNode = Pick<AgentNode, "cid" | "muteDesired" | "withLock">;

interface ConfigActionsDeps {
  store: ConversationStore;
  node(cid: string): ConfigNode;
  config: {
    models: Pick<
      ModelCatalog,
      "chatModel" | "chatSettings" | "isFileProviderModel"
    >;
    levels: Pick<EffortLadder, "resolveEffortLevel" | "ladderHome">;
  };
}

const isDict = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const pyTruthy = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : isDict(value)
      ? Object.keys(value).length > 0
      : Boolean(value);
const thinking = (value: string): Thinking | null =>
  (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as Thinking)
    : null;

export const SAFETY_OFF_NOTICE =
  "[Safety review turned OFF] The operator has turned off the per-action " +
  "safety review for this conversation. The change applies to your next action: " +
  "bash, write, and edit actions run WITHOUT any review or approval " +
  "— nothing will stop a destructive or irreversible command, so weigh every " +
  "side-effecting action yourself and proceed with care. Review stays off until " +
  "the operator turns it back on.";

export const SAFETY_ON_NOTICE =
  "[Safety review turned ON] The operator has turned the per-action safety " +
  "review back on for this conversation. The change applies to your next action: " +
  "bash, write, and edit actions are reviewed before they " +
  "run.";

export class ConfigActions {
  private readonly muteNodeTokens = new WeakMap<
    ConversationGuardToken,
    object
  >();
  // Invariant: A held node token maps to the node whose lock issued it.
  private readonly lockedNodes = new WeakMap<object, ConfigNode>();

  constructor(private readonly deps: ConfigActionsDeps) {}

  withNodeGuard<T>(
    cid: string,
    fn: (nodeToken: object) => Promise<T>,
    nodeToken?: object,
  ): Promise<T> {
    if (typeof cid !== "string" || !CID_RE.test(cid))
      throw new Error("invalid conversation id for guard");
    const held =
      nodeToken === undefined ? undefined : this.lockedNodes.get(nodeToken);
    if (held !== undefined && held.cid !== cid)
      throw new Error("mismatched conversation node guard");
    const node = held ?? this.deps.node(cid);
    return node.withLock(async (token) => {
      if (token === nodeToken) return fn(token);
      this.lockedNodes.set(token, node);
      try {
        return await fn(token);
      } finally {
        this.lockedNodes.delete(token);
      }
    }, nodeToken);
  }

  private lockedNode(nodeToken: object): ConfigNode {
    const node = this.lockedNodes.get(nodeToken);
    if (node === undefined) throw new Error("inactive conversation node guard");
    return node;
  }

  withMuteGuard<T>(
    cid: string,
    fn: (muteToken: ConversationGuardToken, nodeToken: object) => Promise<T>,
    muteToken?: ConversationGuardToken,
  ): Promise<T> {
    if (typeof cid !== "string" || !CID_RE.test(cid))
      throw new Error("invalid conversation id for guard");
    const nodeToken =
      muteToken === undefined ? undefined : this.muteNodeTokens.get(muteToken);
    return this.withNodeGuard(
      cid,
      (heldNode) =>
        this.deps.store.withMuteGuard(
          cid,
          (heldMute) => {
            this.muteNodeTokens.set(heldMute, heldNode);
            return fn(heldMute, heldNode);
          },
          muteToken,
        ),
      nodeToken,
    );
  }

  /** Acquire title → node → mute. */
  withConfigurationMetadataGuard<T>(
    cid: string,
    fn: (
      titleToken: ConversationGuardToken,
      muteToken: ConversationGuardToken,
      nodeToken: object,
    ) => Promise<T>,
  ): Promise<T> {
    return this.deps.store.withTitleGuard(cid, (titleToken) =>
      this.withMuteGuard(cid, (muteToken, nodeToken) =>
        fn(titleToken, muteToken, nodeToken),
      ),
    );
  }

  /** Apply the node's desired mute flag to the runner-owned record. */
  applyPendingMute(
    conv: ConversationRecord,
    muteToken?: ConversationGuardToken,
  ): Promise<boolean> {
    const cid = conv.id as string;
    return this.withMuteGuard(
      cid,
      async (_muteToken, nodeToken) => {
        const node = this.lockedNode(nodeToken);
        const desired = node.muteDesired;
        if (desired === null) return false;
        conv.muted = desired;
        node.muteDesired = null;
        return true;
      },
      muteToken,
    );
  }

  /** Desire `muted` on the locked node while `conv` runs; else clear it. */
  requestMute(
    conv: ConversationRecord,
    muted: boolean,
    nodeToken: object,
  ): void {
    this.lockedNode(nodeToken).muteDesired =
      conv.status === "running" ? muted : null;
  }

  /** Current mute state while holding this conversation's node lock. */
  mutedLocked(conv: ConversationRecord, nodeToken: object): boolean {
    const desired = this.lockedNode(nodeToken).muteDesired;
    if (desired !== null) return desired;
    return pyTruthy(conv.muted);
  }

  /** Apply and consume the durable composer model intent on admission. */
  applyPendingModel(conv: ConversationRecord): boolean {
    const { store } = this.deps;
    const raw = conv.pending_model;
    if (!isDict(raw)) return false;
    const value = raw.model;
    if (typeof value !== "string") return false;
    const desired = value;
    const wantReasoning =
      typeof raw.effort === "string" ? thinking(raw.effort) : null;
    if (wantReasoning === null)
      throw new Error(
        "No recorded reasoning for the selected model. Pick an effort level again for this conversation.",
      );
    // Invariant: Admission preserves the model resolved at level selection.
    const selectedLevel = validLevel(raw.level);
    const home: [number, string, string] | null =
      selectedLevel !== null ? [selectedLevel, desired, wantReasoning] : null;

    const before = store.conversationSettings(conv);
    if (home !== null) {
      const [level, model, reasoning] = home;
      conv.level = level;
      conv.model = model;
      conv.effort = reasoning;
    } else {
      const previous = conv.model;
      delete conv.level;
      if (typeof previous === "string" && previous !== desired)
        conv.legacy_model = previous;
      conv.model = desired;
      conv.effort = wantReasoning;
    }
    delete conv.pending_model;
    conv[CLEAR_PENDING_MODEL_MARKER] = true;
    conv[SET_MODEL_MARKER] = true;
    const changed = before[0] !== conv.model || before[1] !== conv.effort;
    if (changed) invalidateContextUsage(conv);
    return changed;
  }

  // Consume one pending model intent after an operator-originated message is
  // admitted.
  applyPendingModelAtAdmission(cid: string): Promise<boolean> {
    const { store } = this.deps;
    return this.withConfigurationMetadataGuard(cid, async (titleToken) => {
      const conv = store.load(cid, { withPending: false });
      if (conv === null || !isDict(conv.pending_model)) return false;
      this.applyPendingModel(conv);
      await store.save(conv, titleToken);
      return true;
    });
  }

  /** Durably record the next model/effort choice without applying it. */
  requestModelChange(
    cid: string,
    model: string,
    effort: string | null = null,
    level: number | null = null,
    operatorSelectedModel = false,
  ): Promise<Record<string, unknown> | null> {
    const { config, store } = this.deps;
    return this.withConfigurationMetadataGuard(cid, async (titleToken) => {
      const conv = store.load(cid, { withPending: false });
      if (!pyTruthy(conv)) return null;
      let resolved: string;
      try {
        resolved = config.models.chatModel(model).id;
      } catch {
        return null;
      }
      if (
        config.models.isFileProviderModel(resolved) &&
        level === null &&
        !operatorSelectedModel
      )
        return null;
      if (level !== null) {
        if (validLevel(level) === null) return null;
        const [levelModel, levelReasoning] =
          config.levels.resolveEffortLevel(level);
        if (levelModel !== resolved) return null;
        if (effort === null || effort === "default") effort = levelReasoning;
      }
      const payload: Record<string, unknown> = { model: resolved };
      if (effort !== null) {
        const parsed = thinking(effort);
        if (parsed !== null) payload.effort = parsed;
        else if (effort !== "default") return null;
        else payload.effort = "default";
      }
      let selectedLevel = level;
      if (selectedLevel === null) {
        const wanted = payload.effort;
        const home = config.levels.ladderHome(
          resolved,
          wanted === undefined || wanted === "default" ? null : wanted,
        );
        if (home !== null) {
          selectedLevel = home[0];
          payload.effort = home[2];
        }
      }
      if (payload.effort === undefined || payload.effort === "default")
        payload.effort = config.models.chatSettings(resolved)[1];
      if (selectedLevel !== null) payload.level = selectedLevel;
      conv!.pending_model = payload;
      // Invariant: Save carries this request forward over stale runner
      // snapshots.
      conv![SET_PENDING_MODEL_MARKER] = true;
      await store.save(conv!, titleToken);
      return {
        id: cid,
        model: resolved,
        effort: payload.effort ?? null,
        level: selectedLevel,
        pending_model: payload,
      };
    });
  }
}
