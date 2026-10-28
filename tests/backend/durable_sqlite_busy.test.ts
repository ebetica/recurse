import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host.ts";
import { WARNING } from "../../src/observability/runtime_logging";
import { idle, testDeps, until } from "./fixtures/durable_host/host";

const hosts: DurableHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

async function lockedSession(state: string) {
  const dir = mkdtempSync(join(tmpdir(), "durable-busy-"));
  const work = join(dir, "work");
  mkdirSync(work);
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const records = { c1: { id: "c1", backend: "durable", workdir: work } };
  const warnings: [string, unknown][] = [];
  const host = new DurableHost({
    ...testDeps(
      dir,
      (cid) => (cid === "c1" ? records.c1 : null),
      () => ["c1"],
    ),
    models,
    log: (event: string, fields: unknown, level?: number) => {
      if (level === WARNING) warnings.push([event, fields]);
    },
  });
  hosts.push(host);
  const rows = async () =>
    (
      (await host.view("c1", { limit: 50 })).blocks as {
        role: string;
        text?: string;
      }[]
    ).map((b) => [b.role, b.text]);
  if (state === "cleared") {
    const initial = await host.open("c1");
    await host.clear("c1");
    await until(
      async () => (await host.open("c1")).harness !== initial.harness,
    );
  }
  faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  await host.send("c1", "first", "r1");
  await until(async () => (await rows()).length === 2);
  await until(idle(host));

  const before = await host.open("c1");
  const foreign = new Database(host.storagePath("c1"));
  foreign.exec("BEGIN IMMEDIATE");
  let refused: unknown;
  try {
    refused = await host.send("c1", "second", "r2").catch((error) => error);
  } finally {
    foreign.exec("ROLLBACK");
    foreign.close();
  }
  expect(String(refused)).toBe(
    "Error: SQLite refused the write: database is locked",
  );
  expect(warnings.find(([event]) => event === "durable_write_refused")).toEqual(
    ["durable_write_refused", { cid: "c1", code: "SQLITE_BUSY" }],
  );

  expect((await before.harness.closed).reason).toBe("failed");
  expect((await host.open("c1")).harness).not.toBe(before.harness);
  expect(await rows()).toEqual([
    ["user", "first"],
    ["assistant", "one"],
  ]);
  expect(await host.send("c1", "second", "r2")).toBe("r2");
  await until(async () => (await rows()).length === 4);
  await until(idle(host));
  expect(await rows()).toEqual([
    ["user", "first"],
    ["assistant", "one"],
    ["user", "second"],
    ["assistant", "two"],
  ]);
  expect(faux.state.callCount).toBe(2);
}

// Regression: #2326 failed sessions (also after clear) must reopen committed state.
test.each(["opened", "cleared"])(
  "a write lock fails the %s session; a reopened resend is answered once",
  lockedSession,
  20_000,
);
