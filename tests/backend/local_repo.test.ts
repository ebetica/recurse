import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildApp, WebLogSink } from "../../src/web/app";
import { gitEnv, WorkdirGit } from "../../src/workdir_git";
import { prepareGitIdentity } from "../../src/git_identity";
import {
  isRecurseCheckout,
  prepareCodeSource,
  prepareWorkingArea,
} from "../../src/launcher/git";
import * as local from "../../src/local";
import {
  cleanOnce,
  ensureNamedWorktree,
  managedRoot,
  reapOne,
  removeHolder,
  rootFromEnv,
} from "../../tools/worktree";
import { captureFixture } from "./fixture_subprocess";
const cleanup: string[] = [];
const saved = { ...process.env };
afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, saved);
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

async function run(cwd: string, ...args: string[]): Promise<string> {
  const result = await captureFixture(args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0)
    throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const IDENTITY_ENV = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = gitEnv(process.env);
  for (const key of IDENTITY_ENV) delete env[key];
  const result = await captureFixture(["git", "-C", cwd, ...args], { env });
  expect([args, result.exitCode, result.stderr.toString()]).toEqual([
    args,
    0,
    expect.any(String),
  ]);
  return result.stdout.toString().trim();
}

async function commit(work: string, name: string, text: string): Promise<void> {
  writeFileSync(join(work, name), text);
  await run(work, "git", "add", "-A");
  await run(work, "git", "commit", "-m", `add ${name}`);
}

function gitdirPointer(worktree: string): string {
  const value = readFileSync(join(worktree, ".git"), "utf8").trim();
  expect(value.startsWith("gitdir: ")).toBe(true);
  const path = value.slice("gitdir: ".length);
  return isAbsolute(path) ? path : join(worktree, path);
}

const isDir = (path: string) =>
  existsSync(path) && statSync(path).isDirectory();
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

async function buildTargetRepo(): Promise<[string, string]> {
  const origin = temp("recurse-repoarg-origin-");
  await run(origin, "git", "init", "--bare", "-b", "master", origin);
  const target = temp("recurse-repoarg-target-");
  await run(target, "git", "init", "-b", "master", target);
  await run(target, "git", "config", "user.name", "human");
  await run(target, "git", "config", "user.email", "human@example.com");
  writeFileSync(join(target, "hello.txt"), "hi");
  await run(target, "git", "add", "-A");
  await run(target, "git", "commit", "-m", "add hello.txt");
  await run(target, "git", "remote", "add", "origin", origin);
  await run(target, "git", "push", "-u", "origin", "master");
  return [target, origin];
}

const DATA = temp("recurse-repoarg-data-");
delete process.env.GITHUB_TOKEN;
delete process.env.RECURSE_DATA_DIR_LOCK_FD;
process.env.RECURSE_USER = "Local Human";
process.env.CHAT_DATA_DIR = DATA;
const [TARGET, ORIGIN] = await buildTargetRepo();
process.env.CHAT_REPO_URL = TARGET;
const REPO_DIR = join(DATA, "repo");
const WORKTREES = join(DATA, "worktrees");

function workdirGit(repoUrl = TARGET, repoDir = REPO_DIR): WorkdirGit {
  return new WorkdirGit({ repoUrl, repoDir, dataDir: DATA, env: process.env });
}

const toolRoot = () => rootFromEnv(DATA);

async function withRepoUrl<T>(url: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.CHAT_REPO_URL;
  process.env.CHAT_REPO_URL = url;
  try {
    return await body();
  } finally {
    process.env.CHAT_REPO_URL = previous;
  }
}

test("test_resolve_repo_arg", async () => {
  expect(await local.resolveRepoArg(TARGET)).toBe(resolve(TARGET));
  const url = "https://github.com/o/r.git";
  expect(await local.resolveRepoArg(url)).toBe(url);
  expect(await local.resolveRepoArg("git@github.com:o/r.git")).toBe(
    "git@github.com:o/r.git",
  );
  const missing = local.resolveRepoArg("/no/such/dir");
  await expect(missing).rejects.toBeInstanceOf(local.LauncherExit);
  await expect(missing).rejects.toThrow(
    "error: /no/such/dir: no such file or directory",
  );
  const plain = temp("recurse-repoarg-plain-");
  expect(await local.resolveRepoArg(plain)).toBe(resolve(plain));
});

