// One EXCLUSIVE native connection/queue per database serves logical readers.
// Native read-only readers/backups require a closed owner; close/replacement
// await worker exit. WAL/NORMAL survives process crashes, not power loss.
// Open costs separate queue, dispatch/startup, execution and reply delivery.
import {
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  awaitedReplyBytes,
  awaitedSpan,
  slowSpan,
  workerReply,
} from "../../observability/slow_span";
import type { SearchTarget, SyncStats } from "../../search";
import type {
  NativeOpenCosts,
  ThreadReply,
  ThreadRequest,
} from "./sqlite_thread.worker.ts";

export type SqliteOpenCosts = Partial<NativeOpenCosts> & {
  migration_ms: number;
  metadata_ms: number;
  queue_ms: number;
  dispatch_ms: number;
  execution_ms: number;
  reply_ms: number;
};

// Spec: @tla workers
const THREAD_URL = new URL("./sqlite_thread.worker.ts", import.meta.url).href;

interface Thread {
  path: string;
  connections: number;
  worker: Worker;
  waiting: Map<
    number,
    PromiseWithResolvers<unknown> & {
      costs?: SqliteOpenCosts;
      dispatched: number;
      op: ThreadRequest["op"];
      replyBytes?: (bytes: number) => void;
    }
  >;
  dead: Error | null;
  exited: Promise<void>;
  tail: Promise<unknown>;
}

/** One lazy Worker per database, stopped when its last connection closes. */
export class SqliteWorker {
  private threads = new Map<string, Thread>();
  private nextId = 0;
  private nextConnection = 0;
  private closed = false;

  constructor(
    private readonly createWorker: (url: string) => Worker = (url) =>
      new Worker(url),
  ) {}

  private start(path: string): Thread {
    const exited = Promise.withResolvers<void>();
    const thread: Thread = {
      path,
      connections: 0,
      worker: slowSpan("sqlite_worker_create", undefined, () =>
        this.createWorker(THREAD_URL),
      ),
      waiting: new Map(),
      dead: null,
      exited: exited.promise,
      tail: Promise.resolve(),
    };
    thread.worker.onmessage = (event: MessageEvent<ThreadReply>) => {
      const reply = slowSpan(
        "sqlite_reply_decode",
        undefined,
        () => event.data,
      );
      const waiter = thread.waiting.get(reply.id);
      if (!waiter) return;
      thread.waiting.delete(reply.id);
      if (reply.payload) {
        waiter.replyBytes?.(reply.payload.string_bytes);
        workerReply(
          `sqlite_${waiter.op}`,
          reply.payload.string_bytes,
          reply.payload.sent,
        );
      }
      if (waiter.costs && reply.timing) {
        const { received, finished } = reply.timing;
        waiter.costs.dispatch_ms += Math.max(0, received - waiter.dispatched);
        waiter.costs.execution_ms += Math.max(0, finished - received);
        waiter.costs.reply_ms += Math.max(
          0,
          performance.timeOrigin + performance.now() - finished,
        );
      }
      if (reply.ok) waiter.resolve(reply.value);
      else
        waiter.reject(
          Object.assign(new Error(reply.error.message), reply.error),
        );
    };
    thread.worker.onerror = (event) =>
      this.stop(thread, event.message || "error");
    thread.worker.addEventListener("close", () => {
      this.stop(thread, "exited");
      if (this.threads.get(thread.path) === thread)
        this.threads.delete(thread.path);
      exited.resolve();
    });
    this.threads.set(path, thread);
    return thread;
  }

  private stop(thread: Thread, cause: string): void {
    if (thread.dead) return;
    thread.dead = new Error(`SQLite worker died: ${cause}`);
    for (const waiter of thread.waiting.values()) waiter.reject(thread.dead);
    thread.waiting.clear();
    slowSpan("sqlite_worker_terminate", undefined, () =>
      thread.worker.terminate(),
    );
  }

  async release(thread: Thread, closeFailed = false): Promise<void> {
    const last = --thread.connections === 0;
    if (closeFailed || last)
      this.stop(thread, closeFailed ? "connection close failed" : "closed");
    if (thread.dead) await thread.exited;
  }

