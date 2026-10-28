import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import { buildApp, WebLogSink, type App } from "../../src/web/app";
import { tailscaleSocket, type RunningServer } from "../../src/server";
import { appWorld } from "./web_app_support";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function compose(env: Record<string, string>): Promise<App> {
  const app = await buildApp({
    env,
    sink: new WebLogSink(() => {}),
  });
  cleanup.push(() => app.instance.shutdown());
  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

async function until(check: () => Promise<boolean>, ms = 30_000) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(20);
  }
}

async function curl(args: string[], uid?: number) {
  const child = spawn("curl", ["-sS", "--max-time", "5", ...args], {
    uid,
    gid: uid,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

// Feature: #2604 operator identity is confined to the private Unix listener.
test("Tailscale identity is confined to the private Unix listener", async () => {
  const { root, env } = appWorld({ password: true });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  env.RECURSE_TAILSCALE_LOGIN = " Recurse@Example.COM ";
  const app = await compose(env);
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  await until(async () => app.instance.lifecycle.readinessSnapshot().ready);
  const socket = join(env.CHAT_DATA_DIR!, "tailscale", "serve.sock");
  const directory = await lstat(join(env.CHAT_DATA_DIR!, "tailscale"));
  expect(directory.mode & 0o777).toBe(0o700);
  expect(directory.uid).toBe(process.getuid!());
  expect((await lstat(socket)).isSocket()).toBe(true);
  const identity = ["-H", "Tailscale-User-Login:  ReCuRsE@Example.COM  "];
  for (const path of ["/", "/api/tree"]) {
    const admitted = await curl([
      "--unix-socket",
      socket,
      ...identity,
      "-w",
      "%{http_code}",
      `http://localhost${path}`,
    ]);
    expect(admitted.code).toBe(0);
    expect(admitted.stdout.endsWith("200")).toBe(true);
    const denied = await fetch(`${running.url}${path}`, {
      headers: { "Tailscale-User-Login": "recurse@example.com" },
    });
    expect(denied.status).toBe(401);
    await denied.arrayBuffer();
  }
  for (const headers of [
    [],
    ["-H", "Tailscale-User-Login: other@example.com"],
    [...identity, ...identity],
    ["-H", "Tailscale-User-Login: recurse@example.com,other@example.com"],
  ]) {
    const denied = await curl([
      "--unix-socket",
      socket,
      ...headers,
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "http://localhost/api/tree",
    ]);
    expect(denied.code).toBe(0);
    expect(denied.stdout).toBe("401");
  }
  delete env.CHAT_AUTH_SALT;
  delete env.CHAT_AUTH_HASH;
  const open = await fetch(`${running.url}/api/tree`);
  expect(open.status).toBe(200);
  await open.arrayBuffer();
  const denied = await curl([
    "--unix-socket",
    socket,
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "http://localhost/api/tree",
  ]);
  expect(denied.stdout).toBe("401");
  await running.close();
  expect(existsSync(socket)).toBe(false);
});

test.skipIf(process.getuid?.() !== 0)(
  "private Tailscale socket refuses another UID (requires root to switch UID)",
  async () => {
    const { root, env } = appWorld();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    env.RECURSE_TAILSCALE_LOGIN = "recurse@example.com";
    const app = await compose(env);
    const running = await app.serve({ port: 0 });
    cleanup.push(() => running.close());
    const socket = join(env.CHAT_DATA_DIR!, "tailscale", "serve.sock");
    const response = await curl(
      [
        "--unix-socket",
        socket,
        "-H",
        "Tailscale-User-Login: recurse@example.com",
        "http://localhost/api/tree",
      ],
      65534,
    );
    expect(response.code).toBe(7);
    expect(response.stdout).toBe("");
  },
);

// Feature: #2604 the private Unix listener recovers after an unclean exit.
test("Tailscale listener recovers its socket after a killed server", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  env.RECURSE_TAILSCALE_LOGIN = "recurse@example.com";
  const app = await compose(env);
  const socket = await tailscaleSocket(env.CHAT_DATA_DIR!);
  const child = spawn(process.execPath, [
    "-e",
    'Bun.serve({unix: process.argv[1], fetch: () => new Response("ready")}); process.kill(process.pid, "SIGKILL")',
    socket,
  ]);
  const signal = await new Promise<string | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) => resolve(signal));
  });
  expect(signal).toBe("SIGKILL");
  expect((await lstat(socket)).isSocket()).toBe(true);
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  await expect(tailscaleSocket(env.CHAT_DATA_DIR!)).rejects.toThrow(
    "already listening",
  );
  const response = await curl([
    "--unix-socket",
    socket,
    "-H",
    "Tailscale-User-Login: recurse@example.com",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "http://localhost/",
  ]);
  expect(response.code).toBe(0);
  expect(response.stdout).toBe("200");
});