test("test_non_repo_target_runs_in_place_without_git", async () => {
  const plain = temp("recurse-repoarg-plain-");
  writeFileSync(join(plain, "notes.md"), "operator data");
  mkdirSync(join(plain, ".recurse-data-x"));
  const repoDir = join(temp("recurse-repoarg-plain-repo-"), "repo");
  const wg = workdirGit(plain, repoDir);
  await withRepoUrl(plain, () => prepareWorkingArea(repoDir));
  expect(await wg.targetIsGitRepo()).toBe(false);
  expect(await wg.ready()).toBe(true);
  expect(existsSync(join(plain, ".git"))).toBe(false);
  expect(await wg.defaultSpawnWorkdir()).toBe(plain);
});

test("test_broken_git_target_stays_unready", async () => {
  async function setup(
    makeTarget: (target: string) => unknown,
  ): Promise<boolean> {
    const target = temp("recurse-repoarg-edge-");
    await makeTarget(target);
    const repoDir = join(temp("recurse-repoarg-edge-repo-"), "repo");
    await withRepoUrl(target, () => prepareWorkingArea(repoDir));
    return workdirGit(target, repoDir).ready();
  }
  expect(await setup((t) => captureFixture(["git", "init"], { cwd: t }))).toBe(
    false,
  );
  expect(await setup((t) => mkdirSync(join(t, ".git")))).toBe(false);
});

test("test_changed_url_is_flagged_never_repointed", async () => {
  const repoDir = join(temp("recurse-repoarg-repoint-repo-"), "repo");
  const origins: string[] = [];
  for (const tag of ["a", "b"]) {
    const origin = temp(`recurse-repoarg-repoint-origin-${tag}-`);
    await run(origin, "git", "init", "--bare", "-b", "main", origin);
    const seed = temp(`recurse-repoarg-repoint-seed-${tag}-`);
    await run(seed, "git", "init", "-b", "main", seed);
    await commit(seed, "seed.txt", tag);
    await run(seed, "git", "remote", "add", "origin", origin);
    await run(seed, "git", "push", "-u", "origin", "main");
    origins.push(pathToFileURL(origin).href);
  }
  await withRepoUrl(origins[0]!, () => prepareWorkingArea(repoDir));
  const first = workdirGit(origins[0]!, repoDir);
  expect(await first.ready()).toBe(true);
  expect(await first.cloneTargetMismatch()).toBe(false);
  const second = workdirGit(origins[1]!, repoDir);
  expect(await second.ready()).toBe(true);
  expect(await second.cloneTargetMismatch()).toBe(true);
  await withRepoUrl(origins[1]!, () => prepareWorkingArea(repoDir));
  expect(await second.cloneTargetMismatch()).toBe(true);
  expect(await git(repoDir, "remote", "get-url", "origin")).toBe(origins[0]!);
  await prepareGitIdentity(repoDir);
  expect(await git(repoDir, "var", "GIT_COMMITTER_IDENT")).toContain("<");
  expect(await git(repoDir, "config", "credential.helper")).toContain(
    "x-access-token",
  );
});

