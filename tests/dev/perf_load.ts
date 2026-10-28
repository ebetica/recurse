#!/usr/bin/env bun
/**
 * Load and performance harness: overloads a private Recurse server and reports
 * where it slows down.
 *
 * Starts `bun src/server.ts` on a throwaway data directory and port, with a
 * loopback scripted model provider (no real model calls or credentials), seeds
 * realistic state through the real HTTP API and agent tools, drives concurrent
 * HTTP and SSE load, and writes a JSON and Markdown report.
 *
 * Seeded state: a tree of conversations and subagents with multi-turn
 * transcripts (tool calls plus long Markdown replies), a few very long
 * transcripts, side conversations, Artifacts with many versions, Git worktrees
 * with uncommitted diffs, and live background shells.
 *
 * Load: virtual users that open and switch conversations as the web app does
 * (tree poll, focused read, view window, SSE polling at the server's retry
 * cadence), read /diff, the Artifacts list, versions and files, settings and
 * remotes, while senders run streaming turns. Each concurrency level runs for
 * --duration seconds and reports p50/p95/p99 per route, errors, server CPU and
 * RSS (sampled from /proc), event-loop stalls and lag windows, slow spans and
 * other slow/timing events from the server's own log.
 *
 * Usage: bun tests/dev/perf_load.ts [--conversations 50] [--concurrency
 * 0,1,8,32] [--duration 20] [--senders 2] [--turns 4] [--long 2] [--long-turns
 * 40] [--artifacts 6] [--versions 15] [--worktrees 6] [--shells 4] [--sides 4]
 * [--cold-start] [--browser] [--cpu-prof] [--out DIR] [--data DIR] [--keep]
 *
 * --conversations N agents in the tree (a fifth are top level, the rest
 * subagents) --concurrency L comma-separated virtual-user counts, one phase
 * each; 0 is an idle phase (background work only) --duration S seconds per
 * concurrency phase --senders N virtual users that send messages and wait for
 * the turn --turns N seeded turns per conversation (4 tool calls + reply each)
 * --long N conversations seeded with --long-turns turns --artifacts N
 * Artifacts, each with --versions published versions --worktrees N
 * conversations working in their own worktree with a diff --shells N
 * conversations holding 4 live background shells each --sides N side
 * conversations --cold-start restart the server on the same data directory and
 * time until the tree, the focused conversation and Artifacts answer --browser
 * Chromium (Playwright) timings: first paint, switch, long-transcript scroll,
 * long tasks on the main thread --cpu-prof run the server with --cpu-prof
 * (profiles in OUT/profiles) --out DIR report directory (default
 * $TMPDIR/perf-<time>) --data DIR reuse a data directory seeded by an earlier
 * --keep run --keep keep the data directory for --data
 *
 * Keep TMPDIR short (for example /tmp/perf): Unix socket paths must stay under
 * 107 bytes. Never point --data at a live instance.
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toolHelp } from "../../tools/_help.ts";
import { retire } from "../../src/utils/trash";
import * as artifacts from "../../src/artifacts";

const ROOT = resolve(import.meta.dir, "../..");
/** A fresh operator login per run, for this private server only. */
const PASSWORD = randomBytes(18).toString("base64url");
const SALT = randomBytes(16).toString("hex");
const PLAN_RE = /PERF-PLAN:([A-Za-z0-9_-]+)/;
const sleep = (ms: number) => Bun.sleep(ms);
const now = () => performance.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const { values: flags } = parseArgs({
  options: {
    conversations: { type: "string", default: "50" },
    concurrency: { type: "string", default: "0,1,8,32" },
    duration: { type: "string", default: "20" },
    senders: { type: "string", default: "2" },
    turns: { type: "string", default: "4" },
    long: { type: "string", default: "2" },
    "long-turns": { type: "string", default: "40" },
    artifacts: { type: "string", default: "6" },
    versions: { type: "string", default: "15" },
    worktrees: { type: "string", default: "6" },
    shells: { type: "string", default: "4" },
    sides: { type: "string", default: "4" },
    "cold-start": { type: "boolean", default: false },
    browser: { type: "boolean", default: false },
    "cpu-prof": { type: "boolean", default: false },
    out: { type: "string" },
    data: { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (flags.help) {
  console.log(toolHelp(import.meta.url));
  process.exit(0);
}
const count = (name: keyof typeof flags) => {
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`--${name} must be a non-negative integer`);
  return value;
};
const opts = {
  conversations: Math.max(1, count("conversations")),
  concurrency: String(flags.concurrency)
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0),
  duration: count("duration"),
  senders: count("senders"),
  turns: count("turns"),
  long: count("long"),
  longTurns: count("long-turns"),
  artifacts: count("artifacts"),
  versions: Math.max(1, count("versions")),
  worktrees: count("worktrees"),
  shells: count("shells"),
  sides: count("sides"),
};

/** Deterministic choices, so runs at one scale seed the same shape. */
let seed = 0x2545f491;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
};
const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;

function log(text: string): void {
  console.log(`[perf ${new Date().toISOString().slice(11, 19)}] ${text}`);
}

async function run(cmd: string[], cwd: string, env?: Record<string, string>) {
  const child = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${cmd.slice(0, 3).join(" ")} exited ${code}: ${err}`);
  return out;
}

/** Bounded parallel map. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index]!, index);
      }
    }),
  );
}

class Samples {
  readonly ms: number[] = [];
  readonly errors = new Map<string, number>();
  bytes = 0;
  sample = "";
  add(ms: number, error?: string, bytes = 0) {
    this.ms.push(ms);
    this.bytes += bytes;
    if (error) this.errors.set(error, (this.errors.get(error) ?? 0) + 1);
  }
  summary() {
    const sorted = [...this.ms].sort((a, b) => a - b);
    const at = (ratio: number) =>
      sorted.length
        ? Math.round(
            sorted[
              Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)
            ]!,
          )
        : null;
    return {
      count: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: sorted.length ? Math.round(sorted.at(-1)!) : null,
      mean_kb: sorted.length
        ? Math.round(this.bytes / sorted.length / 102.4) / 10
        : 0,
      errors: Object.fromEntries(this.errors),
      sample: this.sample,
    };
  }
}

class Phase {
  readonly routes = new Map<string, Samples>();
  readonly started = Date.now();
  constructor(readonly name: string) {}
  record(route: string, ms: number, error?: string, bytes = 0) {
    let samples = this.routes.get(route);
    if (!samples) this.routes.set(route, (samples = new Samples()));
    samples.add(ms, error, bytes);
  }
}

let phase = new Phase("setup");
const phases: Json[] = [];

interface Plan {
  id: string;
  calls: { name: string; arguments: Record<string, unknown> }[];
  reply: number;
  chunks: number;
  delayMs: number;
}
const replied = new Map<string, () => void>();
const firstRequest = new Map<string, () => void>();
const providerStats = { requests: 0, review: 0, other: 0 };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  return "";
}

function markdown(bytes: number, salt: string): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const block =
      i % 4 === 0
        ? `## Section ${i} (${salt})\n\nThe change keeps **each module** to one job; see \`src/module_${i}.ts\` for the [details](#section-${i}).\n`
        : i % 4 === 1
          ? `- item one for ${salt}\n- item two with \`code\`\n- item three, a longer note about latency and caching\n`
          : i % 4 === 2
            ? '```ts\nexport function handler(input: string): number {\n  return input.split(",").length;\n}\n```\n'
            : `| route | p50 | p95 |\n| --- | --- | --- |\n| /api/tree | ${i} | ${i * 3} |\n| /view | ${i + 1} | ${i * 4} |\n`;
    parts.push(block);
    size += block.length + 1;
  }
  return parts.join("\n");
}

