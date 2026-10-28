import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootId,
  groupSnapshot,
  identityFor,
  procStat,
  sessionMemberState,
} from "../../src/utils/proc_stat";
import {
  AbortScope,
  AsyncEvent,
  AsyncMutex,
  Cancelled,
  TaskSet,
  TimeoutError,
  abortable,
  shield,
  withTimeout,
} from "../../src/utils/tasks";

test("procfs checks keep start tokens exact and scans fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "proc-stat-ts-"));
  const proc = join(root, "proc");
  const boot = join(root, "boot_id");
  const { mkdir } = await import("node:fs/promises");
  const line = (pid: number, state: string, start: string) =>
    `${pid} (spaced ) name) ${state} 1 42 42 ${Array(15).fill("0").join(" ")} ${start} 0\n`;
  try {
    await mkdir(proc);
    await writeFile(boot, "boot-test\n");
    for (const pid of [42, 43]) {
      await mkdir(join(proc, String(pid)));
      await writeFile(
        join(proc, String(pid), "stat"),
        line(pid, "S", `${pid}9007199254740995`),
      );
    }
    expect(await identityFor(42, proc, boot)).toEqual({
      start_time: "429007199254740995",
      pgid: 42,
      sid: 42,
      boot_id: "boot-test",
    });
    const identity = await identityFor(42, proc, boot);
    expect(await sessionMemberState(identity, proc, boot, true)).toBe(
      "present",
    );
    await writeFile(join(proc, "43", "environ"), "A=1\0M=1\0");
    expect(await sessionMemberState(identity, proc, boot, true, "M=1")).toBe(
      "absent",
    );
    expect(await sessionMemberState(identity, proc, boot, true, "M=2")).toBe(
      "present",
    );
    const snapshot = await groupSnapshot(new Set([42]), proc);
    expect(snapshot.get(42)).toEqual({
      count: 2,
      leaderStart: identity.start_time,
      uncertain: false,
    });
    expect(
      (await groupSnapshot(new Set([42]), proc, 1)).get(42)?.uncertain,
    ).toBe(true);
    await writeFile(join(proc, "43", "stat"), line(43, "Z", "43"));
    expect(await sessionMemberState(identity, proc, boot, true)).toBe("absent");
    await writeFile(join(proc, "42", "stat"), line(42, "S", "different"));
    expect(await sessionMemberState(identity, proc, boot)).toBe("absent");
    expect(await procStat(999, proc)).toEqual({ state: "dead", stat: null });
    expect(await procStat(42, join(root, "missing"))).toEqual({
      state: "unavailable",
      stat: null,
    });
    expect(
      await sessionMemberState(identity, proc, join(root, "missing")),
    ).toBe("unknown");
    expect(await bootId(boot)).toBe("boot-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TaskSet observes detached failures; timeout aborts scope; shield preserves work", async () => {
  const errors: string[] = [];
  const tasks = new TaskSet((name) => errors.push(name));
  tasks.spawn("failed", async () => {
    throw new Error("failed");
  });
  await tasks.drain();
  expect(errors).toEqual(["failed"]);
  expect(tasks.size).toBe(0);
  let signal!: AbortSignal;
  let innerError: unknown;
  await expect(
    withTimeout(async (child) => {
      signal = child;
      try {
        await abortable(new Promise<void>(() => {}), child);
      } catch (error) {
        innerError = error;
        throw error;
      }
    }, 5),
  ).rejects.toBeInstanceOf(TimeoutError);
  while (innerError === undefined) await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(innerError).toBeInstanceOf(Cancelled);
  const parent = new AbortScope();
  const cancelledWait = withTimeout(
    async () => new Promise<void>(() => {}),
    Infinity,
    parent.signal,
  );
  parent.abort();
  await expect(cancelledWait).rejects.toBeInstanceOf(Cancelled);
  const scope = new AbortScope();
  let resolve!: (value: string) => void;
  const producer = new Promise<string>((done) => {
    resolve = done;
  });
  const wait = shield(producer, scope.signal);
  scope.abort();
  await expect(wait).rejects.toBeInstanceOf(Cancelled);
  resolve("survived");
  expect(await producer).toBe("survived");
  await expect(
    abortable(Promise.resolve("done"), scope.signal),
  ).rejects.toBeInstanceOf(Cancelled);
});

test("FIFO mutex skips cancelled waiters and event wakes all current waiters", async () => {
  const mutex = new AsyncMutex();
  const first = await mutex.acquire();
  const cancelled = new AbortController();
  const gone = mutex.acquire(cancelled.signal);
  const active = mutex.acquire();
  cancelled.abort();
  await expect(gone).rejects.toBeInstanceOf(Cancelled);
  first();
  const second = await active;
  second();
  const event = new AsyncEvent();
  const one = event.wait();
  const two = event.wait();
  event.set();
  await Promise.all([one, two]);
  event.clear();
  expect(event.isSet).toBe(false);
});
