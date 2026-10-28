import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { captureFixture } from "./fixture_subprocess";

interface Case {
  name: string;
  input: {
    args: string[];
    agent?: string;
    spawn_wait?: string;
    repo?: boolean;
    source?: boolean;
    olderCommit?: boolean;
    remote?: "updated" | "unmapped" | "unavailable";
    files?: Record<string, string>;
    api?: {
      conversations?: Record<string, unknown>[];
      spawn_status?: string;
      spawn_message?: string;
      delete_404?: string[];
      conv_by_id?: Record<string, Record<string, unknown>>;
    };
  };
  exit: number;
  out: string;
  err: string;
  calls: Array<{
    method: string;
    path: string;
    body?: unknown;
    loopback: boolean;
    agent: string | null;
  }>;
}
const tool = resolve(import.meta.dir, "../../tools/subagent.ts");
const token = "subagent-fixture-token";

function replace(value: unknown, data: string, repo: string): unknown {
  if (typeof value === "string")
    return value.replaceAll("$DATA", data).replaceAll("$REPO", repo);
  if (Array.isArray(value))
    return value.map((item) => replace(item, data, repo));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replace(item, data, repo),
      ]),
    );
  }
  return value;
}

function normalize(
  value: unknown,
  data: string,
  repo: string,
  root: string,
): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(repo, "$REPO")
      .replaceAll(data, "$DATA")
      .replaceAll(root, "$ROOT")
      .replace(/(?<![A-Za-z0-9])[0-9a-f]{32}(?![A-Za-z0-9])/g, "<UUID>")
      .replace(/(?<![A-Za-z0-9])[0-9a-f]{12}(?![A-Za-z0-9])/g, "<ID>");
  }
  if (Array.isArray(value))
    return value.map((item) => normalize(item, data, repo, root));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalize(item, data, repo, root),
      ]),
    );
  }
  return value;
}

async function git(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const result = await captureFixture(["git", ...args], { cwd, env });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function createRepo(repo: string): Promise<void> {
  mkdirSync(repo, { recursive: true });
  await git(
    ["init", "-q", "-b", "main"],
    repo,
    process.env as Record<string, string>,
  );
  await commitSeed(repo, "fixture\n");
}

async function commitSeed(repo: string, content: string): Promise<void> {
  writeFileSync(join(repo, "seed.txt"), content);
  await git(["add", "seed.txt"], repo, process.env as Record<string, string>);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z",
  } as Record<string, string>;
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-q",
      "--no-gpg-sign",
      "-m",
      "fixture seed",
    ],
    repo,
    env,
  );
}