test("listen first: 503 Retry-After 2 until the projection applies", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const app = await compose(env);
  let release!: () => void;
  const parked = new Promise<void>((resolve) => (release = resolve));
  let reached = false;
  const store = app.instance.conversations;
  const refresh = store.refreshProjection.bind(store);
  store.refreshProjection = async () => {
    reached = true;
    const result = refresh();
    await parked;
    return result;
  };
  cleanup.push(() => release());
  const running: RunningServer = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  const get = (path: string, init?: RequestInit) =>
    fetch(`${running.url}${path}`, init);

  await until(async () => reached);
  expect((await get("/")).status).toBe(200);
  for (const [path, init] of [
    ["/api/tree", undefined],
    ["/api/conversations/nobody/view", undefined],
    ["/api/conversations/nobody/events", undefined],
    [
      "/api/conversations",
      {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      },
    ],
  ] as const) {
    const response = await get(path, init);
    expect([path, response.status]).toEqual([path, 503]);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await json(response)).toEqual({
      detail: "service_storage_unavailable",
    });
  }
  expect(await json(await get("/api/status"))).toEqual({
    ready: false,
    active_agents: null,
  });

  release();
  await until(async () => (await json(await get("/api/status"))).ready);
  const tree = await get("/api/tree");
  expect(tree.status).toBe(200);
  expect(await json(tree)).toEqual([]);
  expect((await get("/api/conversations/nobody/view")).status).toBe(404);
  await Promise.all(app.detached);
  expect(
    existsSync(join(env.CHAT_DATA_DIR!, "config", "available-models.json")),
  ).toBe(true);
  await app.sink.file!.flush();
  const log = await Bun.file(
    join(env.CHAT_DATA_DIR!, "logs", "recurse.log"),
  ).text();
  expect(log).toContain("event=application_started");
});

test("view polls during shutdown return a quiet retryable 503", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const logs: string[] = [];
  const app = await buildApp({
    env,
    sink: new WebLogSink((line) => logs.push(line)),
  });
  cleanup.push(() => app.instance.shutdown());
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  await until(async () => app.instance.lifecycle.readinessSnapshot().ready);
  await app.instance.create.create({ cid: "main", title: "Main" });
  const closing = app.instance.durable.close();
  const response = await fetch(`${running.url}/api/conversations/main/view`);
  await closing;
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("2");
  expect(logs.some((line) => line.includes("event=http_unhandled_error"))).toBe(
    false,
  );
});

test("the server listens only once the Durable runtime has loaded", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const app = await compose(env);
  let release!: () => void;
  const load = new Promise<void>((resolve) => (release = resolve));
  let loadStarted = false;
  app.instance.durable.loadRuntime = () => ((loadStarted = true), load);
  let startDone!: () => void;
  const started = new Promise<void>((resolve) => (startDone = resolve));
  const start = app.instance.start;
  app.instance.start = async (options) => {
    await start(options);
    startDone();
  };
  cleanup.push(() => release());
  let listening = false;
  const serving = app.serve({ port: 0 }).then((running) => {
    listening = true;
    cleanup.push(() => running.close());
    return running;
  });
  await started;
  while (!loadStarted) await Bun.sleep(5);
  expect(Boolean(loadStarted)).toBe(true);
  expect(listening).toBe(false);
  release();
  const running = await serving;
  expect((await fetch(`${running.url}/`)).status).toBe(200);
});

test("a failed Durable runtime load is logged and the server still listens", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const app = await buildApp({
    env,
    sink: new WebLogSink((line) => warnings.push(line)),
  });
  cleanup.push(() => app.instance.shutdown());
  app.instance.durable.loadRuntime = () =>
    Promise.reject(new Error("runtime unavailable"));
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  expect((await fetch(`${running.url}/`)).status).toBe(200);
  expect(
    warnings.filter((line) =>
      line.includes("event=load_durable_runtime_failed"),
    ).length,
  ).toBe(1);
});

