import { afterAll, describe, expect, it, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import {
  openWorkerSqliteStorage,
  SqliteWorker,
} from "../../src/agents/durable/sqlite_worker.ts";
import { openFauxHarness } from "./fixtures/durable_sqlite/harness.ts";

const root = mkdtempSync(join(tmpdir(), "durable-sqlite-"));
const worker = new SqliteWorker();
afterAll(async () => {
  await worker.close();
  rmSync(root, { recursive: true, force: true });
});
let databases = 0;
const freshPath = () => join(root, `${databases++}.sqlite`);

const awaitingExpect = (actual: unknown, message?: string) => ({
  toBeTruthy: () => expect(actual, message).toBeTruthy(),
  toBe: (expected: unknown) => expect(actual).toBe(expected),
  toEqual: (expected: unknown) => expect(actual).toEqual(expected),
  toMatchObject: (expected: object) => expect(actual).toMatchObject(expected),
  toBeGreaterThan: (expected: number) =>
    expect(actual).toBeGreaterThan(expected),
  rejects: {
    async toThrow(expected?: string | RegExp) {
      const failure = await Promise.resolve(actual).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      if (expected !== undefined)
        expect((failure as Error).message).toMatch(expected);
    },
  },
});

registerStorageConformance(
  {
    describe,
    expect: awaitingExpect as never,
    it: (name, body) => it(name, body, 30_000),
  },
  "Worker SQLite",
  async (use) => {
    const storage = await openWorkerSqliteStorage(worker, freshPath());
    try {
      await use(storage);
    } finally {
      await storage.close(context);
    }
  },
);

test("open costs measure initialization and file sizes before opening an existing store", async () => {
  const path = freshPath();
  const seeded = await openWorkerSqliteStorage(worker, path);
  let storage: Awaited<ReturnType<typeof openWorkerSqliteStorage>> | undefined;
  try {
    const sizes = {
      db_bytes: statSync(path).size,
      wal_bytes: statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0,
    };
    let measured: unknown;
    storage = await openWorkerSqliteStorage(
      worker,
      path,
      undefined,
      (costs) => {
        measured = costs;
      },
    );
    expect(sizes.wal_bytes).toBeGreaterThan(0);
    expect(measured).toMatchObject({
      ...sizes,
      native_ms: expect.any(Number),
      journal_mode_ms: expect.any(Number),
      pragmas_ms: expect.any(Number),
      stat_ms: expect.any(Number),
      migration_ms: expect.any(Number),
      metadata_ms: expect.any(Number),
      queue_ms: expect.any(Number),
      dispatch_ms: expect.any(Number),
      execution_ms: expect.any(Number),
      reply_ms: expect.any(Number),
    });
  } finally {
    await storage?.close(context);
    await seeded.close(context);
  }
});

test("a busy database open does not block another database before the lock is released", async () => {
  const path = freshPath();
  const foreign = new Database(path, { create: true });
  foreign.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE t (x INTEGER); BEGIN IMMEDIATE",
  );
  const posted = Promise.withResolvers<void>();
  const owner = new SqliteWorker((url) => {
    const thread = new Worker(url);
    const post = thread.postMessage.bind(thread);
    thread.postMessage = (message, options) => {
      if (Array.isArray(options)) post(message, options);
      else post(message, options);
      if (message.op === "open" && message.sql === path) posted.resolve();
    };
    return thread;
  });
  let database: Awaited<ReturnType<SqliteWorker["openDatabase"]>> | undefined;
  let settled = false;
  const pending = owner
    .openDatabase(path)
    .then(async (opened) => {
      database = opened;
      await opened.transaction((tx) => tx.run("INSERT INTO t VALUES (?)", 1));
    })
    .then(
      () => {
        settled = true;
        return "committed";
      },
      (error) => {
        settled = true;
        return String(error);
      },
    );
  let other: Awaited<ReturnType<SqliteWorker["openDatabase"]>> | undefined;
  try {
    await posted.promise;
    other = await owner.openDatabase(freshPath());
    await other.exec("CREATE TABLE t (x INTEGER)");
    await other.transaction((tx) => tx.run("INSERT INTO t VALUES (?)", 2));
    expect(await other.all("SELECT x FROM t")).toEqual([{ x: 2 }]);
    expect(settled).toBe(false);
  } finally {
    foreign.exec("ROLLBACK");
    foreign.close();
    await pending;
    await other?.close();
    await database?.close();
    await owner.close();
  }
  expect(await pending).toBe("committed");
});

