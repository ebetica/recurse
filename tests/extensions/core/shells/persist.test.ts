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
  prepareBootId,
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

// Regression: #3113 Capture JSON and shell records (#3076) stay off main.
test("store: session id scopes the directory; write then readAll round-trips", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess-A");
  assert.ok(store.sessionScoped);
  assert.ok(store.dir.includes("sess-A"));
  const active = store.write(rec({ id: "one" }));
  const queued = store.write(rec({ id: "one", command: "sleep 300" }));
  const latest = store.write(rec({ id: "one", command: "sleep 200" }));
  assert.equal(queued, latest, "concurrent snapshots share one pending commit");
  await Promise.all([
    active,
    latest,
    store.write(rec({ id: "two", status: "exited", exitCode: 0 })),
  ]);
  const all = (await store.readAll()).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    all.map((r) => r.id),
    ["one", "two"],
  );
  assert.equal(all[0].command, "sleep 200");
  const other = new RegistryStore(base, "sess-B");
  assert.equal((await other.readAll()).length, 0);
  if (process.platform === "linux") {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "../../../dev/blocking_trace_preload.ts"),
        join(import.meta.dir, "fixtures/record_io.ts"),
      ],
      {
        env: {
          ...process.env,
          RECURSE_BLOCKING_TRACE: join(base, "record-trace.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, errors] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(await child.exited, 0, errors);
    const result = JSON.parse(out);
    assert.equal(result.running, true);
    assert.equal(result.survivedPrune, true);
    assert.equal(result.readBack, true);
    assert.equal(result.settled, true);
    assert.equal(result.requests, 3);
    assert.deepEqual(result.blocking, []);
  }
});

test("store: missing session id degrades to an unscoped dir but still works", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, undefined);
  assert.equal(store.sessionScoped, false);
  await store.write(rec({ id: "x" }));
  assert.equal((await store.readAll()).length, 1);
});

test("store: write is atomic — no torn/temp files are left behind", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  for (let i = 0; i < 20; i++) await store.write(rec({ id: `s${i}` }));
  const names = readdirSync(store.dir);
  assert.ok(
    names.every((n) => n.endsWith(".json")),
    `only committed .json files (got ${names.join(",")})`,
  );
  assert.equal(names.length, 20);
});

test("store: remove deletes a record's file", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  await store.write(rec({ id: "gone" }));
  assert.equal((await store.readAll()).length, 1);
  const active = store.write(rec({ id: "gone", command: "sleep 200" }));
  const queued = store.write(rec({ id: "gone", status: "exited" }));
  await Promise.all([active, queued, store.remove("gone")]);
  assert.equal((await store.readAll()).length, 0);
});

test("store: readAll skips a corrupt file without throwing", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  await store.write(rec({ id: "good" }));
  writeFileSync(join(store.dir, "bad.json"), "{ this is not json");
  const all = await store.readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "good");
});

test("store: prune drops terminated records past their TTL, keeps running ones", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess", {
    terminatedTtlMs: 1000,
    keepTerminated: 100,
  });
  const old = Date.now() - 10_000;
  await store.write(
    rec({ id: "old-exit", status: "exited", exitCode: 0, endedAt: old }),
  );
  await store.write(rec({ id: "still-run", status: "running" }));
  await store.write(
    rec({
      id: "fresh-exit",
      status: "exited",
      exitCode: 0,
      endedAt: Date.now(),
    }),
  );
  await store.prune();
  const ids = (await store.readAll()).map((r) => r.id).sort();
  assert.deepEqual(ids, ["fresh-exit", "still-run"]);
});

test("store: prune retains a conversation-owned lost result until delivery", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess", {
    terminatedTtlMs: 1,
    keepTerminated: 0,
  });
  const recent = Date.now() - 1000;
  await store.write(
    rec({
      id: "pending",
      ownerId: "previous-owner",
      status: "lost",
      endedAt: recent,
    }),
  );
  await store.write(
    rec({
      id: "delivered",
      ownerId: "previous-owner",
      status: "lost",
      endedAt: recent,
      recurseNotice: { version: 1, deliveryId: "platform-shell-restart" },
    }),
  );
  await store.write(
    rec({
      id: "expired",
      ownerId: "previous-owner",
      status: "lost",
      endedAt: 1,
    }),
  );
  await store.prune(Date.now());
  assert.deepEqual(
    (await store.readAll()).map((r) => r.id),
    ["pending"],
  );
});

test("store: prune caps the number of retained terminated records", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess", {
    keepTerminated: 3,
    terminatedTtlMs: 60_000,
  });
  for (let i = 0; i < 10; i++) {
    await store.write(
      rec({
        id: `t${i}`,
        status: "exited",
        exitCode: 0,
        endedAt: Date.now() - i,
      }),
    );
  }
  await store.prune();
  assert.equal((await store.readAll()).length, 3);
});

test("store: prune removes stale .tmp files", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  await store.flush();
  writeFileSync(join(store.dir, "abc.json.999.deadbeef.tmp"), "partial");
  assert.ok(existsSync(join(store.dir, "abc.json.999.deadbeef.tmp")));
  const active = store.write(rec({ id: "live" }));
  await new RegistryStore(base, "sess").prune();
  await active;
  assert.equal((await store.readRecord("live"))?.status, "running");
  assert.ok(!existsSync(join(store.dir, "abc.json.999.deadbeef.tmp")));
});

test("store: completion payload survives prune until acknowledged, then is cleaned", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess", {
    terminatedTtlMs: 1,
    keepTerminated: 0,
  });
  await store.write(
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
  await store.prune(Date.now());
  assert.deepEqual(
    (await store.loadPendingCompletions()).map((completion) => completion.id),
    ["done"],
  );

  assert.ok(await store.acknowledgeCompletions(["done"]));
  assert.deepEqual(await store.loadPendingCompletions(), []);
});

test("store: acknowledging a completion removes its terminated record file", async () => {
  const base = tmpBase();
  const store = new RegistryStore(base, "sess");
  await store.write(
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
  await store.write(
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
  assert.ok(await store.acknowledgeCompletions(["finished", "live"]));
  assert.equal(await store.readRecord("finished"), undefined);
  assert.ok(!existsSync(join(store.dir, "finished.json")));
  assert.equal((await store.readRecord("live"))?.status, "running");
  assert.equal((await store.readRecord("live"))?.completion, undefined);
  assert.deepEqual(await store.loadPendingCompletions(), []);
});

// Regression: #3111 Boot identity is prepared once before synchronous signal checks.
test("getBootId is stable within the process", async () => {
  await prepareBootId();
  const boot = getBootId();
  await prepareBootId();
  assert.equal(getBootId(), boot);
  if (process.platform === "linux")
    assert.match(getBootId()!, /^[0-9a-f-]{8,64}$/i);
});
