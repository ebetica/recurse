// Host-shared Worker with per-bundle native connections. Close drains/destroys
// finders before join; cancellation rejects promptly but calls stay owned until
// drained. Thread failure rejects all pending/later work without retry or
// restart.
import { Worker } from "node:worker_threads";
import type { FffDefinition, FffFlags } from "./fff_tools.ts";
import type {
  SearchMessage,
  SearchReply,
  SearchRequest,
  SearchValue,
} from "./fff_worker_thread.ts";

type Update = Parameters<FffDefinition["execute"]>[3];
type Waiting = PromiseWithResolvers<SearchValue> & {
  cleanup(): void;
  onUpdate: Update;
};

export class FffWorker {
  private thread: Worker | undefined;
  private waiting = new Map<number, Waiting>();
  private nextId = 0;
  private nextConnection = 0;
  private dead: Error | undefined;
  private shutdown: Promise<void> | undefined;

  constructor(private readonly env: NodeJS.ProcessEnv = {}) {}

  private start() {
    // Invariant: Enable PI_FFF_MULTIGREP only on the search thread, matching Pi
    // launch tool availability.
    const thread = new Worker(
      new URL("./fff_worker_thread.ts", import.meta.url),
      { env: { ...this.env, PI_FFF_MULTIGREP: "1" } },
    );
    const failed = (error: Error) => {
      this.dead ??= error;
      for (const waiter of this.waiting.values()) {
        waiter.cleanup();
        waiter.reject(this.dead);
      }
      this.waiting.clear();
    };
    thread.on("error", (error: Error) =>
      failed(new Error(`Search worker failed: ${error.message}`)),
    );
    thread.on("exit", (code) =>
      failed(new Error(`Search worker exited (${code})`)),
    );
    thread.on("message", (reply: SearchReply) => {
      const waiter = this.waiting.get(reply.id);
      if (!waiter) return;
      if ("update" in reply) {
        try {
          waiter.onUpdate?.(reply.update);
        } catch (error) {
          this.waiting.delete(reply.id);
          waiter.cleanup();
          waiter.reject(error);
          this.abort(reply.id);
        }
        return;
      }
      this.waiting.delete(reply.id);
      waiter.cleanup();
      if ("error" in reply) waiter.reject(new Error(reply.error));
      else waiter.resolve(reply.value);
    });
    return thread;
  }

  private abort(id: number) {
    try {
      this.thread?.postMessage({ op: "abort", id } satisfies SearchMessage);
    } catch {
      // Invariant: Exit/error already rejects outstanding calls.
    }
  }

  private request(
    request: SearchRequest,
    signal?: AbortSignal,
    onUpdate?: Update,
  ): Promise<SearchValue> {
    if (this.shutdown && request.op !== "shutdown")
      return Promise.reject(new Error("Search worker closed"));
    if (this.dead) return Promise.reject(this.dead);
    if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
    this.thread ??= this.start();
    const id = this.nextId++;
    const waiter = Promise.withResolvers<SearchValue>();
    const abort = () => {
      this.waiting.delete(id);
      cleanup();
      this.abort(id);
      waiter.reject(new Error("Operation aborted"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    this.waiting.set(id, { ...waiter, cleanup, onUpdate });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      this.thread.postMessage({ ...request, id } satisfies SearchMessage);
    } catch (error) {
      this.waiting.delete(id);
      cleanup();
      waiter.reject(error);
    }
    return waiter.promise;
  }

  async open(cwd: string, flags: FffFlags = {}) {
    const connection = this.nextConnection++;
    const tools = await this.request({ op: "open", connection, cwd, flags });
    if (!Array.isArray(tools))
      throw new Error("Search worker returned invalid tool definitions");
    let closing: Promise<void> | undefined;
    const thisWorker = this;
    const definitions: FffDefinition[] = tools.map((tool) => ({
      ...tool,
      async execute(_id, args, signal, onUpdate, ctx) {
        if (closing) throw new Error("Search connection closed");
        const result = await thisWorker.request(
          { op: "execute", connection, cwd: ctx.cwd, name: tool.name, args },
          signal,
          onUpdate,
        );
        if (!result || Array.isArray(result))
          throw new Error("Search worker returned an invalid result");
        return result;
      },
    }));
    return {
      definitions,
      close: () =>
        (closing ??=
          this.shutdown ??
          this.request({ op: "close", connection }).then(() => undefined)),
    };
  }

  /** Start the thread and import pi-fff there, so the first open waits for
   * neither. It loads no native library, so close() may join it at any time. */
  async warm(): Promise<void> {
    try {
      await this.request({ op: "warm" });
    } catch (error) {
      if (!this.shutdown) throw error;
    }
  }

  // Fence work, drain native calls, destroy finders, then join.
  close(): Promise<void> {
    return (this.shutdown ??= (async () => {
      if (!this.thread) return;
      try {
        if (!this.dead) await this.request({ op: "shutdown" });
      } finally {
        await this.thread.terminate();
      }
    })());
  }
}
