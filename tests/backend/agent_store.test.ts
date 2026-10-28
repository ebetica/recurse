import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  AgentClosed,
  AgentStore,
  MailboxFull,
  MAX_PER_AGENT_OPS,
  MAX_TOTAL_OPS,
  StoreError,
  pyCompactJson,
} from "../../src/agents/agent_store";
import fixture from "./fixtures/agent_store/cases.json";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "agent-store-ts-"));
}

test("historical SQLite files cross-open in AgentStore", async () => {
  for (const item of fixture.cases) {
    if (!("format" in item)) continue;
    const dir = temp();
    const store = new AgentStore(dir);
    try {
      writeFileSync(
        store.dbPath(item.cid),
        new Uint8Array(
          gunzipSync(new Uint8Array(Buffer.from(item.gzip_base64!, "base64"))),
        ),
      );
      if ("error" in item.read)
        await expect(store.loadPersistedAgent(item.cid)).rejects.toBeInstanceOf(
          StoreError,
        );
      else
        expect(await store.loadPersistedAgent(item.cid)).toEqual(
          item.read as [
            Record<string, unknown> | null,
            Record<string, unknown>[],
          ],
        );
    } finally {
      await store.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 30000);

test("retire never passes a queued insert; close gates admission before drain", async () => {
  const dir = temp();
  const store = new AgentStore(dir);
  try {
    const ids = Array.from({ length: 40 }, (_, n) =>
      store.submit("ordering", "submission", { n }),
    );
    for (const id of ids) store.retire("ordering", id);
    expect(await store.close("ordering")).toBe(true);
    expect((await store.loadPersistedAgent("ordering"))[1]).toEqual([]);
    expect(() => store.submit("ordering", "submission", {})).toThrow(
      AgentClosed,
    );
    expect(store.pendingClosures()).toBe(1);
    expect(store.dbPaths("ordering")).toEqual([store.dbPath("ordering")]);
    store.forget("ordering");
    expect(store.pendingClosures()).toBe(0);
  } finally {
    await store.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("close rejects enqueues while an admitted batch is still draining", async () => {
  const dir = temp();
  const store = new AgentStore(dir);
  try {
    store.enqueueMetadata("closing", { v: 1 });
    const closing = store.close("closing");
    expect(() => store.enqueueMetadata("closing", { v: 2 })).toThrow(
      AgentClosed,
    );
    expect(await closing).toBe(true);
    expect((await store.loadPersistedAgent("closing"))[0]).toEqual({ v: 1 });
  } finally {
    await store.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker death rolls back uncommitted SQLite write, retains batch, and retries", async () => {
  const dir = temp();
  const store = new AgentStore(dir, {
    workerUrl: new URL(
      "./fixtures/agent_store/crash_worker.ts",
      import.meta.url,
    ).href,
  });
  try {
    store.enqueueMetadata("crashing", { committed: true });
    expect(await store.flush("crashing")).toBe(true);
    writeFileSync(`${store.dbPath("crashing")}.crash`, "crash");
    store.enqueueMetadata("crashing", { recovered: true });
    expect(await store.flush("crashing", 3)).toBe(false);
    expect(store.status("crashing")).toMatchObject({
      queued: 1,
      admitted: 1,
      failed_ops: 1,
      in_flight: false,
    });
    expect(readFileSync(store.dbPath("crashing")).length).toBeGreaterThan(0);
    expect((await store.loadPersistedAgent("crashing"))[0]).toEqual({
      committed: true,
    });
    expect(await store.flush("crashing")).toBe(true);
    expect((await store.loadPersistedAgent("crashing"))[0]).toEqual({
      recovered: true,
    });
  } finally {
    await store.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("synchronous Worker construction failure does not retain a stale pool job", async () => {
  const dir = temp();
  let attempts = 0;
  const store = new AgentStore(dir, {
    ids: () => "a".repeat(32),
    now: () => 1790000000,
    workerFactory: (url) => {
      if (++attempts <= 3)
        throw new Error("injected Worker construction failure");
      return new Worker(url);
    },
  });
  try {
    const id = store.submit("spawn-failure", "submission", { text: "once" });
    const deadline = Date.now() + 5000;
    while (store.status("spawn-failure").failed_ops === 0) {
      if (Date.now() > deadline) throw new Error("failed batch did not settle");
      await Bun.sleep(1);
    }
    expect(store.status("spawn-failure")).toMatchObject({
      queued: 1,
      admitted: 1,
    });
    expect(await store.flush("spawn-failure")).toBe(false);
    expect(await store.flush("spawn-failure")).toBe(false);
    expect(await store.flush("spawn-failure")).toBe(true);
    expect(store.status("spawn-failure")).toMatchObject({
      queued: 0,
      admitted: 0,
    });
    expect(
      (await store.loadPersistedAgent("spawn-failure"))[1].map(
        (intent) => intent.id,
      ),
    ).toEqual([id]);
  } finally {
    await store.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("per-agent and global bounds include blocked Worker jobs until commit", async () => {
  const dir = temp();
  const store = new AgentStore(dir, {
    workerUrl: new URL(
      "./fixtures/agent_store/gated_worker.ts",
      import.meta.url,
    ).href,
  });
  const cids = Array.from(
    { length: MAX_TOTAL_OPS / MAX_PER_AGENT_OPS },
    (_, n) => `bound-${n}`,
  );
  try {
    for (const cid of cids) writeFileSync(`${store.dbPath(cid)}.hold`, "hold");
    for (const cid of cids)
      for (let n = 0; n < MAX_PER_AGENT_OPS; n++)
        store.submit(cid, "submission", { n });
    expect(store.status(cids[0]!)).toMatchObject({
      admitted: MAX_PER_AGENT_OPS,
      queued: MAX_PER_AGENT_OPS - 1,
    });
    expect(() => store.submit(cids[0]!, "submission", {})).toThrow(MailboxFull);
    expect(() => store.submit("over-total", "submission", {})).toThrow(
      MailboxFull,
    );
    expect(store.status("over-total")).toMatchObject({
      admitted: 0,
      overflows: 1,
    });
    for (const cid of cids) unlinkSync(`${store.dbPath(cid)}.hold`);
    expect(await store.flushAll(30)).toBe(true);
    expect((await store.loadPersistedAgent(cids[0]!))[1]).toHaveLength(
      MAX_PER_AGENT_OPS,
    );
  } finally {
    for (const cid of cids) {
      try {
        unlinkSync(`${store.dbPath(cid)}.hold`);
      } catch {}
    }
    await store.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);

test("unsafe ids, invalid JSON and exact ASCII JSON text", async () => {
  const dir = temp();
  const store = new AgentStore(dir);
  try {
    expect(pyCompactJson({ text: "😀 café", special: Number.NaN })).toBe(
      '{"text":"\\ud83d\\ude00 caf\\u00e9","special":NaN}',
    );
    expect(() => store.submit("../unsafe", "submission", {})).toThrow();
    expect(() => store.submit("safe", "bad", {})).toThrow();
    expect(() => store.enqueueMetadata("safe", { value: 1n })).toThrow();
    expect(() =>
      store.enqueueMetadata("safe", { big: "x".repeat(1 << 20) }),
    ).toThrow();
    expect(store.status("safe")).toMatchObject({ admitted: 0, queued: 0 });
  } finally {
    await store.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