// Regression: #2878 resolve clone identity once and migrate only exact legacy defaults.
test("clone identity respects user settings and records the GitHub account once", async () => {
  const previous = { ...process.env };
  let requests = 0;
  const api = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      requests++;
      if (new URL(request.url).pathname === "/unavailable")
        return new Response(null, { status: 401 });
      return Response.json({
        id: 42,
        login: "fixture-user",
        name:
          new URL(request.url).pathname === "/login" ? null : "Fixture Human",
      });
    },
  });
  try {
    for (const key of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "GITHUB_TOKEN",
      "GH_TOKEN",
    ])
      delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    for (const source of [
      "fallback",
      "legacy-resolved",
      "repo",
      "custom-name",
      "custom-email",
      "global",
      "system",
      "environment",
      "account",
      "login",
      "unavailable",
    ]) {
      const repoDir = join(temp("recurse-identity-"), "repo");
      const config = join(temp("recurse-identity-config-"), "gitconfig");
      const env: Record<string, string | undefined> = {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      };
      if (source === "global" || source === "system") {
        writeFileSync(
          config,
          "[user]\nname = Config Human\nemail = human@example.invalid\n",
        );
        env[source === "global" ? "GIT_CONFIG_GLOBAL" : "GIT_CONFIG_SYSTEM"] =
          config;
      }
      if (source === "environment")
        Object.assign(env, {
          GIT_AUTHOR_NAME: "Env Human",
          GIT_AUTHOR_EMAIL: "env@example.invalid",
          GIT_COMMITTER_NAME: "Other Human",
          GIT_COMMITTER_EMAIL: "other@example.invalid",
        });
      if (source === "fallback") {
        await withRepoUrl(pathToFileURL(ORIGIN).href, () =>
          prepareWorkingArea(repoDir),
        );
        await prepareGitIdentity(repoDir);
      } else {
        await run(dirname(repoDir), "git", "clone", ORIGIN, repoDir);
        await run(
          repoDir,
          "git",
          "config",
          "user.name",
          source === "repo" || source === "custom-name"
            ? "Repo Human"
            : "recurse-agent",
        );
        await run(
          repoDir,
          "git",
          "config",
          "user.email",
          source === "repo" || source === "custom-email"
            ? "repo@example.invalid"
            : "recurse-agent@local",
        );
        if (source === "legacy-resolved")
          await run(repoDir, "git", "config", "recurse.identityVersion", "1");
        else env.GITHUB_TOKEN = "fixture-token";
        await prepareGitIdentity(repoDir, env, new URL(source, api.url).href);
      }
      if (["fallback", "legacy-resolved", "unavailable"].includes(source)) {
        const config = await captureFixture(
          [
            "git",
            "-C",
            repoDir,
            "config",
            "--local",
            "--get-regexp",
            "^(user\\.|recurse\\.identityversion)",
          ],
          { env: gitEnv(env) },
        );
        expect([config.exitCode, config.stdout.toString()]).toEqual([1, ""]);
        const commit = await captureFixture(
          [
            "git",
            "-C",
            repoDir,
            "commit",
            "--allow-empty",
            "-m",
            "no identity",
          ],
          { env: gitEnv(env) },
        );
        expect(commit.exitCode).not.toBe(0);
        expect(commit.stderr.toString()).toContain(
          "Please tell me who you are",
        );
        if (source === "fallback") {
          const dataDir = dirname(repoDir);
          const serverEnv: Record<string, string | undefined> = {
            ...env,
            CHAT_DATA_DIR: dataDir,
            CHAT_REPO_URL: repoDir,
            HOME: join(dataDir, "home"),
            RECURSE_HOME: join(dataDir, "settings"),
            PI_BG_SHELL: "0",
          };
          delete serverEnv.PI_CODING_AGENT_DIR;
          const app = await buildApp({
            env: serverEnv,
            sink: new WebLogSink(() => {}),
          });
          app.instance.lifecycle.startWatcher = async () => {};
          try {
            const running = await app.serve({ port: 0, installSignals: false });
            try {
              await Promise.all(app.detached);
            } finally {
              await running.close();
            }
          } finally {
            await app.instance.shutdown();
          }
          const log = readFileSync(
            join(dataDir, "logs", "recurse.log"),
            "utf8",
          );
          expect(log.match(/event=git_identity_missing /g)).toHaveLength(1);
          expect(log).toContain(
            "Set user.name and user.email, or configure a GitHub token.",
          );
        }
        continue;
      }
      const ident = await captureFixture(
        ["git", "-C", repoDir, "var", "GIT_COMMITTER_IDENT"],
        { env: gitEnv(env) },
      );
      const expected =
        source === "account"
          ? "Fixture Human <42+fixture-user@users.noreply.github.com>"
          : source === "login"
            ? "fixture-user <42+fixture-user@users.noreply.github.com>"
            : source === "environment"
              ? "Other Human <other@example.invalid>"
              : source === "custom-name"
                ? "Repo Human <recurse-agent@local>"
                : source === "custom-email"
                  ? "recurse-agent <repo@example.invalid>"
                  : source === "repo"
                    ? "Repo Human <repo@example.invalid>"
                    : source === "global" || source === "system"
                      ? "Config Human <human@example.invalid>"
                      : "";
      expect(ident.stdout.toString()).toStartWith(expected);
      await prepareGitIdentity(
        repoDir,
        { ...env, GITHUB_TOKEN: "fixture-token" },
        api.url.href,
      );
      expect(await git(repoDir, "config", "recurse.identityVersion")).toBe("1");
    }
    expect(requests).toBe(3);
  } finally {
    api.stop(true);
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previous);
  }
});

