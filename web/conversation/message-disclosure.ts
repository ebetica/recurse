// Disclosure state survives row replacement and stays scoped to a conversation.
import type { MessageEntry } from "../types.js";

export class MessageDisclosureState {
  private readonly open = new Set<string>();

  constructor(private readonly limit = 512) {}

  private key(conversationId: string, identity: string | number): string {
    return `${conversationId}\0${identity}`;
  }

  isOpen(conversationId: string, identity: string | number): boolean {
    return this.open.has(this.key(conversationId, identity));
  }

  toggle(conversationId: string, identity: string | number): boolean {
    const key = this.key(conversationId, identity);
    if (this.open.has(key)) {
      this.open.delete(key);
      return false;
    }
    while (this.open.size >= this.limit) {
      const oldest = this.open.values().next().value;
      if (oldest === undefined) break;
      this.open.delete(oldest);
    }
    this.open.add(key);
    return true;
  }
}

export function messageDisclosureIdentity(entry: MessageEntry): string {
  return entry.id ? `id:${entry.id}` : `offset:${entry.offset}`;
}