test("a missing working area fails startup before listening", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  env.CHAT_REPO_URL = "https://example.invalid/never-cloned.git";
  const app = await compose(env);
  let started = false;
  app.instance.lifecycle.startWatcher = async () => {
    started = true;
  };
  await expect(app.serve({ port: 0 })).rejects.toThrow(
    "working area not ready",
  );
  expect(started).toBe(false);
});

test("a create right after serve() is refused until ready", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const app = await compose(env);
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  await expect(
    app.instance.create.create({ cid: "main", title: "Main" }),
  ).rejects.toThrow("startup import incomplete");
  await until(async () => app.instance.lifecycle.readinessSnapshot().ready);
  const conv = await app.instance.create.create({ cid: "main", title: "Main" });
  expect(conv.id).toBe("main");
  await Promise.all(app.detached);
});

test("post-listen recovery finishes an interrupted artifact deletion", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const app = await compose(env);
  const ctx = {
    artifactsDir: app.instance.config.paths.ARTIFACTS_DIR,
    trashDir: app.instance.config.paths.TRASH_DIR,
  };
  const owner = "ownerabc123";
  const created = await artifacts.create(ctx, { owner, title: "Doomed" });
  const id = String(created.id);
  await writeFile(join(ctx.artifactsDir, owner, id, "index.html"), "<p>x</p>");
  const info = await artifacts.publish(ctx, owner, id);
  await artifacts.deleteArtifact(ctx, owner, id, String(info.version));
  expect(await artifacts.recoverableDeletions(ctx)).toHaveLength(1);
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  await Promise.all(app.detached);
  expect(await artifacts.recoverableDeletions(ctx)).toEqual([]);
});

// Regression: #2824 startup refreshes hooks pointing at the moved Artifact CLI.
test("startup refreshes existing Artifact commit hooks once", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const app = await compose(env);
  const ctx = {
    artifactsDir: app.instance.config.paths.ARTIFACTS_DIR,
    trashDir: app.instance.config.paths.TRASH_DIR,
  };
  const created = await artifacts.create(ctx, {
    owner: "ownerabc123",
    title: "Existing document",
  });
  const repo = String(created.repo_path);
  const hook = join(repo, ".git", "hooks", "post-commit");
  const current = await readFile(hook, "utf8");
  const old = current
    .replace("src/artifacts/publish_commit.ts", "tools/artifact.ts")
    .replace(" .\n", " publish-commit .\n");
  expect(old).not.toBe(current);
  await writeFile(hook, old);
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  expect(await readFile(hook, "utf8")).toBe(current);
  await writeFile(join(repo, "index.md"), "# Published by commit\n");
  await Bun.$`git -C ${repo} add --all`.quiet();
  const committed =
    await Bun.$`git -C ${repo} commit -m ${"Publish document"}`.quiet();
  expect(committed.stderr.toString()).toMatch(/"command":\s*"publish"/);
  const head = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
  expect(
    (await artifacts.get(ctx, "ownerabc123", String(created.id))).version,
  ).toBe(head);
  await writeFile(hook, old);
  await artifacts.migrateCommitHooks(ctx);
  expect(await readFile(hook, "utf8")).toBe(old);
  await Promise.all(app.detached);
});

function within<T>(work: Promise<T>, ms = 10_000): Promise<T> {
  return Promise.race([
    work,
    Bun.sleep(ms).then(() => {
      throw new Error(`deadlocked: no result within ${ms} ms`);
    }),
  ]);
}

test("creating from an attachment draft reuses the held title guard", async () => {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const app = await compose(env);
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  const api = (path: string, init?: RequestInit) =>
    fetch(`${running.url}${path}`, init);
  await until(async () => (await json(await api("/api/status"))).ready);
  const { drafts, create, conversations } = app.instance;

  const direct = await drafts.createAttachmentDraft();
  await drafts.addDraftUpload(
    direct.id,
    new TextEncoder().encode("a"),
    "a.txt",
  );
  const made = await within(create.create({ attachmentDraft: direct.id }));
  const stored = conversations.load(String(made.id))!;
  expect(stored.attachment_draft).toBeUndefined();

  const draft = await drafts.createAttachmentDraft();
  await drafts.addDraftUpload(draft.id, new TextEncoder().encode("b"), "b.txt");
  const response = await within(
    api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ attachment_draft: draft.id }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(response.status).toBe(200);
  const cid = String((await json(response)).id);
  expect(conversations.load(cid)!.attachment_draft).toBeUndefined();
});