  // Send one request to `thread`; rejects if that thread is or becomes dead.
  request(
    thread: Thread,
    request: Omit<ThreadRequest, "id">,
    costs?: SqliteOpenCosts,
  ): Promise<unknown> {
    if (thread.dead) return Promise.reject(thread.dead);
    const id = this.nextId++;
    // Spec: @tla dispatch {request, scope:thread.worker, path:thread.path, id}
    const waiter = {
      ...Promise.withResolvers<unknown>(),
      costs,
      dispatched: costs ? performance.timeOrigin + performance.now() : 0,
      op: request.op,
      replyBytes: awaitedReplyBytes(),
    };
    try {
      slowSpan("sqlite_request_clone", undefined, () =>
        thread.worker.postMessage({ ...request, id, measureRequest: !!costs }),
      );
    } catch (error) {
      // Invariant: A parameter that cannot be cloned never reaches the Worker.
      return Promise.reject(error);
    }
    thread.waiting.set(id, waiter);
    return waiter.promise;
  }

  /** `refused` hears the SQLite code of each write refused busy or locked. */
  async openDatabase(
    path: string,
    refused?: (code: string) => void,
    costs?: SqliteOpenCosts,
    readOnly = false,
    nativeReadOnly = readOnly,
  ): Promise<WorkerSqliteDatabase> {
    if (this.closed) throw new Error("SQLite worker closed");
    const key = resolve(path);
    let previous = this.threads.get(key);
    const waiting = previous?.dead && costs ? performance.now() : undefined;
    while (previous?.dead) {
      await previous.exited;
      if (this.closed) throw new Error("SQLite worker closed");
      previous = this.threads.get(key);
    }
    if (waiting !== undefined && costs)
      costs.queue_ms += performance.now() - waiting;
    const thread = previous ?? this.start(key);
    thread.connections++;
    const connection = this.nextConnection++;
    // Spec: @tla admit tlaConn(thread,connection)
    try {
      const open = () =>
        this.request(
          thread,
          {
            connection,
            op: "open",
            sql: path,
            measureOpen: costs !== undefined,
            readOnly,
            nativeReadOnly,
          },
          costs,
        );
      const native = await this.enqueue(thread, open, costs);
      // Spec: @tla open tlaConn(thread,connection)
      if (costs) Object.assign(costs, native);
      return new WorkerSqliteDatabase(
        this,
        thread,
        connection,
        refused,
        costs,
        readOnly,
      );
    } catch (error) {
      await this.release(thread);
      // Spec: @tla close tlaConn(thread,connection)
      throw error;
    }
  }

  enqueue<T>(
    thread: Thread,
    operation: () => Promise<T>,
    costs?: SqliteOpenCosts,
  ): Promise<T> {
    const queued = costs ? performance.now() : 0;
    const result = thread.tail.then(() => {
      if (costs) costs.queue_ms += performance.now() - queued;
      return operation();
    });
    thread.tail = result.catch(() => undefined);
    return result;
  }

  /** Closing actors still own their native handle until their exit event. */
  hasDatabase(path: string): boolean {
    return this.threads.has(resolve(path));
  }

  /** Project a store through its sole connection, including while live. */
  async syncSearch(target: SearchTarget): Promise<SyncStats> {
    const database = await this.openDatabase(
      target.path,
      undefined,
      undefined,
      true,
      target.archived ?? false,
    ).catch(async (error) => {
      if (error.code !== "SQLITE_CANTOPEN") throw error;
      const exists = await stat(target.path).catch((failure) => {
        if (failure.code === "ENOENT") return null;
        throw failure;
      });
      if (exists) throw error;
      return null;
    });
    if (!database) return { entries: 0, bytes: 0, ms: 0 };
    try {
      return await database.syncSearch(target);
    } finally {
      await database.close();
    }
  }

  /** Refuse requests, stop all Workers, and wait for their native handles. */
  async close(): Promise<void> {
    this.closed = true;
    const threads = [...this.threads.values()];
    for (const thread of threads) this.stop(thread, "closed");
    await Promise.all(threads.map((thread) => thread.exited));
  }
}

class Executor implements SqliteExecutor {
  constructor(
    protected readonly send: (
      op: ThreadRequest["op"],
      sql: string,
      params?: SqliteValue[],
    ) => Promise<unknown>,
  ) {}
  async exec(sql: string): Promise<void> {
    await this.send("exec", sql);
  }
  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    await this.send("run", sql, params);
  }
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.send("runCounted", sql, params) as Promise<number>;
  }
  get<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T | undefined> {
    return this.send("get", sql, params) as Promise<T | undefined>;
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.send("all", sql, params) as Promise<T[]>;
  }
}

