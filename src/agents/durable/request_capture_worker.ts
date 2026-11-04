// One lazy host-owned serializer snapshots before providers can mutate input.
// Failures reject inspection instead of serving stale JSON.
import { Worker } from "node:worker_threads";
import { slowSpan } from "../../observability/slow_span";

export class RequestCaptureWorker {
  private worker?: Worker;
  private readonly waiting = new Map<number, PromiseWithResolvers<string>>();
  private nextId = 0;
  private failure?: Error;
  private closed = false;

  serialize(request: unknown): Promise<string> {
    if (this.closed) throw new Error("Request capture serializer is closed");
    if (this.failure) throw this.failure;
    const worker = (this.worker ??= this.start());
    const id = this.nextId++;
    const result = Promise.withResolvers<string>();
    this.waiting.set(id, result);
    worker.ref();
    try {
      worker.postMessage({ id, request });
    } catch {
      this.waiting.delete(id);
      if (!this.waiting.size) worker.unref();
      throw new Error("Request capture snapshot failed");
    }
    return result.promise;
  }

  private start(): Worker {
    const worker = slowSpan(
      "request_capture_worker_create",
      undefined,
      () => new Worker(new URL("./request_capture.worker.ts", import.meta.url)),
    );
    const failed = () => {
      this.failure = new Error("Request capture serializer stopped");
      for (const result of this.waiting.values()) result.reject(this.failure);
      this.waiting.clear();
      worker.unref();
    };
    worker.on("error", failed);
    worker.on("exit", failed);
    worker.on(
      "message",
      (reply: { id: number } & ({ json: string } | { error: true })) => {
        const result = this.waiting.get(reply.id);
        this.waiting.delete(reply.id);
        if ("error" in reply)
          result?.reject(new Error("Request capture serialization failed"));
        else result?.resolve(reply.json);
        if (!this.waiting.size) worker.unref();
      },
    );
    return worker;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.waiting.values()].map((r) => r.promise));
    await this.worker?.terminate();
  }
}
