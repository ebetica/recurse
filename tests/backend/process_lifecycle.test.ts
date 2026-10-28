import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { ProcessLifecycle, returncode } from "../../src/process_lifecycle";
import { procStat } from "../../src/utils/proc_stat";
import { procIds, procText } from "../../src/utils/process_table";
const roots: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "proc-lifecycle-"));
  roots.push(root);
  return root;
}

function lifecycle(stateDir: string, extra: Record<string, unknown> = {}) {
  const registry = new ShellRegistry({
    enabled: true,
    stateDir,
    processStartedMs: Date.now(),
  });
  return new ProcessLifecycle({
    registry,
    shellStateDir: stateDir,
    termGraceMs: 200,
    killGraceMs: 500,
    baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
    ...extra,
  });
}

const PY = process.execPath;

async function groupMembers(pgid: number): Promise<number[]> {
  const found: number[] = [];
  for (const name of await procIds()) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const raw = await procText(name, "stat");
      const fields = raw
        .slice(raw.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u);
      if (Number(fields[2]) === pgid) found.push(Number(name));
    } catch {}
  }
  return found;
}

function killProbe(pgid: number): string {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}

async function expectGroupGone(pgid: number): Promise<void> {
  let members = await groupMembers(pgid);
  for (let i = 0; i < 40 && members.length; i++) {
    await Bun.sleep(25);
    members = await groupMembers(pgid);
  }
  expect({ pgid, members }).toEqual({ pgid, members: [] });
  expect(killProbe(pgid)).toBe("ESRCH");
}

function hardKill(pgid: number) {
  cleanups.push(() => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  });
}

async function lines(
  proc: ReturnType<typeof Bun.spawn>,
  count: number,
): Promise<string[]> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (text.split("\n").length <= count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n").slice(0, count);
}

async function stranger(): Promise<number> {
  const proc = Bun.spawn([PY, "-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdout: "ignore",
  });
  hardKill(proc.pid);
  while ((await procStat(proc.pid)).state !== "ok") await Bun.sleep(5);
  return proc.pid;
}

async function expectAlive(pid: number) {
  const result = await procStat(pid);
  expect(result.state).toBe("ok");
}

const IGNORE_TERM =
  "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);";

