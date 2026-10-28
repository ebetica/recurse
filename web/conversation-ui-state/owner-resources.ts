// Opaque per-owner browser resources (File objects, object URLs, pending work)
// that cannot be serialized but share the session owner's exact bounded
// lifecycle: promotion transfers them, removal/eviction disposes them, and no
// caller gets an owner-named storage namespace or an unbounded side map.
import { MAX_RETAINED_OWNERS } from "./schema.js";

export interface OwnerResourceStore<T> {
  get(ownerId: string): T | undefined;
  set(ownerId: string, value: T): boolean;
  take(ownerId: string): T | undefined;
  remove(ownerId: string): void;
  entries(): [string, T][];
}

export interface ManagedOwnerResource {
  transfer(fromOwnerId: string, toOwnerId: string): void;
  remove(ownerId: string): void;
}

export class OwnerResourceStoreImpl<T>
  implements OwnerResourceStore<T>, ManagedOwnerResource
{
  private values = new Map<string, T>();

  constructor(
    private retain: (ownerId: string) => boolean,
    private dispose: (value: T) => void,
  ) {}

  get(ownerId: string): T | undefined {
    return this.values.get(ownerId);
  }

  set(ownerId: string, value: T): boolean {
    if (!this.retain(ownerId)) return false;
    const previous = this.values.get(ownerId);
    if (previous !== undefined && previous !== value) this.dispose(previous);
    this.values.delete(ownerId);
    this.values.set(ownerId, value);
    while (this.values.size > MAX_RETAINED_OWNERS) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    return true;
  }

  take(ownerId: string): T | undefined {
    const value = this.values.get(ownerId);
    this.values.delete(ownerId);
    return value;
  }

  remove(ownerId: string): void {
    const value = this.take(ownerId);
    if (value !== undefined) this.dispose(value);
  }

  entries(): [string, T][] {
    return [...this.values.entries()];
  }

  transfer(fromOwnerId: string, toOwnerId: string): void {
    if (fromOwnerId === toOwnerId) return;
    const value = this.take(fromOwnerId);
    if (value === undefined) return;
    const previous = this.values.get(toOwnerId);
    if (previous !== undefined && previous !== value) this.dispose(previous);
    this.values.delete(toOwnerId);
    this.values.set(toOwnerId, value);
  }
}
