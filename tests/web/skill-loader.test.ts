import { describe, expect, test } from "bun:test";
import {
  PersistentSkillCache,
  SKILL_CACHE_KEY,
  SkillLoader,
  type StorageLike,
} from "../../web/skills/loader.js";
import type { SkillChoice } from "../../web/types.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("quota");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const contextA = "a".repeat(32);
const slack: SkillChoice[] = [
  { name: "slack", description: "Send a Slack message" },
];
const ok = (skills = slack, context = contextA, etag = '"one"') => ({
  status: "ok" as const,
  skills,
  context,
  etag,
});

describe("SkillLoader persistent stale-while-revalidate cache", () => {
  test("password/logout clear suppresses an already in-flight response", async () => {
    const pending = deferred<ReturnType<typeof ok>>();
    const storage = new MemoryStorage();
    const loader = new SkillLoader(
      () => pending.promise,
      () => {},
      Date.now,
      5_000,
      new PersistentSkillCache(storage),
    );
    const request = loader.preload("main", contextA);
    loader.clear();
    pending.resolve(ok());
    await request;
    expect(loader.state("main", contextA)).toEqual({ status: "missing" });
    expect(storage.getItem(SKILL_CACHE_KEY)).toBeNull();
  });
});
