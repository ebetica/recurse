// One bounded, off-thread file service for the operator's Explorer.
// Cursors and downloads belong to conversations; shutdown drains the Worker.
// Abandoned replies release handles; admission bounds pending calls.
import { HttpError } from "./router";

export const EXPLORER_PAGE_SIZE = 48;
export const EXPLORER_CHUNK_BYTES = 16 * 1024;
export const EXPLORER_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export interface ExplorerScope {
  owner: string;
  root: string;
  path: string;
}
export interface ExplorerEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  ignored: boolean;
}
export interface ExplorerListing {
  root: string;
  path: string;
  entries: ExplorerEntry[];
  cursor: string | null;
}
export interface ExplorerPreview {
  root: string;
  path: string;
  size: number;
  version: string;
  kind: "text" | "binary";
  text?: string;
  next: number | null;
}
export interface ExplorerRequests {
  list: ExplorerScope & { cursor?: string };
  preview: ExplorerScope & { offset: number; version?: string };
  admit: ExplorerScope;
  download: ExplorerScope;
  read: { owner: string; token: string; offset: number; length: number };
  release: { owner: string; token: string };
  shutdown: Record<string, never>;
}
export interface ExplorerResults {
  list: ExplorerListing;
  preview: ExplorerPreview;
  admit: null;
  download: { token: string; name: string; size: number };
  read: Uint8Array;
  release: null;
  shutdown: null;
}
export type ExplorerMessage = {
  [K in keyof ExplorerRequests]: {
    id: number;
    op: K;
    args: ExplorerRequests[K];
  };
}[keyof ExplorerRequests];
export type ExplorerReply =
  | { id: number; value: ExplorerResults[keyof ExplorerResults] }
  | { id: number; error: { status: number; message: string } };

export class ExplorerIO {
  private worker?: Worker;
  private nextId = 0;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Map<
    number,
    {
      resolve(value: ExplorerResults[keyof ExplorerResults]): void;
      reject(error: Error): void;
    }
  >();

  constructor(signal?: AbortSignal) {
    if (signal?.aborted) this.closed = true;
    signal?.addEventListener(
      "abort",
      () => {
        void this.close().catch(() => {});
      },
      { once: true },
    );
  }

  private start(): Worker {
    if (this.closed) throw new HttpError(503, "file browser is stopping");
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL("./explorer.worker.ts", import.meta.url).href,
    );
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<ExplorerReply>) => {
      const reply = event.data;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if ("error" in reply)
        pending.reject(new HttpError(reply.error.status, reply.error.message));
      else pending.resolve(reply.value);
    };
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      worker.terminate();
      for (const pending of this.pending.values())
        pending.reject(new HttpError(503, "file browser stopped; try again"));
      this.pending.clear();
    };
    worker.onerror = failed;
    worker.addEventListener("close", failed);
    return worker;
  }

  async call<K extends keyof ExplorerRequests>(
    op: K,
    args: ExplorerRequests[K],
    signal?: AbortSignal,
  ): Promise<ExplorerResults[K]> {
    if (signal?.aborted) throw new HttpError(499, "request cancelled");
    if (op !== "shutdown" && op !== "release" && this.pending.size >= 32)
      throw new HttpError(429, "too many file requests; try again");
    const worker = this.start();
    const id = this.nextId++;
    const result = new Promise<ExplorerResults[keyof ExplorerResults]>(
      (resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, args });
      },
    );
    const abort = () => worker.postMessage({ op: "abort", id });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const value = (await result) as ExplorerResults[K];
      if (signal?.aborted) {
        if (value && typeof value === "object") {
          const token =
            "token" in value
              ? value.token
              : "cursor" in value
                ? value.cursor
                : null;
          if (typeof token === "string")
            await this.call("release", {
              owner: (args as ExplorerScope).owner,
              token,
            });
        }
        throw new HttpError(499, "request cancelled");
      }
      return value;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const worker = this.worker;
    const drained = worker ? this.call("shutdown", {}) : Promise.resolve(null);
    this.closed = true;
    return (this.closing = drained
      .then(() => undefined)
      .finally(() => {
        worker?.terminate();
        this.worker = undefined;
        for (const pending of this.pending.values())
          pending.reject(new HttpError(503, "file browser is stopping"));
        this.pending.clear();
      }));
  }
}
