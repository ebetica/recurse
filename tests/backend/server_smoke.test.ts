import { afterAll, beforeAll, expect, test } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFixture } from "./fixture_subprocess";
import { groupMembers, expectGroupGone } from "./pi_real_support";
import { AgentStore } from "../../src/agents/agent_store";

const REPO = join(import.meta.dir, "..", "..");
const PASSWORD = "smoke-test-password-1";
const SALT = "00112233445566778899aabbccddeeff";

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const TEXT =
  chunk({ role: "assistant", content: "scripted reply" }) +
  chunk({}, "stop") +
  "data: [DONE]\n\n";

let hold = false;
let requests = 0;
let release: () => void = () => {};
let provider: ReturnType<typeof Bun.serve>;
let root = "";

beforeAll(() => {
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      await request.text();
      requests++;
      if (hold) await new Promise<void>((r) => (release = r));
      return new Response(TEXT, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  root = mkdtempSync(join(tmpdir(), "server-smoke-"));
});
afterAll(() => {
  release();
  provider?.stop(true);
  if (root && !process.env.SMOKE_KEEP)
    rmSync(root, { recursive: true, force: true });
});

function checkout(scope = root): string {
  const dir = join(scope, "checkout");
  mkdirSync(dir, { recursive: true });
  cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "web"));
  for (const file of ["index.html", "icons.ts", "theme.css"])
    cpSync(join(REPO, "web", file), join(dir, "web", file));
  for (const linked of ["node_modules"])
    symlinkSync(join(REPO, linked), join(dir, linked));
  return dir;
}

function environment(port: number, scope = root): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "TERM", "USER", "TZ"])
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  const data = join(scope, "data");
  const target = join(scope, "target");
  mkdirSync(join(data, "config"), { recursive: true });
  mkdirSync(target, { recursive: true });
  const level = { model: "recurse-test/scripted", reasoning: "low" };
  writeFileSync(
    join(data, "config", "effort-levels.json"),
    JSON.stringify({
      default_level: 3,
      levels: { 1: level, 2: level, 3: level, 4: level, 5: level },
      version: 1,
    }),
  );
  writeFileSync(
    join(data, "config", "model-providers.json"),
    JSON.stringify({
      default: "recurse-test/scripted",
      providers: {
        "recurse-test": {
          base_url: `http://127.0.0.1:${provider.port}/v1`,
          env_key: "RECURSE_TEST_KEY",
          wire_api: "completions",
          models: [{ id: "scripted", context_window: 100000 }],
        },
      },
    }),
  );
  const hash = pbkdf2Sync(
    PASSWORD,
    new Uint8Array(Buffer.from(SALT, "hex")),
    600_000,
    32,
    "sha256",
  ).toString("hex");
  return Object.assign(env, {
    CHAT_DATA_DIR: data,
    HOME: join(scope, "home"),
    RECURSE_HOME: join(scope, "settings"),
    CHAT_REPO_URL: target,
    RECURSE_TEST_KEY: "loopback-only",
    PI_BG_SHELL: "0",
    CHAT_AUTH_SALT: SALT,
    CHAT_AUTH_HASH: hash,
    PORT: String(port),
  });
}

async function dataDirGroups(dataDir: string, own: number, except?: string) {
  const groups = new Set<number>();
  const needle = `CHAT_DATA_DIR=${dataDir}\0`;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const environ = await readFile(`/proc/${name}/environ`, "latin1");
      if (!environ.includes(needle)) continue;
      const cmd = await readFile(`/proc/${name}/cmdline`, "utf8");
      if (except && cmd.includes(except)) continue;
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (pgrp !== own) groups.add(pgrp);
    } catch {}
  }
  return [...groups];
}

async function digest(roots: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    let info;
    try {
      info = await lstat(path);
    } catch {
      return;
    }
    out.set(
      path,
      `${info.isDirectory() ? "d" : "f"} ${info.size} ${info.mtimeMs} ${info.ino}`,
    );
    if (info.isDirectory())
      for (const name of await readdir(path).catch(() => []))
        await visit(join(path, name));
  };
  for (const root of roots) await visit(root);
  return out;
}

