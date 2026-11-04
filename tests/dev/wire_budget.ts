#!/usr/bin/env bun
/**
 * Bytes-over-the-wire budget: measures what the web UI downloads on slow,
 * metered links and fails when a case grows past its recorded budget.
 *
 * Starts `bun src/server.ts` through `tests/dev/private_server.ts` (the built
 * app, gzip on, operator login) on a throwaway data directory and an
 * ephemeral loopback port, with a loopback scripted model provider (no real
 * model calls or credentials). It seeds
 * state through the real HTTP API, agent tools, Pi session import and the
 * Artifact store, then drives one Chromium tab and counts every request
 * through CDP Network events: bytes received as transferred (headers
 * included; 0 for memory/disk cache hits), decoded body bytes, estimated bytes
 * sent, request count, 304 and browser-cache hits, repeated downloads of one
 * URL, the largest resources, uncompressed and event-stream bytes, and
 * requests naming conversations other than the one on screen. Event-stream
 * bytes count as they arrive. No timings are asserted.
 *
 * Cases, in order on one tab: cold load with an empty cache, warm reload, a
 * long imported conversation (3,200 Pi entries in 400 tool-using turns, three
 * compactions) scrolled back three times, a conversation with 100 published
 * images (ten large), a 600 KB Markdown Artifact and a 500 KB HTML app each
 * opened from its conversation, closed and reopened (the Markdown one's
 * conversation also links a copy of the app), switching between five
 * conversations twice, an idle tab, a 20 KB reply streamed over about ten
 * seconds after five tool calls, and a turn in another conversation while 60
 * agents are in the tree. Each case first prepares its starting page
 * unmeasured, so `--cases` can run one alone.
 *
 * Budgets live in `tests/dev/wire_budget.json`: received `bytes` and
 * `requests` per case, per minute for the idle tab. A case over budget fails
 * the run. `--update` rewrites the budgets of the cases run from this run's
 * measurements plus 20% headroom (50% for long-conversation and
 * streaming-reply, whose window loads and polls follow timing; at least 8 KB
 * and 8 requests). Commit it with the change that explains the new numbers.
 * Each run prints a table and writes `report.json` (with every request) for
 * trend comparison.
 *
 * Usage: bun run build && bun tests/dev/wire_budget.ts [--cases a,b]
 * [--idle-seconds 15] [--update] [--out DIR] [--keep]
 *
 * --cases     comma-separated case names (default: all)
 * --idle-seconds  how long the idle case watches an unchanged tab
 * --update    write budgets from this run (measured + 20%), never fail
 * --out DIR   report directory (default $TMPDIR/wire-<time>)
 * --keep      keep the data directory and print its path
 *
 * Keep TMPDIR short (for example /tmp/wire): Unix socket paths must stay under
 * 107 bytes. Never point it at a live instance.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import zlib from "node:zlib";
import { chromium, type BrowserContext, type Page } from "playwright";
import { toolHelp } from "../../tools/_help.ts";
import * as artifacts from "../../src/artifacts";
import { retire } from "../../src/utils/trash";
import {
  killDataDirGroups,
  privateEnv,
  scriptedModel,
  startPrivateServer,
  stopPrivateServer,
  type PrivateServer,
} from "./private_server";

const ROOT = resolve(import.meta.dir, "../..");
const BUDGETS = join(import.meta.dir, "wire_budget.json");
/** Per-case budget headroom (default 20%); SLACK covers a few polls. */
const HEADROOM: Record<string, number> = {
  "long-conversation": 1.5,
  "streaming-reply": 1.5,
};
const SLACK = { bytes: 8192, requests: 8 };
const crc32 = (zlib as unknown as { crc32(data: Uint8Array): number }).crc32;
const PLAN_RE = /WIRE-PLAN:([A-Za-z0-9_-]+)/;
const sleep = (ms: number) => Bun.sleep(ms);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const { values: flags } = parseArgs({
  options: {
    cases: { type: "string" },
    "idle-seconds": { type: "string", default: "15" },
    update: { type: "boolean", default: false },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (flags.help) {
  console.log(toolHelp(import.meta.url));
  process.exit(0);
}
const CASES = [
  "cold-load",
  "warm-reload",
  "long-conversation",
  "images",
  "artifact-markdown",
  "artifact-app",
  "switch",
  "idle",
  "streaming-reply",
  "background-turn",
] as const;
const selected: readonly string[] =
  flags.cases === undefined
    ? CASES
    : flags.cases
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
const unknown = selected.filter(
  (name) => !(CASES as readonly string[]).includes(name),
);
if (!selected.length || unknown.length)
  throw new Error(
    `--cases takes names from ${CASES.join(", ")}${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`,
  );
const idleSeconds = Number(flags["idle-seconds"]);
if (!Number.isFinite(idleSeconds) || idleSeconds <= 0)
  throw new Error("--idle-seconds must be a positive number");

function log(text: string): void {
  console.log(`[wire ${new Date().toISOString().slice(11, 19)}] ${text}`);
}

async function run(cmd: string[], cwd: string, env?: Record<string, string>) {
  const child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}: ${err}`);
  return out;
}

async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  what: string,
  ms = 120_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

interface Plan {
  calls: { name: string; arguments: Record<string, unknown> }[];
  reply: string;
  chunks: number;
  delayMs: number;
  promptTokens?: number;
}
const encoder = new TextEncoder();
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? "").join("\n")
      : "";
const chunk = (delta: object, finish: string | null = null) => ({
  id: "wire",
  object: "chat.completion.chunk",
  created: 0,
  model: "scripted",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function streamed(
  parts: object[],
  delayMs: number,
  promptTokens = 1000,
): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const part of parts) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(part)}\n\n`),
          );
          if (delayMs) await sleep(delayMs);
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 100, total_tokens: promptTokens + 100 } })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function reply(
  text: string,
  chunks = 1,
  delayMs = 0,
  promptTokens = 1000,
): Response {
  const size = Math.ceil(text.length / Math.max(1, chunks));
  const parts: object[] = [chunk({ role: "assistant", content: "" })];
  for (let at = 0; at < text.length; at += size)
    parts.push(chunk({ content: text.slice(at, at + size) }));
  parts.push(chunk({}, "stop"));
  return streamed(parts, delayMs, promptTokens);
}

