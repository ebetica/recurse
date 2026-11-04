import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { WorkdirGit, cleanBaseRef, gitEnv } from "../../src/workdir_git";
import prDiff from "./fixtures/pull_request_diff.json";
import { pullRequestFiles } from "../../src/pull_request/patch";
import { measure } from "../../src/observability/startup_metrics";
import { captureFixture } from "./fixture_subprocess";

type Json = unknown;
const temp = realpathSync(
  mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "workdir-git-ts-")),
);
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const BUILD_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const GIT = Bun.which("git")!;

function sub(value: Json, root: string): Json {
  if (typeof value === "string") return value.replaceAll("$TMP", root);
  if (Array.isArray(value)) return value.map((v) => sub(v, root));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sub(v, root)]),
    );
  return value;
}

function write(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

async function build(
  ops: Json[][],
  root: string,
  env: Record<string, string>,
): Promise<void> {
  for (const op of ops) {
    const [kind, ...args] = sub(op, root) as [string, ...Json[]];
    const a = args as string[];
    if (kind === "write") write(join(root, a[0]!), a[1]!);
    else if (kind === "big") {
      const lines: string[] = [];
      let size = 0;
      for (let i = 0; size < (args[1] as number); i++) {
        const line = `${a[2]} line ${i}\n`;
        lines.push(line);
        size += line.length;
      }
      write(join(root, a[0]!), lines.join(""));
    } else if (kind === "bytes")
      write(join(root, a[0]!), Uint8Array.from(Buffer.from(a[1]!, "hex")));
    else if (kind === "many")
      for (let i = 0; i < (args[1] as number); i++)
        write(
          join(root, a[0]!, `f${String(i).padStart(3, "0")}.txt`),
          `${i}\n`,
        );
    else if (kind === "mkdir")
      mkdirSync(join(root, a[0]!), { recursive: true });
    else if (kind === "symlink") symlinkSync(a[1]!, join(root, a[0]!));
    else if (kind === "git") {
      const r = await captureFixture([GIT, ...a.slice(1)], {
        cwd: join(root, a[0]!),
        env,
      });
      if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")} failed`);
    } else throw new Error(kind);
  }
}

function setupRoot(gh?: string): [string, Record<string, string>] {
  const root = realpathSync(mkdtempSync(join(temp, "r")));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "home"));
  symlinkSync(GIT, join(root, "bin", "git"));
  if (gh !== undefined) {
    writeFileSync(join(root, "bin", "gh"), gh);
    chmodSync(join(root, "bin", "gh"), 0o755);
  }
  return [root, { PATH: join(root, "bin"), HOME: join(root, "home") }];
}

// Regression: #2878 preserve Git config and explicit environment identity in agent shells.
test("agent Git environment preserves configured and explicit commit identity", async () => {
  const [root, env] = setupRoot();
  const globalConfig = join(root, "home", ".gitconfig");
  writeFileSync(
    globalConfig,
    "[user]\nname = Configured Human\nemail = human@example.invalid\n",
  );
  const shellEnv = gitEnv({ ...env, GIT_CONFIG_NOSYSTEM: "1" });
  await captureFixture([GIT, "init", root], { env: shellEnv });
  const tree = await captureFixture([GIT, "mktree"], {
    cwd: root,
    env: shellEnv,
  });
  for (const explicit of [false, true]) {
    const identityEnv = explicit
      ? gitEnv({
          ...shellEnv,
          GIT_AUTHOR_NAME: "Explicit Author",
          GIT_AUTHOR_EMAIL: "author@example.invalid",
          GIT_COMMITTER_NAME: "Explicit Committer",
          GIT_COMMITTER_EMAIL: "committer@example.invalid",
        })
      : shellEnv;
    const commit = await captureFixture(
      [GIT, "commit-tree", tree.stdout.toString().trim(), "-m", "identity"],
      { cwd: root, env: identityEnv },
    );
    expect(commit.exitCode).toBe(0);
    const record = await captureFixture(
      [
        GIT,
        "show",
        "-s",
        "--format=%an <%ae>|%cn <%ce>",
        commit.stdout.toString().trim(),
      ],
      { cwd: root, env: identityEnv },
    );
    expect(record.stdout.toString().trim()).toBe(
      explicit
        ? "Explicit Author <author@example.invalid>|Explicit Committer <committer@example.invalid>"
        : "Configured Human <human@example.invalid>|Configured Human <human@example.invalid>",
    );
    const tagger = await captureFixture([GIT, "var", "GIT_COMMITTER_IDENT"], {
      cwd: root,
      env: identityEnv,
    });
    expect(tagger.stdout.toString()).toStartWith(
      explicit
        ? "Explicit Committer <committer@example.invalid>"
        : "Configured Human <human@example.invalid>",
    );
  }
});