async function listeningUrl(log: string): Promise<string> {
  return until(
    async () =>
      (await readFile(log, "utf8")).match(
        /recurse server listening on (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1],
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  ms = 60_000,
): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (performance.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(50);
  }
}

// Regression: #2878 direct server startup migrates legacy clone identity. (also Feature #2301 copied backend startup and Feature #2502 assigned ports.)
test("bun src/server.ts: check, login, create, send, view, SSE, stop, SIGTERM", async () => {
  const dir = checkout();
  const port = 0;
  const env = environment(port);
  const entry = join(dir, "src", "server.ts");
  const repo = join(env.CHAT_DATA_DIR!, "repo");
  env.CHAT_REPO_URL = "https://github.com/fixture/target.git";
  env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(
    env.GIT_CONFIG_GLOBAL,
    "[user]\nname = Startup Human\nemail = startup@example.invalid\n",
  );
  for (const args of [
    ["init", repo],
    ["-C", repo, "remote", "add", "origin", env.CHAT_REPO_URL],
    ["-C", repo, "config", "user.name", "recurse-agent"],
    ["-C", repo, "config", "user.email", "recurse-agent@local"],
    ["-C", repo, "commit", "--allow-empty", "-m", "fixture"],
  ]) {
    const result = await captureFixture(["git", ...args], { env });
    expect(result.exitCode).toBe(0);
  }

  const check = await captureFixture([process.execPath, entry, "--check"], {
    env,
    cwd: dir,
    timeoutMs: 60_000,
  });
  expect([check.exitCode, check.stderr.toString()]).toEqual([0, ""]);

  const server = Bun.spawn(
    [process.execPath, entry, "--host", "127.0.0.1", "--port", String(port)],
    {
      env,
      cwd: dir,
      stdout: Bun.file(join(root, "server.out")),
      stderr: Bun.file(join(root, "server.out")),
      detached: true,
    },
  );
  const pgid = server.pid;
  try {
    const base = await listeningUrl(join(root, "server.out"));
    const identityConfig = join(repo, ".git", "config");
    await until(
      async () =>
        (await readFile(identityConfig, "utf8")).includes(
          "identityVersion = 1",
        ),
      5000,
    );
    const identity = await captureFixture(
      ["git", "-C", repo, "var", "GIT_COMMITTER_IDENT"],
      { env },
    );
    expect(identity.stdout.toString()).toStartWith(
      "Startup Human <startup@example.invalid>",
    );
    const shell = await until(() =>
      fetch(`${base}/`).then((r) => (r.status === 401 ? r : null)),
    );
    expect(shell.headers.get("content-type")).toContain("text/html");

    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { cookie, "content-type": "application/json" };
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      });

    await until(() =>
      api("/api/status").then(async (r) => (await json(r)).ready === true),
    );
    const created = await api("/api/conversations", {
      method: "POST",
      body: "{}",
    });
    expect(created.status).toBe(200);
    const cid = (await json(created)).id as string;
    expect(cid).toMatch(/^[0-9a-f]+$/);

    hold = true;
    const sent = await api(`/api/conversations/${cid}/deliver`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    });
    expect(sent.status).toBe(200);
    expect((await json(sent)).ok).toBe(true);
    await until(async () => requests > 0);

    const view = await api(`/api/conversations/${cid}/view`);
    expect(view.status).toBe(200);
    const page = await json(view);
    expect(typeof page.revision).toBe("number");

    const events = await until(() =>
      api(`/api/conversations/${cid}/events`).then(async (r) =>
        r.status === 200 ? r : (await r.arrayBuffer(), null),
      ),
    );
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = events.body!.getReader();
    let text = "";
    while (!/\n\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toMatch(/^(id|event|data|retry|:)/m);

    const conv = await until(() =>
      api(`/api/conversations/${cid}`).then(async (r) => {
        const body = await json(r);
        return body.active_run ? body : null;
      }),
    );
    const stopped = await api(`/api/conversations/${cid}/deliver`, {
      method: "POST",
      body: JSON.stringify({ run_id: conv.active_run }),
    });
    expect(stopped.status).toBe(200);
    expect((await json(stopped)).ok).toBe(true);
    release();
    hold = false;
    await until(() =>
      api(`/api/conversations/${cid}`).then(
        async (r) => (await json(r)).status === "idle",
      ),
    );
    expect((await json(await api(`/api/conversations/${cid}`))).backend).toBe(
      "durable",
    );
    expect(
      await dataDirGroups(env.CHAT_DATA_DIR!, pgid, "pi_auth_worker"),
    ).toEqual([]);

    const roots = [env.CHAT_DATA_DIR!, env.RECURSE_HOME!, env.HOME!];
    let before = await digest(roots);
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(1000);
      const next = await digest(roots);
      const same = [...next].every(
        ([k, v]) => k.endsWith("/logs/recurse.log") || before.get(k) === v,
      );
      before = next;
      if (same && next.size === before.size) break;
    }
    const probe = await captureFixture([process.execPath, entry, "--check"], {
      env,
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect([probe.exitCode, probe.stderr.toString()]).toEqual([0, ""]);
    const after = await digest(roots);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (path) => before.get(path) !== after.get(path),
    );
    expect(
      changed.filter((path) => !path.endsWith("/logs/recurse.log")),
    ).toEqual([]);
    expect((await api("/api/status")).status).toBe(200);
  } finally {
    release();
    server.kill("SIGTERM");
    const code = await Promise.race([
      server.exited,
      Bun.sleep(30_000).then(() => "timeout"),
    ]);
    if (code === "timeout") process.kill(-pgid, "SIGKILL");
    expect(code, await readFile(join(root, "server.out"), "utf8")).toBe(0);
  }
  await until(async () => (await groupMembers(pgid)).length === 0, 10_000);
  await expectGroupGone(pgid);
  const stores = [
    ...new Bun.Glob("conversations/*/durable/session.sqlite").scanSync(
      env.CHAT_DATA_DIR!,
    ),
  ];
  expect(stores.length).toBeGreaterThan(0);
  for (const store of stores) {
    const wal = Bun.file(join(env.CHAT_DATA_DIR!, `${store}-wal`));
    expect((await wal.exists()) ? wal.size : 0).toBe(0);
  }
  expect(await dataDirGroups(env.CHAT_DATA_DIR!, pgid)).toEqual([]);
}, 180_000);

