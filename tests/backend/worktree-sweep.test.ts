import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildApp, WebLogSink } from "../../src/web/app";
import { Router } from "../../src/web/router";
import { registerTreeRoutes, type TreeRoutesDeps } from "../../src/web/tree";
import {
  loopbackAuthenticated,
  publishLoopbackToken,
} from "../../src/web/request_auth";
import { appWorld } from "./web_app_support";
import { serveOpen } from "./http_open_app";
import { makeRepo } from "./http_conversations_app";
import {
  requestReapSweep,
  rootFromEnv,
  startSweep,
} from "../../tools/worktree";

const cleanup: Array<() => void | Promise<void>> = [];
const tool = new URL("../../tools/worktree.ts", import.meta.url).pathname;
const subagent = new URL("../../tools/subagent.ts", import.meta.url).pathname;
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function until(check: () => boolean, milliseconds = 10_000) {
  const deadline = performance.now() + milliseconds;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}

async function world() {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  cleanup.push(() => app.instance.shutdown());
  const running = await app.serve({ port: 0, installSignals: false });
  cleanup.push(() => running.close());
  await publishLoopbackToken(env.CHAT_DATA_DIR!, running.port);
  await until(() => app.instance.lifecycle.readinessSnapshot().ready);
  return { root, env, app, managed: rootFromEnv(env.CHAT_DATA_DIR!) };
}

