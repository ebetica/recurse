// Bounded, plugin-declared retention for detached pane bodies. Scope always
// includes pane, UI owner, and plugin key so cached DOM and request state
// cannot cross conversation boundaries. Plugins supply only
// identity/freshness/cleanup.
import type { PaneCacheDef, PaneContext } from "../types.js";

export interface PaneCacheScope {
  paneId: string;
  ownerId: string;
  instanceKey: string;
}

interface Entry<T> {
  scope: PaneCacheScope;
  value: T;
  context: PaneContext;
  policy: PaneCacheDef;
  generation: string | null | undefined;
}

export const MAX_RETAINED_PANES = 12;

function key(scope: PaneCacheScope): string {
  return JSON.stringify([scope.paneId, scope.ownerId, scope.instanceKey]);
}

export function validPaneCacheDef(
  policy: PaneCacheDef | undefined,
): policy is PaneCacheDef {
  return (
    !!policy &&
    Number.isInteger(policy.version) &&
    policy.version > 0 &&
    typeof policy.key === "function"
  );
}

export class PaneInstanceCache<T extends HTMLElement = HTMLElement> {
  private entries = new Map<string, Entry<T>>();

  constructor(private readonly maxEntries = MAX_RETAINED_PANES) {}

  private dispose(entry: Entry<T>): void {
    try {
      entry.policy.dispose?.(entry.value, entry.context);
    } catch {}
  }

  private remove(cacheKey: string, expected?: Entry<T>): void {
    const entry = this.entries.get(cacheKey);
    if (!entry || (expected && entry !== expected)) return;
    this.entries.delete(cacheKey);
    this.dispose(entry);
  }

  put(
    scope: PaneCacheScope,
    value: T,
    context: PaneContext,
    policy?: PaneCacheDef,
  ): void {
    if (!validPaneCacheDef(policy) || this.maxEntries <= 0) {
      if (policy)
        this.dispose({ scope, value, context, policy, generation: undefined });
      return;
    }
    const cacheKey = key(scope);
    this.remove(cacheKey);
    let generation: string | null | undefined;
    try {
      generation = policy.generation?.(context);
    } catch {
      generation = undefined;
    }
    this.entries.set(cacheKey, { scope, value, context, policy, generation });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  take(
    scope: PaneCacheScope,
    context: PaneContext,
    policy?: PaneCacheDef,
  ): T | null {
    if (!validPaneCacheDef(policy)) return null;
    const cacheKey = key(scope);
    const entry = this.entries.get(cacheKey);
    if (!entry) return null;
    this.entries.delete(cacheKey);
    let generation: string | null | undefined;
    try {
      generation = policy.generation?.(context);
    } catch {
      generation = undefined;
    }
    const stale =
      entry.policy.version !== policy.version ||
      (!!policy.generation &&
        (generation === undefined ||
          entry.generation === undefined ||
          generation !== entry.generation));
    if (stale) {
      this.dispose(entry);
      return null;
    }
    try {
      policy.resume?.(entry.value, context);
    } catch {
      this.dispose(entry);
      return null;
    }
    return entry.value;
  }

  invalidate(paneId?: string, instanceKey?: string): void {
    for (const [cacheKey, entry] of this.entries) {
      if (
        (!paneId || entry.scope.paneId === paneId) &&
        (!instanceKey || entry.scope.instanceKey === instanceKey)
      )
        this.remove(cacheKey, entry);
    }
  }

  clear(): void {
    this.invalidate();
  }

  get size(): number {
    return this.entries.size;
  }
}
