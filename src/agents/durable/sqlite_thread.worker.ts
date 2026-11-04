// SQLite requests share one native connection; main queue spans transactions.
// Logical readers cannot write and reuse an existing writable owner. Only a
// cold store opens native read-only. Last-handle close finishes before reply.
// A current search projection retains the final post-checkpoint source cookie.
import { Database, type Statement } from "bun:sqlite";
import { statSync } from "node:fs";
import { closeWithSearchState, sync } from "../../search/sync.worker";
import type { SearchTarget } from "../../search";

export interface NativeOpenCosts {
  native_ms: number;
  journal_mode_ms: number;
  pragmas_ms: number;
  stat_ms: number;
  db_bytes?: number;
  wal_bytes?: number;
}

function fileBytes(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : undefined;
  }
}

export interface ThreadRequest {
  id: number;
  connection: number;
  op:
    | "open"
    | "exec"
    | "run"
    | "runCounted"
    | "get"
    | "all"
    | "close"
    | "syncSearch";
  /** SQL text, or the database path for "open". */
  sql: string;
  params?: unknown[];
  measureOpen?: boolean;
  measureRequest?: boolean;
  readOnly?: boolean;
  nativeReadOnly?: boolean;
  target?: SearchTarget;
}
export interface RequestTiming {
  received: number;
  finished: number;
}

export type ThreadReply = (
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: { name?: string; message: string; code?: string };
    }
) & { timing?: RequestTiming };

interface Store {
  path: string;
  database: Database;
  statements: Map<string, Statement>;
  readOnly: boolean;
  references: number;
}
interface Connection {
  store: Store;
  readOnly: boolean;
}

declare const self: Worker;
const connections = new Map<number, Connection>();
let shared: Store | undefined;

function prepared(store: Store, sql: string): Statement {
  let statement = store.statements.get(sql);
  if (statement === undefined) {
    statement = store.database.prepare(sql);
    store.statements.set(sql, statement);
  }
  return statement;
}

function close(store: Store): void {
  for (const statement of store.statements.values()) statement.finalize();
  store.statements.clear();
  closeWithSearchState(store.path, () => {
    try {
      if (!store.readOnly)
        store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      store.database.close();
    }
  });
}

function execute(request: ThreadRequest): unknown {
  if (request.op === "open") {
    let mark = performance.now();
    const sizes = request.measureOpen
      ? {
          db_bytes: fileBytes(request.sql),
          wal_bytes: fileBytes(`${request.sql}-wal`),
        }
      : {};
    const stat_ms = performance.now() - mark;
    let store = shared;
    let nativeReadOnly = request.nativeReadOnly ?? request.readOnly ?? false;
    if (store && !(store.readOnly && !nativeReadOnly)) {
      store.references++;
      connections.set(request.connection, {
        store,
        readOnly: request.readOnly ?? false,
      });
      return request.measureOpen
        ? { ...sizes, stat_ms, native_ms: 0, journal_mode_ms: 0, pragmas_ms: 0 }
        : undefined;
    }
    mark = performance.now();
    let database: Database;
    try {
      database = new Database(
        request.sql,
        nativeReadOnly
          ? { readonly: true, strict: true }
          : { readwrite: true, create: !request.readOnly, strict: true },
      );
    } catch (error) {
      if (
        !request.readOnly ||
        nativeReadOnly ||
        !/^SQLITE_(CANTOPEN|READONLY)/.test(
          (error as { code?: string }).code ?? "",
        )
      )
        throw error;
      nativeReadOnly = true;
      database = new Database(request.sql, { readonly: true, strict: true });
    }
    const native_ms = performance.now() - mark;
    try {
      if (store) close(store);
      mark = performance.now();
      database.exec("PRAGMA busy_timeout = 5000");
      if (!nativeReadOnly) database.exec("PRAGMA locking_mode = EXCLUSIVE");
      let pragmas_ms = performance.now() - mark;
      mark = performance.now();
      if (!nativeReadOnly) database.exec("PRAGMA journal_mode = WAL");
      const journal_mode_ms = performance.now() - mark;
      mark = performance.now();
      if (!nativeReadOnly) database.exec("PRAGMA synchronous = NORMAL");
      pragmas_ms += performance.now() - mark;
      if (store) {
        store.database = database;
        store.readOnly = nativeReadOnly;
        store.references++;
      } else {
        store = {
          path: request.sql,
          database,
          statements: new Map(),
          readOnly: nativeReadOnly,
          references: 1,
        };
      }
      shared = store;
      connections.set(request.connection, {
        store,
        readOnly: request.readOnly ?? false,
      });
      return request.measureOpen
        ? ({
            ...sizes,
            stat_ms,
            native_ms,
            pragmas_ms,
            journal_mode_ms,
          } satisfies NativeOpenCosts)
        : undefined;
    } catch (error) {
      database.close();
      if (store) {
        store.database = new Database(request.sql, {
          readonly: true,
          strict: true,
        });
        store.database.exec("PRAGMA busy_timeout = 5000");
      }
      if (
        request.readOnly &&
        !nativeReadOnly &&
        /^SQLITE_(READONLY|IOERR_LOCK)/.test(
          (error as { code?: string }).code ?? "",
        )
      )
        return execute({ ...request, nativeReadOnly: true });
      throw error;
    }
  }
  const connection = connections.get(request.connection);
  if (connection === undefined) throw new Error("SQLite connection is closed");
  const { store } = connection;
  if (request.op === "close") {
    connections.delete(request.connection);
    if (--store.references === 0) {
      if (shared === store) shared = undefined;
      close(store);
    }
    return undefined;
  }
  const params = (request.params ?? []) as never[];
  if (
    connection.readOnly &&
    request.op === "exec" &&
    !/^(BEGIN|COMMIT|ROLLBACK)$/.test(request.sql.trim())
  )
    throw Object.assign(new Error("SQLite connection is readonly"), {
      code: "SQLITE_READONLY",
    });
  if (connection.readOnly) store.database.exec("PRAGMA query_only = ON");
  try {
    switch (request.op) {
      case "exec":
        store.database.exec(request.sql);
        return undefined;
      case "run":
        prepared(store, request.sql).run(...params);
        return undefined;
      case "runCounted":
        return prepared(store, request.sql).run(...params).changes;
      case "get":
        return prepared(store, request.sql).get(...params) ?? undefined;
      case "all":
        return prepared(store, request.sql).all(...params);
      case "syncSearch":
        return sync(request.target!, false, store.database);
      default:
        throw new Error(`Unknown SQLite operation: ${request.op}`);
    }
  } finally {
    if (connection.readOnly) store.database.exec("PRAGMA query_only = OFF");
  }
}

self.onmessage = (event: MessageEvent<ThreadRequest>) => {
  const request = event.data;
  // Spec: @tla receive request
  const received = request.measureRequest
    ? performance.timeOrigin + performance.now()
    : 0;
  let reply: ThreadReply;
  try {
    reply = { id: request.id, ok: true, value: execute(request) };
  } catch (error) {
    const failure = error as { name?: string; message?: string; code?: string };
    reply = {
      id: request.id,
      ok: false,
      error: {
        name: failure.name,
        message: String(failure.message ?? error),
        code: failure.code,
      },
    };
  }
  if (request.measureRequest)
    reply.timing = {
      received,
      finished: performance.timeOrigin + performance.now(),
    };
  // Spec: @tla reply request
  self.postMessage(reply);
};
