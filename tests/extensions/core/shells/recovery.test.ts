import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  RegistryStore,
  type ShellRecord,
} from "../../../../src/extensions/core/shells/persist.ts";
import {
  type Notifier,
  ShellRegistry,
  type ShellConfig,
  verifySignalIdentity,
} from "../../../../src/extensions/core/shells/registry.ts";

interface Captured {
  text: string;
  triggerTurn: boolean;
}
class FakeNotifier implements Notifier {
  messages: Captured[] = [];
  errors: string[] = [];
  send(text: string, opts: { triggerTurn: boolean }) {
    this.messages.push({ text, triggerTurn: opts.triggerTurn });
  }
  error(message: string) {
    this.errors.push(message);
  }
  find(re: RegExp) {
    return this.messages.find((m) => re.test(m.text));
  }
}

const dirs: string[] = [];
function testDirs() {
  const logDir = mkdtempSync(join(tmpdir(), "pi-bg-shell-log-"));
  const stateBase = mkdtempSync(join(tmpdir(), "pi-bg-shell-state-"));
  dirs.push(logDir, stateBase);
  return { logDir, stateBase };
}
function cfg(
  logDir: string,
  overrides: Partial<ShellConfig> = {},
): Partial<ShellConfig> {
  return {
    logDir,
    foregroundWaitMs: 200,
    scheduleSeconds: [0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 5],
    monitorFlushMs: 30,
    killGraceMs: 120,
    ...overrides,
  };
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(15);
  }
}
function readOne(store: RegistryStore, id: string): ShellRecord | undefined {
  return store.readAll().find((r) => r.id === id);
}

test("a transient initial ownership-write failure retries from a monitor tick", async () => {
  const { logDir, stateBase } = testDirs();
  class FlakyStore extends RegistryStore {
    attempts = 0;
    override write(record: ShellRecord): boolean {
      this.attempts++;
      if (this.attempts === 1) return false;
      return super.write(record);
    }
  }
  const store = new FlakyStore(stateBase, "sess");
  const reg = new ShellRegistry(
    new FakeNotifier(),
    cfg(logDir, {
      scheduleSeconds: [5],
      ownershipHeartbeatMs: 30,
    }),
    store,
  );
  const shell = reg.run("sleep 1", "background", process.cwd());
  assert.equal(
    readOne(store, shell.id),
    undefined,
    "first atomic write was unavailable",
  );
  await waitFor(() => readOne(store, shell.id)?.status === "running");
  const record = readOne(store, shell.id)!;
  assert.ok(record.identity, "retried ownership record is identity verified");
  assert.equal(record.pid, shell.pid);
  assert.equal(record.pgid, shell.pgid);
  store.remove(shell.id);
  assert.equal(readOne(store, shell.id), undefined);
  await waitFor(() => readOne(store, shell.id)?.status === "running");
  assert.equal(readOne(store, shell.id)?.identity, record.identity);
  await reg.shutdown();
});

test("spawning writes a running record; completion updates it to exited", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(new FakeNotifier(), cfg(logDir), store);
  const shell = reg.run("echo hi; sleep 0.2", "background", process.cwd());
  await waitFor(() => readOne(store, shell.id)?.status === "running");
  const running = readOne(store, shell.id)!;
  assert.equal(running.pid, shell.pid);
  assert.equal(running.pgid, shell.pgid);
  assert.equal(running.command, "echo hi; sleep 0.2");
  assert.equal(running.mode, "background");
  await waitFor(() => readOne(store, shell.id)?.status === "exited");
  assert.equal(readOne(store, shell.id)!.exitCode, 0);
});

test("an external kill updates the record to killed with the signal", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(new FakeNotifier(), cfg(logDir), store);
  const shell = reg.run("sleep 30", "background", process.cwd());
  await waitFor(
    () =>
      shell.pid !== undefined && readOne(store, shell.id)?.status === "running",
  );
  process.kill(-shell.pgid!, "SIGKILL");
  await waitFor(() => readOne(store, shell.id)?.status === "killed");
  assert.equal(readOne(store, shell.id)!.signal, "SIGKILL");
  const pending = store.loadPendingCompletions();
  assert.equal(pending.length, 1);
  assert.match(pending[0].message, /killed by SIGKILL/);
});

test("eviction removes old terminated records and their files", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(
    new FakeNotifier(),
    cfg(logDir, { maxTrackedShells: 3 }),
    store,
  );
  for (let i = 0; i < 12; i++) {
    const s = reg.run(`echo run-${i}`, "background", process.cwd());
    // eslint-disable-next-line no-await-in-loop
    await waitFor(() => s.completed);
    assert.ok(reg.completionPersistence()!.acknowledge([s.id]));
  }
  const files = readdirSync(store.dir).filter((n) => n.endsWith(".json"));
  assert.ok(files.length <= 3, `record files bounded (got ${files.length})`);
});

test("a failed background spawn is durably queued for delivery", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(
    new FakeNotifier(),
    cfg(logDir, { shell: "/definitely/missing/bash" }),
    store,
  );
  const shell = reg.run("echo never", "background", process.cwd());
  await waitFor(() => shell.completed);
  assert.equal(readOne(store, shell.id)?.status, "failed");
  const pending = store.loadPendingCompletions();
  assert.equal(pending.length, 1);
  assert.match(pending[0].message, /failed to start/);
});

test("teardown freezes records as running so a resume can recover them", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(new FakeNotifier(), cfg(logDir), store);
  const shell = reg.run("sleep 30", "background", process.cwd());
  await waitFor(() => readOne(store, shell.id)?.status === "running");
  await reg.shutdown();
  await waitFor(
    () =>
      !!shell.child &&
      (shell.child.exitCode !== null || shell.child.signalCode !== null),
  );
  assert.equal(readOne(store, shell.id)?.status, "running");
});

test("verifySignalIdentity passes the owner, refuses strangers", async () => {
  const { logDir, stateBase } = testDirs();
  const reg = new ShellRegistry(
    new FakeNotifier(),
    cfg(logDir),
    new RegistryStore(stateBase, "s"),
  );
  const shell = reg.run("sleep 30", "background", process.cwd());
  try {
    await waitFor(() => shell.pid !== undefined);
    assert.equal(verifySignalIdentity(shell), true);
    assert.equal(verifySignalIdentity({ ...shell, identity: "0" }), false);
    assert.equal(
      verifySignalIdentity({
        ...shell,
        bootId: "00000000-0000-0000-0000-000000000000",
      }),
      false,
    );
  } finally {
    await reg.shutdown();
  }
});