test("GitHub origin bases are scrubbed, cached and follow persisted chdir", async () => {
  const [root, env] = setupRoot();
  const wg = new WorkdirGit({
    repoUrl: root,
    repoDir: root,
    dataDir: root,
    env,
  });
  const remotes = [
    "https://token@github.com/Owner/Repo.git",
    "git@github.com:Owner/Repo.git",
    "ssh://git@github.com/Owner/Repo",
    "https://github.com.evil/Owner/Repo",
    "http://github.com/Owner/Repo",
    "https://github.com/../Repo",
    "https://github.com/Owner/Repo?token=secret",
  ];
  for (const [index, remote] of remotes.entries()) {
    const cwd = join(root, String(index));
    mkdirSync(cwd);
    await captureFixture([GIT, "init", cwd], { env });
    await captureFixture([GIT, "remote", "add", "origin", remote], {
      cwd,
      env,
    });
    expect(await wg.githubRepoUrl(cwd)).toBe(
      index < 3 ? "https://github.com/Owner/Repo" : null,
    );
  }
  const file = join(root, "workdir.json");
  writeFileSync(file, JSON.stringify({ version: 1, cwd: join(root, "0") }));
  await captureFixture([GIT, "remote", "remove", "origin"], {
    cwd: join(root, "0"),
    env,
  });
  expect(await wg.githubRepoUrl(root, file)).toBe(
    "https://github.com/Owner/Repo",
  );
  writeFileSync(file, JSON.stringify({ version: 1, cwd: root }));
  expect(await wg.githubRepoUrl(join(root, "1"), file)).toBeNull();
});

for (const value of ["--output=x", "-x"]) {
  test(`clean_base_ref ${JSON.stringify(value)}`, () => {
    expect(cleanBaseRef(value)).toBeNull();
  });
}

// Regression: #2306 compute repository diff once; keep PR refresh off the request path.
test("worktree summary computes one real diff and owns PR refresh separately", async () => {
  const [root, env] = setupRoot();
  await build(
    [
      ["mkdir", "r"],
      ["git", "r", "init", "-q", "-b", "main"],
      ["write", "r/a\té", "first\n"],
      ["bytes", "r/binary", "0001"],
      ["git", "r", "add", "-A"],
      ["git", "r", "commit", "-qm", "base"],
      ["write", "r/a\té", "second\n"],
      ["bytes", "r/binary", "0002"],
      ["write", "r/untracked", "new\n"],
    ],
    root,
    { ...env, ...BUILD_ENV },
  );
  const wg = new WorkdirGit({
    repoUrl: "unused",
    repoDir: root,
    dataDir: root,
    env,
  });
  await measure(
    "summary",
    async (measurement) => {
      const result = await wg.worktreeDiff(join(root, "r"), "HEAD");
      expect(result.available).toBe(true);
      expect(result.diff).toContain("+second");
      expect(result.files).toEqual([
        { path: "a\té", additions: 1, deletions: 1, status: "modified" },
        {
          path: "binary",
          additions: null,
          deletions: null,
          status: "modified",
        },
        {
          path: "untracked",
          additions: null,
          deletions: null,
          status: "untracked",
        },
      ]);
      expect(measurement.counters.get("git_diff_subprocesses")).toBe(1);
      expect(result.currentPr).toBeNull();
    },
    { write() {} },
  );
});

