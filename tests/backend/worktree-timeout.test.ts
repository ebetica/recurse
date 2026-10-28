import { afterAll, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFixture } from "./fixture_subprocess";

type Call = { args: string[]; options: childProcess.SpawnSyncOptions };
const calls: Call[] = [];
const realChildProcess = { ...childProcess };
afterAll(() => {
  // test-check-allow: T3 Restores original exports after real Git observation.
  mock.module("node:child_process", () => realChildProcess);
});
// test-check-allow: T3 Forwards real Git results; observes timeout and cleanup.
mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawnSync(
    command: string,
    args: string[],
    options: childProcess.SpawnSyncOptions,
  ) {
    calls.push({ args: args.slice(1), options });
    // test-check-allow: T10 Forwards tools/worktree.ts's own sync Git call.
    return realChildProcess.spawnSync(command, args, options);
  },
}));
const { ensureNamedWorktree } = await import("../../tools/worktree");

// Regression: #2401 failed creation retires files without inline recursive removal. (also #1988 failed worktree add must release its locked Git entry.)
test("worktree add has no timeout and retires its failed locked entry", async () => {
  const base = mkdtempSync(join(tmpdir(), "recurse-worktree-timeout-"));
  const source = join(base, "source");
  const worktrees = join(base, "worktrees");
  const markers = join(worktrees, ".markers");
  mkdirSync(source);
  mkdirSync(markers, { recursive: true });
  const run = async (...args: string[]) => {
    const result = await captureFixture(["git", "-C", source, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  try {
    await run("init", "-q");
    await run("config", "user.name", "Worktree test");
    await run("config", "user.email", "worktree@example.invalid");
    writeFileSync(
      join(source, "seed.txt"),
      "preserved after failed admission\n",
    );
    await run("add", ".");
    await run("commit", "-qm", "seed");
    const hook = join(source, ".git", "hooks", "post-checkout");
    writeFileSync(hook, '#!/bin/sh\ngit worktree lock "$PWD"\nexit 1\n', {
      mode: 0o755,
    });
    calls.length = 0;
    const checkout = join(worktrees, "slow-checkout");
    const root = {
      dataDir: base,
      worktrees,
      markers,
      trash: join(worktrees, ".trash"),
      repoDir: source,
    };
    expect(
      await ensureNamedWorktree(root, "agent", "slow-checkout"),
    ).toBeNull();
    const add = calls.find(
      ({ args }) => args[0] === "worktree" && args[1] === "add",
    );
    expect(add).toBeDefined();
    expect(add?.options.timeout).toBeUndefined();
    expect(calls.map(({ args }) => args.slice(0, 3))).toContainEqual([
      "worktree",
      "unlock",
      checkout,
    ]);
    expect(
      calls.some(({ args }) => args[0] === "worktree" && args[1] === "remove"),
    ).toBe(false);
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(join(markers, "slow-checkout.json"))).toBe(false);
    const retired = readdirSync(root.trash);
    expect(retired).toHaveLength(1);
    expect(
      readFileSync(join(root.trash, retired[0]!, "seed.txt"), "utf8"),
    ).toBe("preserved after failed admission\n");
    expect(
      existsSync(join(source, ".git", "worktrees", "slow-checkout", "locked")),
    ).toBe(false);
    await run("worktree", "prune");
    expect(await run("worktree", "list", "--porcelain")).not.toContain(
      checkout,
    );
    rmSync(hook);
    await run("worktree", "add", "--detach", checkout, "HEAD");
    expect(readFileSync(join(checkout, "seed.txt"), "utf8")).toBe(
      "preserved after failed admission\n",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
