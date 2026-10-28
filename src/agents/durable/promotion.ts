// Promote an idle side conversation to its parent's subagent as a job marked
// `promoting` on its record, which openLive resumes after a restart.
// Spec: stage the fork's copy, rename it into place, commit the record, and
// only then drop the fork; before the commit the side conversation is intact.
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import * as trash from "../../utils/trash";
import type { Opened } from "./host/open.ts";

const runtime = () => import("./host/runtime.ts");

export type PromotionRecord = Pick<PromotionDeps, "promotion" | "promoted">;

export interface PromotionDeps {
  dataDir: string;
  trashDir: string;
  load(cid: string, fields: readonly string[]): Record<string, unknown> | null;
  /** The server is closing or `cid` is being deleted. */
  stopping(cid: string): boolean;
  /** Run `step` after the conversation's earlier sends. */
  serial<T>(cid: string, step: () => Promise<T>): Promise<T>;
  open(cid: string): Promise<Opened>;
  /** Storage for a staged copy, on the shared SQLite thread. */
  storage(path: string): Promise<SqliteStorage>;
  models(): Promise<Models>;
  /** Record the promotion as running or failed. */
  promotion?(cid: string, state: "running" | { failed: string }): Promise<void>;
  /** Commit: the record has no `side_of` and the parent's model. */
  promoted?(cid: string): Promise<void>;
  /** After the commit: forget the side's handle and its fork in `host`. */
  forget(cid: string, host: Opened): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
}

export class Promotions {
  private readonly jobs = new Map<
    string,
    { job: Promise<void>; stop: AbortController }
  >();

  constructor(private readonly deps: PromotionDeps) {}

  /** Start promoting `cid`: null once started, else why it cannot. */
  async request(cid: string): Promise<string | null> {
    const parent = this.deps.load(cid, ["side_of"])?.side_of;
    if (typeof parent !== "string") return "not a side conversation";
    if (this.jobs.has(cid)) return null;
    const refused = await this.deps.serial(cid, async () =>
      this.refused(await this.deps.open(parent), await this.deps.open(cid)),
    );
    if (refused) return refused;
    await this.deps.promotion?.(cid, "running");
    this.resume(cid);
    return null;
  }

  /** Run the recorded promotion of `cid`, if any, unless it already runs. */
  resume(cid: string): void {
    if (this.jobs.has(cid) || this.deps.stopping(cid)) return;
    if (this.deps.load(cid, ["promoting"])?.promoting !== true) return;
    const stop = new AbortController();
    const job = this.deps
      .serial(cid, () => this.run(cid, stop.signal))
      .catch(async (error: unknown) => {
        if (this.deps.stopping(cid)) return;
        const failed = error instanceof Error ? error.message : String(error);
        this.deps.log("durable_promotion_failed", { cid, error: failed });
        await this.deps.promotion?.(cid, { failed });
        this.retireLeftovers(cid);
      })
      .catch((error: unknown) =>
        this.deps.log("durable_promotion_failed", {
          cid,
          error: String(error),
        }),
      )
      .finally(() => this.jobs.delete(cid));
    this.jobs.set(cid, { job, stop });
  }

  /** Stop copies in flight; their marks stay for the next start. */
  async close(): Promise<void> {
    for (const { stop } of this.jobs.values()) stop.abort();
    await Promise.allSettled([...this.jobs.values()].map(({ job }) => job));
  }

  /** Why `side` cannot be promoted now, or null. */
  private async refused(host: Opened, side: Opened): Promise<string | null> {
    const { InboxDoc, LiveDoc } = await runtime();
    const id = side.conversation.id;
    if (
      (await side.harness.snapshot(LiveDoc, id, context))?.run !== undefined ||
      (await side.harness.snapshot(InboxDoc, id, context))?.items.length
    )
      return "the side conversation is busy; promote it once it is idle";
    if (
      !(await side.conversation.agent(context)).extensions.includes(host.side)
    )
      return "this side conversation predates promotion and cannot be promoted";
    return null;
  }

  /** Retire the staged or unused storage a promotion of side `cid` left. */
  private retireLeftovers(cid: string): void {
    if (typeof this.deps.load(cid, ["side_of"])?.side_of !== "string") return;
    const dir = join(this.deps.dataDir, "conversations", cid);
    for (const name of ["durable", "durable.promoting"])
      trash.retire(join(dir, name), this.deps.trashDir);
  }

  private async run(cid: string, signal: AbortSignal): Promise<void> {
    const conv = this.deps.load(cid, ["side_of", "promoting"]);
    const parent = conv?.side_of;
    if (typeof parent !== "string" || conv?.promoting !== true) return;
    const rt = await runtime();
    const host = await this.deps.open(parent);
    const side = await this.deps.open(cid);
    const refused = await this.refused(host, side);
    if (refused) throw new Error(refused);
    const fork = (await rt.sideForks(host.harness, host.conversation))[cid];
    if (fork === undefined) throw new Error("the side conversation is gone");
    this.retireLeftovers(cid);
    const dir = join(this.deps.dataDir, "conversations", cid);
    const staged = join(dir, "durable.promoting");
    await mkdir(staged, { recursive: true, mode: 0o700 });
    const storage = await this.deps.storage(join(staged, "session.sqlite"));
    const ctx = withAbortSignal(signal, context);
    let target: Awaited<ReturnType<typeof rt.Harness.open>>;
    try {
      target = await rt.Harness.open(
        storage,
        { models: await this.deps.models(), registry: rt.createRegistry() },
        ctx,
      );
    } catch (error) {
      await storage.close(context);
      throw error;
    }
    try {
      await rt.copyFork(
        host.harness,
        side.conversation,
        target,
        host.parentSessions.get(fork.sessionId) ?? fork.sessionId,
        ctx,
      );
    } finally {
      await target.close(context);
    }
    await rename(staged, join(dir, "durable"));
    if (this.deps.stopping(cid))
      throw new Error("the side conversation is closing");
    await this.deps.promoted?.(cid);
    await this.deps.forget(cid, host);
    await this.deps.open(cid);
    this.deps.log("durable_promoted", { cid, parent });
  }
}