const encoder = new TextEncoder();
const chunk = (delta: object, finish: string | null = null) => ({
  id: "perf",
  object: "chat.completion.chunk",
  created: 0,
  model: "scripted",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function streamed(parts: object[], delayMs: number, done?: () => void) {
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for (const part of parts) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(part)}\n\n`),
            );
            if (delayMs) await sleep(delayMs);
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id: "perf", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })}\n\ndata: [DONE]\n\n`,
            ),
          );
          controller.close();
        } catch {}
        done?.();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function answer(
  text: string,
  stream: boolean,
  chunks = 1,
  delayMs = 0,
  done?: () => void,
) {
  if (!stream) {
    done?.();
    return Response.json({
      id: "perf",
      object: "chat.completion",
      created: 0,
      model: "scripted",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
      },
    });
  }
  const size = Math.ceil(text.length / Math.max(1, chunks));
  const parts: object[] = [{ ...chunk({ role: "assistant", content: "" }) }];
  for (let at = 0; at < text.length; at += size)
    parts.push(chunk({ content: text.slice(at, at + size) }));
  parts.push(chunk({}, "stop"));
  return streamed(parts, delayMs, done);
}

function startProvider() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const body = (await request.json()) as Json;
      providerStats.requests++;
      const messages: Json[] = body.messages ?? [];
      const stream = body.stream !== false;
      const system = messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => textOf(m.content))
        .join("\n");
      if (system.includes("You are pi-safety")) {
        providerStats.review++;
        return answer("OK", stream);
      }
      let last = -1;
      messages.forEach((m, i) => {
        if (m.role === "user" && PLAN_RE.test(textOf(m.content))) last = i;
      });
      const after = messages.slice(last + 1);
      const finished = after.some(
        (m) =>
          m.role === "assistant" && !m.tool_calls?.length && textOf(m.content),
      );
      if (last < 0 || finished || !body.tools?.length) {
        providerStats.other++;
        return answer("Perf conversation", stream);
      }
      const plan = JSON.parse(
        Buffer.from(
          PLAN_RE.exec(textOf(messages[last].content))![1]!,
          "base64url",
        ).toString(),
      ) as Plan;
      const step = after.filter(
        (m) => m.role === "assistant" && m.tool_calls?.length,
      ).length;
      if (step === 0) firstRequest.get(plan.id)?.();
      const call = plan.calls[step];
      if (call)
        return streamed(
          [
            chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${plan.id}_${step}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ],
            }),
            chunk({}, "tool_calls"),
          ],
          0,
        );
      return answer(
        markdown(plan.reply, plan.id),
        stream,
        plan.chunks,
        plan.delayMs,
        () => replied.get(plan.id)?.(),
      );
    },
  });
}

let planCounter = 0;
function planMessage(
  calls: Plan["calls"],
  reply = 3000,
  chunks = 12,
  delayMs = 15,
): { id: string; content: string } {
  const id = `p${++planCounter}x${Math.floor(random() * 1e6)}`;
  const plan: Plan = { id, calls, reply, chunks, delayMs };
  return {
    id,
    content: `Perf load turn ${id}: please run the planned tools and summarize.\nPERF-PLAN:${Buffer.from(JSON.stringify(plan)).toString("base64url")}`,
  };
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  name: "bash",
  arguments: { command, ...extra },
});
const seedCalls = () => [
  bash("seq 1 600 | paste -sd' ' | fold -w 120"),
  bash("ls -la /usr/lib | head -150"),
  bash("git log --oneline | head -20; git status --short | head -40"),
  bash("find src -name '*.ts' | head -80 | xargs wc -l | tail -40"),
];

interface Paths {
  root: string;
  data: string;
  out: string;
}

/** Agents' tools reach the server at the PORT it publishes, fixed up front. */
function freePort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port!;
  void probe.stop(true);
  return port;
}

