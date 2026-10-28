// Live AgentNode registry: one owner per conversation; Durable owns Harnesses.
// Await-free check/insert prevents duplicate owners; expose desired
// mute/safety.
import type { ConversationRecord } from "../conversation_store";

export interface RegistryNode<S> {
  store: S | null;
  readonly reaping: boolean;
  muteDesired: boolean | null;
  safetyDesired: boolean | null;
  readonly turnTask: Promise<void> | null;
  submit(
    kind: string,
    body: Record<string, unknown>,
    first: boolean,
  ): string | null;
  uncertainIntents(): Record<string, unknown>[];
  pendingIntents(): Record<string, unknown>[];
  dropStall(): void;
}

export interface AgentNodesDeps<N extends RegistryNode<S>, S> {
  createNode(cid: string, store: S | null): N;
  store: {
    convRowExists(cid: string): boolean;
    load(
      cid: string,
      options: { withPending?: boolean },
    ): ConversationRecord | null;
  };
}

export class AgentNodes<N extends RegistryNode<S>, S = unknown> {
  private readonly nodes = new Map<string, N>();

  constructor(private readonly deps: AgentNodesDeps<N, S>) {}

  // Create a live node on first touch. Bind a later store only to a store-less
  // node; an already bound node keeps its store.
  node(cid: string, store: S | null = null): N {
    const existing = this.nodes.get(cid);
    if (existing !== undefined) {
      if (store !== null && existing.store === null) existing.store = store;
      return existing;
    }
    const created = this.deps.createNode(cid, store);
    this.nodes.set(cid, created);
    return created;
  }

  // Admit without resurrecting reap: reject absent records and reap_deferred.
  // Submit revalidates the memory fence in the same await-free block.
  admit(
    cid: string,
    kind: string,
    body: Record<string, unknown>,
    options: { first?: boolean; store?: S | null } = {},
  ): string | null {
    if (!this.deps.store.convRowExists(cid)) return null;
    const doomed = this.deps.store.load(cid, { withPending: false });
    if (doomed !== null && pyTruthy(doomed.reap_deferred)) return null;
    return this.node(cid, options.store ?? null).submit(
      kind,
      body,
      options.first ?? false,
    );
  }

  /** The live node for cid without creating one. Read paths only. */
  existing(cid: string): N | null {
    return this.nodes.get(cid) ?? null;
  }

  /** Live node ids. O(live), never a scan. */
  nodeCids(): string[] {
    return [...this.nodes.keys()];
  }

  /** Surviving unfinished work for a conversation: no replay implied. */
  uncertainIntents(cid: string): Record<string, unknown>[] {
    return this.nodes.get(cid)?.uncertainIntents() ?? [];
  }

  /** Inbox rows the thread shows: pending intents only, never in-flight. */
  pendingCount(cid: string): number {
    return this.nodes.get(cid)?.pendingIntents().length ?? 0;
  }

  /** Whether a permanent reap owns this conversation (the node fence). */
  retiring(cid: string): boolean {
    return this.existing(cid)?.reaping === true;
  }

  /** Loop-side membership+retiring revalidation. Sync; no await. */
  ownerAdmits(cid: string): boolean {
    if (this.retiring(cid)) return false;
    return this.deps.store.convRowExists(cid);
  }

  /** Forget cached intent for a removed conversation (reap path). */
  dropNode(cid: string): void {
    const node = this.nodes.get(cid);
    this.nodes.delete(cid);
    if (node !== undefined) node.dropStall();
  }

  /** Test hook: reset all cached intent. */
  clearNodes(): void {
    const nodes = [...this.nodes.values()];
    this.nodes.clear();
    for (const node of nodes) node.dropStall();
  }

  /** Every registered runner task, for shutdown cancellation. */
  allTurnTasks(): Promise<void>[] {
    const out: Promise<void>[] = [];
    for (const node of this.nodes.values())
      if (node.turnTask !== null) out.push(node.turnTask);
    return out;
  }
}

/** Python bool() over a JSON value. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object")
    return Object.keys(value).length > 0;
  return Boolean(value);
}
