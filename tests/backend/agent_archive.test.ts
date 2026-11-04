import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host.ts";
import { WARNING } from "../../src/observability/runtime_logging.ts";
import { testDeps, until } from "./fixtures/durable_host/host.ts";
import { openDescriptors as descriptors } from "./fixtures/durable_sqlite/descriptors.ts";
import { holdStoragePage } from "./fixtures/durable_sqlite/held_page.ts";

const root = mkdtempSync(join(tmpdir(), "agent-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function world(
  record: Record<string, unknown>,
  data = mkdtempSync(join(root, "data-")),
) {
  const work = join(data, "work");
  mkdirSync(work, { recursive: true });
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const records: Record<string, Record<string, unknown>> = {
    c1: {
      id: "c1",
      backend: "durable",
      workdir: work,
      tmp_key: "20261011-k1",
      ...record,
    },
  };
  const logs: Array<[string, Record<string, unknown>, number | undefined]> = [];
  const host = new DurableHost({
    ...testDeps(
      data,
      (cid) => records[cid] ?? null,
      () => Object.keys(records),
    ),
    models,
    log: (event, fields, level) => void logs.push([event, fields, level]),
  });
  return { data, faux, host, logs };
}

async function talk(w: ReturnType<typeof world>) {
  w.faux.setResponses([fauxAssistantMessage("archived answer")]);
  await w.host.send("c1", "keep me", "r1");
  await until(
    () =>
      w.host.runningCount() === 0 && w.host.metadata("c1").pending.length === 0,
  );
}

test("a failed archive keeps the store, warns each retry, and a later retire archives it", async () => {
  const w = world({ title: "Keeper", created: 5 });
  await talk(w);
  const store = join(w.data, "conversations/c1/durable/session.sqlite");
  writeFileSync(join(w.data, "agent-archive"), "");
  expect(await w.host.retire("c1")).toBe(false);
  expect(await w.host.retire("c1")).toBe(false);
  const failures = w.logs.filter(
    ([event]) => event === "durable_archive_failed",
  );
  expect(failures).toHaveLength(2);
  expect(failures[0]![2]).toBe(WARNING);
  expect(String(failures[0]![1].error)).toMatch(/EEXIST|ENOTDIR/);
  expect(existsSync(store)).toBe(true);
  rmSync(join(w.data, "agent-archive"));
  expect(await w.host.retire("c1")).toBe(true);
  expect(existsSync(join(w.data, "conversations/c1"))).toBe(false);
  expect(
    existsSync(join(w.data, "agent-archive/c1.20261011-k1/session.sqlite")),
  ).toBe(true);
  const rows = await w.host.archive.search("kpr", 0, 10);
  expect(rows).toMatchObject([
    {
      archive_id: "c1.20261011-k1",
      cid: "c1",
      reason: "reap",
      title: "Keeper",
      top_level: true,
      created: 5,
    },
  ]);
  expect(await w.host.archive.search("zzz", 0, 10)).toEqual([]);
  await w.host.close();
});

// Regression: #3055 skipped archives still drain readers before retirement.
test.each([
  ["service", { service_principal: "svc" }],
  ["unkeyed", { tmp_key: undefined }],
] as const)(
  "a %s conversation drains cold readers before deletion",
  async (_kind, record) => {
    const w = world(record);
    let held: ReturnType<typeof holdStoragePage> | undefined;
    let reading: Promise<unknown> | undefined;
    let retiring: Promise<boolean> | undefined;
    try {
      await talk(w);
      await w.host.close();
      w.host = new DurableHost(w.host.deps);
      const identity = statSync(w.host.storagePath("c1"));
      held = holdStoragePage(w.host);
      reading = w.host.view("c1");
      void reading.catch(() => undefined);
      await held.reached;
      expect(descriptors(identity).length).toBeGreaterThan(0);
      w.host.deps.load("c1")!.reap_deferred = Date.now() / 1000;
      let retired = false;
      retiring = w.host.retire("c1").then((value) => {
        retired = true;
        return value;
      });
      void retiring.catch(() => undefined);
      await until(
        () =>
          retired ||
          w.logs.some(([event]) => event === "durable_storage_read_wait"),
      );
      expect(descriptors(identity).length).toBeGreaterThan(0);
      expect(existsSync(join(w.data, "conversations/c1"))).toBe(true);
      expect(retired).toBe(false);
      held.release();
      await reading;
      expect(await retiring).toBe(true);
      expect(descriptors(identity)).toEqual([]);
      expect(existsSync(join(w.data, "conversations/c1"))).toBe(false);
      expect(await w.host.archive.search("", 0, 10)).toEqual([]);
    } finally {
      held?.release();
      await Promise.allSettled([reading, retiring]);
      await w.host.close();
    }
  },
);

test("a clear stopped mid-archive finishes archiving before the next open", async () => {
  const w = world({ title: "Halfway" });
  await talk(w);
  const conv = join(w.data, "conversations/c1");
  for (const name of ["session.sqlite", "session.sqlite-wal"])
    copyFileSync(join(conv, "durable", name), join(w.data, name));
  await w.host.close();
  for (const name of ["session.sqlite", "session.sqlite-wal"])
    copyFileSync(join(w.data, name), join(conv, "durable", name));
  writeFileSync(
    join(conv, "clear.json"),
    JSON.stringify({ held: [], rotated: false, archive: "abcd1234" }),
  );
  const dir = join(w.data, "agent-archive/c1.clear-abcd1234");
  mkdirSync(dir, { recursive: true });
  renameSync(join(conv, "durable/session.sqlite"), join(dir, "session.sqlite"));
  const again = world({ title: "Halfway" }, w.data);
  again.faux.setResponses([fauxAssistantMessage("fresh answer")]);
  await again.host.send("c1", "after the clear", "r2");
  await until(() => again.host.runningCount() === 0);
  const history = JSON.stringify(
    await again.host.transcript("c1", { limit: 50 }),
  );
  expect(history).toContain("after the clear");
  expect(history).not.toContain("keep me");
  expect(existsSync(join(conv, "clear.json"))).toBe(false);
  const archived = new Database(join(dir, "session.sqlite"), {
    readonly: true,
  });
  const tables = archived
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  const dump = JSON.stringify(
    tables.map(({ name }) => archived.query(`SELECT * FROM "${name}"`).all()),
  );
  archived.close();
  expect(dump).toContain("keep me");
  expect(await again.host.archive.search("hlfwy", 0, 10)).toMatchObject([
    { archive_id: "c1.clear-abcd1234", reason: "clear", title: "Halfway" },
  ]);
  await again.host.close();
});

// Regression: #3055 archive expiry must close search readers before rename.
test("archive expiry waits for the real SQLite search reader to close", async () => {
  const w = world({ title: "Reading archive" });
  let pipe: number | undefined;
  let syncing: Promise<unknown> | undefined;
  let expiring: Promise<number> | undefined;
  const dir = join(w.host.archive.root, "c1.20261011-k1");
  const database = join(dir, "session.sqlite");
  const metadata = join(dir, "message-search-state.json");
  const temporary = `${metadata}.tmp`;
  const held = join(dir, "held-reader.fifo");
  const buffer = new Uint8Array(4096);
  const drain = () => {
    if (pipe === undefined) return;
    for (;;) {
      try {
        if (!readSync(pipe, buffer, 0, buffer.length, null)) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") return;
        throw error;
      }
    }
  };
  try {
    await talk(w);
    expect(await w.host.retire("c1")).toBe(true);
    const identity = statSync(database);
    expect(descriptors(identity)).toEqual([]);
    const saved = readFileSync(metadata, "utf8");
    expect(await Bun.spawn(["mkfifo", temporary]).exited).toBe(0);
    pipe = openSync(temporary, constants.O_RDWR | constants.O_NONBLOCK);
    const fifo = statSync(temporary);
    for (;;) {
      try {
        writeSync(pipe, buffer);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") break;
        throw error;
      }
    }
    rmSync(join(dir, "transcript.txt"));
    syncing = w.host.messageSearch.sync({
      cid: "c1",
      path: database,
      archived: true,
    });
    void syncing.catch(() => undefined);
    await until(
      () =>
        existsSync(join(dir, "transcript.txt")) &&
        descriptors(fifo).some((fd) => fd !== pipe),
    );
    expect(descriptors(identity).length).toBeGreaterThan(0);
    renameSync(temporary, held);
    writeFileSync(temporary, saved);
    let expired = false;
    expiring = w.host.archive
      .expire(0, join(w.data, "trash"), 1, Date.now() / 1000 + 1)
      .then((count) => {
        expired = true;
        return count;
      });
    void expiring.catch(() => undefined);
    await until(
      () => expired || w.logs.some(([event]) => event === "search_store_wait"),
    );
    expect(descriptors(identity).length).toBeGreaterThan(0);
    expect(expired).toBe(false);
    expect(statSync(database).ino).toBe(identity.ino);
    drain();
    await syncing;
    expect(await expiring).toBe(1);
    expect(descriptors(identity)).toEqual([]);
    expect(existsSync(database)).toBe(false);
    expect(await w.host.archive.search("", 0, 10)).toEqual([]);
  } finally {
    drain();
    await Promise.allSettled([syncing, expiring]);
    if (pipe !== undefined) closeSync(pipe);
    rmSync(held, { force: true });
    await w.host.close();
  }
});
