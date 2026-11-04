// Appends and startup catch-up publish derived files behind rotation fences.
// Durable file/state markers restore readiness; queries never open SQLite.
import { INFO, WARNING } from "../observability/runtime_logging";
import { slowSpan } from "../observability/slow_span";
import { dirname, join } from "node:path";
import type { CommitPublication } from "@earendil-works/pi-durable";
import type { Work } from "./search.worker";
import { abortable } from "../utils/tasks";
import type { TranscriptRole } from "./transcript";

export interface SearchTarget {
  cid: string;
  path: string;
  agent?: string;
  conversation?: number;
  archived?: boolean;
}
export interface SyncStats {
  entries: number;
  bytes: number;
  ms: number;
  file?: { path: string; bytes: number; identity?: string; inode?: number };
  profile?: {
    open_ms: number;
    sqlite_ms: number;
    decode_ms: number;
    write_ms: number;
    verify_ms?: number;
  };
}
export interface SearchHit {
  agent: string;
  cid: string;
  entry: number;
  time: number;
  role: TranscriptRole;
  snippet: string;
  path: string;
  line: number;
}
export interface SearchOptions {
  query: string;
  role?: TranscriptRole;
  limit?: number;
  scope: string;
  signal?: AbortSignal;
}
export class SearchBusyError extends Error {
  constructor() {
    super("Search busy; retry after current searches finish");
  }
}

const SEARCH_CONCURRENCY = 4;
const SEARCH_WAITING = 6;
let searches = 0;
let ripgreps = 0;
const queue: (() => void)[] = [];
const filesInFlight = new Map<string, Promise<void>>();

async function withFiles<T>(
  paths: string[],
  work: () => Promise<T>,
): Promise<T> {
  const finished = Promise.withResolvers<void>();
  const previous = paths.map((path) => filesInFlight.get(path));
  for (const path of paths) filesInFlight.set(path, finished.promise);
  try {
    await Promise.all(previous);
    return await work();
  } finally {
    for (const path of paths)
      if (filesInFlight.get(path) === finished.promise)
        filesInFlight.delete(path);
    finished.resolve();
  }
}

