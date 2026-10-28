import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePiPackage } from "./fake_pi_auth";
import { ProcessLifecycle } from "../../src/process_lifecycle";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { procStat } from "../../src/utils/proc_stat";
import { OAuthStore, parseTokenJson } from "../../src/auth/oauth";
import * as anthropic from "../../src/auth/anthropic";
import * as codex from "../../src/auth/codex";

type Step = { op: string; args?: unknown[]; [key: string]: unknown };
const NOW_MS = 1790000000.25 * 1000;
let WORK = "";
let PACKAGE = "";

function tokenBytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) % 256);
}

beforeAll(() => {
  WORK = mkdtempSync(join(tmpdir(), "recurse-provider-auth-ts-"));
  PACKAGE = fakePiPackage(join(WORK, "pkg"));
});
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

function lifecycle(root: string): ProcessLifecycle {
  const state = join(root, "shell-state");
  mkdirSync(state, { recursive: true });
  return new ProcessLifecycle({
    registry: new ShellRegistry({
      enabled: true,
      stateDir: state,
      processStartedMs: Date.now(),
    }),
    shellStateDir: state,
    termGraceMs: 200,
    killGraceMs: 500,
  });
}

interface FakeServer {
  url: string;
  responses: Step[];
  requests: unknown[];
  stop(): void;
}

function fakeServer(): FakeServer {
  const fake: Omit<FakeServer, "url" | "stop"> = {
    responses: [],
    requests: [],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      fake.requests.push({
        path: new URL(request.url).pathname,
        content_type: request.headers.get("content-type"),
        accept: request.headers.get("accept"),
        user_agent: request.headers.get("user-agent"),
        form: [...new URLSearchParams(body)],
      });
      const reply: Step = fake.responses.shift() ?? { op: "reply" };
      return new Response(String(reply.body ?? "{}"), {
        status: Number(reply.status ?? 200),
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    ...fake,
    url: `http://127.0.0.1:${server.port}/oauth/token`,
    stop: () => server.stop(true),
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

interface World {
  root: string;
  agent: string;
  ambient: Record<string, string | undefined>;
  store: OAuthStore;
  claude: anthropic.AnthropicAuth;
  openai: codex.CodexAuth;
  server: FakeServer;
  lifecycle: ProcessLifecycle;
}

function world(): World {
  const root = mkdtempSync(join(WORK, "case-"));
  const agent = join(root, "pi-agent");
  mkdirSync(agent);
  const ambient: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    RECURSE_PI_PACKAGE_ROOT: PACKAGE,
  };
  const life = lifecycle(root);
  const store = new OAuthStore({
    piAgentDir: async () => agent,
    ambient,
    customProviderIds: () => ["custom-x"],
    lifecycle: life,
    nowMs: () => NOW_MS,
  });
  const server = fakeServer();
  const common = {
    store,
    ambient,
    nowMs: () => NOW_MS,
    randomBytes: tokenBytes,
    tokenUrl: server.url,
  };
  return {
    root,
    agent,
    ambient,
    store,
    claude: new anthropic.AnthropicAuth(common),
    openai: new codex.CodexAuth(common),
    server,
    lifecycle: life,
  };
}

test("worker env strips ambient provider credentials", async () => {
  const w = world();
  w.server.stop();
  for (const name of [
    "PI_AUTH_JSON",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ])
    w.ambient[name] = "must-not-enter-worker";
  const env = await w.store.workerEnv();
  expect(Object.values(env)).not.toContain("must-not-enter-worker");
  expect(env.RECURSE_PI_AUTH_PATH).toBe(join(w.agent, "auth.json"));
  delete w.ambient.RECURSE_PI_PACKAGE_ROOT;
});

test("secrets cross only stdin: never argv, errors, or the pending file", async () => {
  const w = world();
  w.server.stop();
  const secret = "sk-SECRET-MARKER-123";
  const seen: string[] = [];
  const spawn = w.lifecycle.spawnTracked.bind(w.lifecycle);
  (w.lifecycle as any).spawnTracked = (argv: string[], ...rest: any[]) => {
    seen.push(...argv);
    return (spawn as any)(argv, ...rest);
  };
  await w.claude.setApiKey(secret);
  expect(seen.join(" ")).not.toContain(secret);
  expect((readJson(join(w.agent, "auth.json")) as any).anthropic.key).toBe(
    secret,
  );
  let message = "";
  try {
    parseTokenJson(`{"access_token": "${secret}"`, "hint");
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).not.toContain(secret);
  expect(message).toContain("isn't valid JSON");
});

async function groupAlive(pgid: number): Promise<number[]> {
  const members: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const { stat } = await procStat(Number(name));
    if (stat && stat.pgrp === pgid && stat.state !== "Z")
      members.push(Number(name));
  }
  return members;
}

function hangingWorker(root: string): string {
  const path = join(root, "hang.mjs");
  writeFileSync(
    path,
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
  );
  return path;
}

test("a timed-out worker's process group is gone", async () => {
  const w = world();
  w.server.stop();
  const pids: number[] = [];
  const spawn = w.lifecycle.spawnTracked.bind(w.lifecycle);
  (w.lifecycle as any).spawnTracked = async (...args: any[]) => {
    const result = await (spawn as any)(...args);
    pids.push(result[0].pid);
    return result;
  };
  const store = new OAuthStore({
    ...w.store.options,
    lifecycle: w.lifecycle,
    workerPath: hangingWorker(w.root),
  });
  await expect(
    store.nativeRequest({ action: "remove" }, { timeoutMs: 300 }),
  ).rejects.toThrow("Pi authentication operation timed out");
  expect(pids).toHaveLength(1);
  expect(await groupAlive(pids[0]!)).toEqual([]);
});

test("an aborted request hands the worker to the lifecycle reaper", async () => {
  const w = world();
  w.server.stop();
  const pids: number[] = [];
  const spawn = w.lifecycle.spawnTracked.bind(w.lifecycle);
  (w.lifecycle as any).spawnTracked = async (...args: any[]) => {
    const result = await (spawn as any)(...args);
    pids.push(result[0].pid);
    return result;
  };
  const store = new OAuthStore({
    ...w.store.options,
    lifecycle: w.lifecycle,
    workerPath: hangingWorker(w.root),
  });
  const controller = new AbortController();
  const pending = store.nativeRequest(
    { action: "remove" },
    { signal: controller.signal },
  );
  while (pids.length === 0) await Bun.sleep(5);
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  await w.lifecycle.drainReaps();
  expect(await groupAlive(pids[0]!)).toEqual([]);
});

test("named difference: a non-object pending file means no login", async () => {
  const w = world();
  w.server.stop();
  writeFileSync(join(w.agent, anthropic.PENDING_FILE_NAME), "[1]");
  expect(await w.store.readPending(anthropic.PENDING_FILE_NAME)).toBeNull();
  await expect(w.claude.completeLogin("x")).rejects.toThrow(
    "No login in progress",
  );
});

test("named difference: postForm does not follow redirects", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("", {
        status: 307,
        headers: { location: "http://127.0.0.1:1/elsewhere" },
      }),
  });
  try {
    const { postForm } = await import("../../src/auth/oauth");
    await expect(
      postForm(`http://127.0.0.1:${server.port}/t`, { code: "c" }),
    ).rejects.toThrow("token exchange failed (307): ");
  } finally {
    server.stop(true);
  }
});
