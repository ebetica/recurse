import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fauxAssistantMessage,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { fauxHost, idle, until } from "./fixtures/durable_host/host.ts";

const root = mkdtempSync(join(tmpdir(), "durable-store-upgrade-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const schemaVersion = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.query("SELECT version FROM durable_schema").get() as {
        version: number;
      }
    ).version;
  } finally {
    db.close();
  }
};

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

// Feature: #2960 a Pi 1.3.0 store migrates in place, and interrupted replies exhaust their retry budget without leaving commands running.
test("a Pi 1.3.0 store migrates on open, and repeated interrupted attempts stop the reply and its background command", async () => {
  const dir = mkdtempSync(join(root, "c-"));
  const { host, faux, work } = fauxHost(dir);
  const path = host.storagePath("c1");
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(
    readFileSync(
      join(import.meta.dir, "fixtures/pi_1_3_store/session.sql"),
      "utf8",
    ).replaceAll("/pi-1.3-fixture/work", work),
  );
  db.close();
  expect(schemaVersion(path)).toBe(1);
  const child = join(
    import.meta.dir,
    "fixtures/durable_crash_loop/crash_child.ts",
  );
  for (const mode of ["send", "open", "open", "open"]) {
    const crashed = Bun.spawn([process.execPath, child, dir, mode], {
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(await crashed.exited).toBe(70);
  }
  expect(schemaVersion(path)).toBe(2);
  const requests: ModelContext[] = [];
  faux.setResponses([
    (request: ModelContext) => {
      requests.push(structuredClone(request));
      return fauxAssistantMessage("Acknowledged stopped command.");
    },
    (request: ModelContext) => {
      requests.push(structuredClone(request));
      return fauxAssistantMessage("Answer after the crashes.");
    },
  ]);
  await host.open("c1");
  await until(() => requests.length === 1);
  await until(idle(host));
  const rows = (await host.view("c1", { limit: 50 })).blocks as {
    text: string;
    result: unknown;
    error_detail: unknown;
  }[];
  const pgid = Number(
    /pgid (\d+)\)/.exec(JSON.stringify(rows.map((row) => row.result)))![1],
  );
  await until(() => !groupAlive(pgid));
  expect(rows.map((row) => row.text)).toContain("Remembered PI13-CODEWORD.");
  expect(rows.map((row) => row.error_detail).filter(Boolean)).toEqual([
    "The reply was interrupted when the server restarted; send again to retry.\n\nThe host stopped while the model was answering, on attempt 4",
  ]);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0]!.messages.at(-1))).toContain(
    '"shellNotice":true',
  );
  await host.send(
    "c1",
    "[recurse-origin: operator]\nafter the crashes",
    "op:2",
  );
  await until(idle(host));
  expect(requests).toHaveLength(2);
  const said = JSON.stringify(requests[1]!.messages);
  expect(said).toContain("PI13-TOOL-OUTPUT");
  expect(said).toContain("after the crashes");
  expect(
    ((await host.view("c1", { limit: 50 })).blocks as { text: string }[]).at(
      -1,
    )!.text,
  ).toBe("Answer after the crashes.");
  await host.close();
}, 60_000);
