import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFixture } from "./fixture_subprocess";
import { cleanOnce, rootFromEnv } from "../../tools/worktree";

const tool = join(import.meta.dir, "../../tools/worktree.ts");
const HERMETIC_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/tmp",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await captureFixture(["git", ...args], {
    cwd,
    env: { ...HERMETIC_ENV },
  });
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
}
async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stderr };
}
async function sourceRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.name", "fixture");
  await git(path, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(path, "seed.txt"), "fixture\n");
  await git(path, "add", "seed.txt");
  await git(path, "commit", "-m", "fixture");
}
// Regression: #2596 sweeps ignored unmarked checkouts and retained missing-directory records.
test("sweep retires unheld worktrees only with known membership", async () => {
  const data = mkdtempSync(join(tmpdir(), "worktree-unmarked-"));
  const root = rootFromEnv(data);
  try {
    await sourceRepo(root.repoDir);
    mkdirSync(root.markers, { recursive: true });
    for (const name of ["old", "held", "live-unmarked", "missing"]) {
      const path = join(root.worktrees, name);
      await git(root.repoDir, "worktree", "add", "--detach", path);
      if (name === "held" || name === "missing")
        writeFileSync(
          join(root.markers, `${name}.json`),
          JSON.stringify({ version: 1, name, path, holders: { live: 0 } }),
        );
    }
    writeFileSync(join(root.worktrees, "old", "seed.txt"), "uncommitted\n");
    await git(
      root.repoDir,
      "worktree",
      "remove",
      "--force",
      join(root.worktrees, "missing"),
    );
    for (const name of [".internal", "TO_REAP"])
      mkdirSync(join(root.worktrees, name));
    expect(await cleanOnce(root, () => [Infinity, "UNKNOWN", false])).toBe(
      "unknown",
    );
    expect(existsSync(join(root.worktrees, "old"))).toBe(true);
    expect(existsSync(join(root.markers, "missing.json"))).toBe(true);
    const liveCwd = join(root.worktrees, "live-unmarked", "nested");
    mkdirSync(liveCwd);
    expect(
      await cleanOnce(root, () => [
        Infinity,
        new Set(["live"]),
        true,
        new Set([liveCwd]),
      ]),
    ).toBe("cleaned-2");
    expect(existsSync(liveCwd)).toBe(true);
    expect(existsSync(join(root.worktrees, "old"))).toBe(false);
    expect(readFileSync(join(root.worktrees, "held", "seed.txt"), "utf8")).toBe(
      "fixture\n",
    );
    expect(existsSync(join(root.markers, "missing.json"))).toBe(false);
    const retired = readdirSync(root.trash);
    expect(retired).toHaveLength(1);
    expect(
      readFileSync(join(root.trash, retired[0]!, "seed.txt"), "utf8"),
    ).toBe("uncommitted\n");
    for (const name of [".internal", "TO_REAP"])
      expect(existsSync(join(root.worktrees, name))).toBe(true);
    const listed = await captureFixture(
      ["git", "worktree", "list", "--porcelain"],
      { cwd: root.repoDir, env: HERMETIC_ENV },
    );
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString()).toContain(join(root.worktrees, "old"));
    expect(listed.stdout.toString()).toContain(join(root.worktrees, "held"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// Regression: #2605 a sweep could retire a checkout while git worktree add was still running.
test("sweep preserves creation before Git returns and admits the completed checkout", async () => {
  const data = mkdtempSync(join(tmpdir(), "worktree-creating-"));
  const root = rootFromEnv(data);
  const ready = join(data, "ready");
  const release = join(data, "release");
  let child: Subprocess<"ignore", "ignore", "pipe"> | undefined;
  try {
    await sourceRepo(root.repoDir);
    writeFileSync(
      join(root.repoDir, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\nprintf ready > '${ready}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\n`,
      { mode: 0o755 },
    );
    child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        const { ensureNamedWorktree, rootFromEnv } = await import(process.argv[2]);
        const result = await ensureNamedWorktree(rootFromEnv(process.argv[1]), "pending", "creating");
        if (!result) process.exit(1);
      `,
        data,
        tool,
      ],
      { env: { ...HERMETIC_ENV }, stdout: "ignore", stderr: "pipe" },
    );
    const deadline = performance.now() + 5000;
    while (!existsSync(ready)) {
      if (performance.now() > deadline)
        throw new Error("checkout hook did not start");
      await Bun.sleep(5);
    }
    expect(
      await cleanOnce(root, () => [Date.now() / 1000, new Set(), true]),
    ).toBe("cleaned-0");
    expect(
      readFileSync(join(root.worktrees, "creating", "seed.txt"), "utf8"),
    ).toBe("fixture\n");
    writeFileSync(release, "release");
    expect({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    }).toEqual({ code: 0, stderr: "" });
    await git(join(root.worktrees, "creating"), "status", "--porcelain");
  } finally {
    writeFileSync(release, "release");
    if (child) await child.exited;
    rmSync(data, { recursive: true, force: true });
  }
});

// Regression: #3479 worktrees from the install checkout broke on deploy.
test("enter creates a real worktree, never from the install checkout; unknown options fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-cli-"));
  const source = join(root, "source");
  const install = join(root, "install");
  const installWorktree = join(root, "install-worktree");
  const flatInstall = join(root, "flat-install");
  await sourceRepo(source);
  await sourceRepo(install);
  await git(install, "worktree", "add", "--detach", installWorktree);
  mkdirSync(flatInstall);
  await git(flatInstall, "init", "--bare", "-b", "main");
  await git(flatInstall, "config", "core.bare", "false");
  await git(flatInstall, "config", "core.worktree", flatInstall);
  await git(flatInstall, "config", "user.name", "fixture");
  await git(flatInstall, "config", "user.email", "fixture@example.invalid");
  await git(flatInstall, "commit", "--allow-empty", "-m", "fixture");
  const env = {
    ...HERMETIC_ENV,
    CHAT_DATA_DIR: join(root, "data"),
    RECURSE_AGENT_ID: "fixture-agent",
    RECURSE_SRC: install,
  };
  try {
    for (const [cwd, src] of [
      [install, install],
      [installWorktree, install],
      [flatInstall, flatInstall],
    ] as const)
      expect(
        await runCli([tool, "enter", "from-install"], cwd, {
          ...env,
          RECURSE_SRC: src,
        }),
      ).toEqual({
        code: 1,
        stderr: `Recurse's install checkout ($RECURSE_SRC) is replaced on update, which breaks worktrees made from it; run from ${join(root, "data", "repo")} or a worktree made from it.\n`,
      });
    expect(existsSync(join(root, "data/worktrees/from-install"))).toBe(false);
    expect(await runCli([tool, "enter", "cli-worktree"], source, env)).toEqual({
      code: 0,
      stderr: "",
    });
    expect(existsSync(join(root, "data/worktrees/cli-worktree/.git"))).toBe(
      true,
    );
    expect((await runCli([tool, "--unknown"], source, env)).code).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
