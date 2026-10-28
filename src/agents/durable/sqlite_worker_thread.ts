// Worker thread for sqlite_worker.ts: holds bun:sqlite connections by number
// and runs each request in arrival order, replying exactly once. The main side
// serializes each connection, so requests for one connection never overlap.
// Requested file sizes are sampled before open; inaccessible sizes are omitted.
import { Database, type Statement } from "bun:sqlite";
import { statSync } from "node:fs";

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
  op: "open" | "exec" | "run" | "get" | "all" | "close";
  /** SQL text, or the database path for "open". */
  sql: string;
  params?: unknown[];
  measureOpen?: boolean;
}
export type ThreadReply =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: { name?: string; message: string; code?: string };
    };

interface Connection {
  database: Database;
  statements: Map<string, Statement>;
}

declare const self: Worker;
const connections = new Map<number, Connection>();

function prepared(connection: Connection, sql: string): Statement {
  let statement = connection.statements.get(sql);
  if (statement === undefined) {
    statement = connection.database.prepare(sql);
    connection.statements.set(sql, statement);
  }
  return statement;
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
    mark = performance.now();
    const database = new Database(request.sql, { create: true, strict: true });
    const native_ms = performance.now() - mark;
    mark = performance.now();
    database.exec("PRAGMA busy_timeout = 5000");
    let pragmas_ms = performance.now() - mark;
    mark = performance.now();
    database.exec("PRAGMA journal_mode = WAL");
    const journal_mode_ms = performance.now() - mark;
    mark = performance.now();
    database.exec("PRAGMA synchronous = NORMAL");
    pragmas_ms += performance.now() - mark;
    connections.set(request.connection, { database, statements: new Map() });
    return request.measureOpen
      ? ({
          ...sizes,
          stat_ms,
          native_ms,
          pragmas_ms,
          journal_mode_ms,
        } satisfies NativeOpenCosts)
      : undefined;
  }
  const connection = connections.get(request.connection);
  if (connection === undefined) throw new Error("SQLite connection is closed");
  const params = (request.params ?? []) as never[];
  switch (request.op) {
    case "exec":
      connection.database.exec(request.sql);
      return undefined;
    case "run":
      prepared(connection, request.sql).run(...params);
      return undefined;
    case "get":
      return prepared(connection, request.sql).get(...params) ?? undefined;
    case "all":
      return prepared(connection, request.sql).all(...params);
    case "close":
      connections.delete(request.connection);
      for (const statement of connection.statements.values())
        statement.finalize();
      try {
        connection.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        connection.database.close();
      }
      return undefined;
  }
}

self.onmessage = (event: MessageEvent<ThreadRequest>) => {
  const request = event.data;
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
  self.postMessage(reply);
};