function startProvider() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const body = (await request.json()) as Json;
      const messages: Json[] = body.messages ?? [];
      const system = messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => textOf(m.content))
        .join("\n");
      if (system.includes("You are pi-safety")) return reply("OK");
      const last = messages.findLastIndex(
        (m) => m.role === "user" && PLAN_RE.test(textOf(m.content)),
      );
      if (last < 0 || !body.tools?.length) return reply("Wire conversation");
      const plan = JSON.parse(
        Buffer.from(
          PLAN_RE.exec(textOf(messages[last].content))![1]!,
          "base64url",
        ).toString(),
      ) as Plan;
      const after = messages.slice(last + 1);
      if (after.some((m) => m.role === "assistant" && !m.tool_calls?.length))
        return reply("Done.");
      const step = after.filter((m) => m.role === "assistant").length;
      const call = plan.calls[step];
      if (!call)
        return reply(plan.reply, plan.chunks, plan.delayMs, plan.promptTokens);
      return streamed(
        [
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${step}_${Math.random().toString(36).slice(2)}`,
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
    },
  });
}

const planText = (plan: Partial<Plan>, ask = "Run the plan."): string =>
  `${ask}\nWIRE-PLAN:${Buffer.from(JSON.stringify({ calls: [], reply: "Done.", chunks: 1, delayMs: 0, ...plan })).toString("base64url")}`;

/** Deterministic Markdown of about `bytes` characters. */
function markdown(bytes: number, salt: string): string {
  const parts: string[] = [];
  for (let i = 0, size = 0; size < bytes; i++) {
    const block = [
      `## Section ${i} (${salt})\n\nThe change keeps **each module** to one job; see \`src/module_${i}.ts\` for details.\n`,
      `- item one for ${salt}\n- item two with \`code\`\n- item three, a longer note about latency and caching\n`,
      '```ts\nexport function handler(input: string): number {\n  return input.split(",").length;\n}\n```\n',
      `| route | p50 | p95 |\n| --- | --- | --- |\n| /api/tree | ${i} | ${i * 3} |\n`,
    ][i % 4]!;
    parts.push(block);
    size += block.length + 1;
  }
  return parts.join("\n");
}