test("a gh lookup past its timeout is killed, reads as no PR and backs off", async () => {
  const pidFile = join(temp, "gh.pid");
  const [root, env] = setupRoot(
    `#!/bin/sh\necho $$ >> ${pidFile}\nexec /bin/sleep 30\n`,
  );
  await build(
    [
      ["mkdir", "r"],
      ["git", "r", "init", "-q", "-b", "main"],
      ["git", "r", "commit", "-q", "--allow-empty", "-m", "a"],
      ["git", "r", "remote", "add", "origin", "https://github.com/o/r"],
      ["git", "r", "update-ref", "refs/remotes/origin/main", "HEAD"],
      ["git", "r", "branch", "-q", "--set-upstream-to", "origin/main"],
    ],
    root,
    { ...env, ...BUILD_ENV },
  );
  const logged: unknown[] = [];
  const wg = new WorkdirGit({
    repoUrl: "x",
    repoDir: root,
    dataDir: root,
    env,
    log: (event, fields) => logged.push({ event, reason: fields.reason }),
  });
  const started = performance.now();
  expect(await wg.branchPr(join(root, "r"), "test")).toBeNull();
  console.log("gh lookup elapsed ms", performance.now() - started);
  const pid = (await Bun.file(pidFile).text()).trim();
  expect(await Bun.file(`/proc/${pid}/stat`).exists()).toBe(false);
  expect(await wg.pullRequestDiff(prDiff.pr.url)).toMatchObject({
    available: false,
  });
  expect((await Bun.file(pidFile).text()).trim()).toBe(pid);
  expect(logged).toEqual([
    { event: "gh_call", reason: "test" },
    { event: "gh_call_skipped", reason: "pull_request_diff" },
    { event: "gh_call_skipped", reason: "pull_request_description" },
  ]);
}, 20_000);

test("branch PR lookups are rate-limited, skip final and default-branch closed PRs, and set the open PR base", async () => {
  const [root, env] = setupRoot(
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS"\n[ "$1" = api ] && exec /bin/cat "$GH_LIMITS"\nexec /bin/cat "$GH_PR"\n',
  );
  const pr = {
    number: 1801,
    title: "Re-record the managed Pi wrapper on every root preparation",
    url: "https://github.com/ebetica/recurse/pull/1801",
    state: "OPEN",
    baseRefName: "main",
    headRepository: { name: "r" },
    headRepositoryOwner: { login: "o" },
  };
  const [calls, payload] = [join(root, "calls"), join(root, "pr.json")];
  const limits = join(root, "limits.json");
  const fork = { ...pr, number: 9, headRepositoryOwner: { login: "fork" } };
  write(payload, JSON.stringify([fork, pr]));
  let clock = 0;
  await build(
    [
      ["mkdir", "r"],
      ["git", "r", "init", "-q", "-b", "main"],
      ["write", "r/a", "base\n"],
      ["git", "r", "add", "-A"],
      ["git", "r", "commit", "-qm", "base"],
      ["git", "r", "update-ref", "refs/remotes/origin/main", "HEAD"],
      ["git", "r", "checkout", "-qb", "feature"],
      ["write", "r/a", "branch\n"],
      ["git", "r", "commit", "-qam", "branch"],
      ["git", "r", "update-ref", "refs/remotes/origin/feature", "HEAD"],
      ["git", "r", "remote", "add", "origin", "https://github.com/o/r"],
      ["git", "r", "config", "branch.feature.remote", "origin"],
      ["git", "r", "config", "branch.feature.merge", "refs/heads/feature"],
      [
        "git",
        "r",
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ],
    ],
    root,
    { ...env, ...BUILD_ENV },
  );
  const git = new WorkdirGit({
    repoUrl: "unused",
    repoDir: root,
    dataDir: root,
    env: { ...env, GH_CALLS: calls, GH_PR: payload, GH_LIMITS: limits },
    now: () => clock,
  });
  const wt = join(root, "r");
  const lookup = async () => (await git.branchPr(wt, "test"))?.state ?? null;
  const called = async () =>
    (await Bun.file(calls).text()).split("\n").filter(Boolean);
  const checkout = (...args: string[]) =>
    build([["git", "r", "checkout", "-q", ...args]], root, {
      ...env,
      ...BUILD_ENV,
    });
  expect((await git.worktreeDiff(wt)).reason).toBe("clean");
  expect(await lookup()).toBe("OPEN");
  const automatic = await git.worktreeDiff(wt);
  expect(automatic.base).toBe("origin/main");
  expect(automatic.currentPr?.number).toBe(1801);
  expect(automatic.files.map((file) => file.path)).toEqual(["a"]);
  expect((await git.diffFile(wt, "a")).patch).toContain("+branch");
  expect((await git.worktreeDiff(wt, "HEAD")).baseSource).toBe("override:HEAD");
  expect(await lookup()).toBe("OPEN");
  expect(await called()).toEqual([
    "pr list --repo o/r --head feature --state all --limit 5 --json number,title,url,state,baseRefName,statusCheckRollup,headRepository,headRepositoryOwner",
  ]);
  await checkout("--detach", "HEAD");
  expect(await lookup()).toBeNull();
  expect((await git.worktreeDiff(wt, "HEAD")).currentPr).toBeNull();
  await checkout("feature");
  expect(await lookup()).toBe("OPEN");
  write(payload, JSON.stringify([{ ...pr, state: "MERGED" }]));
  for (const _ of [0, 1]) {
    clock += 61;
    expect(await lookup()).toBe("MERGED");
  }
  expect(await called()).toHaveLength(2);
  await build(
    [
      ["git", "r", "checkout", "-q", "main"],
      ["git", "r", "branch", "-q", "--set-upstream-to", "origin/main"],
    ],
    root,
    { ...env, ...BUILD_ENV },
  );
  write(payload, JSON.stringify([pr]));
  expect(await lookup()).toBe("OPEN");
  expect(await called()).toHaveLength(3);
  const track = (branch: string) =>
    Bun.spawn(["git", "config", "branch.main.merge", `refs/heads/${branch}`], {
      cwd: wt,
      env: { ...env, ...BUILD_ENV },
    }).exited;
  for (let i = 0; i <= 200; i++) {
    await track(`b${i}`);
    expect(await lookup()).toBe("OPEN");
  }
  await track("main");
  expect(await lookup()).toBe("OPEN");
  expect(await called()).toHaveLength(204);
  write(payload, "[");
  const reset = Math.round(Date.now() / 1000) + 3600;
  write(
    limits,
    JSON.stringify({ resources: { core: { remaining: 0, reset } } }),
  );
  clock += 61;
  expect(await lookup()).toBe("OPEN");
  expect((await called()).slice(204)).toEqual([
    "pr list --repo o/r --head main --state all --limit 5 --json number,title,url,state,baseRefName,statusCheckRollup,headRepository,headRepositoryOwner",
    "api rate_limit",
  ]);
  write(payload, JSON.stringify([{ ...pr, state: "MERGED" }]));
  await track("b200");
  for (const _ of [0, 1]) {
    clock += 900;
    expect(await lookup()).toBe("OPEN");
  }
  expect(await called()).toHaveLength(206);
  await track("main");
  for (const _ of [0, 1]) {
    clock += 3600;
    expect(await lookup()).toBeNull();
  }
  expect(await called()).toHaveLength(207);
  await checkout("feature");
  expect(await lookup()).toBe("MERGED");
  expect(await called()).toHaveLength(207);
}, 60_000);