function serverEnv(paths: Paths, port: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "TERM", "USER", "TZ"])
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  const hash = pbkdf2Sync(
    PASSWORD,
    new Uint8Array(Buffer.from(SALT, "hex")),
    600_000,
    32,
    "sha256",
  ).toString("hex");
  return Object.assign(env, {
    HOME: join(paths.root, "home"),
    CHAT_DATA_DIR: paths.data,
    CHAT_REPO_URL: join(paths.root, "repo"),
    RECURSE_HOME: join(paths.root, "settings"),
    PI_CODING_AGENT_DIR: join(paths.root, "settings", "pi-agent"),
    RECURSE_TEMP_ROOT: join(paths.root, "scratch"),
    PI_BG_SHELL_STATE_DIR: join(paths.root, "pi-bg"),
    RECURSE_FRONTEND_LIVE: "0",
    PORT: String(port),
    RECURSE_PERF_KEY: "loopback-only",
    CHAT_AUTH_SALT: SALT,
    CHAT_AUTH_HASH: hash,
    GIT_AUTHOR_NAME: "Perf",
    GIT_AUTHOR_EMAIL: "perf@example.invalid",
    GIT_COMMITTER_NAME: "Perf",
    GIT_COMMITTER_EMAIL: "perf@example.invalid",
  });
}