// Regression: #2410 stale selected models return actionable 422 without fallback.
test("first messages report malformed and unavailable stored models", async () => {
  hold = false;
  const scope = join(root, "model-case");
  const dir = checkout(scope);
  const port = 0;
  const env = environment(port, scope);
  const entry = join(dir, "src", "server.ts");
  let base = "";
  let cookie = "";
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        cookie,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const start = async () => {
    const log = join(scope, "model-server.out");
    await writeFile(log, "");
    const child = Bun.spawn(
      [process.execPath, entry, "--host", "127.0.0.1", "--port", String(port)],
      {
        env,
        cwd: dir,
        stdout: Bun.file(join(scope, "model-server.out")),
        stderr: Bun.file(join(scope, "model-server.out")),
        detached: true,
      },
    );
    base = await listeningUrl(log);
    await until(() =>
      fetch(`${base}/`)
        .then((r) => (r.status === 401 ? r : null))
        .catch(() => null),
    );
    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(login.status).toBe(303);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    await until(() =>
      api("/api/status").then(async (r) => (await json(r)).ready === true),
    );
    return child;
  };
  const stop = async (child: Awaited<ReturnType<typeof start>>) => {
    child.kill("SIGTERM");
    const code = await Promise.race([
      child.exited,
      Bun.sleep(30_000).then(() => "timeout"),
    ]);
    if (code === "timeout") process.kill(-child.pid, "SIGKILL");
    expect(code, await readFile(join(scope, "model-server.out"), "utf8")).toBe(
      0,
    );
    await expectGroupGone(child.pid);
  };
  const models = ["", "not-a-model", "recurse-test/removed"];
  const agents: string[] = [];
  let server = await start();
  try {
    for (let index = 0; index < models.length; index++) {
      const response = await api("/api/conversations", {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(200);
      agents.push((await json(response)).id);
    }
  } finally {
    await stop(server);
  }
  const store = new AgentStore(join(env.CHAT_DATA_DIR!, "agents"));
  try {
    for (const [index, cid] of agents.entries()) {
      const [record] = await store.loadPersistedAgent(cid);
      expect(record).not.toBeNull();
      store.enqueueMetadata(cid, {
        ...record!,
        level: null,
        model: models[index],
      });
    }
    expect(await store.flushAll()).toBe(true);
  } finally {
    expect(await store.dispose()).toBe(true);
  }
  server = await start();
  try {
    const before = requests;
    const results: { model: string; status: number; body: string }[] = [];
    for (const [index, cid] of agents.entries()) {
      const response = await api(`/api/conversations/${cid}/deliver`, {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
      });
      results.push({
        model: models[index]!,
        status: response.status,
        body: await response.text(),
      });
    }
    console.info("model admission responses", JSON.stringify(results));
    expect(requests).toBe(before);
    expect(results.map((result) => result.status)).toEqual([422, 422, 422]);
    for (const [index, result] of results.entries()) {
      const error = JSON.parse(result.body).detail as string;
      if (models[index]) expect(error).toContain(models[index]!);
      else expect(error).toContain("No model");
      expect(error).toContain("effort level");
      expect(error).toContain("Settings > Effort ladder");
      expect(error).not.toContain("durable");
    }
    const repaired = await api(`/api/conversations/${agents[0]}/model`, {
      method: "POST",
      body: JSON.stringify({ level: 3 }),
    });
    expect(repaired.status).toBe(200);
    const accepted = await api(`/api/conversations/${agents[0]}/deliver`, {
      method: "POST",
      body: JSON.stringify({ content: "hello after choosing a model" }),
    });
    expect(accepted.status).toBe(200);
    await until(() =>
      api(`/api/conversations/${agents[0]}/view`).then(async (response) =>
        (await response.text()).includes("scripted reply"),
      ),
    );
    expect(requests).toBeGreaterThan(before);
  } finally {
    await stop(server);
  }
}, 60_000);