/** One connection; requests run one at a time in call order. */
export class WorkerSqliteDatabase extends Executor implements SqliteDatabase {
  private closed = false;

  constructor(
    private readonly owner: SqliteWorker,
    private readonly thread: Thread,
    private readonly connection: number,
    private readonly refused?: (code: string) => void,
    private opening?: SqliteOpenCosts,
    private readonly readOnly = false,
  ) {
    super((op, sql, params) => this.serial(() => this.direct(op, sql, params)));
  }

  private direct(
    op: ThreadRequest["op"],
    sql: string,
    params?: SqliteValue[],
  ): Promise<unknown> {
    return this.owner.request(
      this.thread,
      { connection: this.connection, op, sql, params },
      this.opening,
    );
  }

  // Run `operation` after everything queued before it; it holds the queue until
  // it settles.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    return this.owner.enqueue(this.thread, operation, this.opening);
  }

  override get<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T | undefined> {
    const costs = this.opening;
    const started = costs ? performance.now() : 0;
    const result = super.get<T>(sql, ...params);
    return costs
      ? result.finally(() => {
          costs.metadata_ms += performance.now() - started;
        })
      : result;
  }

  transaction<T>(
    callback: (transaction: SqliteExecutor) => Promise<T>,
  ): Promise<T> {
    const costs = this.opening;
    const started = costs ? performance.now() : 0;
    const result = this.serial(async () => {
      try {
        await this.direct("exec", this.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code !== "string" || !/^SQLITE_(BUSY|LOCKED)/.test(code))
          throw error;
        this.refused?.(code);
        throw new Error(
          `SQLite refused the write: ${(error as Error).message}`,
          { cause: error },
        );
      }
      let active = true;
      const handle = new Executor((op, sql, params) =>
        active
          ? this.direct(op, sql, params)
          : Promise.reject(
              new Error("SQLite transaction handle is no longer active"),
            ),
      );
      try {
        const result = await callback(handle);
        active = false;
        await this.direct("exec", "COMMIT");
        return result;
      } catch (error) {
        active = false;
        try {
          await this.direct("exec", "ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite transaction failed and rollback failed",
          );
        }
        throw error;
      }
    });
    return costs
      ? result.finally(() => {
          costs.migration_ms += performance.now() - started;
        })
      : result;
  }

  syncSearch(target: SearchTarget): Promise<SyncStats> {
    return this.serial(() =>
      this.owner.request(this.thread, {
        connection: this.connection,
        op: "syncSearch",
        sql: "",
        target,
      }),
    ) as Promise<SyncStats>;
  }

  finishOpenTiming(): void {
    this.opening = undefined;
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      let failed = true;
      try {
        await this.direct("close", "");
        failed = false;
      } finally {
        await this.owner.release(this.thread, failed);
        // Spec: @tla close tlaConn(this.thread,this.connection)
      }
    });
  }
}

/** Open file-backed Durable storage at `path` whose SQL runs on `worker`. */
export async function openWorkerSqliteStorage(
  worker: SqliteWorker,
  path: string,
  refused?: (code: string) => void,
  onCosts?: (costs: SqliteOpenCosts) => void,
  readOnly = false,
  nativeReadOnly = readOnly,
  diagnosticCid?: string,
): Promise<SqliteStorage> {
  const costs = onCosts
    ? {
        migration_ms: 0,
        metadata_ms: 0,
        queue_ms: 0,
        dispatch_ms: 0,
        execution_ms: 0,
        reply_ms: 0,
      }
    : undefined;
  const database = await worker.openDatabase(
    path,
    refused,
    costs,
    readOnly,
    nativeReadOnly,
  );
  try {
    const open = () => SqliteStorage.open(database, { readOnly });
    const storage = await (diagnosticCid
      ? awaitedSpan("pi_storage_open", diagnosticCid, open)
      : open());
    if (!diagnosticCid) return storage;
    const methods = new Map<PropertyKey, unknown>();
    return new Proxy(storage, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (
          typeof value !== "function" ||
          key === "constructor" ||
          !Object.hasOwn(SqliteStorage.prototype, key)
        )
          return value;
        if (!methods.has(key))
          methods.set(key, (...args: unknown[]) =>
            awaitedSpan(`pi_${String(key)}`, diagnosticCid, () =>
              Promise.resolve(Reflect.apply(value, target, args)),
            ),
          );
        return methods.get(key);
      },
    });
  } finally {
    database.finishOpenTiming();
    if (costs) onCosts?.(costs);
  }
}
