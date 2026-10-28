import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  getBootId,
  RegistryStore,
  type ShellRecord,
} from "../../../../src/extensions/core/shells/persist.ts";

const dirs: string[] = [];
function tmpBase(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-bg-shell-state-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function rec(over: Partial<ShellRecord> = {}): ShellRecord {
  return {
    id: over.id ?? "abc123",
    pid: 4242,
    pgid: 4242,
    command: "sleep 100",
    mode: "background",
    startedAt: Date.now() - 5000,
    logPath: "/tmp/pi-bg-shell/x.log",
    status: "running",
    exitCode: null,
    identity: "999",
    updatedAt: Date.now(),
    ...over,
  };
}

test("store: session id scopes the directory; write then readAll round-trips", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess-A");
  assert.ok(store.sessionScoped);
  assert.ok(store.dir.includes("sess-A"));
  store.write(rec({ id: "one" }));
  store.write(rec({ id: "two", status: "exited", exitCode: 0 }));
  const all = store.readAll().sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    all.map((r) => r.id),
    ["one", "two"],
  );
  assert.equal(all[0].command, "sleep 100");
  const other = new RegistryStore(base, "sess-B");
  assert.equal(other.readAll().length, 0);
});

test("store: missing session id degrades to an unscoped dir but still works", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, undefined);
  assert.equal(store.sessionScoped, false);
  store.write(rec({ id: "x" }));
  assert.equal(store.readAll().length, 1);
});

test("store: write is atomic — no torn/temp files are left behind", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  for (let i = 0; i < 20; i++) store.write(rec({ id: `s${i}` }));
  const names = readdirSync(store.dir);
  assert.ok(
    names.every((n) => n.endsWith(".json")),
    `only committed .json files (got ${names.join(",")})`,
  );
  assert.equal(names.length, 20);
});

test("store: remove deletes a record's file", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  store.write(rec({ id: "gone" }));
  assert.equal(store.readAll().length, 1);
  store.remove("gone");
  assert.equal(store.readAll().length, 0);
});

test("store: readAll skips a corrupt file without throwing", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  store.write(rec({ id: "good" }));
  writeFileSync(join(store.dir, "bad.json"), "{ this is not json");
  const all = store.readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "good");
});

test("store: prune drops terminated records past their TTL, keeps running ones", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess", {
    terminatedTtlMs: 1000,
    keepTerminated: 100,
  });
  const old = Date.now() - 10_000;
  store.write(
    rec({ id: "old-exit", status: "exited", exitCode: 0, endedAt: old }),
  );
  store.write(rec({ id: "still-run", status: "running" }));
  store.write(
    rec({
      id: "fresh-exit",
      status: "exited",
      exitCode: 0,
      endedAt: Date.now(),
    }),
  );
  store.prune();
  const ids = store
    .readAll()
    .map((r) => r.id)
    .sort();
  assert.deepEqual(ids, ["fresh-exit", "still-run"]);
});

test("store: prune retains a conversation-owned lost result until delivery", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess", {
    terminatedTtlMs: 1,
    keepTerminated: 0,
  });
  const recent = Date.now() - 1000;
  store.write(
    rec({
      id: "pending",
      ownerId: "previous-owner",
      status: "lost",
      endedAt: recent,
    }),
  );
  store.write(
    rec({
      id: "delivered",
      ownerId: "previous-owner",
      status: "lost",
      endedAt: recent,
      recurseNotice: { version: 1, deliveryId: "platform-shell-restart" },
    }),
  );
  store.write(
    rec({
      id: "expired",
      ownerId: "previous-owner",
      status: "lost",
      endedAt: 1,
    }),
  );
  store.prune(Date.now());
  assert.deepEqual(
    store.readAll().map((r) => r.id),
    ["pending"],
  );
});

test("store: prune caps the number of retained terminated records", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess", {
    keepTerminated: 3,
    terminatedTtlMs: 60_000,
  });
  for (let i = 0; i < 10; i++) {
    store.write(
      rec({
        id: `t${i}`,
        status: "exited",
        exitCode: 0,
        endedAt: Date.now() - i,
      }),
    );
  }
  store.prune();
  assert.equal(store.readAll().length, 3);
});

test("store: prune removes stale .tmp files", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  writeFileSync(join(store.dir, "abc.json.999.deadbeef.tmp"), "partial");
  assert.ok(existsSync(join(store.dir, "abc.json.999.deadbeef.tmp")));
  store.prune();
  assert.ok(!existsSync(join(store.dir, "abc.json.999.deadbeef.tmp")));
});

test("store: completion payload survives prune until acknowledged, then is cleaned", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess", {
    terminatedTtlMs: 1,
    keepTerminated: 0,
  });
  store.write(
    rec({
      id: "done",
      status: "exited",
      endedAt: 1,
      completion: {
        id: "done",
        message: "done message",
        createdAt: 1,
        sequence: 1,
      },
    }),
  );
  store.prune(Date.now());
  assert.deepEqual(
    store.loadPendingCompletions().map((completion) => completion.id),
    ["done"],
  );

  assert.ok(store.acknowledgeCompletions(["done"]));
  assert.deepEqual(store.loadPendingCompletions(), []);
});

test("store: acknowledging a completion removes its terminated record file", () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  store.write(
    rec({
      id: "finished",
      status: "exited",
      endedAt: Date.now(),
      completion: {
        id: "finished",
        message: "finished message",
        createdAt: 1,
        sequence: 1,
      },
    }),
  );
  store.write(
    rec({
      id: "live",
      status: "running",
      completion: {
        id: "live",
        message: "live message",
        createdAt: 2,
        sequence: 2,
      },
    }),
  );
  assert.ok(store.acknowledgeCompletions(["finished", "live"]));
  assert.equal(store.readRecord("finished"), undefined);
  assert.ok(!existsSync(join(store.dir, "finished.json")));
  assert.equal(store.readRecord("live")?.status, "running");
  assert.equal(store.readRecord("live")?.completion, undefined);
  assert.deepEqual(store.loadPendingCompletions(), []);
});

test("getBootId is stable within the process", () => {
  assert.equal(getBootId(), getBootId());
  if (process.platform === "linux")
    assert.match(getBootId()!, /^[0-9a-f-]{8,64}$/i);
});
