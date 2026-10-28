import { ConversationUiStateStore } from "../../web/conversation-ui-state/store.js";
import type { StorageLike } from "../../web/conversation-ui-state/schema.js";

export class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  reads: string[] = [];
  writes: string[] = [];
  removes: string[] = [];
  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.removes.push(key);
    this.values.delete(key);
  }
}

export const storedFor = (
  storage: MemoryStorage,
  prefix: string,
  owner: string,
): string | undefined =>
  [...storage.values.entries()].find(([key, raw]) => {
    const suffix = key.slice(`${prefix}slot.`.length);
    if (!key.startsWith(`${prefix}slot.`) || !/^\d+$/.test(suffix))
      return false;
    try {
      return (JSON.parse(raw) as { owner?: unknown }).owner === owner;
    } catch {
      return false;
    }
  })?.[1];
export const slotKeys = (storage: MemoryStorage, prefix: string): string[] => {
  const start = `${prefix}slot.`;
  return [...storage.values.keys()]
    .filter(
      (key) => key.startsWith(start) && /^\d+$/.test(key.slice(start.length)),
    )
    .sort();
};

export function store(
  local = new MemoryStorage(),
  session = new MemoryStorage(),
) {
  return {
    local,
    session,
    state: new ConversationUiStateStore(local, session, 60_000),
  };
}
