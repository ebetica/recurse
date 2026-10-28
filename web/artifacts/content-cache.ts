import type { ArtifactInfo } from "./model.js";

export interface ArtifactContentSnapshot {
  info: ArtifactInfo;
  content: string | null;
}

interface CacheEntry {
  agentId: string;
  artifactId: string;
  mutable: boolean;
  bytes: number;
  value: Promise<ArtifactContentSnapshot>;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function snapshotBytes(snapshot: ArtifactContentSnapshot): number {
  // Invariant: JavaScript strings may occupy two bytes per code unit. Metadata
  // is tiny but include a fixed allowance so binary/image entries do not become
  // free.
  return (snapshot.content?.length || 0) * 2 + 1024;
}

// Byte-bounded artifact LRU: immutable versions survive until eviction. Current
// revisions invalidate only on mutation; rejected/oversized loads never cache.
export class ArtifactContentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  private remove(key: string, expected?: CacheEntry): void {
    const entry = this.entries.get(key);
    if (!entry || (expected && entry !== expected)) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  private trim(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  getOrLoad(
    key: string,
    agentId: string,
    artifactId: string,
    mutable: boolean,
    load: () => Promise<ArtifactContentSnapshot>,
  ): Promise<ArtifactContentSnapshot> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }

    let cacheEntry: CacheEntry;
    const value = load()
      .then((snapshot) => {
        if (this.entries.get(key) === cacheEntry) {
          cacheEntry.bytes = snapshotBytes(snapshot);
          this.totalBytes += cacheEntry.bytes;
          this.trim();
        }
        return snapshot;
      })
      .catch((error) => {
        this.remove(key, cacheEntry);
        throw error;
      });
    cacheEntry = { agentId, artifactId, mutable, bytes: 0, value };
    this.entries.set(key, cacheEntry);
    this.trim();
    return value;
  }

  invalidateMutable(agentId: string): void {
    for (const [key, entry] of this.entries)
      if (entry.agentId === agentId && entry.mutable) this.remove(key, entry);
  }

  invalidateArtifact(agentId: string, artifactId: string): void {
    for (const [key, entry] of this.entries)
      if (entry.agentId === agentId && entry.artifactId === artifactId)
        this.remove(key, entry);
  }
}