test("database workers start lazily and stop only after their last connection closes", async () => {
  const started: Worker[] = [];
  const exited: Promise<void>[] = [];
  let closedCount = 0;
  const owner = new SqliteWorker((url) => {
    expect(closedCount).toBe(started.length);
    const thread = new Worker(url);
    const closed = Promise.withResolvers<void>();
    thread.addEventListener(
      "close",
      () => {
        closedCount++;
        closed.resolve();
      },
      { once: true },
    );
    started.push(thread);
    exited.push(closed.promise);
    return thread;
  });
  try {
    expect(started).toHaveLength(0);
    const path = freshPath();
    const database = await owner.openDatabase(path);
    await database.exec("CREATE TABLE t (x INTEGER)");
    await database.run("INSERT INTO t VALUES (?)", 1);
    const reader = await owner.openDatabase(path, undefined, undefined, true);
    expect(started).toHaveLength(1);
    expect(await reader.all("SELECT x FROM t")).toEqual([{ x: 1 }]);
    expect(
      await reader.run("INSERT INTO t VALUES (?)", 2).then(String, String),
    ).toContain("readonly");
    await reader.close();
    await database.run("INSERT INTO t VALUES (?)", 3);
    expect(await database.all("SELECT x FROM t")).toEqual([{ x: 1 }, { x: 3 }]);
    expect(started).toHaveLength(1);
    await database.close();
    const reopened = await owner.openDatabase(path);
    expect(started).toHaveLength(2);
    expect(await reopened.all("SELECT x FROM t")).toEqual([{ x: 1 }, { x: 3 }]);
    await reopened.close();
    await exited[1];
    await expect(
      owner.openDatabase(freshPath(), undefined, undefined, true),
    ).rejects.toThrow();
    expect(started).toHaveLength(3);
    await exited[2];
    const active = await owner.openDatabase(path);
    const stopping = owner.close();
    await active.close().catch(() => undefined);
    expect(closedCount).toBe(4);
    await stopping;
  } finally {
    await owner.close();
  }
});

test("a dead Worker poisons only its database and the next open starts a new one", async () => {
  const started: Worker[] = [];
  const posted = Promise.withResolvers<void>();
  const owner = new SqliteWorker((url) => {
    const thread = new Worker(url);
    const post = thread.postMessage.bind(thread);
    thread.postMessage = (message, options) => {
      if (Array.isArray(options)) post(message, options);
      else post(message, options);
      if (String(message.sql).startsWith("WITH RECURSIVE")) posted.resolve();
    };
    started.push(thread);
    return thread;
  });
  try {
    const path = freshPath();
    const database = await owner.openDatabase(path);
    await database.exec("CREATE TABLE t (x INTEGER)");
    await database.run("INSERT INTO t VALUES (?)", 1);
    const sibling = await owner.openDatabase(path);
    const other = await owner.openDatabase(freshPath());
    expect(started).toHaveLength(2);
    const pending = database.get(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000000) SELECT count(*) AS n FROM c",
    );
    const result = pending.then(String, String);
    await posted.promise;
    started[0]!.terminate();
    expect(await result).toBe("Error: SQLite worker died: exited");
    expect(await database.get("SELECT 1").then(String, String)).toBe(
      "Error: SQLite worker died: exited",
    );
    expect(await sibling.get("SELECT 1").then(String, String)).toBe(
      "Error: SQLite worker died: exited",
    );
    expect(await other.get("SELECT 1 AS one")).toEqual({ one: 1 });
    const reopened = await owner.openDatabase(path);
    expect(started).toHaveLength(3);
    expect(await reopened.all("SELECT x FROM t")).toEqual([{ x: 1 }]);
    await sibling.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    await other.close();
    await reopened.close();
  } finally {
    await owner.close();
  }
});

test("a parameter the Worker cannot receive rejects only that request", async () => {
  const exited = Promise.withResolvers<void>();
  const owner = new SqliteWorker((url) => {
    const thread = new Worker(url);
    thread.addEventListener("close", () => exited.resolve(), { once: true });
    return thread;
  });
  const database = await owner.openDatabase(freshPath());
  const bytes = new Uint8Array([1, 2]);
  structuredClone(bytes, { transfer: [bytes.buffer] });
  expect(
    await database.get("SELECT ? AS b", bytes).then(
      () => "answered",
      (error: Error) => error.name,
    ),
  ).toBe("DataCloneError");
  expect(await database.get("SELECT 1 AS one")).toEqual({ one: 1 });
  await database.close();
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    await owner.close();
    await exited.promise;
  } finally {
    process.off("unhandledRejection", record);
  }
  expect(unhandled.map(String)).toEqual([]);
});

