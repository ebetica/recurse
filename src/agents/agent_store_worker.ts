// SQLite work and FULL fsyncs run only in this Worker, never on Bun's main
// loop.
import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { StoreOp, WorkerRequest, WorkerResponse } from "./agent_store";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent (
    cid TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intents (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_ts REAL NOT NULL
);
-- Dispatch marks: one row per intent that left the queue toward Pi.
-- A separate table (never a column) so pre-upgrade databases simply
-- lack it: recovery then treats every survivor as dispatched.
CREATE TABLE IF NOT EXISTS dispatches (
    intent_id TEXT PRIMARY KEY
);
`;

function apply(cid: string, path: string, batch: StoreOp[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.run("PRAGMA busy_timeout=5000;");
    db.run("PRAGMA journal_mode=DELETE;");
    db.run("PRAGMA synchronous=FULL;");
    db.exec(SCHEMA);
    db.run("BEGIN IMMEDIATE;");
    try {
      for (const op of batch) {
        switch (op.kind) {
          case "save":
            db.run(
              "INSERT INTO agent (cid, data) VALUES (?, ?) ON CONFLICT (cid) DO UPDATE SET data = excluded.data;",
              [cid, op.payload],
            );
            break;
          case "intent":
            db.run(
              "INSERT INTO intents (id, kind, body, created_ts) VALUES (?, ?, ?, ?);",
              op.payload,
            );
            break;
          case "retire":
            db.run("DELETE FROM intents WHERE id = ?;", [op.payload]);
            db.run("DELETE FROM dispatches WHERE intent_id = ?;", [op.payload]);
            break;
          case "dispatched":
            db.run("INSERT OR IGNORE INTO dispatches (intent_id) VALUES (?);", [
              op.payload,
            ]);
            break;
          case "undispatched":
            db.run("DELETE FROM dispatches WHERE intent_id = ?;", [op.payload]);
            break;
        }
      }
      db.run("COMMIT;");
    } catch (error) {
      try {
        db.run("ROLLBACK;");
      } catch {}
      throw error;
    }
  } finally {
    db.close();
  }
}

function load(
  cid: string,
  path: string,
): [Record<string, unknown> | null, Record<string, unknown>[]] {
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (error) {
    try {
      statSync(path);
    } catch (statError) {
      // Invariant: existsSync conflates EACCES with absence; only a missing
      // path is empty.
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (statError as NodeJS.ErrnoException).code ?? "",
        )
      )
        return [null, []];
    }
    throw new Error(`agent database unavailable: ${path}: ${String(error)}`);
  }
  try {
    db.run("PRAGMA busy_timeout=5000;");
    let row: unknown[] | undefined;
    let intents: unknown[][];
    try {
      row = db.query("SELECT data FROM agent WHERE cid = ?;").values(cid)[0];
      intents = db
        .query("SELECT id, kind, body, created_ts FROM intents ORDER BY seq;")
        .values();
    } catch (error) {
      throw new Error(`agent database unreadable: ${path}: ${String(error)}`);
    }
    let metadata: Record<string, unknown> | null = null;
    if (row) {
      try {
        metadata = JSON.parse(row[0] as string);
      } catch (error) {
        throw new Error(`agent metadata corrupt: ${path}: ${String(error)}`);
      }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        throw new Error(`agent metadata corrupt: ${path}: not an object`);
    }
    let dispatched: Set<unknown> | null;
    try {
      dispatched = new Set(
        db
          .query("SELECT intent_id FROM dispatches;")
          .values()
          .map((r) => r[0]),
      );
    } catch (error) {
      // Invariant: Keep the three-line legacy tolerance, but never mask any
      // other SQL failure.
      if (
        !(error instanceof SQLiteError) ||
        !String(error).includes("no such table: dispatches")
      )
        throw error;
      dispatched = null;
    }
    return [
      metadata,
      intents.map(([id, kind, body, created_ts]) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body as string);
        } catch (error) {
          throw new Error(`agent intent corrupt: ${path}: ${String(error)}`);
        }
        return {
          id,
          kind,
          body: parsed,
          created_ts,
          dispatched: dispatched === null || dispatched.has(id),
        };
      }),
    ];
  } finally {
    db.close();
  }
}

// Each request owns a connection; each Worker serializes its jobs.
declare const self: { onmessage: (event: MessageEvent<WorkerRequest>) => void };
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const result =
      request.kind === "apply"
        ? apply(request.cid, request.path, request.batch)
        : load(request.cid, request.path);
    postMessage({ id: request.id, ok: true, result } satisfies WorkerResponse);
  } catch (error) {
    postMessage({
      id: request.id,
      ok: false,
      error: `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies WorkerResponse);
  }
};