/** Local target repository (a clone of a local origin) and its setup clone. */
async function prepare(paths: Paths, providerPort: number, fresh: boolean) {
  for (const dir of ["home", "settings/pi-agent", "scratch", "pi-bg", "wt"])
    await mkdir(join(paths.root, dir), { recursive: true, mode: 0o700 });
  await mkdir(join(paths.data, "config"), { recursive: true });
  const level = { model: "perf/scripted", reasoning: "low" };
  await writeFile(
    join(paths.data, "config", "effort-levels.json"),
    JSON.stringify({
      default_level: 3,
      levels: { 1: level, 2: level, 3: level, 4: level, 5: level },
      version: 1,
    }),
  );
  await writeFile(
    join(paths.data, "config", "model-providers.json"),
    JSON.stringify({
      default: "perf/scripted",
      providers: {
        perf: {
          base_url: `http://127.0.0.1:${providerPort}/v1`,
          env_key: "RECURSE_PERF_KEY",
          wire_api: "completions",
          models: [{ id: "scripted", context_window: 1_000_000 }],
        },
      },
    }),
  );
  if (!fresh) return;
  const source = join(paths.root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  for (let i = 0; i < 300; i++)
    await writeFile(
      join(source, "src", `module_${i}.ts`),
      Array.from(
        { length: 120 },
        (_, line) =>
          `export const value_${line} = ${i * line}; // value ${line}`,
      ).join("\n") + "\n",
    );
  await writeFile(join(source, "README.md"), markdown(6000, "readme"));
  const env = serverEnv(paths, 0);
  await run(["git", "init", "-q", "-b", "main"], source, env);
  await run(["git", "add", "-A"], source, env);
  await run(["git", "commit", "-qm", "initial"], source, env);
  for (let i = 0; i < 30; i++) {
    await writeFile(
      join(source, "src", `module_${i}.ts`),
      `export const changed = ${i};\n`,
      { flag: "a" },
    );
    await run(["git", "commit", "-qam", `change ${i}`], source, env);
  }
  await run(
    ["git", "clone", "-q", "--bare", source, join(paths.root, "origin.git")],
    paths.root,
    env,
  );
  for (const clone of [join(paths.root, "repo"), join(paths.data, "repo")])
    await run(
      ["git", "clone", "-q", join(paths.root, "origin.git"), clone],
      paths.root,
      env,
    );
}

interface Server {
  proc: { pid: number; exited: Promise<number>; exitCode: number | null };
  base: string;
  cookie: string;
  started: number;
  listeningMs: number;
}

async function startServer(
  paths: Paths,
  env: Record<string, string>,
  label: string,
): Promise<Server> {
  const logFile = join(paths.out, `server-${label}.log`);
  const profiles = join(paths.out, "profiles");
  const prof = flags["cpu-prof"]
    ? [
        "--cpu-prof",
        "--cpu-prof-md",
        `--cpu-prof-dir=${profiles}`,
        `--cpu-prof-name=${label}`,
      ]
    : [];
  await writeFile(logFile, "");
  const started = now();
  const proc = Bun.spawn(
    [
      process.execPath,
      ...prof,
      join(ROOT, "src", "server.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      env.PORT!,
    ],
    {
      cwd: ROOT,
      env,
      stdout: Bun.file(logFile),
      stderr: Bun.file(logFile),
      detached: true,
    },
  );
  let base = "";
  while (!base) {
    if (now() - started > 120_000 || proc.exitCode !== null)
      throw new Error(`server did not listen; see ${logFile}`);
    base =
      (await readFile(logFile, "utf8").catch(() => "")).match(
        /listening on (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1] ?? "";
    if (!base) await sleep(20);
  }
  const listeningMs = now() - started;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(PASSWORD)}`,
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (login.status !== 303 || !cookie)
    throw new Error(`login failed: ${login.status}`);
  return { proc, base, cookie, started, listeningMs };
}

async function stopServer(server: Server): Promise<number> {
  const started = now();
  try {
    process.kill(server.proc.pid, "SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(-server.proc.pid, "SIGKILL");
    } catch {}
  }, 60_000);
  await server.proc.exited;
  clearTimeout(timer);
  return now() - started;
}

/** Kill every process group (shells, Pi workers) in our data directory. */
async function killDataDirGroups(data: string): Promise<number> {
  const needle = `CHAT_DATA_DIR=${data}\0`;
  const groups = new Set<number>();
  const pgidOf = (stat: string) =>
    Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  const own = pgidOf(await readFile("/proc/self/stat", "utf8"));
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (!(await readFile(`/proc/${name}/environ`, "latin1")).includes(needle))
        continue;
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      groups.add(pgidOf(stat));
    } catch {}
  }
  groups.delete(own);
  for (const group of groups)
    try {
      process.kill(-group, "SIGKILL");
    } catch {}
  return groups.size;
}

let server: Server;

/** One timed request; with `etags`, it revalidates like a browser (304s). */
async function call(
  route: string,
  path: string,
  init: RequestInit = {},
  etags?: Map<string, string>,
): Promise<{ status: number; text: string; ms: number; json: () => Json }> {
  const started = now();
  let status = 0;
  let text = "";
  let error: string | undefined;
  const held = etags?.get(path);
  try {
    const response = await fetch(`${server.base}${path}`, {
      ...init,
      headers: {
        cookie: server.cookie,
        "content-type": "application/json",
        ...(held ? { "if-none-match": held } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(120_000),
    });
    status = response.status;
    text = await response.text();
    const etag = response.headers.get("etag");
    if (etags && etag) etags.set(path, etag);
    if (status >= 400) error = String(status);
  } catch (caught) {
    error = (caught as Error).name === "TimeoutError" ? "timeout" : "network";
  }
  const ms = now() - started;
  phase.record(route, ms, error, text.length);
  const samples = phase.routes.get(route)!;
  if (!samples.sample) samples.sample = text.slice(0, 160);
  return { status, text, ms, json: () => JSON.parse(text) };
}

const post = (route: string, path: string, body: unknown) =>
  call(route, path, { method: "POST", body: JSON.stringify(body) });

async function within(promise: Promise<void>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${what}`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  ms: number,
  what: string,
  intervalMs = 250,
): Promise<T> {
  const deadline = now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Send one planned turn and wait until the conversation is idle again. */
async function turn(
  cid: string,
  message: { id: string; content: string },
  route = "deliver",
) {
  const timing: Record<string, number> = {};
  const started = now();
  const first = new Promise<void>((done) => firstRequest.set(message.id, done));
  const finished = new Promise<void>((done) => replied.set(message.id, done));
  const sent = await post(route, `/api/conversations/${cid}/deliver`, {
    content: message.content,
  });
  if (sent.status !== 200)
    throw new Error(
      `deliver ${cid}: ${sent.status} ${sent.text.slice(0, 200)}`,
    );
  timing.ack = sent.ms;
  await within(first, 120_000, `turn ${message.id} to start`);
  timing.start = now() - started;
  await within(finished, 300_000, `turn ${message.id} to reply`);
  timing.replied = now() - started;
  await until(
    async () => {
      const conv = (
        await call("conversation(poll)", `/api/conversations/${cid}`)
      ).json();
      return conv.status === "idle" && !conv.active_run;
    },
    300_000,
    `turn ${message.id} to finish`,
    50,
  );
  timing.idle = now() - started;
  firstRequest.delete(message.id);
  replied.delete(message.id);
  return timing;
}

interface World {
  ids: string[];
  long: string[];
  worktrees: string[];
  shells: string[];
  sides: string[];
  artifacts: { id: string; owner: string }[];
  seedMs: Record<string, number>;
}

async function seedWorld(
  paths: Paths,
  env: Record<string, string>,
): Promise<World> {
  const world: World = {
    ids: [],
    long: [],
    worktrees: [],
    shells: [],
    sides: [],
    artifacts: [],
    seedMs: {},
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    const started = now();
    await fn();
    world.seedMs[name] = Math.round(now() - started);
    log(`seeded ${name} in ${(world.seedMs[name]! / 1000).toFixed(1)}s`);
  };
  const tops = Math.max(1, Math.ceil(opts.conversations / 5));
  const create = async (parent: string | null) => {
    const created = await post(
      "create",
      "/api/conversations",
      parent ? { parent } : {},
    );
    if (created.status !== 200)
      throw new Error(
        `create: ${created.status} ${created.text.slice(0, 200)}`,
      );
    return String(created.json().id);
  };
  await step("tree", async () => {
    await pool(Array.from({ length: tops }), 8, async () => {
      world.ids.push(await create(null));
    });
    const children = Array.from({ length: opts.conversations - tops }, () =>
      pick(world.ids),
    );
    await pool(children, 8, async (parent) => {
      world.ids.push(await create(parent));
    });
  });
  world.long = world.ids.slice(0, opts.long);
  world.shells = opts.shells ? world.ids.slice(-opts.shells) : [];
  await step("turns", () =>
    pool(world.ids, 16, async (cid) => {
      for (let i = 0; i < opts.turns; i++)
        await turn(cid, planMessage(seedCalls()));
    }),
  );
  await step("long", () =>
    pool(world.long, 4, async (cid) => {
      for (let i = 0; i < opts.longTurns; i++)
        await turn(cid, planMessage(seedCalls(), 6000));
    }),
  );
  await step("worktrees", async () => {
    const parents = world.ids.slice(opts.long, opts.long + opts.worktrees);
    await pool(parents, 8, async (cid, index) => {
      const name = `perf-wt-${index}`;
      await turn(
        cid,
        planMessage([
          bash(
            `bun $RECURSE_SRC/tools/subagent.ts create --worktree ${name} --title "Perf worktree ${index}" "Work in this worktree."`,
          ),
          bash(
            `cd ${join(paths.data, "worktrees", name)} && for f in $(ls src | head -60); do sed -i 's/value/changed value/g' src/$f; done; mkdir -p added; for i in $(seq 1 30); do seq 1 400 > added/file_$i.txt; done; git rm -q src/module_299.ts`,
          ),
        ]),
      );
    });
    const known = new Set(world.ids);
    const tree: Json[] = (await call("tree", "/api/tree")).json();
    for (const node of tree.filter((node) => !known.has(node.id))) {
      const conv = (
        await call("conversation", `/api/conversations/${node.id}`)
      ).json();
      if (/\/worktrees\/perf-wt-\d+$/.test(conv.workdir ?? ""))
        world.worktrees.push(String(node.id));
    }
    world.ids.push(...world.worktrees);
  });
  await step("shells", () =>
    pool(world.shells, 8, async (cid) => {
      const shell = bash("while sleep 2; do date; done", {
        background: true,
        inactivityReminderSeconds: 0,
      });
      await turn(cid, planMessage([shell, shell, shell, shell]));
    }),
  );
  await step("sides", () =>
    pool(
      Array.from(
        { length: opts.sides },
        (_, i) => world.ids[i % world.ids.length]!,
      ),
      4,
      async (parent) => {
        const message = planMessage(seedCalls());
        const finished = new Promise<void>((done) =>
          replied.set(message.id, done),
        );
        const side = await post("side", `/api/conversations/${parent}/side`, {
          question: message.content,
        });
        if (side.status !== 200 && side.status !== 201)
          throw new Error(`side: ${side.status} ${side.text.slice(0, 200)}`);
        const cid = String(side.json().id);
        world.sides.push(cid);
        await within(finished, 300_000, `side ${cid} to reply`);
      },
    ),
  );
  await step("artifacts", () =>
    pool(
      Array.from(
        { length: opts.artifacts },
        (_, i) => world.ids[i % world.ids.length]!,
      ),
      4,
      async (owner) => {
        world.artifacts.push(
          await seedArtifact(paths, env, owner, world.artifacts.length),
        );
      },
    ),
  );
  await writeFile(join(paths.root, "world.json"), JSON.stringify(world));
  return world;
}

/** Seed a document through the Artifact module, then publish Git commits. */
async function seedArtifact(
  paths: Paths,
  env: Record<string, string>,
  owner: string,
  index: number,
) {
  const agentEnv = { ...env, RECURSE_AGENT_ID: owner };
  const context = {
    artifactsDir: join(paths.data, "artifact_repos"),
    trashDir: join(paths.data, "trash"),
  };
  const file = join(paths.root, "scratch", `artifact-${index}.md`);
  await writeFile(
    file,
    `# Perf report ${index}\n\n${markdown(4000, `artifact${index}`)}`,
  );
  const created = await artifacts.create(context, {
    owner,
    title: `Perf report ${index}`,
    source: file,
  });
  const workspace = String(created.repo_path ?? "");
  if (!workspace)
    throw new Error(
      `artifact create gave no workspace: ${JSON.stringify(created)}`,
    );
  for (let version = 1; version < opts.versions; version++) {
    await writeFile(
      join(workspace, "index.md"),
      `\n## Revision ${version}\n\n${markdown(800, `v${version}`)}`,
      { flag: "a" },
    );
    await run(
      ["git", "commit", "-qam", `revision ${version}`],
      workspace,
      agentEnv,
    );
  }
  return { id: String(created.id), owner };
}

const settingsRoutes = [
  "/api/settings/effort-levels",
  "/api/settings/theme",
  "/api/settings/model-list",
  "/api/models",
  "/api/backends",
  "/api/settings/mcp-servers",
  "/api/version",
];

async function tab(world: World, stopAt: number): Promise<void> {
  const etags = new Map<string, string>();
  let focused = pick(world.ids);
  let cursor: string | null = null;
  const events = async () => {
    while (now() < stopAt) {
      const target = focused;
      const response = await call(
        "events",
        `/api/conversations/${target}/events`,
        {
          headers: cursor ? { "last-event-id": cursor } : {},
        },
      );
      if (target === focused)
        cursor = /^id: (.*)$/m.exec(response.text)?.[1] ?? null;
      const retry = Number(/^retry: (\d+)/m.exec(response.text)?.[1] ?? 3000);
      await sleep(Math.min(retry, Math.max(0, stopAt - now())));
    }
  };
  const stream = events();
  let nextSwitch = now() + 2000 + random() * 6000;
  while (now() < stopAt) {
    const started = now();
    await Promise.all([
      call("tree", "/api/tree", {}, etags),
      call(
        "conversation",
        `/api/conversations/${focused}?focused=1`,
        {},
        etags,
      ),
    ]);
    if (now() >= nextSwitch) {
      const roll = random();
      const pool =
        roll < 0.15 && world.long.length
          ? world.long
          : roll < 0.3 && world.worktrees.length
            ? world.worktrees
            : roll < 0.4 && world.sides.length
              ? world.sides
              : world.ids;
      focused = pick(pool);
      cursor = null;
      const switchStarted = now();
      await Promise.all([
        call(
          "conversation",
          `/api/conversations/${focused}?focused=1`,
          {},
          etags,
        ),
        call("events", `/api/conversations/${focused}/events`),
      ]);
      phase.record("switch", now() - switchStarted);
      const extra = random();
      if (extra < 0.3)
        await call("diff", `/api/conversations/${focused}/diff`, {}, etags);
      else if (extra < 0.5 && world.artifacts.length) {
        const artifact = pick(world.artifacts);
        const agent = encodeURIComponent(artifact.owner);
        await call("artifacts", `/api/artifacts?agent=${agent}`, {}, etags);
        await call(
          "artifacts/revision",
          `/api/artifacts/revision?agent=${agent}`,
          {},
          etags,
        );
        await call(
          "artifact/versions",
          `/api/artifacts/${artifact.id}/versions?agent=${agent}`,
          {},
          etags,
        );
        await call(
          "artifact/file",
          `/api/artifacts/${artifact.id}/file?agent=${agent}&path=index.md`,
          {},
          etags,
        );
      } else if (extra < 0.6)
        await Promise.all(
          settingsRoutes.map((path) =>
            call(`settings ${path}`, path, {}, etags),
          ),
        );
      else if (extra < 0.7) {
        const scrolled = pick(world.long.length ? world.long : world.ids);
        const latest = await call(
          "view",
          `/api/conversations/${scrolled}/view?limit=100`,
        );
        const page = latest.status === 200 ? latest.json() : {};
        const oldest = page.older && page.blocks?.[0]?.id;
        if (typeof oldest === "string")
          await call(
            "view(older)",
            `/api/conversations/${scrolled}/view?limit=100&before=${encodeURIComponent(oldest)}`,
          );
      }
      nextSwitch = now() + 3000 + random() * 7000;
    }
    await sleep(
      Math.max(0, Math.min(1500 - (now() - started), stopAt - now())),
    );
  }
  await stream;
}

async function sender(
  world: World,
  stopAt: number,
  busy: Set<string>,
): Promise<void> {
  while (now() < stopAt) {
    const free = world.ids.filter(
      (cid) => !busy.has(cid) && !world.shells.includes(cid),
    );
    if (!free.length) return;
    const cid = pick(free);
    busy.add(cid);
    try {
      const timing = await turn(
        cid,
        planMessage(
          [bash("seq 1 300 | paste -sd' '"), bash("ls /usr/bin | head -80")],
          4000,
          40,
          25,
        ),
      );
      for (const [name, ms] of Object.entries(timing))
        phase.record(`turn:${name}`, ms);
      phase.record("turn:finalize", timing.idle! - timing.replied!);
    } catch (error) {
      phase.record("turn:idle", 0, (error as Error).message.slice(0, 60));
    } finally {
      busy.delete(cid);
    }
  }
}

interface Usage {
  cpu: number[];
  mainCpu: number[];
  rssMb: number[];
  threads: number[];
}

/** Server CPU (process and main thread), RSS and threads from /proc. */
function sampleServer(stopAt: number): Promise<Usage> {
  const pid = server.proc.pid;
  const ticks = async (path: string) => {
    const stat = await readFile(path, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[11]) + Number(fields[12]);
  };
  const both = () =>
    Promise.all([
      ticks(`/proc/${pid}/stat`),
      ticks(`/proc/${pid}/task/${pid}/stat`),
    ]);
  return (async () => {
    const usage: Usage = { cpu: [], mainCpu: [], rssMb: [], threads: [] };
    let last = await both().catch(() => [0, 0]);
    let lastAt = now();
    while (now() < stopAt) {
      await sleep(1000);
      try {
        const current = await both();
        const seconds = (now() - lastAt) / 1000;
        usage.cpu.push(Math.round((current[0]! - last[0]!) / seconds));
        usage.mainCpu.push(Math.round((current[1]! - last[1]!) / seconds));
        last = current;
        lastAt = now();
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        usage.rssMb.push(
          Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024),
        );
        usage.threads.push(Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? 0));
      } catch {}
    }
    return usage;
  })();
}

/** Server log records between two times: stalls, lag, warnings, timing. */
async function serverLog(paths: Paths, from: number, to: number) {
  const dir = join(paths.data, "logs");
  const names = (await readdir(dir).catch(() => [] as string[])).filter(
    (name) => name.startsWith("recurse.log"),
  );
  const lines: string[] = [];
  for (const name of names)
    lines.push(...(await readFile(join(dir, name), "utf8")).split("\n"));
  const events = new Map<string, number>();
  const stalls: string[] = [];
  const lag: string[] = [];
  const timing: string[] = [];
  const warnings: string[] = [];
  const ui: string[] = [];
  for (const line of lines) {
    const stamp = Date.parse(line.slice(0, 20));
    if (!Number.isFinite(stamp) || stamp < from - 1000 || stamp > to + 1000)
      continue;
    const event = / event=(\S+)/.exec(line)?.[1] ?? "?";
    events.set(event, (events.get(event) ?? 0) + 1);
    if (event === "ui_timing") ui.push(line);
    else if (event === "event_loop_stall") stalls.push(line);
    else if (event === "event_loop_lag") lag.push(line);
    else if (/level=(WARNING|ERROR)/.test(line)) warnings.push(line);
    else if (/_ms[=:]|duration|slow/.test(line) && event !== "http_summary")
      timing.push(line);
  }
  const stallMs = stalls.map((line) =>
    Number(/\bms=(\d+)/.exec(line)?.[1] ?? 0),
  );
  return {
    events: Object.fromEntries([...events].sort((a, b) => b[1] - a[1])),
    stalls: stalls.length,
    stall_total_ms: stallMs.reduce((a, b) => a + b, 0),
    stall_max_ms: Math.max(0, ...stallMs),
    worst_stalls: stalls
      .sort(
        (a, b) =>
          Number(/\bms=(\d+)/.exec(b)?.[1] ?? 0) -
          Number(/\bms=(\d+)/.exec(a)?.[1] ?? 0),
      )
      .slice(0, 5),
    lag: lag.slice(-3),
    warnings: warnings.slice(0, 10),
    timing: timing.slice(0, 30),
    ui,
  };
}

async function loadPhase(
  paths: Paths,
  world: World,
  users: number,
): Promise<void> {
  const senders = users ? opts.senders : 0;
  phase = new Phase(users ? `users=${users}` : "idle");
  log(`phase ${phase.name}: ${opts.duration}s, ${senders} senders`);
  const stopAt = now() + opts.duration * 1000;
  const sampler = sampleServer(stopAt);
  const busy = new Set<string>();
  await Promise.all([
    ...Array.from({ length: users }, () => tab(world, stopAt)),
    ...Array.from({ length: senders }, () => sender(world, stopAt, busy)),
  ]);
  const usage = await sampler;
  phases.push({
    ...summarize(phase),
    server: summarizeUsage(usage),
    log: await serverLog(paths, phase.started, Date.now()),
  });
}

function summarizeUsage(usage: Usage) {
  const mean = (items: number[]) =>
    items.length
      ? Math.round(items.reduce((a, b) => a + b, 0) / items.length)
      : null;
  const max = (items: number[]) => (items.length ? Math.max(...items) : null);
  return {
    cpu_mean_pct: mean(usage.cpu),
    cpu_max_pct: max(usage.cpu),
    main_thread_cpu_mean_pct: mean(usage.mainCpu),
    main_thread_cpu_max_pct: max(usage.mainCpu),
    rss_max_mb: max(usage.rssMb),
    threads_max: max(usage.threads),
  };
}

function summarize(current: Phase) {
  const seconds = (Date.now() - current.started) / 1000;
  const routes: Record<string, Json> = {};
  let total = 0;
  for (const [route, samples] of [...current.routes].sort()) {
    routes[route] = samples.summary();
    total += samples.ms.length;
  }
  return {
    name: current.name,
    seconds: Math.round(seconds),
    requests: total,
    rps: Math.round(total / seconds),
    routes,
  };
}

async function coldStart(
  paths: Paths,
  env: Record<string, string>,
  world: World,
) {
  log("cold start: stopping the server");
  const stopMs = await stopServer(server);
  phase = new Phase("cold-start");
  const spawned = Date.now();
  server = await startServer(paths, env, "cold");
  const t0 = server.started;
  const focused = world.long[0] ?? world.ids[0]!;
  const artifact = world.artifacts[0];
  const ready: Record<string, number> = {
    listening: Math.round(server.listeningMs),
  };
  const mark = (name: string) => (ready[name] = Math.round(now() - t0));
  const watch = (name: string, check: () => Promise<boolean>) =>
    until(check, 300_000, name).then(() => mark(name));
  await Promise.all([
    watch(
      "status_ready",
      async () => (await call("status", "/api/status")).json().ready === true,
    ),
    watch("tree", async () => {
      const tree = await call("tree", "/api/tree");
      return tree.status === 200 && tree.json().length >= world.ids.length;
    }),
    watch("focused_conversation", async () => {
      const [conv, events] = await Promise.all([
        call("conversation", `/api/conversations/${focused}?focused=1`),
        call("events", `/api/conversations/${focused}/events`),
      ]);
      return conv.status === 200 && events.status === 200;
    }),
    artifact
      ? watch("artifacts", async () => {
          const list = await call(
            "artifacts",
            `/api/artifacts?agent=${encodeURIComponent(artifact.owner)}`,
          );
          return list.status === 200 && list.text.includes(artifact.id);
        })
      : Promise.resolve(),
    world.worktrees[0]
      ? watch(
          "diff",
          async () =>
            (
              await call(
                "diff",
                `/api/conversations/${world.worktrees[0]}/diff`,
              )
            ).status === 200,
        )
      : Promise.resolve(),
  ]);
  await sleep(5000);
  const startup = (await readFile(join(paths.out, "server-cold.log"), "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("[startup]"));
  phases.push({
    ...summarize(phase),
    stop_ms: Math.round(stopMs),
    ready_ms: ready,
    startup,
    log: await serverLog(paths, spawned, Date.now()),
  });
}

/** Chromium on the built app: first paint, switches, scroll, long tasks. */
async function browserPhase(paths: Paths, world: World): Promise<void> {
  const { chromium } = await import("playwright");
  phase = new Phase("browser");
  const started = Date.now();
  const browser = await chromium.launch();
  const result: Json = {};
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
    });
    const [name, value] = server.cookie.split("=") as [string, string];
    await context.addCookies([{ name, value, url: server.base }]);
    await context.addInitScript({
      content:
        "const perf = (globalThis.__perf = { longTasks: [] }); new PerformanceObserver((list) => { for (const entry of list.getEntries()) perf.longTasks.push(entry.duration); }).observe({ type: 'longtask', buffered: true });",
    });
    const page = await context.newPage();
    const cdp = flags["cpu-prof"] ? await context.newCDPSession(page) : null;
    await cdp?.send("Profiler.enable");
    await cdp?.send("Profiler.start");
    const turns = () => page.locator("#messages .turn").count();
    const longTasks = async (reset = true) =>
      page.evaluate((reset) => {
        const tasks = (globalThis as Json).__perf.longTasks as number[];
        const out = {
          count: tasks.length,
          total_ms: Math.round(tasks.reduce((a, b) => a + b, 0)),
          max_ms: Math.round(Math.max(0, ...tasks)),
        };
        if (reset) tasks.length = 0;
        return out;
      }, reset);
    const focused = world.long[0] ?? world.ids[0]!;
    let at = now();
    await page.goto(`${server.base}/c/${focused}`);
    await page.locator(".agent[data-id]").first().waitFor({ timeout: 120_000 });
    result.first_tree_ms = Math.round(now() - at);
    await until(async () => (await turns()) > 0, 120_000, "first turn painted");
    result.first_turn_ms = Math.round(now() - at);
    result.paint = await page.evaluate(
      "Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, Math.round(entry.startTime)]))",
    );
    result.load_long_tasks = await longTasks();
    const switches: number[] = [];
    for (let i = 0; i < 12; i++) {
      const visible = await page
        .locator(".agent[data-id]:not(.selected)")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => (node as Json).offsetParent !== null)
            .map((node) => node.getAttribute("data-id")!),
        );
      if (!visible.length) break;
      const target = pick(visible);
      at = now();
      await page.locator(`.agent[data-id="${target}"]`).first().click();
      await page
        .locator(`.agent.selected[data-id="${target}"]`)
        .first()
        .waitFor({ timeout: 60_000 });
      await until(
        async () => (await turns()) > 0,
        60_000,
        "switched turn painted",
      );
      switches.push(now() - at);
      phase.record("browser:switch", now() - at);
    }
    result.switch_long_tasks = await longTasks();
    await page.locator(`.agent[data-id="${focused}"]`).first().click();
    await until(
      async () => (await turns()) > 0,
      60_000,
      "long transcript painted",
    );
    at = now();
    for (let i = 0; i < 15; i++) {
      await page.locator("#scroll").evaluate((node) => (node.scrollTop = 0));
      await sleep(400);
    }
    result.scroll = {
      ms: Math.round(now() - at),
      turns: await turns(),
      long_tasks: await longTasks(),
    };
    result.heap_mb = await page.evaluate(() =>
      Math.round(((performance as Json).memory?.usedJSHeapSize ?? 0) / 1048576),
    );
    if (cdp) {
      const { profile } = await cdp.send("Profiler.stop");
      await mkdir(join(paths.out, "profiles"), { recursive: true });
      await writeFile(
        join(paths.out, "profiles", "browser.cpuprofile"),
        JSON.stringify(profile),
      );
    }
    await sleep(8000);
  } finally {
    await browser.close();
  }
  const timings = new Map<string, Samples>();
  for (const line of (await serverLog(paths, started, Date.now())).ui)
    for (const [, label, ms] of line.matchAll(/label=(\S+) ms=(\d+)/g)) {
      if (!timings.has(label!)) timings.set(label!, new Samples());
      timings.get(label!)!.add(Number(ms));
    }
  result.ui_timing = Object.fromEntries(
    [...timings].map(([label, samples]) => [label, samples.summary()]),
  );
  phases.push({ ...summarize(phase), browser: result });
}