/** An RGB PNG of noise (incompressible, like a photo) or a flat colour. */
function png(width: number, height: number, noise: boolean, seed: number) {
  const rows = new Uint8Array((width * 3 + 1) * height);
  let state = seed | 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width * 3; x++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      rows[y * (width * 3 + 1) + 1 + x] = noise
        ? state & 255
        : (seed * 37 + x) & 255;
    }
  const part = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(data.length + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(encoder.encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    part("IHDR", header),
    part("IDAT", new Uint8Array(zlib.deflateSync(rows))),
    part("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

interface Paths {
  root: string;
  data: string;
  out: string;
}

async function prepare(paths: Paths, providerPort: number) {
  for (const dir of ["home", "settings/pi-agent", "scratch", "pi-bg", "repo"])
    await mkdir(join(paths.root, dir), { recursive: true, mode: 0o700 });
  await scriptedModel(paths.data, "wire", providerPort, "RECURSE_WIRE_KEY");
  const repo = join(paths.root, "repo");
  const env = privateEnv(paths.root, paths.data);
  await writeFile(join(repo, "README.md"), "# Wire budget target\n");
  await run(["git", "init", "-q", "-b", "main"], repo, env);
  await run(["git", "add", "-A"], repo, env);
  await run(["git", "commit", "-qm", "initial"], repo, env);
  await run(["git", "clone", "-q", repo, join(paths.data, "repo")], ROOT, env);
}

let server: PrivateServer;

async function api(path: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${server.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: server.cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const createAgent = async (parent: string | null = null): Promise<string> =>
  String((await api("/api/conversations", parent ? { parent } : {})).id);

async function idle(cid: string): Promise<void> {
  await until(async () => {
    const conv = await api(`/api/conversations/${cid}`);
    return conv.status === "idle" && !conv.active_run;
  }, `${cid} to finish its turn`);
}

async function turn(cid: string, plan: Partial<Plan>, ask?: string) {
  await api(`/api/conversations/${cid}/deliver`, {
    content: planText(plan, ask),
  });
  await until(async () => {
    const conv = await api(`/api/conversations/${cid}`);
    return conv.status !== "idle" || conv.active_run;
  }, `${cid} to start`).catch(() => undefined);
  await idle(cid);
}

/** A Pi v3 session: `turns` tool-using turns with compactions along the way. */
function piSession(turns: number, compactions: number, cwd: string): string {
  const lines: Json[] = [
    {
      type: "session",
      version: 3,
      id: "wire-long",
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd,
    },
  ];
  let parent: string | null = null;
  const push = (entry: Json) => {
    lines.push({ ...entry, parentId: parent, timestamp: lines.length });
    parent = entry.id;
  };
  const every = Math.floor(turns / (compactions + 1));
  for (let t = 0; t < turns; t++) {
    const first = `u${t}`;
    push({
      type: "message",
      id: first,
      message: {
        role: "user",
        content: `Turn ${t}: check module ${t} and report.`,
      },
    });
    for (let c = 0; c < 3; c++) {
      const call = `call-${t}-${c}`;
      push({
        type: "message",
        id: `a${t}-${c}`,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: call,
              name: "bash",
              arguments: { command: `rg -n handler src/module_${t}_${c}.ts` },
            },
          ],
          stopReason: "toolUse",
        },
      });
      push({
        type: "message",
        id: `r${t}-${c}`,
        message: {
          role: "toolResult",
          toolCallId: call,
          toolName: "bash",
          content: [
            {
              type: "text",
              text: Array.from(
                { length: 30 },
                (_, line) =>
                  `src/module_${t}_${c}.ts:${line}: export const value_${line} = ${t * line};`,
              ).join("\n"),
            },
          ],
        },
      });
    }
    push({
      type: "message",
      id: `z${t}`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: markdown(1200, `turn${t}`) }],
        stopReason: "stop",
      },
    });
    if (t > 0 && t % every === 0 && t / every <= compactions)
      push({
        type: "compaction",
        id: `compact${t}`,
        summary: `Summary through turn ${t}.\n\n${markdown(1500, `summary${t}`)}`,
        firstKeptEntryId: first,
        tokensBefore: 150_000,
      });
  }
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

interface World {
  root: string;
  long: string;
  gallery: string;
  stream: string;
  background: string;
  peers: string[];
  markdownArtifact: string;
  appArtifact: string;
}