// Regression: #2142 Git 2.55 ambiguous ref names must remain selectable
test("diff candidates keep ambiguous short names and <remote>/HEAD on every Git", async () => {
  const [root, env] = setupRoot();
  await build(
    [
      ["mkdir", "r"],
      ["git", "r", "init", "-q", "-b", "main"],
      ["write", "r/a", "base\n"],
      ["git", "r", "add", "-A"],
      ["git", "r", "commit", "-qm", "base"],
      ["git", "r", "branch", "example"],
      ["git", "r", "tag", "example"],
      ["git", "r", "update-ref", "refs/remotes/origin/main", "HEAD"],
      ["git", "r", "update-ref", "refs/remotes/other/main", "HEAD"],
      ["git", "r", "tag", "other/HEAD"],
      ["git", "r", "update-ref", "refs/remotes/third/main", "HEAD"],
      ["git", "r", "tag", "third/HEAD"],
      ["git", "r", "tag", "remotes/third/HEAD"],
      [
        "git",
        "r",
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ],
      [
        "git",
        "r",
        "symbolic-ref",
        "refs/remotes/other/HEAD",
        "refs/remotes/other/main",
      ],
      [
        "git",
        "r",
        "symbolic-ref",
        "refs/remotes/third/HEAD",
        "refs/remotes/third/main",
      ],
    ],
    root,
    { ...env, ...BUILD_ENV },
  );
  const git = new WorkdirGit({
    repoUrl: "unused",
    repoDir: root,
    dataDir: root,
    env,
  });
  const { branches } = await git.diffCandidates(join(root, "r"));
  expect([...branches!].sort()).toEqual([
    "heads/example",
    "main",
    "origin/HEAD",
    "origin/main",
    "other/main",
    "refs/remotes/third/HEAD",
    "remotes/other/HEAD",
    "third/main",
  ]);
});