function checkout(dataDir: string, name: string, cid: string) {
  const root = rootFromEnv(dataDir);
  const path = join(root.worktrees, name);
  mkdirSync(path, { recursive: true });
  mkdirSync(root.markers, { recursive: true });
  writeFileSync(join(path, "owned.txt"), "owned worktree contents\n");
  writeFileSync(
    join(root.markers, `${name}.json`),
    JSON.stringify({
      version: 1,
      name,
      path,
      holders: { [cid]: Date.now() / 1000 - 1 },
    }),
  );
  return path;
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function ownGroup(pid: number) {
  cleanup.push(async () => {
    if (groupExists(pid)) process.kill(-pid, "SIGKILL");
    await until(() => !groupExists(pid));
  });
}

async function sweepPid(root: ReturnType<typeof rootFromEnv>) {
  const path = join(root.markers, ".sweeper.pid");
  await until(
    () => existsSync(path) && readFileSync(path, "utf8").trim() !== "",
  );
  return Number(readFileSync(path, "utf8"));
}

// Regression: #2401 create awaited the cleaner's membership/deletion work.
test("enter returns while its independent sweeper is blocked on membership", async () => {
  const { root, env, app, managed } = await world();
  const owner = String(
    (await app.instance.create.create({ title: "owner" })).id,
  );
  const source = await makeRepo(join(root, "source"));
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const router = new Router();
  const served = await serveOpen(router, env.CHAT_DATA_DIR!);
  cleanup.push(() => served.running.close());
  cleanup.push(() => release());
  registerTreeRoutes(router, {
    loopbackAuthenticated: (ex) =>
      loopbackAuthenticated(ex, served.loopbackToken),
    projectionReady: () => app.instance.conversations.projectionReady(),
    nodeCids: () => app.instance.nodes.nodeCids(),
    cliIndex: async () => {
      reached();
      await gate;
      return app.instance.conversations.cliIndex();
    },
  } as Partial<TreeRoutesDeps> as TreeRoutesDeps);
  await publishLoopbackToken(env.CHAT_DATA_DIR!, served.running.port);
  const caller = Bun.spawn(
    [
      process.execPath,
      tool,
      "--root",
      managed.dataDir,
      "--agent",
      owner,
      "enter",
      "new",
    ],
    {
      cwd: source,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  cleanup.push(async () => {
    caller.kill();
    await caller.exited;
  });
  await entered;
  expect(await caller.exited).toBe(0);
  const pid = await sweepPid(managed);
  ownGroup(pid);
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  expect(Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2])).toBe(pid);
  expect(groupExists(pid)).toBe(true);
  expect(existsSync(join(managed.worktrees, "new", ".git"))).toBe(true);
  release();
  await until(() => !groupExists(pid));
});

// Regression: #2401 duplicate triggers must not wait or lose a later asynchronous reap.
test("an active sweep ignores duplicates, consumes later rm requests, and retains live holders", async () => {
  const { env, app, managed } = await world();
  const blocker = String(
    (await app.instance.create.create({ title: "pending blocker" })).id,
  );
  const doomed = String(
    (await app.instance.create.create({ title: "doomed" })).id,
  );
  const live = String((await app.instance.create.create({ title: "live" })).id);
  const removed = checkout(managed.dataDir, "doomed", doomed);
  const retained = checkout(managed.dataDir, "live", live);
  requestReapSweep(managed, [blocker]);
  const pid = await sweepPid(managed);
  ownGroup(pid);
  const duplicate = Bun.spawn(
    [process.execPath, tool, "--root", managed.dataDir, "sweep"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  expect(await new Response(duplicate.stdout).text()).toBe("skipped\n");
  expect(await duplicate.exited).toBe(0);
  expect(groupExists(pid)).toBe(true);
  process.kill(-pid, "SIGKILL");
  await until(() => !groupExists(pid));
  expect(existsSync(join(managed.markers, ".pending-reap", blocker))).toBe(
    true,
  );
  const resumed = startSweep(managed)!;
  await until(
    () =>
      existsSync(join(managed.markers, ".sweeper.pid")) &&
      Number(readFileSync(join(managed.markers, ".sweeper.pid"), "utf8")) ===
        resumed,
  );
  ownGroup(resumed);
  const caller = Bun.spawn([process.execPath, subagent, "rm", doomed], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(caller.stdout).text();
  const error = await new Response(caller.stderr).text();
  expect([await caller.exited, error]).toEqual([0, ""]);
  expect(output).toContain(`Reap requested: agent ${doomed}`);
  await until(() => !existsSync(removed));
  expect(existsSync(retained)).toBe(true);
  expect(groupExists(resumed)).toBe(true);
  await app.instance.reap.reap(blocker);
  await until(() => !groupExists(resumed));
  expect(readdirSync(join(managed.markers, ".pending-reap"))).toEqual([]);
  expect(readdirSync(managed.trash)).toEqual([]);
});

// Regression: #2401 a confirmed reap must release its old creation PID before acknowledging the request.
test("a reaped owner retires even while its creating process remains alive", async () => {
  const { app, managed } = await world();
  const owner = String(
    (await app.instance.create.create({ title: "reaped creator" })).id,
  );
  const live = String(
    (await app.instance.create.create({ title: "shared live holder" })).id,
  );
  const abandoned = checkout(managed.dataDir, "creating", owner);
  const shared = checkout(managed.dataDir, "shared-creating", owner);
  for (const name of ["creating", "shared-creating"]) {
    const marker = join(managed.markers, `${name}.json`);
    const record = JSON.parse(readFileSync(marker, "utf8"));
    record.creating = { cid: owner, pid: process.pid };
    if (name === "shared-creating")
      record.holders[live] = Date.now() / 1000 - 1;
    writeFileSync(marker, JSON.stringify(record));
  }
  await app.instance.reap.reap(owner);
  requestReapSweep(managed, [owner, live]);
  const pid = await sweepPid(managed);
  ownGroup(pid);
  await until(
    () =>
      !existsSync(abandoned) &&
      !existsSync(join(managed.markers, ".pending-reap", owner)),
  );
  expect(existsSync(join(managed.markers, ".pending-reap", owner))).toBe(false);
  expect(existsSync(shared)).toBe(true);
  const record = JSON.parse(
    readFileSync(join(managed.markers, "shared-creating.json"), "utf8"),
  );
  expect(record.holders).toHaveProperty(live);
  expect(record.holders).not.toHaveProperty(owner);
  expect(record.creating).toBeUndefined();
  expect(() => process.kill(process.pid, 0)).not.toThrow();
  await app.instance.reap.reap(live);
  await until(() => !groupExists(pid));
  expect(existsSync(shared)).toBe(false);
  expect(readdirSync(managed.trash)).toEqual([]);
});

// Regression: #2401 a killed sweep must resume already-retired trash rather than restarting retirement.
test("a sweep killed mid-delete resumes remaining files without repeating retirement", async () => {
  const { env, app, managed } = await world();
  const owner = String(
    (await app.instance.create.create({ title: "retired owner" })).id,
  );
  const path = checkout(managed.dataDir, "large", owner);
  for (let index = 0; index < 20_000; index++)
    writeFileSync(join(path, `${index}.txt`), "package contents\n");
  const originalFiles = readdirSync(path).length;
  await app.instance.reap.reap(owner);
  const first = Bun.spawn(
    [process.execPath, tool, "--root", managed.dataDir, "sweep"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  cleanup.push(async () => {
    first.kill();
    await first.exited;
  });
  const reader = first.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "retired cleaned-1\n",
  );
  reader.releaseLock();
  const staged = join(managed.trash, readdirSync(managed.trash)[0]!);
  await until(
    () => existsSync(staged) && readdirSync(staged).length < originalFiles,
  );
  first.kill("SIGKILL");
  await first.exited;
  const remaining = readdirSync(staged).length;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(originalFiles);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(managed.markers, "large.json"))).toBe(false);
  const second = Bun.spawn(
    [process.execPath, tool, "--root", managed.dataDir, "sweep"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(second.stdout).text();
  expect(await second.exited).toBe(0);
  expect(output).toContain("retired cleaned-0\n");
  expect(output).not.toContain("retired cleaned-1\n");
  expect(readdirSync(managed.trash)).toEqual([]);
});
