// Persistent stale-while-revalidate cache for pi skill discovery. This module
// is DOM-free so storage failure, races, and eviction can be tested without a
// browser. Only the exact {name, description} autocomplete payload is stored.

import type { SkillChoice } from "../types.js";

export const SKILL_CACHE_KEY = "recurse.skillCache.v2";
export const SKILL_CACHE_VERSION = 2;
export const SKILL_CACHE_TTL_MS = 15 * 60_000;
export const SKILL_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const SKILL_CACHE_MAX_ENTRIES = 24;
const SKILL_CACHE_MAX_BYTES = 256 * 1024;
const SKILL_CACHE_MAX_SKILLS = 256;

export type SkillLoadState =
  | {
      status: "ready";
      skills: SkillChoice[];
      stale: boolean;
      refreshing: boolean;
      refreshFailed: boolean;
    }
  | { status: "loading" | "error" | "missing" };

export type SkillFetchResult =
  | { status: "ok"; skills: SkillChoice[]; context: string; etag?: string }
  | { status: "not-modified"; context: string; etag?: string };

type FetchSkills = (
  agentId: string,
  context: string,
  etag?: string,
) => Promise<SkillFetchResult>;
type Settled = (agentId: string) => void;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SkillCacheEntry {
  agentId: string;
  context: string;
  skills: SkillChoice[];
  etag?: string;
  updatedAt: number;
  usedAt: number;
  revision: string;
}

interface SkillCacheEnvelope {
  version: number;
  entries: SkillCacheEntry[];
}

const entryKey = (agentId: string, context: string) => `${agentId}\n${context}`;
const validAgent = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const validContext = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{16,128}$/.test(value);

function validSkills(value: unknown): value is SkillChoice[] {
  return (
    Array.isArray(value) &&
    value.length <= SKILL_CACHE_MAX_SKILLS &&
    value.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof (item as SkillChoice).name === "string" &&
        // Invariant: pi package skills may be namespaced (plugin:skill); dots
        // also occur in package-style names. Path separators/control/whitespace
        // remain invalid.
        /^[A-Za-z0-9_.:-]{1,128}$/.test((item as SkillChoice).name) &&
        typeof (item as SkillChoice).description === "string" &&
        (item as SkillChoice).description.length <= 8_000,
    )
  );
}

function parseEnvelope(
  raw: string | null,
  now: number,
): Map<string, SkillCacheEntry> | null {
  if (!raw || raw.length > SKILL_CACHE_MAX_BYTES) return raw ? null : new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const envelope = value as Partial<SkillCacheEnvelope>;
  if (
    envelope.version !== SKILL_CACHE_VERSION ||
    !Array.isArray(envelope.entries)
  )
    return null;
  const entries = new Map<string, SkillCacheEntry>();
  for (const rawEntry of envelope.entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as SkillCacheEntry;
    if (
      !validAgent(entry.agentId) ||
      !validContext(entry.context) ||
      !validSkills(entry.skills) ||
      typeof entry.updatedAt !== "number" ||
      !Number.isFinite(entry.updatedAt) ||
      typeof entry.usedAt !== "number" ||
      !Number.isFinite(entry.usedAt) ||
      typeof entry.revision !== "string" ||
      entry.revision.length > 96 ||
      !/^[A-Za-z0-9.-]+$/.test(entry.revision) ||
      (entry.etag !== undefined &&
        (typeof entry.etag !== "string" || entry.etag.length > 160)) ||
      now - entry.updatedAt > SKILL_CACHE_MAX_AGE_MS
    )
      continue;
    entries.set(entryKey(entry.agentId, entry.context), {
      ...entry,
      // Invariant: Never retain an object graph supplied by parsed/tampered
      // storage.
      skills: entry.skills.map((skill) => ({ ...skill })),
    });
  }
  return entries;
}

function prune(entries: Map<string, SkillCacheEntry>): void {
  if (entries.size <= SKILL_CACHE_MAX_ENTRIES) return;
  const oldest = [...entries.entries()].sort(
    (a, b) => a[1].usedAt - b[1].usedAt || a[1].updatedAt - b[1].updatedAt,
  );
  for (const [key] of oldest.slice(0, entries.size - SKILL_CACHE_MAX_ENTRIES))
    entries.delete(key);
}

export class PersistentSkillCache {
  private entries = new Map<string, SkillCacheEntry>();
  private writable = true;

