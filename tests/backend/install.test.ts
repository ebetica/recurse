import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureFixture } from "./fixture_subprocess";
import { expectGroupGone } from "./pi_real_support";

const ROOT = join(import.meta.dir, "../..");
const temp = mkdtempSync(join(tmpdir(), "recurse-install-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const PATH = `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
const GIT_ID = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

async function sh(argv: string[], env: Record<string, string>, cwd = temp) {
  const result = await captureFixture(argv, {
    cwd,
    env: { PATH: process.env.PATH ?? PATH, ...env },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

// Feature: #2507 fixture subprocess deadlines retain diagnostics and reap only their group.
test("a stalled fixture command reports its child and stops only its group", async () => {
  const unrelated = Bun.spawn(["sleep", "5"], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let failure: unknown;
    try {
      await captureFixture(["sh", "-c", "sleep 5 & wait"], { timeoutMs: 20 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("fixture command timed out");
    expect(message).toContain("sleep 5 & wait");
    expect(message).toContain("elapsed=");
    expect(message).toContain("process tree:");
    expect(message).toContain("fd ");
    expect(message).toContain("/dev/null");
    const group = Number(message.match(/group=(\d+)/)?.[1]);
    await expectGroupGone(group);
    expect(unrelated.exitCode).toBeNull();
  } finally {
    unrelated.kill("SIGKILL");
    await unrelated.exited;
  }
});

async function origin(): Promise<string> {
  const work = join(temp, "seed");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "recurse"), "#!/usr/bin/env bash\necho ran\n", {
    mode: 0o755,
  });
  for (const argv of [
    ["git", "init", "-q", "-b", "main"],
    ["git", "add", "-A"],
    ["git", "commit", "-q", "-m", "seed"],
  ])
    expect((await sh(argv, GIT_ID, work)).code).toBe(0);
  const bare = join(temp, "origin.git");
  expect(
    (await sh(["git", "clone", "-q", "--bare", work, bare], GIT_ID)).code,
  ).toBe(0);
  return bare;
}

function runInstall(home: string, env: Record<string, string>) {
  return sh(["bash", join(ROOT, "install.sh")], {
    HOME: home,
    RECURSE_BIN_DIR: join(home, "bin"),
    ...GIT_ID,
    ...env,
  });
}

test("install.sh installs a checkout-only managed shim and keeps RECURSE_HOME", async () => {
  const repo = await origin();
  const home = join(temp, "home one");
  const install = join(home, "recurse checkout");
  mkdirSync(home, { recursive: true });
  const first = await runInstall(home, {
    RECURSE_REPO: repo,
    RECURSE_INSTALL_DIR: install,
    RECURSE_HOME: join(temp, "state"),
  });
  expect(first.code).toBe(0);
  const shim = join(home, "bin/recurse");
  expect(statSync(shim).mode & 0o777).toBe(0o755);
  expect((await sh([shim], {})).out).toBe("ran\n");

  writeFileSync(
    join(install, ".env"),
    `GITHUB_TOKEN=keep\nRECURSE_HOME=/old\nPORT=1`,
  );
  const second = await runInstall(home, {
    RECURSE_REPO: repo,
    RECURSE_INSTALL_DIR: install,
    RECURSE_HOME: join(temp, "state2"),
  });
  expect(second.code).toBe(0);
  expect(readFileSync(join(install, ".env"), "utf8")).toBe(
    `GITHUB_TOKEN=keep\nPORT=1\nRECURSE_HOME=${join(temp, "state2")}\n`,
  );
  expect(statSync(join(install, ".env")).mode & 0o777).toBe(0o600);
  expect(
    readdirSync(install).filter((name) => name.startsWith(".env.")),
  ).toEqual([]);
  expect(readdirSync(join(home, "bin"))).toEqual(["recurse"]);
  expect(existsSync(`${install}.update`)).toBe(false);

  writeFileSync(join(install, "local.txt"), "local\n");
  expect((await sh(["git", "add", "local.txt"], GIT_ID, install)).code).toBe(0);
  expect(
    (await sh(["git", "commit", "-q", "-m", "local"], GIT_ID, install)).code,
  ).toBe(0);
  writeFileSync(join(temp, "seed", "remote.txt"), "remote\n");
  expect(
    (await sh(["git", "add", "remote.txt"], GIT_ID, join(temp, "seed"))).code,
  ).toBe(0);
  expect(
    (
      await sh(
        ["git", "commit", "-q", "-m", "remote"],
        GIT_ID,
        join(temp, "seed"),
      )
    ).code,
  ).toBe(0);
  expect(
    (
      await sh(
        ["git", "push", "-q", join(temp, "origin.git"), "main"],
        GIT_ID,
        join(temp, "seed"),
      )
    ).code,
  ).toBe(0);
  const failed = await runInstall(home, {
    RECURSE_REPO: repo,
    RECURSE_INSTALL_DIR: install,
  });
  expect(failed.code).toBe(1);
  expect(failed.out).toContain("fatal:");
  expect(failed.out).toContain(
    `restored checkout at ${install}. Fix the Git error and rerun install.sh.`,
  );
  expect(existsSync(install)).toBe(true);
  expect(existsSync(`${install}.update`)).toBe(false);
  expect((await sh([shim], {})).out).toBe("ran\n");
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await sh(["git", ...args], GIT_ID, cwd);
  expect([args, result.code]).toEqual([args, 0]);
  return result.out.trim();
}

async function release(
  dev: string,
  version: string,
  publicRepo: string,
  replace = false,
) {
  const before = await git(dev, "rev-parse", "HEAD");
  const devRemote = await git(dev, "remote", "get-url", "origin");
  const result = await sh(
    [
      process.execPath,
      join(dev, "scripts/release.ts"),
      version,
      "--dev-remote",
      devRemote,
      "--public-remote",
      publicRepo,
      ...(replace ? ["--replace"] : []),
    ],
    {
      ...GIT_ID,
      GIT_AUTHOR_NAME: "recurse-agent",
      GIT_COMMITTER_NAME: "recurse-agent",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Release Owner",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "owner@example.invalid",
      TMPDIR: temp,
    },
    temp,
  );
  expect([version, result.code, result.out]).toEqual([
    version,
    0,
    expect.any(String),
  ]);
  expect(result.out).toContain("Author: Release Owner <owner@example.invalid>");
  expect(result.out).toContain(
    "Committer: Release Owner <owner@example.invalid>",
  );
  expect(result.out).toContain("Public tree diff:");
  expect(await git(dev, "rev-parse", "HEAD")).toBe(before);
  expect(await git(dev, "status", "--porcelain")).toBe("");
  const dir = result.out.match(/^Prepared directory: (.+)$/m)![1]!;
  const repo = join(dir, "repo");
  const plan = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
  expect(await git(repo, "rev-parse", `${plan.release}^{tree}`)).toBe(
    await git(repo, "rev-parse", `${plan.commit}^{tree}`),
  );
  expect(await git(repo, "cat-file", "-t", plan.tag)).toBe("tag");
  expect(await git(repo, "cat-file", "-p", plan.publicTagObject)).toContain(
    "tagger Release Owner <owner@example.invalid>",
  );
  expect(await git(devRemote, "rev-parse", "main")).toBe(before);
  const refsBefore = await git(publicRepo, "for-each-ref");
  const refused = await sh(
    [
      process.execPath,
      join(dev, "scripts/release.ts"),
      version,
      "--push",
      "--prepared",
      dir,
      "--dev-remote",
      devRemote,
      "--public-remote",
      publicRepo,
    ],
    GIT_ID,
    temp,
  );
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(
    "--push requires an interactive terminal; nothing pushed",
  );
  expect(await git(publicRepo, "for-each-ref")).toBe(refsBefore);
  expect(await git(devRemote, "rev-parse", "main")).toBe(before);
  if (replace) {
    expect(
      await git(repo, "rev-list", "--parents", "-n", "1", plan.commit),
    ).toBe(plan.commit);
    expect(plan.bumped).toBe(false);
    return;
  }
  await git(
    repo,
    "push",
    "--atomic",
    devRemote,
    "refs/recurse-public/dev:refs/heads/main",
    `refs/recurse-public/dev-tag:refs/tags/v${version}`,
  );
  await git(
    repo,
    "push",
    "--atomic",
    publicRepo,
    "refs/recurse-public/main:refs/heads/main",
    `refs/recurse-public/public-tag:refs/tags/v${version}`,
  );
  await git(dev, "fetch", "origin");
  await git(dev, "reset", "--hard", "origin/main");
}

// Feature: #2868 install.sh picks the newest release, a pin or a branch.
test("install.sh installs the newest public release, a pinned release or a branch", async () => {
  const dev = join(temp, "release-dev");
  const publicRepo = join(temp, "release-public.git");
  for (const rel of [
    "recurse",
    "install.sh",
    "package.json",
    "src/release.ts",
    "scripts/release.ts",
  ]) {
    mkdirSync(dirname(join(dev, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dev, rel));
  }
  await git(dev, "init", "-q", "-b", "main");
  await git(dev, "add", "-A");
  await git(dev, "commit", "-q", "-m", "seed");
  await git(temp, "init", "-q", "--bare", join(temp, "release-dev.git"));
  await git(temp, "init", "-q", "--bare", "-b", "main", publicRepo);
  await git(dev, "remote", "add", "origin", join(temp, "release-dev.git"));
  await git(dev, "push", "-q", "origin", "main");
  await release(dev, "1.9.0", publicRepo);
  await release(dev, "1.9.0", publicRepo, true);
  writeFileSync(join(dev, "feature.txt"), "feature\n");
  await git(dev, "add", "feature.txt");
  await git(dev, "commit", "-q", "-m", "Add a feature (#2)");
  await git(dev, "push", "-q", "origin", "main");
  await release(dev, "1.10.0", publicRepo);

  const [older, newer] = [
    await git(publicRepo, "rev-parse", "v1.9.0^{commit}"),
    await git(publicRepo, "rev-parse", "v1.10.0^{commit}"),
  ];
  expect(await git(publicRepo, "rev-list", "--parents", "main")).toBe(
    `${newer} ${older}\n${older}`,
  );
  expect(await git(publicRepo, "rev-parse", "main^{tree}")).toBe(
    await git(dev, "rev-parse", "v1.10.0^{tree}"),
  );
  expect(await git(publicRepo, "log", "-1", "--format=%s", "main")).toBe(
    "Recurse v1.10.0",
  );
  expect(await git(publicRepo, "log", "-1", "--format=%b", "main")).toBe(
    "- Add a feature (#2)",
  );

  const home = join(temp, "release-home");
  const install = join(home, "recurse");
  const installed = async (
    env: Record<string, string>,
    commit: string,
    version: string,
  ) => {
    const result = await runInstall(home, {
      RECURSE_REPO: publicRepo,
      RECURSE_INSTALL_DIR: install,
      ...env,
    });
    expect([env, result.code]).toEqual([env, 0]);
    expect(await git(install, "rev-parse", "HEAD")).toBe(commit);
    const short = await git(install, "rev-parse", "--short", "HEAD");
    expect((await sh([join(home, "bin/recurse"), "--version"], {})).out).toBe(
      `recurse ${version} (${short})\n`,
    );
  };
  const update = async (args: string[], env: Record<string, string> = {}) =>
    sh([join(home, "bin/recurse"), "update", ...args], { ...GIT_ID, ...env });
  const check = async (lines: string) => {
    const result = await update(["--check"]);
    expect([result.code, result.out]).toEqual([0, expect.any(String)]);
    expect(result.out.match(/^\w+=.*$/gm)!.join("\n")).toBe(lines);
  };
  const short = (sha: string) => sha.slice(0, 7);
  await installed({ RECURSE_VERSION: "1.9.0" }, older, "1.9.0");
  await check("channel=version 1.9.0\ninstalled=v1.9.0\navailable=v1.9.0");
  expect((await update([])).out).toContain("already up to date at v1.9.0");
  expect(await git(install, "rev-parse", "HEAD")).toBe(older);
  await git(install, "config", "--unset", "recurse.channel");
  await check("channel=release\ninstalled=v1.9.0\navailable=v1.10.0");
  expect((await update([])).code).toBe(0);
  expect(await git(install, "rev-parse", "HEAD")).toBe(newer);
  expect(await git(install, "config", "recurse.channel")).toBe("release");
  await installed({}, newer, "1.10.0");
  await git(dev, "push", "-q", publicRepo, "HEAD:refs/heads/dev");
  const branchHead = await git(dev, "rev-parse", "HEAD");
  await installed({ RECURSE_BRANCH: "dev" }, branchHead, "1.10.0");
  writeFileSync(join(dev, "later.txt"), "later\n");
  await git(dev, "add", "later.txt");
  await git(dev, "commit", "-q", "-m", "Later");
  await git(dev, "push", "-q", publicRepo, "HEAD:refs/heads/dev");
  const later = await git(dev, "rev-parse", "HEAD");
  await check(
    `channel=branch dev\ninstalled=${short(branchHead)}\navailable=${short(later)}`,
  );
  expect((await update([])).code).toBe(0);
  expect(await git(install, "rev-parse", "HEAD")).toBe(later);
  await check(
    `channel=branch dev\ninstalled=${short(later)}\navailable=${short(later)}`,
  );
  const switched = await runInstall(home, {
    RECURSE_REPO: publicRepo,
    RECURSE_INSTALL_DIR: install,
  });
  expect(switched.out).toContain(
    "switching the update channel from branch dev to release",
  );
  expect(await git(install, "rev-parse", "HEAD")).toBe(newer);
  await git(install, "config", "--unset", "recurse.channel");
  await git(install, "checkout", "-q", "dev");
  const untracked = await update([]);
  expect(untracked.code).toBe(3);
  expect(untracked.out).toContain(
    "is not on a release tag and install.sh recorded no channel",
  );
  expect(await git(install, "rev-parse", "HEAD")).toBe(later);
}, 60_000);

test("install.sh refuses unsafe install directories before cloning", async () => {
  const home = join(temp, "home-two");
  mkdirSync(join(home, "real"), { recursive: true });
  symlinkSync(join(home, "real"), join(home, "link"));
  writeFileSync(join(home, "file"), "");
  const absolute = "RECURSE_INSTALL_DIR must be an absolute directory";
  const unsafe = "unsafe install directory component:";
  const cases: [string, string][] = [
    ["relative/dir", absolute],
    ["/", absolute],
    ["//", absolute],
    ["/tmp/a\tb", "RECURSE_INSTALL_DIR must not contain control characters"],
    [join(home, "link/x"), `${unsafe} ${join(home, "link")}`],
    [join(home, "file/x"), `${unsafe} ${join(home, "file")}`],
  ];
  for (const [dir, message] of cases) {
    const result = await runInstall(home, {
      RECURSE_REPO: join(temp, "missing.git"),
      RECURSE_INSTALL_DIR: dir,
    });
    expect([dir, result.code, result.out]).toEqual([
      dir,
      1,
      `error: ${message}\n`,
    ]);
  }
});

test("install.sh reports a clear error when Bun is absent", async () => {
  const home = join(temp, "no-bun-home");
  const result = await runInstall(home, {
    RECURSE_REPO: join(temp, "missing.git"),
    RECURSE_INSTALL_DIR: join(home, "recurse"),
    PATH: "/usr/bin:/bin",
  });
  expect(result.code).not.toBe(0);
  expect(result.out).toContain(
    "Bun >= 1.4.0 is required; install it with: curl -fsSL https://bun.sh/install | bash",
  );
});

test("install.sh rejects every Bun version below the minimum before setup", async () => {
  const bin = join(temp, "old-bun-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "bun"),
    '#!/usr/bin/env bash\necho "$FAKE_BUN_VERSION"\n',
    { mode: 0o755 },
  );
  for (const version of ["0.9.0", "1.2.20", "1.3.13", "1.4.0-canary.1"]) {
    const home = join(temp, `old-bun-${version.replaceAll(".", "-")}`);
    const result = await runInstall(home, {
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_BUN_VERSION: version,
      RECURSE_REPO: join(temp, "missing.git"),
      RECURSE_INSTALL_DIR: join(home, "recurse"),
    });
    expect([version, result.code, result.out]).toEqual([
      version,
      2,
      expect.stringContaining("Bun >= 1.4.0 is required"),
    ]);
  }
});
