import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
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

test("a service conversation is deleted, not archived", async () => {
  const w = world({ title: "Service thread", service_principal: "svc" });
  await talk(w);
  expect(await w.host.retire("c1")).toBe(true);
  expect(existsSync(join(w.data, "conversations/c1"))).toBe(false);
  expect(await w.host.archive.search("", 0, 10)).toEqual([]);
  await w.host.close();
});

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