  constructor(
    private readonly storage: StorageLike | null,
    private readonly now: () => number = Date.now,
    private readonly storageKey = SKILL_CACHE_KEY,
  ) {
    if (!storage) return;
    try {
      const parsed = parseEnvelope(storage.getItem(storageKey), now());
      if (parsed) this.entries = parsed;
      else storage.removeItem(storageKey);
      if (storageKey === SKILL_CACHE_KEY)
        storage.removeItem("recurse.skillCache.v1");
    } catch {
      this.writable = false;
    }
    prune(this.entries);
  }

  get(agentId: string, context: string): SkillCacheEntry | null {
    const entry = this.entries.get(entryKey(agentId, context));
    if (!entry) return null;
    if (this.now() - entry.updatedAt > SKILL_CACHE_MAX_AGE_MS) {
      this.entries.delete(entryKey(agentId, context));
      return null;
    }
    entry.usedAt = this.now();
    return entry;
  }

  adopt(agentId: string, context: string): SkillCacheEntry | null {
    const own = this.get(agentId, context);
    if (own) return own;
    const source = [...this.entries.values()]
      .filter((entry) => entry.context === context)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!source) return null;
    const adopted = { ...source, agentId, usedAt: this.now() };
    this.entries.set(entryKey(agentId, context), adopted);
    this.persist();
    return adopted;
  }

  put(entry: SkillCacheEntry): boolean {
    if (
      !validAgent(entry.agentId) ||
      !validContext(entry.context) ||
      !validSkills(entry.skills)
    )
      return false;
    this.mergeStored();
    const key = entryKey(entry.agentId, entry.context);
    const current = this.entries.get(key);
    // Invariant: A response from a request that began before another tab's
    // successful revalidation must not overwrite the newer result when it
    // finishes late.
    if (current && current.revision > entry.revision) return false;
    this.entries.set(key, {
      ...entry,
      skills: entry.skills.map((skill) => ({ ...skill })),
    });
    prune(this.entries);
    this.persist();
    return true;
  }

  revalidated(
    agentId: string,
    context: string,
    revision: string,
    etag?: string,
  ): boolean {
    const current = this.get(agentId, context);
    if (!current) return false;
    return this.put({
      ...current,
      etag: etag || current.etag,
      updatedAt: this.now(),
      usedAt: this.now(),
      revision,
    });
  }

  sync(raw: string | null): void {
    if (raw === null) {
      this.entries.clear();
      return;
    }
    const external = parseEnvelope(raw, this.now());
    if (!external) return;
    for (const [key, entry] of external) {
      const current = this.entries.get(key);
      if (
        !current ||
        entry.revision > current.revision ||
        (entry.revision === current.revision &&
          entry.updatedAt > current.updatedAt)
      )
        this.entries.set(key, entry);
    }
    prune(this.entries);
  }

  clear(): void {
    this.entries.clear();
    this.writable = true;
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {
      this.writable = false;
    }
  }

  private mergeStored(): void {
    if (!this.storage || !this.writable) return;
    try {
      this.sync(this.storage.getItem(this.storageKey));
    } catch {
      this.writable = false;
    }
  }

  private persist(): void {
    if (!this.storage || !this.writable) return;
    const serialize = () =>
      JSON.stringify({
        version: SKILL_CACHE_VERSION,
        entries: [...this.entries.values()],
      } satisfies SkillCacheEnvelope);
    try {
      let raw = serialize();
      if (raw.length > SKILL_CACHE_MAX_BYTES) {
        const keep = [...this.entries.entries()].sort(
          (a, b) => b[1].usedAt - a[1].usedAt,
        );
        this.entries = new Map(
          keep.slice(0, Math.max(1, Math.floor(keep.length / 2))),
        );
        raw = serialize();
      }
      this.storage.setItem(this.storageKey, raw);
    } catch {
      // Invariant: Quota/security failure cannot break autocomplete. Make one
      // smaller retry, then retain an in-memory cache only for the rest of this
      // page lifetime.
      try {
        const keep = [...this.entries.entries()].sort(
          (a, b) => b[1].usedAt - a[1].usedAt,
        );
        this.entries = new Map(
          keep.slice(0, Math.max(1, Math.floor(keep.length / 2))),
        );
        this.storage.setItem(this.storageKey, serialize());
      } catch {
        this.writable = false;
      }
    }
  }
}