// Feature: #3055 one exclusive owner serves durable history and search readers.
test("stores share exclusive WAL with history and search readers", async () => {
  const owner = new SqliteWorker();
  const path = freshPath();
  const database = await owner.openDatabase(path);
  const { harness, conversation } = await openFauxHarness(database);
  try {
    expect(await database.get("PRAGMA journal_mode")).toEqual({
      journal_mode: "wal",
    });
    expect(await database.get("PRAGMA locking_mode")).toEqual({
      locking_mode: "exclusive",
    });
    const run = await conversation.submit(
      { type: "input", content: "network question", requestId: "network" },
      context,
    );
    expect((await run.wait(context)).status).toBe("done");
    const reader = await owner.openDatabase(path, undefined, undefined, true);
    try {
      expect(
        (await reader.all("SELECT id FROM entries")).length,
      ).toBeGreaterThan(0);
      expect(
        await reader
          .get("DELETE FROM entries RETURNING id")
          .then(String, String),
      ).toContain("readonly");
      const storage = await openWorkerSqliteStorage(
        owner,
        path,
        undefined,
        undefined,
        true,
      );
      expect(
        (
          await storage.scanEntries(
            { conversationId: conversation.id },
            1,
            undefined,
            context,
          )
        ).items.length,
      ).toBeGreaterThan(0);
      await storage.close(context);
      const projection = await owner.syncSearch({ cid: "network", path });
      expect(readFileSync(projection!.file!.path, "utf8")).toContain(
        "network question",
      );
      expect(readFileSync(projection!.file!.path, "utf8")).toContain("done");
      await database.exec("CREATE TABLE serial (n INTEGER)");
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const write = database.transaction(async (tx) => {
        await tx.run("INSERT INTO serial VALUES (1)");
        started.resolve();
        await release.promise;
      });
      await started.promise;
      const read = reader.all("SELECT n FROM serial");
      release.resolve();
      await write;
      expect(await read).toEqual([{ n: 1 }]);
      expect(
        statSync(`${path}-shm`, { throwIfNoEntry: false }),
      ).toBeUndefined();
    } finally {
      await reader.close();
    }
  } finally {
    await harness.close(context);
  }
  const live = await owner.openDatabase(
    path,
    undefined,
    undefined,
    true,
    false,
  );
  expect(await live.get("PRAGMA locking_mode")).toEqual({
    locking_mode: "exclusive",
  });
  expect(
    await live
      .exec("PRAGMA query_only=OFF; DELETE FROM entries")
      .then(String, String),
  ).toContain("readonly");
  await live.close();
  const cold = await owner.openDatabase(path, undefined, undefined, true);
  try {
    expect((await cold.all("SELECT id FROM entries")).length).toBeGreaterThan(
      0,
    );
    const writer = await owner.openDatabase(path);
    await writer.run("INSERT INTO serial VALUES (2)");
    expect(await cold.all("SELECT n FROM serial")).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    await writer.close();
  } finally {
    await cold.close();
    await owner.close();
  }
});

async function killInsideTransaction(
  path: string,
  first: number,
  killAt: number,
): Promise<number[]> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/durable_sqlite/crash_child.ts"),
      path,
      String(first),
      String(killAt),
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(137);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).done);
}

test("kill -9 inside a commit loses no settled turn and the storage reopens", async () => {
  const path = freshPath();
  const settled: number[] = [];
  for (const killAt of [3, 8, 15, 40, 90]) {
    const first = (settled.at(-1) ?? -1) + 1 + 10;
    settled.push(...(await killInsideTransaction(path, first, killAt)));
  }
  expect(settled.length).toBeGreaterThan(0);
  const database = await worker.openDatabase(path);
  expect(await database.all("PRAGMA integrity_check")).toEqual([
    { integrity_check: "ok" },
  ]);
  const done = new Set(
    (
      await database.all<{ request_id: string }>(
        "SELECT request_id FROM submissions WHERE status = 'done'",
      )
    ).map((row) => JSON.parse(row.request_id)),
  );
  const answered = new Set<string>();
  let asked = "";
  for (const row of await database.all<{ record: string }>(
    "SELECT record FROM entries ORDER BY id",
  ))
    for (const message of JSON.parse(row.record).model ?? []) {
      if (message.role === "user") asked = message.content;
      else if (
        message.role === "assistant" &&
        message.content.some(
          (block: { type: string; text?: string }) =>
            block.type === "text" && block.text === "done",
        )
      )
        answered.add(asked);
    }
  for (const turn of settled) {
    expect(done).toContain(`turn-${turn}`);
    expect(answered).toContain(`turn ${turn}`);
  }
  const { harness, conversation } = await openFauxHarness(database);
  try {
    const run = await conversation.submit(
      { type: "input", content: "after restart", requestId: "after" },
      context,
    );
    expect((await run.wait(context)).status).toBe("done");
  } finally {
    await harness.close(context);
  }
}, 120_000);