async function seed(paths: Paths): Promise<World> {
  const started = Date.now();
  const root = await createAgent();
  await turn(root, { reply: `# Welcome\n\n${markdown(3000, "root")}` });
  const peers: string[] = [];
  for (let i = 0; i < 5; i++) {
    const cid = await createAgent(i % 2 ? root : null);
    peers.push(cid);
  }
  await Promise.all(
    peers.map((cid, i) =>
      turn(cid, {
        calls: [{ name: "bash", arguments: { command: `seq 1 ${40 * i}` } }],
        reply: markdown(4000, `peer${i}`),
      }),
    ),
  );
  for (let i = 0; i < 50; i++)
    await createAgent(i % 3 ? peers[i % peers.length]! : root);
  log(`seeded tree in ${Date.now() - started} ms`);

  const sessionFile = join(paths.root, "scratch", "long.jsonl");
  await writeFile(sessionFile, piSession(400, 3, join(paths.root, "repo")));
  const long = String(
    (
      await api("/api/agent-archive/revive", {
        from: sessionFile,
        parent: null,
      })
    ).id,
  );
  log(`seeded long conversation ${long} in ${Date.now() - started} ms`);

  const gallery = await createAgent(root);
  const images = join(paths.root, "scratch", "images");
  await mkdir(images, { recursive: true });
  const paths100: string[] = [];
  for (let i = 0; i < 100; i++) {
    const large = i % 10 === 9;
    const path = join(images, `shot-${String(i).padStart(3, "0")}.png`);
    await writeFile(
      path,
      large ? png(1600, 1000, true, i + 1) : png(400, 250, false, i + 1),
    );
    paths100.push(path);
  }
  await turn(gallery, {
    calls: [
      { name: "publish", arguments: { paths: paths100.slice(0, 50) } },
      { name: "publish", arguments: { paths: paths100.slice(50) } },
    ],
    reply: "All 100 screenshots are attached.",
  });
  log(`seeded gallery ${gallery} in ${Date.now() - started} ms`);

  const owner = peers[0]!;
  const context = {
    artifactsDir: join(paths.data, "artifact_repos"),
    trashDir: join(paths.data, "trash"),
  };
  const docFile = join(paths.root, "scratch", "report.md");
  await writeFile(docFile, `# Wire report\n\n${markdown(600_000, "report")}`);
  const doc = await artifacts.create(context, {
    owner,
    title: "Wire report",
    source: docFile,
  });
  const appFile = join(paths.root, "scratch", "app.html");
  await writeFile(
    appFile,
    `<!doctype html><title>Wire app</title><h1>Wire app</h1><script>const data = ${JSON.stringify(
      Array.from({ length: 6000 }, (_, i) => ({
        id: i,
        name: `row ${i}`,
        value: (i * 7919) % 1000,
        note: `note ${i} about caching and latency`,
      })),
    )};document.body.append(Object.assign(document.createElement("pre"),{textContent:data.slice(0,50).map((row)=>row.name).join("\\n")}));</script>`,
  );
  const [linked, app] = await Promise.all(
    [owner, peers[1]!].map((appOwner) =>
      artifacts.create(context, {
        owner: appOwner,
        title: "Wire app",
        source: appFile,
      }),
    ),
  );
  await turn(owner, {
    reply: `Report: [Wire report](#artifact=${doc.id}) and app: [Wire app](#artifact=${linked!.id}).`,
  });
  await turn(peers[1]!, { reply: `App: [Wire app](#artifact=${app!.id}).` });
  log(`seeded artifacts in ${Date.now() - started} ms`);

  const stream = await createAgent(root);
  const background = await createAgent(root);
  await turn(stream, { reply: "Ready." });
  await turn(background, { reply: "Ready." });
  return {
    root,
    long,
    gallery,
    stream,
    background,
    peers,
    markdownArtifact: String(doc.id),
    appArtifact: String(app!.id),
  };
}

interface Exchange {
  url: string;
  /** Status from the response event; 304 wins from any event. */
  status: number;
  encoding: string;
  /** Largest byte count CDP reported received, headers included. */
  received: number;
  /** Response header bytes, from the raw headers when CDP reports them. */
  headers: number;
  /** Body bytes delivered to the page, after decompression. */
  body: number;
  /** Request line, headers and body sent. */
  sent: number;
  /** Served from a browser cache without a network request. */
  cacheHit: "" | "memory" | "disk";
  revalidated: boolean;
  done: boolean;
}

const headerBytes = (headers: Record<string, string> = {}) =>
  Object.entries(headers).reduce(
    (sum, [name, value]) => sum + name.length + String(value).length + 4,
    2,
  );
const POLL_PATH = /\/events$/;
const cachedAs = (item: Exchange) => (item.revalidated ? "304" : item.cacheHit);

/**
 * Received bytes, independent of CDP event order: 0 for cache hits, headers
 * for 304s, and identity bodies (which CDP may under-count) plus headers.
 */
function wireOf(item: Exchange): number {
  if (item.revalidated) return Math.max(item.received, item.headers);
  if (item.cacheHit) return 0;
  if (item.encoding) return item.received;
  return Math.max(item.received, item.headers + item.body);
}
const decodedOf = (item: Exchange) => (cachedAs(item) ? 0 : item.body);

interface Pairing {
  flagged: Exchange[];
  waiting: Map<string, Json[]>;
  paired: Record<string, number>;
}

/** Counts every request of one page through CDP Network events. */
class Meter {
  /** One entry per request hop; a redirect starts a new hop. */
  private exchanges: Exchange[] = [];
  /** CDP request id to its hops, oldest first. */
  private hops = new Map<string, Exchange[]>();
  private marks = new Map<Exchange, [number, number]>();