async function enter(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (searches >= SEARCH_CONCURRENCY) {
    if (queue.length >= SEARCH_WAITING) throw new SearchBusyError();
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = queue.indexOf(wake);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      queue.push(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  } else searches++;
  return () => {
    const next = queue.shift();
    if (next) next();
    else searches--;
  };
}

export type Log = (
  event: string,
  fields: Record<string, unknown>,
  level: number,
) => void;
export type SearchFile = {
  path: string;
  target: SearchTarget;
  checkCurrent?: boolean;
};
export type QueryResult = {
  hits: SearchHit[];
  truncated: boolean;
  missing?: string[];
  unindexed?: string[];
  bytes_scanned?: number;
};

type Projector = (
  target: SearchTarget,
  owned?: SyncStats,
) => Promise<SyncStats | undefined>;

export class MessageSearch {
  private workers = new Map<number, Worker>();
  private next = 0;
  private waiting = new Map<
    number,
    { worker: Worker; waiter: PromiseWithResolvers<unknown> }
  >();
  private pending = new Map<string, SearchTarget>();
  private flushing?: Promise<void>;
  private timer?: ReturnType<typeof setImmediate>;
  private closed = false;
  private controllers = new Set<AbortController>();
  private queries = 0;
  private active = new Set<Promise<void>>();
  private backfills = 0;
  private backfillIncomplete = false;
  private backfillFailed = false;
  private indexedLive = new Set<string>();
  private rotating = new Set<string>();

  constructor(
    private readonly log: Log = () => {},
    private readonly syncOwned?: (
      target: SearchTarget,
    ) => Promise<SyncStats | undefined>,
  ) {}

  /** Queued queries and ripgrep cleanup take priority over startup reads. */
  get hasQueries(): boolean {
    return this.queries > 0;
  }

  private shard(path: string): number {
    let hash = 0;
    for (let i = 0; i < path.length; i++)
      hash = (hash * 31 + path.charCodeAt(i)) | 0;
    return (hash >>> 0) % 4;
  }

  /** Track catch-up while queries restore readiness from durable markers. */
  backfillStarted(): (complete?: boolean) => void {
    if (!this.backfills) {
      this.indexedLive.clear();
      this.backfillIncomplete = true;
      this.backfillFailed = false;
    }
    this.backfills++;
    return (complete = true) => {
      if (!complete) this.backfillFailed = true;
      if (!--this.backfills && !this.backfillFailed) {
        this.backfillIncomplete = false;
        this.indexedLive.clear();
      }
    };
  }

  private async syncTarget(
    target: SearchTarget,
    signal?: AbortSignal,
    project?: Projector,
  ): Promise<SyncStats> {
    const owned = await this.syncOwned?.(target);
    return (
      (project ? await project(target, owned) : owned) ??
      this.dispatch<SyncStats>(
        { op: "sync", target },
        this.shard(target.path),
        signal,
      )
    );
  }

  private request(
    request: Extract<Work, { op: "sync" }>,
    signal?: AbortSignal,
    project?: Projector,
  ): Promise<SyncStats> {
    const waiting = this.rotating.has(request.target.path);
    const started = performance.now();
    if (waiting)
      this.log(
        "search_rotation_wait",
        { cid: request.target.cid, holder: "store rotation" },
        INFO,
      );
    const work = withFiles(
      [request.target.path],
      () =>
        /* Spec: @tla hold tlaRead(request) */
        this.syncTarget(request.target, signal, project) /* Spec: @tla held */,
    );
    return (signal ? abortable(work, signal) : work).finally(() => {
      if (waiting)
        this.log(
          "search_rotation_wait_done",
          {
            cid: request.target.cid,
            wait_ms: Math.round(performance.now() - started),
          },
          INFO,
        );
    });
  }

  /** Fence file moves until admitted search readers have closed. */
  withStores<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
    const unique = [...new Set(paths)];
    const waiting = unique.filter((path) => filesInFlight.has(path));
    const started = performance.now();
    if (waiting.length)
      this.log(
        "search_store_wait",
        { paths: waiting, holder: "message search or store operation" },
        INFO,
      );
    return withFiles(unique, async () => {
      if (waiting.length)
        this.log(
          "search_store_wait_done",
          { paths: waiting, wait_ms: Math.round(performance.now() - started) },
          INFO,
        );
      for (const path of unique) this.rotating.add(path);
      // Spec: @tla fence {paths:unique, k:"search"}
      try {
        return await operation();
      } finally {
        for (const path of unique) {
          this.rotating.delete(path);
          this.indexedLive.delete(path);
        }
        // Spec: @tla unfence {paths:unique, k:"search"}
      }
    });
  }

  /** Finish projection and close its owner handle before moving a store. */
  async rotate<T>(
    target: SearchTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.drain();
    return this.withStores([target.path], async () => {
      await this.syncTarget(target);
      return operation();
    });
  }

  private dispatch<T>(
    request: Work,
    shard: number,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new Error("Message search closed"));
    let worker = this.workers.get(shard);
    if (!worker) {
      worker = slowSpan(
        "message_search_worker_create",
        undefined,
        () =>
          /* Spec: @tla worker */ new Worker(
            new URL("./search.worker.ts", import.meta.url).href,
          ),
      );
      this.workers.set(shard, worker);
      const current = worker;
      worker.onmessage = (event) => {
        const { id, value, error, log } = event.data;
        if (log) {
          this.log(
            log.event,
            log.event === "search_rg"
              ? { active: (ripgreps += Number(log.fields.delta)) }
              : log.fields,
            INFO,
          );
          return;
        }
        const pending = this.waiting.get(id);
        if (!pending) return;
        this.waiting.delete(id);
        if (error) pending.waiter.reject(new Error(error));
        else pending.waiter.resolve(value);
      };
      worker.onerror = () => {
        for (const [id, pending] of this.waiting) {
          if (pending.worker !== current) continue;
          pending.waiter.reject(new Error("Message search worker failed"));
          this.waiting.delete(id);
        }
        current.terminate();
        this.workers.delete(shard);
      };
    }
    const id = this.next++;
    const waiter = Promise.withResolvers<unknown>();
    this.waiting.set(id, { worker, waiter });
    // Spec: @tla dispatch {request, scope:worker, id}
    worker.postMessage({ ...request, id });
    const abort = () => worker.postMessage({ op: "cancel", id });
    signal?.addEventListener("abort", abort, { once: true });
    const work =
      signal && request.op !== "query"
        ? abortable(waiter.promise, signal)
        : waiter.promise;
    return work.finally(() =>
      signal?.removeEventListener("abort", abort),
    ) as Promise<T>;
  }

  schedule(target: SearchTarget, publication?: CommitPublication): void {
    if (this.closed) return;
    if (
      publication &&
      !publication.changes.some((change) => change.type === "entry")
    )
      return;
    this.indexedLive.delete(target.path);
    this.pending.set(target.path, target);
    this.timer ??= setImmediate(() => {
      this.timer = undefined;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.pending.size) {
        const batch = [...this.pending.entries()].slice(0, 4);
        for (const [path] of batch) this.pending.delete(path);
        await Promise.all(
          batch.map(async ([, target]) => {
            try {
              await this.sync(target);
            } catch {
              this.log("search_sync_failed", { cid: target.cid }, WARNING);
            }
          }),
        );
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  async drain(): Promise<void> {
    if (this.timer) {
      clearImmediate(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  async sync(target: SearchTarget, project?: Projector): Promise<SyncStats> {
    const stats = await this.request(
      { op: "sync", target },
      undefined,
      project,
    );
    if (this.backfillIncomplete && !target.archived)
      this.indexedLive.add(target.path);
    const { file: _file, ...timing } = stats;
    this.log("search_sync", { cid: target.cid, ...timing }, INFO);
    return stats;
  }

  async search(
    targets: SearchTarget[],
    options: SearchOptions,
  ): Promise<{ hits: SearchHit[]; truncated: boolean; not_indexed: number }> {
    if (
      !options.query.trim() ||
      options.query.length > 4096 ||
      /[\r\n\u0000]/.test(options.query)
    )
      throw new Error(
        "Search requires a single-line query of 1–4096 characters",
      );
    const start = performance.now();
    options.signal?.throwIfAborted();
    const finished = Promise.withResolvers<void>();
    this.active.add(finished.promise);
    const controller = new AbortController();
    const partial = this.backfillIncomplete;
    const files = targets.map((target) => ({
      target,
      path: join(dirname(target.path), "transcript.txt"),
      checkCurrent:
        partial && !target.archived && !this.indexedLive.has(target.path),
    }));
    this.controllers.add(controller);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    let leave: (() => void) | undefined;
    let running: Promise<QueryResult> | undefined;
    let rgStart = start;
    this.queries++;
    try {
      leave = await enter(controller.signal);
      controller.signal.throwIfAborted();
      rgStart = performance.now();
      const { signal: _signal, ...query } = options;
      running = this.dispatch(
        { op: "query", files, options: query },
        4,
        controller.signal,
      );
      const result = await abortable(running, controller.signal);
      const incomplete = new Set(result.unindexed ?? []);
      for (const path of result.missing ?? []) incomplete.add(path);
      const notIndexed = files.filter(({ path }) =>
        incomplete.has(path),
      ).length;
      this.log(
        "search_query",
        {
          scope: options.scope,
          agents: targets.length,
          not_indexed: notIndexed,
          queue_ms: rgStart - start,
          rg_ms: performance.now() - rgStart,
          total_ms: performance.now() - start,
          files: files.length,
          ...(result.bytes_scanned === undefined
            ? {}
            : { bytes_scanned: result.bytes_scanned }),
          hits: result.hits.length,
          truncated: result.truncated,
        },
        INFO,
      );
      return {
        hits: result.hits,
        truncated: result.truncated,
        not_indexed: notIndexed,
      };
    } finally {
      if (running) {
        const release = leave;
        leave = undefined;
        const cleanup = running
          .then(
            () => {},
            () => {},
          )
          .finally(() => {
            release?.();
            this.queries--;
            this.active.delete(cleanup);
          });
        this.active.add(cleanup);
      } else this.queries--;
      leave?.();
      this.controllers.delete(controller);
      options.signal?.removeEventListener("abort", abort);
      this.active.delete(finished.promise);
      finished.resolve();
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearImmediate(this.timer);
    await this.flush();
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.all(this.active);
    for (const { waiter } of this.waiting.values())
      waiter.reject(new Error("Message search closed"));
    this.waiting.clear();
    for (const worker of this.workers.values()) worker.terminate();
    this.workers.clear();
  }
}