test("test_in_place_no_clone_and_one_hop_origin", async () => {
  expect(process.env.GITHUB_TOKEN).toBeUndefined();
  const targetHead = await git(TARGET, "rev-parse", "HEAD");
  await prepareCodeSource(DATA);
  const wg = workdirGit();
  expect(await wg.ready()).toBe(true);
  expect(await wg.defaultBranch()).toBe("master");

  expect(isFile(join(REPO_DIR, ".git"))).toBe(true);
  const common = await git(REPO_DIR, "rev-parse", "--git-common-dir");
  expect(resolve(REPO_DIR, common)).toBe(join(TARGET, ".git"));

  mkdirSync(WORKTREES, { recursive: true });
  await git(TARGET, "switch", "-c", "human-feature");
  const primaryAlias = join(WORKTREES, "primary-alias");
  mkdirSync(primaryAlias);
  writeFileSync(
    join(primaryAlias, ".git"),
    `gitdir: ${join(TARGET, ".git")}\n`,
  );
  let wt: string | null = null;
  const root = toolRoot();
  try {
    expect(managedRoot(root, primaryAlias)).toBeNull();
    wt = await ensureNamedWorktree(root, "primary-alias", "ignored");
    expect(wt).not.toBeNull();
    expect(wt).not.toBe(primaryAlias);
    expect(managedRoot(root, primaryAlias)).toBeNull();
  } finally {
    if (wt !== null) {
      removeHolder(root, basename(wt), "primary-alias");
      reapOne(root, basename(wt), new Set());
    }
    unlinkSync(join(primaryAlias, ".git"));
    rmSync(primaryAlias, { recursive: true });
    await git(TARGET, "switch", "master");
    await git(TARGET, "branch", "-D", "human-feature");
  }

  const spawnDefault = (repoDir: string) =>
    workdirGit(TARGET, repoDir).defaultSpawnWorkdir();
  const alias = join(temp("recurse-repo-alias-"), "repo");
  symlinkSync(TARGET, alias);
  expect(await workdirGit(TARGET, alias).ready()).toBe(true);
  expect(await spawnDefault(alias)).toBe(alias);
  await git(REPO_DIR, "switch", "-c", "unsafe-canonical");
  await git(
    REPO_DIR,
    "branch",
    "--set-upstream-to",
    "origin/master",
    "unsafe-canonical",
  );
  expect(await spawnDefault(REPO_DIR)).toBe(REPO_DIR);
  await git(REPO_DIR, "switch", "--detach", targetHead);
  await git(REPO_DIR, "branch", "-D", "unsafe-canonical");
  expect(await spawnDefault(REPO_DIR)).toBe(REPO_DIR);

  const agentWt = await ensureNamedWorktree(root, "abc", "abc");
  expect(agentWt !== null && isDir(agentWt)).toBe(true);
  expect(await git(agentWt!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  expect(existsSync(join(agentWt!, "hello.txt"))).toBe(true);
  expect(await git(agentWt!, "remote", "get-url", "origin")).toBe(ORIGIN);
  await git(agentWt!, "switch", "-c", "local-human-abc");
  await git(
    agentWt!,
    "branch",
    "--set-upstream-to",
    "origin/master",
    "local-human-abc",
  );
  expect(await git(agentWt!, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
    "origin/master",
  );

  await prepareCodeSource(DATA);
  expect(await git(agentWt!, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
    "origin/master",
  );
  expect(await git(TARGET, "config", "branch.master.remote")).toBe("origin");
  expect(await git(TARGET, "config", "branch.master.merge")).toBe(
    "refs/heads/master",
  );
  await git(agentWt!, "branch", "--unset-upstream", "--", "local-human-abc");

  writeFileSync(join(agentWt!, "x.txt"), "x");
  await git(agentWt!, "add", "-A");
  await git(agentWt!, "commit", "-m", "agent change");
  expect(await git(agentWt!, "log", "-1", "--format=%an")).toBe("human");

  expect(await git(TARGET, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
  expect(await git(TARGET, "rev-parse", "HEAD")).toBe(targetHead);
  expect(await git(TARGET, "status", "--porcelain")).toBe("");
});

// Regression: #2596 repo-wide pruning removed live checkout metadata with stale backpointers.
test("test_cleanup_preserves_live_worktree_admin_metadata", async () => {
  await prepareCodeSource(DATA);
  mkdirSync(WORKTREES, { recursive: true });
  const neverEntered = join(WORKTREES, "never-entered");
  await git(
    TARGET,
    "worktree",
    "add",
    "-b",
    "local-human/never-entered",
    neverEntered,
    "origin/master",
  );
  const doomed = await ensureNamedWorktree(toolRoot(), "reaped", "reaped");
  expect(doomed).not.toBeNull();
  expect(removeHolder(toolRoot(), basename(doomed!), "reaped")).toBe(true);

  const canonicalAdmin = gitdirPointer(REPO_DIR);
  const neverAdmin = gitdirPointer(neverEntered);
  const doomedAdmin = gitdirPointer(doomed!);
  expect([
    isDir(canonicalAdmin),
    isDir(neverAdmin),
    isDir(doomedAdmin),
  ]).toEqual([true, true, true]);
  const liveEntries: [string, string][] = [
    [canonicalAdmin, join(canonicalAdmin, "gitdir")],
    [neverAdmin, join(neverAdmin, "gitdir")],
  ];
  const original = new Map(
    liveEntries.map(([, path]) => [path, readFileSync(path, "utf8")]),
  );
  const missingRoot = join(DATA, "not-mounted");
  try {
    for (const [admin, backpointer] of liveEntries)
      writeFileSync(
        backpointer,
        `${join(missingRoot, basename(admin), ".git")}\n`,
      );
    expect(await git(REPO_DIR, "status", "--porcelain")).toBe("");
    await git(neverEntered, "status", "--porcelain");
    const before = await git(TARGET, "worktree", "list", "--porcelain");
    expect(before).toContain(join(missingRoot, basename(canonicalAdmin)));
    expect(before).toContain(join(missingRoot, basename(neverAdmin)));

    const observe = () =>
      [Date.now() / 1000, new Set(["abc"]), true] as [
        number,
        Set<string>,
        boolean,
      ];
    expect(await cleanOnce(toolRoot(), observe)).toBe("cleaned-2");
    expect([isDir(canonicalAdmin), isDir(neverAdmin)]).toEqual([true, true]);
    expect(isDir(doomedAdmin)).toBe(true);
    expect(await git(REPO_DIR, "status", "--porcelain")).toBe("");
    expect(reapOne(toolRoot(), "never-entered", new Set())).toBe(false);
    expect(reapOne(toolRoot(), "reaped", new Set())).toBe(false);
    expect(await cleanOnce(toolRoot(), observe)).toBe("cleaned-0");

    expect(isDir(canonicalAdmin)).toBe(true);
    expect(existsSync(neverEntered)).toBe(false);
    expect(isDir(neverAdmin)).toBe(true);
    expect(isDir(gitdirPointer(REPO_DIR))).toBe(true);
    expect(await git(REPO_DIR, "status", "--porcelain")).toBe("");
    expect(existsSync(doomed!)).toBe(false);
  } finally {
    for (const [admin, backpointer] of liveEntries)
      if (isDir(admin)) writeFileSync(backpointer, original.get(backpointer)!);
  }
});

// Regression: #2605 a stale backpointer must not unlock live checkout metadata.
test("cleanup retains initializing locks even with missing backpointers", async () => {
  const [target] = await buildTargetRepo();
  const root = { ...rootFromEnv(temp("recurse-add-locks-")), repoDir: target };
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const locks = new Map<string, string>();
  const live = join(root.worktrees, "live");
  for (const name of ["abandoned", "recent", "manual", "live"]) {
    const checkout = join(root.worktrees, name);
    await git(target, "worktree", "add", "--detach", checkout, "HEAD");
    const lock = join(gitdirPointer(checkout), "locked");
    locks.set(name, lock);
    await git(
      target,
      "worktree",
      "lock",
      checkout,
      "--reason",
      name === "manual" ? "operator" : "initializing",
    );
    if (name !== "recent") utimesSync(lock, old, old);
    if (name !== "live") rmSync(checkout, { recursive: true });
    else
      writeFileSync(
        join(gitdirPointer(checkout), "gitdir"),
        `${join(root.dataDir, "missing", ".git")}\n`,
      );
  }
  expect(
    await cleanOnce(root, () => [
      Date.now() / 1000,
      new Set(),
      true,
      new Set([live]),
    ]),
  ).toBe("cleaned-0");
  for (const name of ["live", "abandoned", "recent", "manual"])
    expect(existsSync(locks.get(name)!)).toBe(true);
  await git(target, "worktree", "prune");
  for (const lock of locks.values()) expect(isDir(join(lock, ".."))).toBe(true);
  expect(await git(live, "status", "--porcelain")).toBe("");
});

test("test_reinit_from_stale_repo_dir", async () => {
  await prepareCodeSource(DATA);
  const wg = workdirGit();
  expect(await wg.ready()).toBe(true);
  unlinkSync(join(REPO_DIR, ".git"));
  writeFileSync(join(REPO_DIR, "leftover.txt"), "x");
  await git(TARGET, "worktree", "prune");
  expect(await wg.ready()).toBe(false);

  await prepareCodeSource(DATA);
  expect(await wg.ready()).toBe(true);
  expect(isFile(join(REPO_DIR, ".git"))).toBe(true);
  expect(existsSync(join(REPO_DIR, "leftover.txt"))).toBe(false);
});

test("test_default_data_dir_inside_local_target", async () => {
  const inside = await local.defaultDataDir(TARGET);
  expect(inside).toBe(
    join(resolve(TARGET), `.recurse-data-${basename(TARGET)}`),
  );
  expect(inside.startsWith(`${local.HERE}/`)).toBe(false);
  expect(await local.defaultDataDir("https://github.com/o/r.git")).toBe(
    join(local.HERE, ".recurse-data-r"),
  );
  expect(await local.defaultDataDir(null)).toBe(
    join(local.HERE, ".recurse-data"),
  );
});

test("test_code_source_guard_for_foreign_repo", async () => {
  const [codeDir, headWatch] = await prepareCodeSource(DATA);
  expect(await isRecurseCheckout(codeDir)).toBe(true);
  expect(headWatch).toBe(true);
  const previous = process.env.RECURSE_SELF_DEPLOY;
  try {
    process.env.RECURSE_SELF_DEPLOY = "0";
    const [, watched] = await prepareCodeSource(DATA);
    expect(watched).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.RECURSE_SELF_DEPLOY;
    else process.env.RECURSE_SELF_DEPLOY = previous;
  }
});

test("test_code_source_never_serves_a_recurse_target", async () => {
  mkdirSync(REPO_DIR, { recursive: true });
  for (const [launcher, web, agents] of [
    ["src/local.ts", "src/web/app.ts", "src/agents/instance.ts"],
  ]) {
    const markers = ["AGENTS.md", launcher!, web!, agents!].map((name) =>
      join(REPO_DIR, name),
    );
    try {
      for (const marker of markers) {
        mkdirSync(resolve(marker, ".."), { recursive: true });
        writeFileSync(marker, "target\n");
      }
      expect(await isRecurseCheckout(REPO_DIR)).toBe(true);
      const [codeDir] = await prepareCodeSource(DATA);
      expect(codeDir).toBe(local.HERE);
    } finally {
      for (const marker of markers) rmSync(marker, { force: true });
    }
  }
});

test("test_startup_fails_fast_without_working_area", async () => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined) env[name] = value;
  delete env.PI_CODING_AGENT_DIR;
  async function gate(repoUrl: string, dataDir: string): Promise<void> {
    const app = await buildApp({
      env: {
        ...env,
        CHAT_REPO_URL: repoUrl,
        CHAT_DATA_DIR: dataDir,
        HOME: join(dataDir, "home"),
        RECURSE_HOME: join(dataDir, "settings"),
        PI_BG_SHELL: "0",
      },
      sink: new WebLogSink(() => {}),
    });
    app.instance.lifecycle.startWatcher = async () => {};
    try {
      const running = await app.serve({ port: 0 });
      await running.close();
    } finally {
      await app.instance.shutdown();
    }
  }
  const missing = temp("recurse-repoarg-missing-");
  await expect(
    gate("https://example.invalid/no-such-repo.git", missing),
  ).rejects.toThrow("run setup");
  const origin = temp("recurse-repoarg-mismatch-origin-");
  await run(origin, "git", "init", "--bare", "-b", "main", origin);
  await run(missing, "git", "clone", origin, join(missing, "repo"));
  await expect(
    gate("https://example.invalid/no-such-repo.git", missing),
  ).rejects.toThrow("different target");
  await prepareCodeSource(DATA);
  await gate(TARGET, DATA);
});