  static async attach(page: Page): Promise<Meter> {
    const meter = new Meter();
    const cdp = await page.context().newCDPSession(page);
    const current = (id: string) => meter.hops.get(id)?.at(-1);
    // Invariant: CDP sends ExtraInfo only for hops it flags (hasExtraInfo,
    // redirectHasExtraInfo), in hop order, possibly before the hop's events.
    const pairings = new Map<string, Pairing>();
    const handlers = new Map<string, (event: Json, hop: Exchange) => void>();
    const pairing = (id: string) => {
      const found = pairings.get(id);
      if (found) return found;
      const created: Pairing = { flagged: [], waiting: new Map(), paired: {} };
      pairings.set(id, created);
      return created;
    };
    const pair = (id: string) => {
      const entry = pairing(id);
      for (const [name, waiting] of entry.waiting) {
        let next = entry.paired[name] ?? 0;
        while (waiting.length && next < entry.flagged.length)
          handlers.get(name)!(waiting.shift()!, entry.flagged[next++]!);
        entry.paired[name] = next;
      }
    };
    const flag = (id: string, hop: Exchange | undefined) => {
      if (!hop || pairing(id).flagged.includes(hop)) return;
      pairing(id).flagged.push(hop);
      pair(id);
    };
    const onExtraInfo = (
      name: string,
      handle: (event: Json, hop: Exchange) => void,
    ) => {
      handlers.set(name, handle);
      cdp.on(name as "Network.requestWillBeSentExtraInfo", (event: Json) => {
        const entry = pairing(event.requestId);
        entry.waiting.set(name, [...(entry.waiting.get(name) ?? []), event]);
        pair(event.requestId);
      });
    };
    cdp.on("Network.requestWillBeSent", (event: Json) => {
      const hops = meter.hops.get(event.requestId) ?? [];
      const prior = hops.at(-1);
      if (event.redirectResponse && prior) {
        if (event.redirectHasExtraInfo) flag(event.requestId, prior);
        prior.status = event.redirectResponse.status;
        prior.received = Math.max(
          prior.received,
          event.redirectResponse.encodedDataLength,
        );
        prior.done = true;
      }
      const item: Exchange = {
        url: event.request.url,
        status: 0,
        encoding: "",
        received: 0,
        headers: 0,
        body: 0,
        sent:
          event.request.method.length +
          event.request.url.length +
          12 +
          (event.request.postData?.length ?? 0),
        cacheHit: "",
        revalidated: false,
        done: false,
      };
      hops.push(item);
      meter.hops.set(event.requestId, hops);
      meter.exchanges.push(item);
    });
    onExtraInfo("Network.requestWillBeSentExtraInfo", (event, item) => {
      item.sent += headerBytes(event.headers);
    });
    cdp.on("Network.requestServedFromCache", (event: Json) => {
      const item = current(event.requestId);
      if (item) item.cacheHit = "memory";
    });
    onExtraInfo("Network.responseReceivedExtraInfo", (event, item) => {
      item.headers = Math.max(
        item.headers,
        event.headersText?.length || headerBytes(event.headers) + 15,
      );
      if (event.statusCode === 304) {
        item.revalidated = true;
        item.status = 304;
      }
    });
    cdp.on("Network.responseReceived", (event: Json) => {
      const item = current(event.requestId);
      if (!item) return;
      if (event.hasExtraInfo) flag(event.requestId, item);
      const response = event.response;
      if (response.status === 304) item.revalidated = true;
      item.status = item.revalidated ? 304 : response.status;
      if (response.fromDiskCache) item.cacheHit ||= "disk";
      if (response.fromServiceWorker) item.cacheHit ||= "memory";
      item.encoding = String(
        Object.entries(response.headers ?? {}).find(
          ([name]) => name.toLowerCase() === "content-encoding",
        )?.[1] ?? "",
      );
      item.received = Math.max(item.received, response.encodedDataLength);
      item.headers ||= response.encodedDataLength;
    });
    cdp.on("Network.dataReceived", (event: Json) => {
      const item = current(event.requestId);
      if (!item) return;
      item.body += event.dataLength;
      item.received += event.encodedDataLength;
    });
    cdp.on("Network.loadingFinished", (event: Json) => {
      const item = current(event.requestId);
      if (!item) return;
      item.received = Math.max(item.received, event.encodedDataLength);
      item.done = true;
    });
    cdp.on("Network.loadingFailed", (event: Json) => {
      const item = current(event.requestId);
      if (item) item.done = true;
      const waiting = [...pairing(event.requestId).waiting.values()];
      if (waiting.some((events) => events.length)) flag(event.requestId, item);
    });
    await cdp.send("Network.enable");
    return meter;
  }

  /** Start a case: bytes open requests already received are excluded. */
  start(): void {
    this.marks = new Map(
      this.exchanges.map((item) => [item, [wireOf(item), decodedOf(item)]]),
    );
  }

