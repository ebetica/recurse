// Mute/safety desires park on the node while its runner owns disk state.
// Model/effort stays pending until the next operator message is admitted.
// Nested guards require explicit live tokens, never ambient ownership.
import { THINKING_LEVELS, type Config, type Thinking } from "../../config";
import {
  CLEAR_PENDING_MODEL_MARKER,
  SET_MODEL_MARKER,
  SET_PENDING_MODEL_MARKER,
  validLevel,
  type ConversationGuardToken,
  type ConversationRecord,
  type ConversationStore,
} from "../conversation_store";

export interface NodeCache {
  muteDesired: boolean | null;
  safetyDesired: boolean | null;
}

export interface ConfigActionsDeps {
  store: ConversationStore;
  node(cid: string): NodeCache;
  config: Pick<
    Config,
    "chatModel" | "chatSettings" | "resolveEffortLevel" | "ladderHome"
  >;
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
  constructor(private readonly deps: ConfigActionsDeps) {}

  /** Apply the node's desired mute flag to the runner-owned record. */
  applyPendingMute(
    conv: ConversationRecord,
    muteToken?: ConversationGuardToken,
  ): Promise<boolean> {
    const cid = conv.id as string;
    return this.deps.store.withMuteGuard(
      cid,
      async () => {
        const node = this.deps.node(cid);
        const desired = node.muteDesired;
        if (desired === null) return false;
        conv.muted = desired;
        node.muteDesired = null;
        return true;
      },
      muteToken,
    );
  }

  /** Current mute state while holding this conversation's mute lock. */
  mutedLocked(conv: ConversationRecord): boolean {
    const desired = this.deps.node(conv.id as string).muteDesired;
    if (desired !== null) return desired;
    return pyTruthy(conv.muted);
  }

  /** Set the wake-policy mute flag as one guarded record write. */
  requestMute(
    cid: string,
    muted: unknown,
    tokens?: [ConversationGuardToken, ConversationGuardToken],
  ): Promise<{ id: string; muted: boolean } | null> {
    if (typeof muted !== "boolean") return Promise.resolve(null);
    const { store } = this.deps;
    return store.withTitleGuard(
      cid,
      (titleToken) =>
        store.withMuteGuard(
          cid,
          async () => {
            const conv = store.load(cid);
            if (!pyTruthy(conv) || !pyTruthy(conv!.parent)) return null;
            this.deps.node(cid).muteDesired = muted;
            if (conv!.status !== "running") {
              conv!.muted = muted;
              // Invariant: The settled record is authoritative while idle.
              this.deps.node(cid).muteDesired = null;
              await store.save(conv!, titleToken);
            } else {
              // Invariant: No save while running: the node cache is the visible
              // state.
              store.refreshTreeRow(cid);
            }
            return { id: cid, muted };
          },
          tokens?.[1],
        ),
      tokens?.[0],
    );
  }

  /** Flip this conversation's wake-policy mute flag. */
  toggleMute(cid: string): Promise<{ id: string; muted: boolean } | null> {
    const { store } = this.deps;
    return store.withTitleGuard(cid, (titleToken) =>
      store.withMuteGuard(cid, async (muteToken) => {
        const conv = store.load(cid);
        if (!pyTruthy(conv) || !pyTruthy(conv!.parent)) return null;
        return this.requestMute(cid, !this.mutedLocked(conv!), [
          titleToken,
          muteToken,
        ]);
      }),
    );
  }

  /** The node's desired safety state (or null if never overridden). */
  drainSafety(cid: string, nodeToken?: object): Promise<boolean | null> {
    return this.deps.store.withSafetyGuard(
      cid,
      async () => this.deps.node(cid).safetyDesired,
      nodeToken,
    );
  }

  /** Apply the node's desired safety flag into `conv.safety_off`. */
  applyPendingSafety(
    conv: ConversationRecord,
    nodeToken?: object,
  ): Promise<boolean> {
    const cid = conv.id as string;
    return this.deps.store.withSafetyGuard(
      cid,
      async () => {
        const record = this.deps.node(cid);
        const desired = record.safetyDesired;
        if (desired === null) return false;
        const changed = pyTruthy(conv.safety_off) !== desired;
        conv.safety_off = desired;
        record.safetyDesired = null;
        return changed;
      },
      nodeToken,
    );
  }