async function runOne(spec: Case): Promise<{
  exit: number;
  out: string;
  err: string;
  calls: unknown[];
  worktree?: { seed: string; gitdir: string; holders: string[] };
}> {
  const root = mkdtempSync(join(tmpdir(), "subagent-replay-"));
  const data = join(root, "data");
  const repo = join(root, "repo");
  mkdirSync(data);
  mkdirSync(repo);
  if (spec.input.repo) await createRepo(repo);
  if (spec.input.source) {
    await createRepo(join(root, "source"));
  }
  if (spec.input.olderCommit) {
    await git(["branch", "start"], repo, process.env as Record<string, string>);
    await commitSeed(repo, "later\n");
  }
  if (spec.input.remote) {
    const remote = join(root, "remote");
    await createRepo(remote);
    const env = process.env as Record<string, string>;
    await git(["remote", "add", "origin", remote], repo, env);
    await git(["fetch", "origin", "main"], repo, env);
    if (spec.input.remote === "unmapped")
      await git(["config", "--unset-all", "remote.origin.fetch"], repo, env);
    await commitSeed(remote, "remote updated\n");
    if (spec.input.remote === "unavailable")
      rmSync(remote, { recursive: true });
  }
  const prepared = replace(spec.input, data, repo) as Case["input"];
  prepared.args = prepared.args.map((arg) =>
    arg.replaceAll("$SOURCE", join(root, "source")),
  );
  for (const [relative, content] of Object.entries(prepared.files ?? {})) {
    const path = join(data, relative);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  const calls: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      let body: unknown;
      const raw = await request.text();
      if (raw) body = JSON.parse(raw);
      const caller = request.headers.get("x-recurse-agent");
      calls.push({
        method: request.method,
        path,
        ...(body === undefined ? {} : { body }),
        loopback: request.headers.get("x-loopback-token") === token,
        agent: caller,
      });
      const api = prepared.api ?? {};
      let status = 200;
      let response: Record<string, unknown> = {};
      if (path === "/api/subagent-tool/conversations") {
        response = { conversations: api.conversations ?? [], complete: true };
      } else if (path.endsWith("/spawn-outcome") && request.method === "GET") {
        response = {
          status: api.spawn_status ?? "queued",
          ...(api.spawn_message ? { message: api.spawn_message } : {}),
        };
      } else if (
        request.method === "DELETE" &&
        api.delete_404?.includes(path.split("/").at(-1)!)
      ) {
        status = 404;
        response = { detail: "not found" };
      } else if (
        request.method === "GET" &&
        path.startsWith("/api/conversations/")
      ) {
        const cid = path.slice("/api/conversations/".length);
        const conv = api.conv_by_id?.[cid];
        if (conv) response = conv;
        else {
          status = 404;
          response = { detail: "not found" };
        }
      }
      return Response.json(response, { status });
    },
  });

  try {
    writeFileSync(
      join(data, "server.json"),
      JSON.stringify({ port: server.port, token }),
    );
    const env = { ...process.env } as Record<string, string>;
    for (const name of [
      "RECURSE_AGENT_ID",
      "RECURSE_SPAWN_WAIT_SECONDS",
      "CHAT_REPO_URL",
      "RECURSE_SELF_DEPLOY",
    ])
      delete env[name];
    env.CHAT_DATA_DIR = data;
    env.RECURSE_ISOLATED_DATA_DIR = data;
    env.RECURSE_TEMP_ROOT = join(root, "temp");
    env.PI_BG_SHELL_STATE_DIR = join(root, "shell-state");
    env.RECURSE_HOME = join(root, "home");
    env.PI_CODING_AGENT_DIR = join(root, "home", "pi-agent");
    env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
    env.CHAT_REPO_URL = join(root, "target-repo");
    env.RECURSE_BIN_DIR = join(root, "bin");
    env.WORKTREE_ROOT = data;
    if (spec.input.agent) env.RECURSE_AGENT_ID = spec.input.agent;
    if (spec.input.spawn_wait !== undefined)
      env.RECURSE_SPAWN_WAIT_SECONDS = spec.input.spawn_wait;
    const cwd = spec.input.repo ? repo : root;
    const proc = Bun.spawn(["bun", tool, ...prepared.args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const spawn = calls.find(
      (call: any) => call.path === "/api/conversations/spawn",
    ) as { body: { id: string; workdir?: string } } | undefined;
    let worktree;
    if (spec.input.source !== undefined && spawn?.body.workdir) {
      const markers = join(data, "worktrees", ".markers");
      const name = basename(spawn.body.workdir);
      const marker = JSON.parse(
        readFileSync(join(markers, `${name}.json`), "utf8"),
      );
      worktree = {
        seed: readFileSync(join(spawn.body.workdir, "seed.txt"), "utf8"),
        gitdir: normalize(
          readFileSync(join(spawn.body.workdir, ".git"), "utf8"),
          data,
          repo,
          root,
        ) as string,
        holders: Object.keys(marker.holders).map((id) =>
          id === spawn.body.id ? "child" : id,
        ),
      };
    }
    return {
      exit,
      ...(worktree ? { worktree } : {}),
      out: normalize(out, data, repo, root) as string,
      err: normalize(err, data, repo, root) as string,
      calls: normalize(calls, data, repo, root) as unknown[],
    };
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

function createArgs(...options: string[]): string[] {
  return ["create", "--title", "Kid", ...options, "task"];
}

test("subagent create forks the explicit source regardless of caller cwd", async () => {
  for (const [repo, source] of [
    [true, true],
    [false, true],
    [true, false],
  ]) {
    const got = await runOne({
      input: {
        args: createArgs(
          "--worktree",
          "kid",
          ...(source ? ["--worktree-source", "$SOURCE"] : []),
        ),
        source,
        repo,
        spawn_wait: "0",
      },
    } as Case);
    expect(got.exit).toBe(0);
    expect(got.worktree).toEqual({
      seed: "fixture\n",
      gitdir: source
        ? "gitdir: $ROOT/source/.git/worktrees/kid\n"
        : "gitdir: $REPO/.git/worktrees/kid\n",
      holders: ["child"],
    });
    const spawn = got.calls.find(
      (call: any) => call.path === "/api/conversations/spawn",
    ) as any;
    expect(spawn.body.workdir).toBe("$DATA/worktrees/kid");
  }
});

test("subagent create starts at --commit instead of the source HEAD", async () => {
  const got = await runOne({
    input: {
      args: createArgs("--worktree", "kid", "--commit", "start"),
      repo: true,
      source: false,
      olderCommit: true,
      spawn_wait: "0",
    },
  } as Case);
  expect(got.exit).toBe(0);
  expect(got.worktree?.seed).toBe("fixture\n");
});

test("subagent create refreshes remote --commit refs and rejects failed fetches", async () => {
  for (const remote of ["updated", "unmapped", "unavailable"] as const) {
    const got = await runOne({
      input: {
        args: createArgs("--worktree", "kid", "--commit", "origin/main"),
        repo: true,
        source: false,
        remote,
        spawn_wait: "0",
      },
    } as Case);
    if (remote !== "unavailable") {
      expect(got.exit).toBe(0);
      expect(got.worktree?.seed).toBe("remote updated\n");
    } else {
      expect(got.exit).toBe(1);
      expect(got.err).toContain(
        "Could not fetch --commit 'origin/main'; check remote 'origin' and branch 'main', then retry.",
      );
      expect(got.calls).toEqual([]);
    }
  }
});

test("subagent create rejects invalid worktree flags before spawning", async () => {
  const rejected: [string[], number, string][] = [
    [
      ["--commit", "HEAD"],
      2,
      "--commit requires --worktree; add --worktree <name>",
    ],
    [
      ["--worktree-source", "$SOURCE"],
      2,
      "--worktree-source requires --worktree; add --worktree <name>",
    ],
    [
      ["--worktree", "kid", "--commit", "missing"],
      1,
      "--commit 'missing' does not resolve to a commit",
    ],
    [
      ["--worktree", "kid", "--worktree-source", "$SOURCE"],
      1,
      "--worktree-source must be a real, non-symlink, non-bare Git checkout top level",
    ],
  ];
  for (const [flags, exit, message] of rejected) {
    const got = await runOne({
      input: { args: createArgs(...flags), repo: true },
    } as Case);
    expect(got.exit).toBe(exit);
    expect(got.err).toContain(message);
    expect(got.calls).toEqual([]);
  }
});
