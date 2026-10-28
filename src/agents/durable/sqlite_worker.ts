// Worker SQL/fsync; per-database queues hold transactions through commit.
// SQLite waits for busy writes; any storage failure fails the session.
// Worker death rejects pending work/poisons sessions; new opens replace it.
// WAL/NORMAL survives process crashes, but power loss may drop the last commit.
import {
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import type {
  NativeOpenCosts,
  ThreadReply,
  ThreadRequest,
} from "./sqlite_worker_thread.ts";

export type SqliteOpenCosts = Partial<NativeOpenCosts> & {
  migration_ms: number;
  metadata_ms: number;
};

const THREAD_URL = new URL("./sqlite_worker_thread.ts", import.meta.url).href;

interface Thread {
  worker: Worker;
  waiting: Map<number, PromiseWithResolvers<unknown>>;
  dead: Error | null;
}

/** One Worker thread holding many SQLite connections. */
export class SqliteWorker {
  private thread: Thread | null = null;
  private nextId = 0;
  private nextConnection = 0;
  private closed = false;

  constructor(
    private readonly createWorker: (url: string) => Worker = (url) =>
      new Worker(url),
  ) {}

  private start(): Thread {
    const thread: Thread = {
      worker: this.createWorker(THREAD_URL),
      waiting: new Map(),
      dead: null,
    };
    thread.worker.onmessage = (event: MessageEvent<ThreadReply>) => {
      const reply = event.data;
      const waiter = thread.waiting.get(reply.id);
      if (!waiter) return;
      thread.waiting.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.value);
      else
        waiter.reject(
          Object.assign(new Error(reply.error.message), reply.error),
        );
    };
    const died = (cause: string) => {
      if (thread.dead) return;
      thread.dead = new Error(`SQLite worker died: ${cause}`);
      if (this.thread === thread) this.thread = null;
      for (const waiter of thread.waiting.values()) waiter.reject(thread.dead);
      thread.waiting.clear();
      thread.worker.terminate();
    };
    thread.worker.onerror = (event) => died(event.message || "error");
    thread.worker.addEventListener("close", () => died("exited"));
    return thread;
  }

  // Send one request to `thread`; rejects if that thread is or becomes dead.
  request(
    thread: Thread,
    request: Omit<ThreadRequest, "id">,
  ): Promise<unknown> {
    if (thread.dead) return Promise.reject(thread.dead);
    const id = this.nextId++;
    const waiter = Promise.withResolvers<unknown>();
    try {
      thread.worker.postMessage({ ...request, id });
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
  ): Promise<WorkerSqliteDatabase> {
    if (this.closed) throw new Error("SQLite worker closed");
    this.thread ??= this.start();
    const thread = this.thread;
    const connection = this.nextConnection++;
    const native = await this.request(thread, {
      connection,
      op: "open",
      sql: path,
      measureOpen: costs !== undefined,
    });
    if (costs) Object.assign(costs, native);
    return new WorkerSqliteDatabase(this, thread, connection, refused, costs);
  }

  /** Stop the Worker; pending and later requests reject. */
  close(): void {
    this.closed = true;
    this.thread?.worker.terminate();
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
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly owner: SqliteWorker,
    private readonly thread: Thread,
    private readonly connection: number,
    private readonly refused?: (code: string) => void,
    private opening?: SqliteOpenCosts,
  ) {
    super((op, sql, params) => this.serial(() => this.direct(op, sql, params)));
  }

  private direct(
    op: ThreadRequest["op"],
    sql: string,
    params?: SqliteValue[],
  ): Promise<unknown> {
    return this.owner.request(this.thread, {
      connection: this.connection,
      op,
      sql,
      params,
    });
  }

  // Run `operation` after everything queued before it; it holds the queue until
  // it settles.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
        await this.direct("exec", "BEGIN IMMEDIATE");
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

  finishOpenTiming(): void {
    this.opening = undefined;
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      await this.direct("close", "");
    });
  }
}

/** Open file-backed Durable storage at `path` whose SQL runs on `worker`. */
export async function openWorkerSqliteStorage(
  worker: SqliteWorker,
  path: string,
  refused?: (code: string) => void,
  onCosts?: (costs: SqliteOpenCosts) => void,
): Promise<SqliteStorage> {
  const costs = onCosts ? { migration_ms: 0, metadata_ms: 0 } : undefined;
  const database = await worker.openDatabase(path, refused, costs);
  try {
    return await SqliteStorage.open(database);
  } finally {
    database.finishOpenTiming();
    if (costs) onCosts?.(costs);
  }
}