// Regression: #2498 concurrent shutdown cleanup must not report a stopped group as surviving.
test("a concurrent shell stop reports success after another stop proves the group gone", async () => {
  let reached!: () => void;
  const checked = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const resume = new Promise<void>((resolve) => (release = resolve));
  let pause = true;
  class PausedLifecycle extends ProcessLifecycle {
    override async recordGoneReason(
      record: Parameters<ProcessLifecycle["recordGoneReason"]>[0],
    ) {
      const reason = await super.recordGoneReason(record);
      if (pause) {
        pause = false;
        reached();
        await resume;
      }
      return reason;
    }
  }
  const stateDir = join(scratch(), "state");
  const life = new PausedLifecycle({
    registry: new ShellRegistry({
      enabled: true,
      stateDir,
      processStartedMs: Date.now(),
    }),
    shellStateDir: stateDir,
  });
  const other = await stranger();
  const [proc, handle] = await life.spawnTracked(
    [PY, "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
    "pi-rpc",
    { cid: "worker", spawn: { stdout: "pipe" } },
  );
  hardKill(proc.pid);
  await lines(proc, 1);
  const row = life.rows.get(handle.recordId)!;
  const first = life.stopGroup(row);
  await checked;
  try {
    expect(await life.stopGroup(row)).toBe(true);
    await proc.exited;
    await expectGroupGone(proc.pid);
  } finally {
    release();
  }
  expect(await first).toBe(true);
  await expectAlive(other);
});

test("shutdown TERMs, then KILLs a TERM-ignoring group; stranger survives", async () => {
  const life = lifecycle(join(scratch(), "state"));
  const other = await stranger();
  const [graceful] = await life.spawnTracked(
    [PY, "-e", "setInterval(() => {}, 1000)"],
    "pi-rpc",
    { cid: "worker", spawn: { stdout: "ignore" } },
  );
  const [stubborn, handle] = await life.spawnTracked(
    [PY, "-e", IGNORE_TERM],
    "pi-rpc",
    {
      cid: "worker",
      spawn: { stdout: "pipe" },
    },
  );
  hardKill(graceful.pid);
  hardKill(stubborn.pid);
  expect(await lines(stubborn, 1)).toEqual(["ready"]);
  expect(handle.pgid).toBe(stubborn.pid);
  expect(handle.sid).toBe(stubborn.pid);
  expect(
    await life.signalGroup(
      {
        pid: other,
        pgid: other,
        sid: other,
        start_time: "1",
        boot_id: handle.bootId,
      },
      "SIGKILL",
    ),
  ).toBe("reused");
  expect(await life.shutdownCleanup(200)).toBe(true);
  await stubborn.exited;
  expect(returncode(stubborn)).toBe(-9);
  await expectGroupGone(graceful.pid);
  await expectGroupGone(stubborn.pid);
  expect(life.rows.size).toBe(0);
  expect(life.owned.size).toBe(0);
  await expectAlive(other);
  await expect(life.spawnTracked([PY, "-e", "pass"], "pi-rpc")).rejects.toThrow(
    "shutting down",
  );
});

test("reap stops a detached shell group whose leader died; a stale stranger record is released unsignaled", async () => {
  const state = join(scratch(), "state");
  const life = lifecycle(state);
  const other = await stranger();
  const [pi, handle] = await life.spawnTracked(
    [PY, "-e", "setInterval(() => {}, 1000)"],
    "pi-rpc",
    { cid: "shelly", spawn: { stdout: "ignore" } },
  );
  hardKill(pi.pid);
  const shell = Bun.spawn(
    [
      PY,
      "-e",
      "const child=Bun.spawn([process.execPath,'-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"]); console.log(process.pid); console.log(child.pid); setTimeout(()=>process.exit(0),300);",
    ],
    { detached: true, stdout: "pipe" },
  );
  hardKill(shell.pid);
  const printed = (await lines(shell, 2)).map(Number);
  expect(printed).toContain(shell.pid);
  const leaderStat = await procStat(shell.pid);
  expect(leaderStat.state).toBe("ok");
  const session = join(state, "sess1");
  mkdirSync(session, { recursive: true });
  const record = (id: string, pid: number, identity: string) =>
    writeFileSync(
      join(session, `${id}.json`),
      JSON.stringify({
        id,
        ownerId: handle.ownerId,
        pid,
        pgid: pid,
        identity,
        status: "running",
        startedAt: 1,
        updatedAt: 1,
      }),
    );
  record(
    "sh1",
    shell.pid,
    leaderStat.state === "ok" ? leaderStat.stat.startTime : "",
  );
  await shell.exited;
  process.kill(-pi.pid, "SIGKILL");
  await pi.exited;
  await life.unregisterIfDead(handle, pi);
  await life.drainReaps();
  expect(life.rows.has(handle.recordId)).toBe(true);
  expect(life.hasRetainedShellsFor("shelly")).toBe(true);
  expect(await life.hasProcessRecordsFor(new Set(["shelly"]))).toBe(true);

  record("sh2", other, "1");
  expect(await life.cleanupBackgroundRecordsFor(new Set(["shelly"]))).toBe(
    true,
  );
  await expectGroupGone(shell.pid);
  expect(life.rows.size).toBe(0);
  await expectAlive(other);
});

test("idle Stop kills shells behind a live core and leaves the core", async () => {
  const state = join(scratch(), "state");
  const life = lifecycle(state);
  const [pi, handle] = await life.spawnTracked(
    [PY, "-e", "setInterval(() => {}, 1000)"],
    "pi-rpc",
    { cid: "idle", spawn: { stdout: "ignore" } },
  );
  hardKill(pi.pid);
  const shell = Bun.spawn([PY, "-e", IGNORE_TERM], {
    detached: true,
    stdout: "pipe",
  });
  hardKill(shell.pid);
  await lines(shell, 1);
  const stat = await procStat(shell.pid);
  const session = join(state, "sess");
  mkdirSync(session, { recursive: true });
  writeFileSync(
    join(session, "s.json"),
    JSON.stringify({
      id: "s",
      ownerId: handle.ownerId,
      pid: shell.pid,
      pgid: shell.pid,
      identity: stat.state === "ok" ? stat.stat.startTime : "",
      status: "running",
    }),
  );
  expect(await life.stopIdleShellsFor("idle")).toEqual([1, 0]);
  await expectGroupGone(shell.pid);
  await expectAlive(pi.pid);
  expect(await life.cleanupCurrentRecordsFor(new Set(["idle"]))).toBe(true);
  await expectGroupGone(pi.pid);
});