test("PR patches decode Git-quoted paths", () => {
  expect(pullRequestFiles(prDiff.quoted.patch)[0]?.path).toBe(
    prDiff.quoted.path,
  );
});

test("PR summary, description and lazy patch share bounded fetches without a checkout", async () => {
  const [root, env] = setupRoot(
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PR_CALLS"\n[ "$2" = view ] && exec /bin/cat "$PR_METADATA"\nexec /bin/cat "$PR_PATCH"\n',
  );
  const patch = join(root, "patch");
  const calls = join(root, "calls");
  const metadata = join(root, "metadata.json");
  write(patch, prDiff.file.patch);
  write(metadata, JSON.stringify({ body: prDiff.pr.body }));
  const git = new WorkdirGit({
    repoUrl: "unused",
    repoDir: join(root, "reaped"),
    dataDir: root,
    env: { ...env, PR_PATCH: patch, PR_CALLS: calls, PR_METADATA: metadata },
  });
  const [summary, file] = await Promise.all([
    git.pullRequestDiff(prDiff.pr.url),
    git.pullRequestDiff(prDiff.pr.url, prDiff.file.path),
  ]);
  expect(summary.files).toEqual(prDiff.summary.files);
  expect(summary.target).toEqual(prDiff.summary.target);
  expect(summary.body).toBe(prDiff.pr.body);
  expect((await Bun.file(calls).text()).split("\n")).toHaveLength(3);
  expect(file).toEqual(prDiff.file);
  expect((await git.pullRequestDiff(prDiff.pr.url, "missing")).available).toBe(
    false,
  );
  expect(
    (await git.pullRequestDiff("https://example.invalid/pull/2069")).available,
  ).toBe(false);
});

// Regression: #2778 one overall deadline bounds the Git metadata chain, while shared walks retain independent caller cancellation.
test("identical diffs share one git walk that dies with its last caller", async () => {
  const [root, env] = setupRoot();
  await build(
    [
      ["mkdir", "r"],
      ["git", "r", "init", "-q", "-b", "main"],
      ["write", "r/a", "base\n"],
      ["git", "r", "add", "-A"],
      ["git", "r", "commit", "-qm", "base"],
    ],
    root,
    { ...env, ...BUILD_ENV },
  );
  const pids = join(root, "diff-pids");
  rmSync(join(root, "bin", "git"));
  write(
    join(root, "bin", "git"),
    `#!/bin/sh\nfor a; do [ "$a" = diff ] && { echo $$ >> ${pids}; exec ${Bun.which("sleep")} 30; }; done\nexec ${GIT} "$@"\n`,
  );
  chmodSync(join(root, "bin", "git"), 0o755);
  const git = new WorkdirGit({
    repoUrl: "unused",
    repoDir: root,
    dataDir: root,
    env,
  });
  const wt = join(root, "r");
  const [a, b] = [new AbortController(), new AbortController()];
  const first = git.worktreeDiff(wt, "HEAD", "stored", a.signal);
  const second = git.worktreeDiff(wt, "HEAD", "stored", b.signal);
  while (!(await Bun.file(pids).exists())) await Bun.sleep(20);
  const pid = (await Bun.file(pids).text()).trim();
  const alive = (): boolean => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  a.abort();
  await Bun.sleep(200);
  expect(alive()).toBe(true);
  b.abort();
  expect((await first).reason).toBe("diff-failed");
  expect(await second).toBe(await first);
  expect((await Bun.file(pids).text()).trim()).toBe(pid);
  expect(alive()).toBe(false);
  write(
    join(root, "bin", "git"),
    `#!${process.execPath}\nawait Bun.sleep(2500);\nconst child = Bun.spawn([${JSON.stringify(GIT)}, ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });\nprocess.exit(await child.exited);\n`,
  );
  const started = performance.now();
  const bounded = await git.worktreeDiff(wt, "HEAD");
  const elapsed = performance.now() - started;
  console.log("overall diff deadline elapsed ms", elapsed);
  expect(bounded.reason).toBe("diff-failed");
}, 20_000);