function markdownReport(meta: Json): string {
  const out: string[] = [
    `# Recurse load report`,
    "",
    "```json",
    JSON.stringify(meta, null, 1),
    "```",
    "",
  ];
  for (const item of phases) {
    out.push(`## ${item.name}`, "");
    if (item.ready_ms)
      out.push(
        `Ready after (ms from spawn): ${JSON.stringify(item.ready_ms)}; previous server stopped in ${item.stop_ms} ms`,
        "",
      );
    if (item.server)
      out.push(
        `Server: ${JSON.stringify(item.server)}; ${item.requests} requests, ${item.rps}/s`,
        "",
      );
    out.push(
      "| route | count | p50 | p95 | p99 | max | KB | errors |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const [route, s] of Object.entries(item.routes ?? {}) as [
      string,
      Json,
    ][])
      out.push(
        `| ${route} | ${s.count} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} | ${s.mean_kb} | ${Object.keys(s.errors).length ? JSON.stringify(s.errors) : ""} |`,
      );
    if (item.log) {
      out.push(
        "",
        `Loop stalls: ${item.log.stalls} (total ${item.log.stall_total_ms} ms, max ${item.log.stall_max_ms} ms)`,
      );
      for (const line of [
        ...item.log.worst_stalls,
        ...item.log.lag,
        ...item.log.warnings,
        ...item.log.timing,
      ])
        out.push(`    ${line.slice(0, 600)}`);
    }
    for (const line of item.startup ?? []) out.push(`    ${line}`);
    if (item.browser)
      out.push("", "```json", JSON.stringify(item.browser, null, 1), "```");
    out.push("");
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  const root = flags.data
    ? resolve(flags.data)
    : await mkdtemp(join(tmpdir(), "pl-"));
  const out = resolve(
    flags.out ??
      join(tmpdir(), `perf-${new Date().toISOString().replace(/[:.]/g, "-")}`),
  );
  await mkdir(out, { recursive: true });
  const paths: Paths = { root, data: join(root, "data"), out };
  const fresh = !existsSync(join(root, "world.json"));
  const provider = startProvider();
  const discard = () => {
    if (!flags.keep && !flags.data) retire(root, join(tmpdir(), ".trash"));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void (async () => {
        log(`${signal}: stopping`);
        if (server) await stopServer(server).catch(() => undefined);
        await killDataDirGroups(paths.data);
        discard();
        process.exit(130);
      })();
    });
  let world: World | undefined;
  try {
    await prepare(paths, provider.port!, fresh);
    const env = serverEnv(paths, freePort());
    log(`data ${root}, report ${out}`);
    if (flags.browser) {
      log("building web/dist; the server reads it at startup");
      await run([process.execPath, "run", "build"], ROOT);
    }
    server = await startServer(paths, env, "main");
    await until(
      async () => (await call("status", "/api/status")).json().ready === true,
      300_000,
      "server ready",
    );
    log(`server ${server.base} ready`);
    world = fresh
      ? await seedWorld(paths, env)
      : (JSON.parse(await readFile(join(root, "world.json"), "utf8")) as World);
    phases.push({
      ...summarize(phase),
      seed_ms: world.seedMs,
      log: await serverLog(paths, phase.started, Date.now()),
    });
    for (const users of opts.concurrency) await loadPhase(paths, world, users);
    if (flags["cold-start"]) await coldStart(paths, env, world);
    if (flags.browser) await browserPhase(paths, world);
  } finally {
    if (server) await stopServer(server).catch(() => undefined);
    const killed = await killDataDirGroups(paths.data);
    if (killed) log(`killed ${killed} leftover process groups`);
    provider.stop(true);
    const meta = {
      options: opts,
      flags: { ...flags },
      provider: providerStats,
      data: root,
      world: world && {
        conversations: world.ids.length,
        sides: world.sides.length,
        artifacts: world.artifacts.length,
        worktrees: world.worktrees.length,
        shells: world.shells.length,
      },
    };
    await writeFile(
      join(out, "report.json"),
      JSON.stringify({ meta, phases }, null, 1),
    );
    await writeFile(join(out, "report.md"), markdownReport(meta));
    log(`report: ${join(out, "report.md")}`);
    discard();
  }
}

await main();
process.exit(0);