  /** Current DESIRED safety-off state, cache-first. */
  safetyOffLocked(conv: ConversationRecord): boolean {
    const desired = this.deps.node(conv.id as string).safetyDesired;
    if (desired !== null) return desired;
    return pyTruthy(conv.safety_off);
  }

  /** Whether per-action review is OFF right now (the launched value). */
  safetyEffectiveOff(conv: ConversationRecord): boolean {
    if (conv.status === "running") {
      const active = pyTruthy(conv.active_turn) ? conv.active_turn : {};
      if (isDict(active) && "safety_off" in active)
        return pyTruthy(active.safety_off);
    }
    return this.safetyOffLocked(conv);
  }

  /** Serialize a model switch against the running turn's drains. */
  withModelGuard<T>(
    cid: string,
    fn: () => Promise<T>,
    nodeToken?: object,
  ): Promise<T> {
    return this.deps.store.hooks.withNodeLock(cid, () => fn(), nodeToken);
  }

  /** Apply and consume the durable composer model intent on admission. */
  applyPendingModel(conv: ConversationRecord): boolean {
    const { config, store } = this.deps;
    const raw = conv.pending_model;
    if (!isDict(raw)) return false;
    const value = raw.model;
    if (typeof value !== "string") return false;
    let desired: string;
    try {
      desired = config.chatModel(value).id;
    } catch {
      return false;
    }
    const effort = raw.effort ?? null;
    if (effort !== null && typeof effort !== "string") return false;
    let wantReasoning: string | null = null;
    if (effort !== null && effort !== "default") {
      wantReasoning = thinking(effort);
      if (wantReasoning === null) return false;
    }
    // Invariant: A level captured with the request is authoritative while it
    // still resolves to the requested model/reasoning; otherwise use the home.
    const selectedLevel = validLevel(raw.level);
    let home: [number, string, string] | null = null;
    if (selectedLevel !== null) {
      const [levelModel, levelReasoning] =
        config.resolveEffortLevel(selectedLevel);
      if (
        levelModel === desired &&
        (effort === null ||
          effort === "default" ||
          levelReasoning === wantReasoning)
      )
        home = [selectedLevel, levelModel, levelReasoning];
    }
    if (home === null) home = config.ladderHome(desired, wantReasoning);

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
      conv.effort = wantReasoning ?? config.chatSettings(desired)[1];
    }
    delete conv.pending_model;
    conv[CLEAR_PENDING_MODEL_MARKER] = true;
    conv[SET_MODEL_MARKER] = true;
    const changed = before[0] !== conv.model || before[1] !== conv.effort;
    if (changed) store.invalidateContextUsage(conv);
    return changed;
  }

  // Consume one pending model intent after an operator-originated message is
  // admitted.
  applyPendingModelAtAdmission(cid: string): Promise<boolean> {
    const { store } = this.deps;
    return this.withModelGuard(cid, async () => {
      const conv = store.load(cid, { withPending: false });
      if (conv === null || !isDict(conv.pending_model)) return false;
      this.applyPendingModel(conv);
      await store.save(conv);
      return true;
    });
  }

  /** Durably record the next model/effort choice without applying it. */
  requestModelChange(
    cid: string,
    model: string,
    effort: string | null = null,
    level: number | null = null,
  ): Promise<Record<string, unknown> | null> {
    const { config, store } = this.deps;
    return store.withConfigurationMetadataGuard(cid, async (titleToken) => {
      const conv = store.load(cid, { withPending: false });
      if (!pyTruthy(conv)) return null;
      let resolved: string;
      try {
        resolved = config.chatModel(model).id;
      } catch {
        return null;
      }
      if (level !== null) {
        if (validLevel(level) === null) return null;
        const [levelModel, levelReasoning] = config.resolveEffortLevel(level);
        if (levelModel !== resolved) return null;
        if (effort === null) effort = levelReasoning;
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
        const home = config.ladderHome(
          resolved,
          wanted === undefined || wanted === "default" ? null : wanted,
        );
        if (home !== null) selectedLevel = home[0];
      }
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
