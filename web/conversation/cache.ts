import type { Conversation } from "../types.js";

export const MAX_CACHED_CONVERSATIONS = 8;

/** Only a real view promotes an entry; prefetched entries are evicted first. */
export class ConversationCache {
  private readonly entries = new Map<string, Conversation>();
  private readonly unviewed = new Set<string>();
  constructor(private readonly limit = MAX_CACHED_CONVERSATIONS) {}

  peek(id: string): Conversation | undefined {
    return this.entries.get(id);
  }
  view(id: string): Conversation | undefined {
    const conv = this.entries.get(id);
    if (!conv) return undefined;
    this.unviewed.delete(id);
    this.entries.delete(id);
    this.entries.set(id, conv);
    return conv;
  }
  set(id: string, conv: Conversation, viewed = false): void {
    const existed = this.entries.has(id);
    if (viewed) {
      this.entries.delete(id);
      this.entries.set(id, conv);
      this.unviewed.delete(id);
    } else {
      this.entries.set(id, conv);
      if (!existed) this.unviewed.add(id);
    }
    while (this.entries.size > this.limit) {
      const oldest =
        this.unviewed.values().next().value ?? this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
  delete(id: string): void {
    this.entries.delete(id);
    this.unviewed.delete(id);
  }
  keys(): IterableIterator<string> {
    return this.entries.keys();
  }
}

export type ConversationFetchPurpose = "focused" | "prefetch" | "stop";

// A response may only update the cache entry it was requested for. A focused
// read additionally has to still be the open agent, and a background prefetch
// must never write the open agent's entry — that slot belongs to the focused
// read whose fuller window and in-flight reconciliation a preview would undo.
export function shouldCacheConversationResponse(
  responseId: string,
  requestedId: string,
  selectedId: string,
  purpose: ConversationFetchPurpose = "focused",
): boolean {
  if (responseId !== requestedId) return false;
  return purpose === "prefetch"
    ? requestedId !== selectedId
    : requestedId === selectedId;
}