  /** Requests and bytes since start(); conversation ids become `<id>`. */
  result(focused: string | null, known: readonly string[]): Json {
    const rows = this.exchanges
      .map((item) => {
        const url = new URL(item.url);
        const [wire, decoded] = this.marks.get(item) ?? [0, 0];
        return {
          ...item,
          cached: cachedAs(item),
          path: url.pathname,
          query: url.search,
          wire: Math.max(0, wireOf(item) - wire),
          decoded: Math.max(0, decodedOf(item) - decoded),
          fresh: !this.marks.has(item),
        };
      })
      .filter((row) => row.fresh || row.wire > 0);
    const fresh = rows.filter((row) => row.fresh);
    const sum = (list: typeof rows, key: "wire" | "decoded" | "sent") =>
      list.reduce((total, row) => total + row[key], 0);
    const label = (path: string) =>
      known.reduce(
        (text, cid) =>
          text.replace(cid, cid === focused ? "<open>" : "<other>"),
        path,
      );
    const groups = new Map<string, { count: number; bytes: number }>();
    for (const row of rows) {
      const key = label(row.path);
      const entry = groups.get(key) ?? { count: 0, bytes: 0 };
      entry.count += row.fresh ? 1 : 0;
      entry.bytes += row.wire;
      groups.set(key, entry);
    }
    const downloads = new Map<string, number>();
    for (const row of fresh)
      if (row.status === 200 && !row.cached && !POLL_PATH.test(row.path))
        downloads.set(row.url, (downloads.get(row.url) ?? 0) + 1);
    return {
      bytes: sum(rows, "wire"),
      decoded: sum(rows, "decoded"),
      sent: sum(fresh, "sent"),
      requests: fresh.length,
      not_modified: fresh.filter((row) => row.cached === "304").length,
      browser_cache: fresh.filter(
        (row) => row.cached === "memory" || row.cached === "disk",
      ).length,
      uncompressed_bytes: sum(
        rows.filter((row) => !row.encoding && row.decoded > 1024),
        "wire",
      ),
      event_stream_bytes: sum(
        rows.filter((row) => POLL_PATH.test(row.path)),
        "wire",
      ),
      largest: [...groups]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 8)
        .map(([path, entry]) => ({ path, ...entry })),
      repeated: [...downloads]
        .filter(([, count]) => count > 1)
        .map(([url, count]) => ({ path: label(new URL(url).pathname), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      other_conversations: [
        ...new Set(
          rows
            .map((row) => label(row.path))
            .filter((p) => p.includes("<other>")),
        ),
      ],
      log: rows.map((row) => [
        label(row.path + row.query).slice(0, 120),
        row.status,
        row.wire,
        row.decoded,
        row.cached || row.encoding,
      ]),
    };
  }

  /**
   * Wait until all but event-stream requests finished and no request to a new
   * URL started for `quietMs`; repeated polls do not hold it open.
   */
  async settle(quietMs = 1000, maxMs = 30_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    const seen = new Set<string>();
    let since = Date.now();
    for (;;) {
      const open = this.exchanges.filter(
        (item) => !item.done && !POLL_PATH.test(new URL(item.url).pathname),
      );
      for (const item of this.exchanges)
        if (!seen.has(item.url)) {
          seen.add(item.url);
          since = Date.now();
        }
      if (!open.length && Date.now() - since >= quietMs) return;
      if (Date.now() > deadline)
        throw new Error(
          `requests did not settle: ${open.map((item) => item.url).join(", ")}`,
        );
      await sleep(100);
    }
  }
}

interface Tab {
  context: BrowserContext;
  page: Page;
  meter: Meter;
}

async function openTab(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<Tab> {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const [name, value] = server.cookie.split("=") as [string, string];
  await context.addCookies([{ name, value, url: server.base }]);
  const page = await context.newPage();
  return { context, page, meter: await Meter.attach(page) };
}

const thread = (page: Page, cid: string) =>
  page.locator(`.agent.selected[data-id="${cid}"]`).first();

async function show(tab: Tab, cid: string): Promise<void> {
  await tab.page.evaluate((cid) => {
    (globalThis as Json).location.hash = `agent=${cid}`;
  }, cid);
  await thread(tab.page, cid).waitFor();
  await tab.page.locator("#messages .turn").first().waitFor();
}

type Case = {
  name: (typeof CASES)[number];
  focused: string | null;
  /** Unmeasured preparation: the page and conversation the case starts from. */
  setup?: () => Promise<void>;
  run: () => Promise<Json | void>;
  /** False when the case measures a fixed interval instead. */
  settle?: boolean;
};

async function main(): Promise<void> {
  const began = Date.now();
  const root = await mkdtemp(join(tmpdir(), "wire-"));
  const out = resolve(
    flags.out ??
      join(tmpdir(), `wire-${new Date().toISOString().replace(/[:.]/g, "-")}`),
  );
  await mkdir(out, { recursive: true });
  const paths: Paths = { root, data: join(root, "data"), out };
  const provider = startProvider();
  let owned: { pid: number; exited: Promise<number> } | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let closing: Promise<void> | undefined;
  const starting: Promise<unknown>[] = [];
  const stopping = new AbortController();
  const launch = <T>(work: () => Promise<T>): Promise<T> => {
    stopping.signal.throwIfAborted();
    const promise = work();
    starting.push(promise.catch(() => undefined));
    return promise;
  };
  const shutdown = () =>
    (closing ??= (async () => {
      stopping.abort();
      await Promise.all(starting);
      await browser?.close().catch(() => undefined);
      void provider.stop(true);
      try {
        if (owned) await stopPrivateServer(owned.pid, owned.exited, 30_000);
        const killed = await killDataDirGroups(paths.data);
        if (killed) log(`killed ${killed} leftover process groups`);
      } catch (error) {
        log(`cleanup failed; data kept at ${root}`);
        throw error;
      }
      if (flags.keep) log(`data kept at ${root}`);
      else retire(root, join(tmpdir(), ".trash"));
    })());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      log(`${signal}: stopping`);
      shutdown().then(
        () => process.exit(130),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
  const results: Record<string, Json> = {};
  try {
    log("starting the server");
    await prepare(paths, provider.port!);
    // Invariant: an ephemeral port; the default (8000) can collide with a
    // live instance on the same host.
    server = await launch(() =>
      startPrivateServer({
        env: privateEnv(root, paths.data, {
          TZ: "UTC",
          RECURSE_WIRE_KEY: "loopback-only",
        }),
        logFile: join(out, "server.log"),
        port: 0,
        owned: (pid, exited) => (owned = { pid, exited }),
        signal: stopping.signal,
      }),
    );
    await until(
      async () => (await api("/api/status")).ready === true,
      "server ready",
    );
    log(`server ${server.base} ready; seeding`);
    const world = await seed(paths);
    const known = [
      world.root,
      world.long,
      world.gallery,
      world.stream,
      world.background,
      ...world.peers,
    ];
    const opened = await launch(
      async () => (browser = await chromium.launch({ timeout: 30_000 })),
    );
    const tab = await openTab(opened);
    const { page, meter } = tab;
    const link = (id: string) => page.locator(`a[href="#artifact=${id}"]`);
    const closeArtifacts = async () => {
      await page
        .getByRole("button", { name: "Close Artifacts", exact: true })
        .click();
      await page
        .locator('.pane-col[data-pane="report"]')
        .waitFor({ state: "detached" });
    };
    const loadRoot = async () => {
      await page.goto(`${server.base}/c/${world.root}`);
      await thread(page, world.root).waitFor();
      await page.locator("#messages .turn").first().waitFor();
    };
    const open = (cid?: string) => async () => {
      if (page.url() === "about:blank") {
        await loadRoot();
        await meter.settle();
      }
      if (cid) {
        await show(tab, cid);
        await meter.settle();
      }
    };
    const cases: Case[] = [
      { name: "cold-load", focused: world.root, run: loadRoot },
      {
        name: "warm-reload",
        focused: world.root,
        setup: async () => {
          await open()();
          await Promise.all(
            ["/api/tree", `/api/conversations/${world.root}`].map((path) =>
              page.waitForResponse(
                async (response) =>
                  new URL(response.url()).pathname === path &&
                  [200, 304].includes(response.status()) &&
                  (await response.finished()) === null,
              ),
            ),
          );
        },
        run: async () => {
          await page.reload();
          await thread(page, world.root).waitFor();
          await page.locator("#messages .turn").first().waitFor();
        },
      },
      {
        name: "long-conversation",
        focused: world.long,
        setup: open(),
        run: async () => {
          await show(tab, world.long);
          await meter.settle();
          for (let i = 0; i < 3; i++) {
            await page
              .locator("#scroll")
              .evaluate((node) => (node.scrollTop = 0));
            await meter.settle(800);
          }
        },
      },
      {
        name: "images",
        focused: world.gallery,
        setup: open(),
        run: async () => {
          await show(tab, world.gallery);
          await meter.settle();
          return page.evaluate(() => {
            const browser = globalThis as Json;
            const images = [
              ...browser.document.querySelectorAll("#messages img"),
            ];
            return {
              images_in_thread: images.length,
              images_in_view: images.filter((img: Json) => {
                const box = img.getBoundingClientRect();
                return box.bottom > 0 && box.top < browser.innerHeight;
              }).length,
            };
          });
        },
      },
      ...(
        [
          ["artifact-markdown", world.markdownArtifact, world.peers[0]!],
          ["artifact-app", world.appArtifact, world.peers[1]!],
        ] as const
      ).map(([name, id, owner]) => ({
        name,
        focused: owner,
        setup: open(),
        run: async () => {
          await show(tab, owner);
          await meter.settle();
          const body =
            name === "artifact-app"
              ? page
                  .frameLocator("iframe.artifact-embed-page")
                  .getByRole("heading", { name: "Wire app" })
              : page.locator(".report-doc h1").first();
          for (let round = 0; round < 2; round++) {
            await link(id).click();
            await body.waitFor();
            await meter.settle();
            await closeArtifacts();
          }
        },
      })),
      {
        name: "switch",
        focused: null,
        setup: open(),
        run: async () => {
          for (let round = 0; round < 2; round++)
            for (const cid of world.peers) {
              await show(tab, cid);
              await meter.settle(500);
            }
        },
      },
      {
        name: "idle",
        focused: world.root,
        setup: open(world.root),
        settle: false,
        run: async () => {
          await sleep(idleSeconds * 1000);
          return { seconds: idleSeconds };
        },
      },
      {
        name: "streaming-reply",
        focused: world.stream,
        setup: open(world.stream),
        run: async () => {
          const text = markdown(20_000, "stream");
          await turn(world.stream, {
            calls: Array.from({ length: 5 }, (_, i) => ({
              name: "bash",
              arguments: { command: `seq 1 ${200 * (i + 1)}` },
            })),
            reply: text,
            chunks: 200,
            delayMs: 50,
            promptTokens: 2000,
          });
          await page
            .locator("#messages")
            .getByText("Section 0 (stream)")
            .first()
            .waitFor();
          await page
            .getByRole("button", {
              name: "Latest provider context: 2k tokens. Open context details.",
              exact: true,
            })
            .waitFor();
          return { reply_bytes: text.length };
        },
      },
      {
        name: "background-turn",
        focused: world.root,
        setup: open(world.root),
        run: async () => {
          const text = markdown(20_000, "background");
          await turn(world.background, {
            calls: [{ name: "bash", arguments: { command: "seq 1 2000" } }],
            reply: text,
            chunks: 100,
            delayMs: 50,
          });
          return { reply_bytes: text.length };
        },
      },
    ];
    for (const item of cases) {
      if (!selected.includes(item.name)) continue;
      log(`case ${item.name}`);
      await item.setup?.();
      meter.start();
      const extra = (await item.run()) ?? {};
      if (item.settle !== false) await meter.settle();
      const result = { ...meter.result(item.focused, known), ...extra };
      if (result.reply_bytes)
        result.wire_per_reply_byte =
          Math.round((result.bytes / result.reply_bytes) * 100) / 100;
      if (result.seconds) {
        result.bytes_per_minute = Math.round(
          (result.bytes * 60) / result.seconds,
        );
        result.requests_per_minute = Math.round(
          (result.requests * 60) / result.seconds,
        );
      }
      results[item.name] = result;
    }
  } finally {
    await shutdown();
  }
  await writeFile(
    join(out, "report.json"),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 1),
  );
  report(results, out);
  log(`finished in ${Math.round((Date.now() - began) / 1000)} s`);
  const failures = await check(results);
  for (const failure of failures) console.error(`OVER BUDGET: ${failure}`);
  if (failures.length) process.exit(1);
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** The budgeted numbers: totals, or per minute for the idle tab. */
const measured = (result: Json) =>
  result.seconds
    ? { bytes: result.bytes_per_minute, requests: result.requests_per_minute }
    : { bytes: result.bytes, requests: result.requests };

async function check(results: Record<string, Json>): Promise<string[]> {
  const budgets: Record<string, { bytes: number; requests: number }> =
    (await Bun.file(BUDGETS).exists()) ? await Bun.file(BUDGETS).json() : {};
  if (flags.update) {
    for (const [name, result] of Object.entries(results)) {
      const value = measured(result);
      const headroom = HEADROOM[name] ?? 1.2;
      budgets[name] = {
        bytes: Math.ceil(
          Math.max(value.bytes * headroom, value.bytes + SLACK.bytes),
        ),
        requests: Math.ceil(
          Math.max(value.requests * headroom, value.requests + SLACK.requests),
        ),
      };
    }
    await writeFile(BUDGETS, JSON.stringify(budgets, null, 2) + "\n");
    log(`budgets written to ${BUDGETS}`);
    return [];
  }
  const failures: string[] = [];
  const limit = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  for (const [name, result] of Object.entries(results)) {
    const budget = budgets[name];
    const value = measured(result);
    if (!budget) failures.push(`${name}: no budget (run with --update)`);
    else if (!limit(budget.bytes) || !limit(budget.requests))
      failures.push(`${name}: malformed budget ${JSON.stringify(budget)}`);
    else
      for (const key of ["bytes", "requests"] as const)
        if (value[key] > budget[key])
          failures.push(
            `${name}: ${key} ${value[key]} over budget ${budget[key]}`,
          );
  }
  return failures;
}

function report(results: Record<string, Json>, out: string): void {
  console.log(
    "\n| case | wire | decoded | sent | requests | 304/cache | top 3 by wire bytes |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const [name, result] of Object.entries(results))
    console.log(
      `| ${name} | ${kb(result.bytes)} | ${kb(result.decoded)} | ${kb(result.sent)} | ${result.requests} | ${result.not_modified}/${result.browser_cache} | ${result.largest
        .slice(0, 3)
        .map((item: Json) => `${item.path} ${kb(item.bytes)}×${item.count}`)
        .join(", ")} |`,
    );
  console.log(`\nreport: ${join(out, "report.json")}`);
}

await main();
process.exit(0);
