// Startup catch-up uses one owned process without pre-reading transcript data.
// Replies contain counters only; closing verifies the process group is gone.
import { fileURLToPath } from "node:url";
import type { ProcessLifecycle } from "../process_lifecycle";
import type { SearchTarget, SyncStats } from "./index";

export type BackfillWork =
  | { op: "start" }
  | { op: "sync"; target: SearchTarget };
export type BackfillReply =
  | { id: number; value?: SyncStats }
  | { id: number; error: string };
type Child = ReturnType<typeof Bun.spawn>;

export class BackfillProcess {
  private starting?: Promise<Child>;
  private child?: Child;
  private failure?: Error;
  private next = 0;
  private waiting = new Map<
    number,
    PromiseWithResolvers<SyncStats | undefined>
  >();
  private shutdown?: Promise<void>;

  constructor(private readonly processes: ProcessLifecycle) {}

  private async spawn(): Promise<Child> {
    const [child] = await this.processes.spawnTracked<Child>(
      [
        process.execPath,
        fileURLToPath(new URL("./backfill.worker.ts", import.meta.url)),
      ],
      "message-search",
      {
        spawn: {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          ipc: (reply: BackfillReply) => {
            const waiter = this.waiting.get(reply.id);
            if (!waiter) return;
            this.waiting.delete(reply.id);
            if ("error" in reply) waiter.reject(new Error(reply.error));
            else waiter.resolve(reply.value);
          },
        },
      },
    );
    this.child = child;
    void child.exited.then((code) => {
      this.failure = new Error(
        `Message search startup process exited (${code})`,
      );
      for (const waiter of this.waiting.values()) waiter.reject(this.failure);
      this.waiting.clear();
    });
    return child;
  }

  private async request(work: BackfillWork): Promise<SyncStats | undefined> {
    if (this.shutdown) throw new Error("Message search startup process closed");
    if (this.failure) throw this.failure;
    const child = await (this.starting ??= this.spawn());
    if (this.failure) throw this.failure;
    const id = this.next++;
    const waiter = Promise.withResolvers<SyncStats | undefined>();
    this.waiting.set(id, waiter);
    try {
      child.send({ ...work, id });
    } catch (error) {
      this.waiting.delete(id);
      throw error;
    }
    return waiter.promise;
  }

  async start(): Promise<void> {
    await this.request({ op: "start" });
  }

  async sync(target: SearchTarget): Promise<SyncStats> {
    const stats = await this.request({ op: "sync", target });
    if (!stats) throw new Error("Missing startup search progress");
    return stats;
  }

  close(): Promise<void> {
    return (this.shutdown ??= (async () => {
      const child = this.child ?? (await this.starting?.catch(() => undefined));
      if (child && (await this.processes.cleanupProcessObject(child)) === false)
        throw new Error("Message search startup process survived shutdown");
    })());
  }
}
