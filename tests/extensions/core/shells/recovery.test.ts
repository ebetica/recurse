import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(15);
  }
}

test("a transient initial ownership-write failure retries from a monitor tick", async () => {
  const { logDir, stateBase } = testDirs();
  class FlakyStore extends RegistryStore {
    attempts = 0;
    override async write(record: ShellRecord): Promise<boolean> {
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
  await reg.waitForLaunch(shell);
  assert.equal(store.attempts, 1, "first atomic write was unavailable");
  await waitFor(
    async () => (await store.readRecord(shell.id))?.status === "running",
  );
  const record = (await store.readRecord(shell.id))!;
  assert.ok(record.identity, "retried ownership record is identity verified");
  assert.equal(record.pid, shell.pid);
  assert.equal(record.pgid, shell.pgid);
  await store.remove(shell.id);
  assert.equal(await store.readRecord(shell.id), undefined);
  await waitFor(
    async () => (await store.readRecord(shell.id))?.status === "running",
  );
  assert.equal((await store.readRecord(shell.id))?.identity, record.identity);
  await reg.shutdown();
});

test("spawning writes a running record; completion updates it to exited", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(new FakeNotifier(), cfg(logDir), store);
  const shell = reg.run("echo hi; sleep 0.2", "background", process.cwd());
  await reg.waitForLaunch(shell);
  await waitFor(
    async () => (await store.readRecord(shell.id))?.status === "running",
  );
  const running = (await store.readRecord(shell.id))!;
  assert.equal(running.pid, shell.pid);
  assert.equal(running.pgid, shell.pgid);
  assert.equal(running.command, "echo hi; sleep 0.2");
  assert.equal(running.mode, "background");
  await waitFor(
    async () => (await store.readRecord(shell.id))?.status === "exited",
  );
  assert.equal((await store.readRecord(shell.id))!.exitCode, 0);
});

test("an external kill updates the record to killed with the signal", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(new FakeNotifier(), cfg(logDir), store);
  const shell = reg.run("sleep 30", "background", process.cwd());
  await reg.waitForLaunch(shell);
  await waitFor(
    async () =>
      shell.pid !== undefined &&
      (await store.readRecord(shell.id))?.status === "running",
  );
  process.kill(-shell.pgid!, "SIGKILL");
  await waitFor(
    async () => (await store.readRecord(shell.id))?.status === "killed",
  );
  assert.equal((await store.readRecord(shell.id))!.signal, "SIGKILL");
  const pending = await store.loadPendingCompletions();
  assert.equal(pending.length, 1);
  assert.match(pending[0].message, /killed by SIGKILL/);
});

test("eviction removes old terminated records and their files", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(
    new FakeNotifier(),
    cfg(logDir, { maxTrackedShells: 1 }),
    store,
  );
  for (let i = 0; i < 12; i++) {
    const a = reg.run(
      `echo run-${i}; sleep 0.025`,
      "background",
      process.cwd(),
    );
    await reg.waitForLaunch(a);
    const b = reg.run(
      `echo overlap-${i}; sleep 0.025`,
      "background",
      process.cwd(),
    );
    await reg.waitForLaunch(b);
    await waitFor(async () => a.completed && b.completed);
    await waitFor(async () => {
      const pending = await store.loadPendingCompletions();
      return [a, b].every((shell) =>
        pending.some((record) => record.id === shell.id),
      );
    });
    const pending = await store.loadPendingCompletions();
    assert.ok(
      pending
        .find((record) => record.id === a.id)!
        .message.endsWith(`\nrun-${i}\n`),
      JSON.stringify(pending.find((record) => record.id === a.id)!.message),
    );
    assert.ok(
      pending
        .find((record) => record.id === b.id)!
        .message.endsWith(`\noverlap-${i}\n`),
      JSON.stringify(pending.find((record) => record.id === b.id)!.message),
    );
    assert.equal(reg.get(a.id), a);
    assert.equal(reg.get(b.id), b);
    const heldA = reg.retainOutput(a);
    const nestedA = reg.retainOutput(a);
    const heldB = reg.retainOutput(b);
    assert.ok(await reg.completionPersistence()!.acknowledge([a.id, b.id]));
    assert.ok(existsSync(a.logPath));
    assert.ok(existsSync(b.logPath));
    heldA[Symbol.dispose]();
    heldA[Symbol.dispose]();
    assert.equal(reg.get(a.id), a);
    nestedA[Symbol.dispose]();
    assert.equal(reg.get(a.id), undefined);
    assert.equal(existsSync(a.logPath), false);
    assert.equal(reg.get(b.id), b);
    heldB[Symbol.dispose]();
  }
  const files = readdirSync(store.dir).filter((n) => n.endsWith(".json"));
  assert.ok(files.length <= 3, `record files bounded (got ${files.length})`);
  assert.ok(
    files.length <= 1,
    `single-record cap retained (got ${files.length})`,
  );
});

// Regression: #3066 await the shell commit before reading durable failure records.
test("a failed background spawn is durably queued for delivery", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(
    new FakeNotifier(),
    cfg(logDir, { shell: "/definitely/missing/bash" }),
    store,
  );
  const shell = reg.run("echo never", "background", process.cwd());
  await reg.waitForLaunch(shell);
  await waitFor(async () => shell.completed);
  await store.flush(shell.id);
  assert.equal((await store.readRecord(shell.id))?.status, "failed");
  const pending = await store.loadPendingCompletions();
  assert.equal(pending.length, 1);
  assert.match(pending[0].message, /failed to start/);
});

test("teardown freezes records as running so a resume can recover them", async () => {
  const { logDir, stateBase } = testDirs();
  const store = new RegistryStore(stateBase, "sess");
  const reg = new ShellRegistry(new FakeNotifier(), cfg(logDir), store);
  const shell = reg.run("sleep 30", "background", process.cwd());
  await reg.waitForLaunch(shell);
  await waitFor(
    async () => (await store.readRecord(shell.id))?.status === "running",
  );
  await reg.shutdown();
  await waitFor(
    async () =>
      !!shell.child &&
      (shell.child.exitCode !== null || shell.child.signalCode !== null),
  );
  assert.equal((await store.readRecord(shell.id))?.status, "running");
});

test("verifySignalIdentity passes the owner, refuses strangers", async () => {
  const { logDir, stateBase } = testDirs();
  const reg = new ShellRegistry(
    new FakeNotifier(),
    cfg(logDir),
    new RegistryStore(stateBase, "s"),
  );
  const shell = reg.run("sleep 30", "background", process.cwd());
  await reg.waitForLaunch(shell);
  try {
    await waitFor(async () => shell.pid !== undefined);
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
