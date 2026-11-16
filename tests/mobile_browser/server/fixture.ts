import { randomUUID } from "node:crypto";
import type { Instance } from "../../../src/agents/instance";
import { createAgents } from "./agents";
import { createHistory } from "./history";
import * as media from "./media";

export type Json = Record<string, unknown>;
export type Conv = Json & { id: string };
export type Storage = {
  load: (cid: string) => Conv | null;
  save: (conv: Conv) => Promise<void>;
  rootAgentId: () => string;
};
export const hex = (n = 32): string =>
  randomUUID().replaceAll("-", "").slice(0, n);
export const nowSeconds = (): number => Date.now() / 1000;

export function createFixture(instance: Instance) {
  const { conversations } = instance;
  const load = (cid: string): Conv | null =>
    conversations.load(cid) as Conv | null;
  const save = (conv: Conv): Promise<void> => conversations.save(conv as never);
  const rootAgentId = (): string => {
    for (const conv of conversations.allConvs({ withPending: false }))
      if (!conv.parent) return String(conv.id);
    throw new Error("no root agent");
  };

  const memo = new Map<string, Promise<unknown>>();
  function once<T>(key: string, work: () => Promise<T>): Promise<T>;
  function once(
    key: { agent: string },
    work: () => Promise<void>,
  ): Promise<void>;
  function once(
    key: string | { agent: string },
    work: () => Promise<unknown>,
  ): Promise<unknown> {
    const name = typeof key === "string" ? key : JSON.stringify(key);
    const cached = memo.get(name);
    if (cached) return cached;
    if (typeof key !== "string" && load(key.agent) !== null)
      return Promise.resolve();
    const result = work()
      .catch((error) => {
        memo.delete(name);
        throw error;
      })
      .finally(() => {
        if (typeof key !== "string") memo.delete(name);
      });
    memo.set(name, result);
    return result;
  }
  const storage = { load, save, rootAgentId };
  return {
    instance,
    ...storage,
    once,
    agents: createAgents(instance, storage),
    history: createHistory(instance, storage),
    media,
    dirs: {
      artifactsDir: instance.config.paths.ARTIFACTS_DIR,
      trashDir: instance.config.paths.TRASH_DIR,
    },
  };
}
export type Fixture = ReturnType<typeof createFixture>;
export type Routes = Record<
  string,
  (body: any, request: Request) => Promise<Json>
>;
