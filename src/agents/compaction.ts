// Parked clear/compact requests: one volatile slot per conversation/action.
// New requests replace unapplied ones; crashes lose them and clients retry.
// Consume only after success. Admit/select under the conversation guard;
// native work runs outside it, parking never needs an instance storage lease.
import type { ConversationRecord } from "./conversation_store";

export type ActionKind = "clear" | "compact";

export interface ActionRequest {
  id: string;
  action: string;
  action_id: unknown;
  requested_at: number | null;
}

export interface QueuedAction {
  id: string;
  action: string;
  queued: boolean;
}

export interface CompactionDeps {
  load(
    cid: string,
  ): ConversationRecord | null | Promise<ConversationRecord | null>;
  /** Select the live backend and admit its action under the owner's guard. */
  admitContextAction?(
    cid: string,
    action: ActionKind,
    park: () => Promise<QueuedAction | null>,
  ): Promise<QueuedAction | null>;
  requestRun(cid: string): void;
  newActionId(): string;
  /** Wall-clock seconds (time.time). */
  now(): number;
}

type Slot = Record<string, unknown>;

export class ParkedActions {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly deps: CompactionDeps) {}

  private static key(cid: string, action: string): string {
    return JSON.stringify([cid, action]);
  }

  private park(action: string, cid: string, payload: Slot): void {
    this.slots.set(ParkedActions.key(cid, action), { ...payload });
  }

  /** Conversations with a parked request for one action (tick scan). */
  parkedActionCids(action: string): string[] {
    const out: string[] = [];
    for (const key of this.slots.keys()) {
      const [cid, parked] = JSON.parse(key) as [string, string];
      if (parked === action) out.push(cid);
    }
    return out;
  }

  dropParkedAction(action: string, cid: string): void {
    this.slots.delete(ParkedActions.key(cid, action));
  }

  clearParkedActions(): void {
    this.slots.clear();
  }

  /** The parked request plus its identity, if any. */
  actionRequest(action: string, cid: string): ActionRequest | null {
    const parked = this.slots.get(ParkedActions.key(cid, action));
    if (parked === undefined) return null;
    const at = parked.requested_at;
    return {
      id: cid,
      action,
      action_id: parked.action_id ?? null,
      requested_at: typeof at === "number" ? at : null,
    };
  }

  /** Drop the slot only when its identity still matches; true if dropped. */
  consumeActionBatch(request: unknown): boolean {
    if (
      request === null ||
      typeof request !== "object" ||
      Array.isArray(request)
    )
      return false;
    const r = request as Record<string, unknown>;
    const key = JSON.stringify([r.id ?? null, r.action ?? null]);
    const parked = this.slots.get(key);
    if (parked === undefined) return false;
    const actionId = r.action_id ?? null;
    if (actionId !== null && (parked.action_id ?? null) !== actionId)
      return false;
    this.slots.delete(key);
    return true;
  }

  private async queueContextAction(
    cid: string,
    action: ActionKind,
  ): Promise<QueuedAction | null> {
    const conv = await this.deps.load(cid);
    if (!conv || Object.keys(conv).length === 0) return null;
    const running = conv.status === "running";
    const payload: Slot = {
      action_id: this.deps.newActionId(),
      requested_at: this.deps.now(),
    };
    this.park(action, cid, payload);
    return { id: cid, action, queued: running };
  }

  private async guarded(
    cid: string,
    action: ActionKind,
  ): Promise<QueuedAction | null> {
    const park = () => this.queueContextAction(cid, action);
    const result = await (this.deps.admitContextAction
      ? this.deps.admitContextAction(cid, action, park)
      : park());
    if (result !== null) this.deps.requestRun(cid);
    return result;
  }

  /** HTTP seam: acknowledge only after the compact request is parked. */
  requestCompact(cid: string): Promise<QueuedAction | null> {
    return this.guarded(cid, "compact");
  }

  /** HTTP seam: acknowledge only after the clear request is parked. */
  requestClear(cid: string): Promise<QueuedAction | null> {
    return this.guarded(cid, "clear");
  }

  /** Actions not yet applied; clear first. */
  pendingActions(cid: string): string[] {
    if (this.actionRequest("clear", cid) !== null) return ["clear"];
    if (this.actionRequest("compact", cid) !== null) return ["compact"];
    return [];
  }
}
