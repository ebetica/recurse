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
  const tasks: (() => Promise<void>)[] = [];
  const wg = new WorkdirGit({
    repoUrl: "unused",
    repoDir: root,
    dataDir: root,
    env,
    backgroundTask: (_name, work) => tasks.push(work),
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
      expect(tasks.length).toBe(1);
    },
    { write() {} },
  );
  await tasks[0]!();
});

test("a gh lookup past its timeout is killed and reads as no PR", async () => {
  const pidFile = join(temp, "gh.pid");
  const [root, env] = setupRoot(
    `#!/bin/sh\necho $$ > ${pidFile}\nexec /bin/sleep 30\n`,
  );
  await build(
    [
      ["mkdir", "r"],
      ["git", "r", "init", "-q", "-b", "main"],
      ["write", "r/a", "a\n"],
      ["git", "r", "add", "-A"],
      ["git", "r", "commit", "-q", "-m", "a"],
      ["write", "r/a", "b\n"],
    ],
    root,
    { ...env, ...BUILD_ENV },
  );
  const tasks: (() => Promise<void>)[] = [];
  const wg = new WorkdirGit({
    repoUrl: "x",
    repoDir: root,
    dataDir: root,
    env,
    backgroundTask: (_name, work) => tasks.push(work),
  });
  const started = performance.now();
  const out = await wg.worktreeDiff(join(root, "r"));
  console.log("gh lookup elapsed ms", performance.now() - started);
  expect(out.available).toBe(true);
  expect(out.currentPr).toBeNull();
  expect(await Bun.file(pidFile).exists()).toBe(false);
  expect(tasks.length).toBe(1);
  await tasks[0]!();
  const pid = (await Bun.file(pidFile).text()).trim();
  expect(await Bun.file(`/proc/${pid}/stat`).exists()).toBe(false);
}, 20_000);

test("cached open PR base wins over upstream, but explicit bases still win", async () => {
  const [root, env] = setupRoot(
    '#!/bin/sh\nprintf \'%s\\n\' \'{"number":1801,"title":"Re-record the managed Pi wrapper on every root preparation","url":"https://github.com/ebetica/recurse/pull/1801","state":"OPEN","baseRefName":"main"}\'\n',
  );
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
      ["git", "r", "remote", "add", "origin", "."],
      ["git", "r", "config", "branch.feature.remote", "origin"],
      ["git", "r", "config", "branch.feature.merge", "refs/heads/feature"],
    ],
    root,
    { ...env, ...BUILD_ENV },
  );
  const tasks: (() => Promise<void>)[] = [];
  const git = new WorkdirGit({
    repoUrl: "unused",
    repoDir: root,
    dataDir: root,
    env,
    backgroundTask: (_name, work) => tasks.push(work),
  });
  const wt = join(root, "r");
  expect((await git.worktreeDiff(wt)).reason).toBe("clean");
  await tasks.shift()!();
  const automatic = await git.worktreeDiff(wt);
  expect(automatic.base).toBe("origin/main");
  expect(automatic.files.map((file) => file.path)).toEqual(["a"]);
  expect((await git.diffFile(wt, "a")).patch).toContain("+branch");
  expect((await git.worktreeDiff(wt, "HEAD")).baseSource).toBe("override:HEAD");
  while (tasks.length) await tasks.shift()!();
  await build([["git", "r", "checkout", "--detach", "HEAD"]], root, {
    ...env,
    ...BUILD_ENV,
  });
  const detached = await git.worktreeDiff(wt, "HEAD");
  expect(detached.currentPr).toBeNull();
  expect(detached.reason).toBe("clean");
  expect(tasks.length).toBe(1);
  await tasks.shift()!();
  await build([["git", "r", "checkout", "feature"]], root, {
    ...env,
    ...BUILD_ENV,
  });
  expect((await git.worktreeDiff(wt, "HEAD")).currentPr).toBeNull();
  expect(tasks.length).toBe(1);
  await tasks.shift()!();
  expect((await git.worktreeDiff(wt, "HEAD")).currentPr?.number).toBe(1801);
});

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

test("PR list metadata includes the description after its background read", async () => {
  const [root, env] = setupRoot('#!/bin/sh\nexec /bin/cat "$PR_METADATA"\n');
  const payload = join(root, "metadata.json");
  write(payload, JSON.stringify(prDiff.pr));
  const tasks: (() => Promise<void>)[] = [];
  const git = new WorkdirGit({
    repoUrl: "unused",
    repoDir: root,
    dataDir: root,
    env: { ...env, PR_METADATA: payload },
    backgroundTask: (_name, work) => tasks.push(work),
  });
  expect(git.pullRequests(null, [prDiff.pr.url]).prs[0]?.metadata).toBe(
    "pending",
  );
  await tasks.shift()!();
  const row = git.pullRequests(null, [prDiff.pr.url]).prs[0]!;
  expect(row.metadata).toBe("ready");
  expect(row.title).toBe(prDiff.pr.title);
  expect(row.body).toBe(prDiff.pr.body);
  expect(tasks).toHaveLength(0);
});

test("PR summary and lazy patch share a bounded fetch without a checkout", async () => {
  const [root, env] = setupRoot(
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PR_CALLS"\nexec /bin/cat "$PR_PATCH"\n',
  );
  const patch = join(root, "patch");
  const calls = join(root, "calls");
  write(patch, prDiff.file.patch);
  const git = new WorkdirGit({
    repoUrl: "unused",
    repoDir: join(root, "reaped"),
    dataDir: root,
    env: { ...env, PR_PATCH: patch, PR_CALLS: calls },
  });
  const [summary, file] = await Promise.all([
    git.pullRequestDiff(prDiff.pr.url),
    git.pullRequestDiff(prDiff.pr.url, prDiff.file.path),
  ]);
  expect(summary.files).toEqual(prDiff.summary.files);
  expect(summary.target).toEqual(prDiff.summary.target);
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