export class SkillLoader {
  private readonly requests = new Map<string, Promise<void>>();
  private readonly attempted = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly failed = new Set<string>();
  private readonly aliases = new Map<string, Set<string>>();
  private revisionCounter = 0;
  private epoch = 0;
  private readonly revisionNonce = Math.random().toString(36).slice(2, 12);

  constructor(
    private readonly fetchSkills: FetchSkills,
    private readonly onSettled: Settled = () => {},
    private readonly now: () => number = Date.now,
    private readonly retryMs = 5_000,
    private readonly cache = new PersistentSkillCache(null, now),
    private readonly ttlMs = SKILL_CACHE_TTL_MS,
  ) {}

  state(agentId: string, context: string): SkillLoadState {
    const cached = this.cache.get(agentId, context);
    if (cached)
      return {
        status: "ready",
        skills: cached.skills,
        stale: this.now() - cached.updatedAt >= this.ttlMs,
        refreshing: this.requests.has(context),
        refreshFailed: this.failed.has(context),
      };
    if (this.requests.has(context)) return { status: "loading" };
    if ((this.retryAt.get(context) || 0) > this.now())
      return { status: "error" };
    return { status: "missing" };
  }

  // A page lifecycle revalidates each opened context once even when storage is
  // warm. Repeated polls/preloads share that request; force is explicit
  // refresh.
  preload(
    agentId: string,
    context: string,
    force = false,
  ): Promise<void> | null {
    let aliases = this.aliases.get(context);
    if (!aliases) {
      aliases = new Set();
      this.aliases.set(context, aliases);
    }
    aliases.add(agentId);
    const cached = this.cache.adopt(agentId, context);
    const active = this.requests.get(context);
    if (active) return active;
    if (
      !force &&
      this.failed.has(context) &&
      (this.retryAt.get(context) || 0) > this.now()
    )
      return null;
    if (!force && this.attempted.has(context) && !this.failed.has(context))
      return null;
    const epoch = this.epoch;
    const revision =
      `${String(this.now()).padStart(16, "0")}` +
      `-${this.revisionNonce}-${String(++this.revisionCounter).padStart(6, "0")}`;
    this.attempted.add(context);
    const request = (async () => {
      try {
        const result = await this.fetchSkills(agentId, context, cached?.etag);
        // Invariant: Responses belong only to their captured workdir/context.
        // Logout/password cache clearing invalidates all prior requests so none
        // can repopulate cleared data.
        if (epoch !== this.epoch || result.context !== context) return;
        if (result.status === "not-modified") {
          if (!this.cache.revalidated(agentId, context, revision, result.etag))
            throw new Error("not modified without a cached result");
        } else if (
          !this.cache.put({
            agentId,
            context,
            skills: result.skills,
            etag: result.etag,
            updatedAt: this.now(),
            usedAt: this.now(),
            revision,
          })
        ) {
          // Invariant: A malformed/oversized server or tampered test response
          // must not leave the picker forever "loading" after persistence
          // rejected it.
          throw new Error("invalid skill payload");
        }
        for (const alias of this.aliases.get(context) || [])
          this.cache.adopt(alias, context);
        this.failed.delete(context);
        this.retryAt.delete(context);
      } catch {
        if (epoch === this.epoch) {
          this.failed.add(context);
          this.retryAt.set(context, this.now() + this.retryMs);
          // Invariant: failed stays distinct from a successful empty result;
          // preload permits another attempt once retryAt has passed.
        }
      }
    })().finally(() => {
      if (this.requests.get(context) === request) this.requests.delete(context);
      this.onSettled(agentId);
    });
    this.requests.set(context, request);
    return request;
  }

  adopt(agentId: string, context: string): void {
    let aliases = this.aliases.get(context);
    if (!aliases) {
      aliases = new Set();
      this.aliases.set(context, aliases);
    }
    aliases.add(agentId);
    this.cache.adopt(agentId, context);
  }
  sync(raw: string | null): void {
    if (raw === null) {
      this.epoch++;
      this.requests.clear();
      this.attempted.clear();
      this.retryAt.clear();
      this.failed.clear();
      this.aliases.clear();
    }
    this.cache.sync(raw);
    this.onSettled("");
  }
  clear(): void {
    this.epoch++;
    this.requests.clear();
    this.cache.clear();
    this.attempted.clear();
    this.retryAt.clear();
    this.failed.clear();
    this.aliases.clear();
  }
}
