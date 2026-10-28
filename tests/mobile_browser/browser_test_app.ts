import { SET_MODEL_MARKER } from "../../src/agents/conversation_store";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type AssistantMessage,
  type AssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  addUpload,
  registerFile,
} from "../../src/agents/runtime/attachments/publish";
import * as artifacts from "../../src/artifacts";
import { CHECKOUT_ROOT } from "../../src/build_dir";
import { buildApp } from "../../src/web/app";
import { jsonResponse, type Handler } from "../../src/web/router";
import { publishLoopbackToken } from "../../src/web/request_auth";

import { replayResponse } from "../backend/fixtures/model_response/replay";
import { entries as contextEntries } from "../backend/fixtures/durable_context_usage/entries";
import { promptTokens } from "../../src/agents/runtime/context_usage";
import titleRecording from "../backend/fixtures/conversation_title/recording.json";
import {
  recordedModels,
  recordingNames,
  type RecordingName,
} from "../backend/fixtures/provider_replay/models.ts";

type Json = Record<string, unknown>;
type Conv = Json & { id: string };

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

type ImageBytes = Uint8Array<ArrayBuffer>;
const imageBytes = (value: Uint8Array): ImageBytes =>
  value as unknown as ImageBytes;

function navigationPng(
  background: [number, number, number],
  digit: number,
): ImageBytes {
  const width = 800;
  const height = 500;
  const pixels = new Uint8Array(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3)
    pixels.set(background, offset);
  const segments: Record<string, [number, number, number, number]> = {
    a: [280, 80, 520, 125],
    b: [480, 110, 525, 240],
    c: [480, 260, 525, 390],
    d: [280, 375, 520, 420],
    e: [275, 260, 320, 390],
    f: [275, 110, 320, 240],
    g: [280, 228, 520, 272],
  };
  const digits = ["abcdef", "bc", "abdeg", "abcdg"];
  for (const segment of digits[digit]) {
    const [x1, y1, x2, y2] = segments[segment];
    for (let y = y1; y < y2; y++)
      pixels.fill(255, (y * width + x1) * 3, (y * width + x2) * 3);
  }
  const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const concatBytes = (...parts: Uint8Array[]): ImageBytes => {
    const result = new Uint8Array(
      parts.reduce((total, part) => total + part.length, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return imageBytes(result);
  };
  const chunk = (type: string, data: ImageBytes): ImageBytes => {
    const body = concatBytes(
      Uint8Array.from(type, (character) => character.charCodeAt(0)),
      data,
    );
    const result = new Uint8Array(data.length + 12);
    const writeU32 = (offset: number, value: number) => {
      result[offset] = value >>> 24;
      result[offset + 1] = value >>> 16;
      result[offset + 2] = value >>> 8;
      result[offset + 3] = value;
    };
    writeU32(0, data.length);
    result.set(body, 4);
    writeU32(body.length + 4, crc32(body));
    return imageBytes(result);
  };
  const scanlines = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines.set(
      pixels.subarray(y * width * 3, (y + 1) * width * 3),
      y * (width * 3 + 1) + 1,
    );
  }
  return concatBytes(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Uint8Array.from([0, 0, 3, 32, 0, 0, 1, 244, 8, 2, 0, 0, 0])),
    chunk(
      "IDAT",
      imageBytes(
        deflateSync(
          scanlines as Uint8Array<ArrayBufferLike>,
        ) as unknown as Uint8Array,
      ),
    ),
    chunk("IEND", new Uint8Array()),
  );
}

const NAVIGATION_IMAGES = [
  navigationPng([210, 55, 55], 1),
  navigationPng([40, 150, 80], 2),
  navigationPng([50, 100, 210], 3),
];

const hex = (n = 32): string => randomUUID().replaceAll("-", "").slice(0, n);
const nowSeconds = (): number => Date.now() / 1000;

const pyDumps = (value: unknown): string =>
  JSON.stringify(value).replace(/("(?:[^"\\]|\\.)*")|,|:/g, (m, str) =>
    str ? str : m === "," ? ", " : ": ",
  );

export function piUser(
  id: string,
  text: string,
  parent: string | null,
  ts = 100,
): Json {
  return {
    type: "message",
    id,
    parentId: parent,
    timestamp: ts,
    message: { role: "user", content: text },
  };
}

export function piAssistant(
  id: string,
  text: string,
  parent: string | null,
  stop = "stop",
  ts = 101,
): Json {
  return {
    type: "message",
    id,
    parentId: parent,
    timestamp: ts,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: stop,
    },
  };
}

async function writePiSession(
  entries: Json[],
  path: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-09-01T00:00:00.000Z",
    cwd,
  };
  await writeFile(
    path,
    [header, ...entries].map((row) => pyDumps(row) + "\n").join(""),
  );
}

const port = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(port))
  throw new Error("usage: browser_test_app.ts <port>");

const app = await buildApp({
  env: process.env,
  sourceRoot: CHECKOUT_ROOT,
});
const { instance, router } = app;
const { conversations, agentTemp, nodes, reads } = instance;

const durableFaux = fauxProvider({ tokensPerSecond: 20 });
const durableThinking = fauxProvider({ provider: "fauxthinking" });
let thinkingCommit = Promise.resolve();
let releaseThinkingCommit = () => {};

function paceThinking(source: AssistantMessageEventStream) {
  const copied = createAssistantMessageEventStream();
  const paced = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of source) copied.push(structuredClone(event));
    copied.end(await source.result());
  })();
  void (async () => {
    for await (const event of copied) {
      if (event.type === "thinking_delta")
        await Bun.sleep((Math.ceil(event.delta.length / 4) / 80) * 1000);
      if (event.type === "toolcall_end") await thinkingCommit;
      paced.push(event);
    }
    paced.end(await copied.result());
  })();
  return paced;
}
const durableFast = fauxProvider({
  provider: "fauxfast",
  tokensPerSecond: 20_000,
});
const durableOrdinary = fauxProvider({
  provider: "fauxordinary",
  tokensPerSecond: 20_000,
});
const ordinaryReply: import("@earendil-works/pi-ai").FauxResponseFactory = (
  context,
) => {
  durableOrdinary.appendResponses([ordinaryReply]);
  return fauxAssistantMessage(
    JSON.stringify(
      context.messages.findLast((message) => message.role === "user")?.content,
    ).match(/Reply only ([^"\\]+)/)?.[1] ?? "Acknowledged.",
  );
};
durableOrdinary.setResponses([ordinaryReply]);
const durableModels = createModels();
durableModels.setProvider(durableOrdinary.provider);
durableModels.setProvider(durableFaux.provider);
durableModels.setProvider({
  ...durableThinking.provider,
  stream: (...args) => paceThinking(durableThinking.provider.stream(...args)),
  streamSimple: (...args) =>
    paceThinking(durableThinking.provider.streamSimple(...args)),
});
durableModels.setProvider(durableFast.provider);
const durableModel = new Map<string, string | null>();
const recordedRuns = new Map<
  string,
  Awaited<ReturnType<typeof recordedModels>>
>();
{
  const deps = (
    instance.durable as unknown as {
      deps: {
        models: unknown;
        settings: (conv: Json) => [string, string];
        agentEnv: (conv: Json) => Promise<NodeJS.ProcessEnv>;
      };
    }
  ).deps;
  deps.models = durableModels;
  const agentEnv = deps.agentEnv;
  deps.agentEnv = async (conv) => ({
    ...(await agentEnv(conv)),
    ...(String(conv.id).startsWith("safety-browser-")
      ? { RECURSE_MODEL_POLICY: undefined }
      : {}),
  });
  const storedSettings = deps.settings;
  deps.settings = (conv) => {
    const model = durableModel.get(String(conv.id));
    return model === null
      ? storedSettings(conv)
      : [
          model ?? "fauxordinary/faux-1",
          recordedRuns.has(String(conv.id)) ? "low" : "high",
        ];
  };
}
let durableGate: () => void = () => undefined;

async function createDurable(cid: string, title: string, model: string) {
  durableModel.set(cid, model);
  await instance.create.create({
    cid,
    title,
    parent: rootAgentId(),
  });
}
async function submitDurable(
  cid: string,
  content: string,
  during = async () => {},
): Promise<void> {
  const { conversation } = await instance.durable.open(cid);
  const run = await conversation.submit(
    { type: "input", content },
    BACKGROUND_CONTEXT,
  );
  await during();
  await run.wait(BACKGROUND_CONTEXT);
}
type FauxReply = Parameters<typeof durableFast.setResponses>[0][number];
async function sayDurable(
  cid: string,
  question: string,
  answer: string,
  before: FauxReply[] = [],
  during?: () => Promise<void>,
) {
  durableFast.setResponses([...before, fauxAssistantMessage(answer)]);
  const content = `## Message\n[recurse-origin: operator]\n${question}`;
  await submitDurable(cid, content, during);
}
async function sayDurableHistory(cid: string, n: number, report = false) {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const call = fauxToolCall("bash", { command: "true" });
  await sayDurable(
    cid,
    `Assignment ${n} ${"x".repeat(2000)}`,
    `Answer ${n}`,
    report
      ? [
          async () =>
            held.then(() =>
              fauxAssistantMessage([call], { stopReason: "toolUse" }),
            ),
        ]
      : [],
    async () => {
      if (!report) return;
      await instance.delivery.deliver(cid, `Report ${n}`, {
        origin: "agent",
        sender: `${cid}-kid`,
      });
      release();
    },
  );
}
async function compactDurableHistory(cid: string, summary: string) {
  const { harness, conversation } = await instance.durable.open(cid);
  durableFast.setResponses([fauxAssistantMessage(summary)]);
  await harness.waitForTask(
    await conversation.compact(undefined, BACKGROUND_CONTEXT),
    BACKGROUND_CONTEXT,
  );
}
const sessionDir = instance.backend.sessionDir;

async function seedPiSession(
  conv: Conv,
  entries: Json[],
  sessionId?: string,
  cwd?: string,
): Promise<Conv> {
  const sid = sessionId ?? `${conv.id}-session`;
  const target = cwd ?? (await mkdtemp(join(tmpdir(), "pi-seed-cwd-")));
  await mkdir(target, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const path = join(sessionDir, `test_${sid}.jsonl`);
  await writePiSession(entries, path, sid, target);
  Object.assign(conv, {
    session_id: sid,
    session_file: path,
    session_cwd: target,
  });
  await conversations.save(conv);
  await readoptBinding(conv.id, conv);
  return conv;
}

const load = (cid: string): Conv | null =>
  conversations.load(cid) as Conv | null;
const save = (conv: Conv): Promise<void> => conversations.save(conv as never);
const create = async (cid: string, title: string, parent: string | null) => {
  durableModel.set(cid, "fauxordinary/faux-1");
  await instance.create.create({ cid, title, parent });
};
const rootAgentId = (): string => {
  for (const conv of conversations.allConvs({ withPending: false }))
    if (!conv.parent) return String(conv.id);
  throw new Error("no root agent");
};

async function seedUpload(
  owner: string,
  body: Uint8Array,
  filename: string,
): Promise<Json> {
  const conv = load(owner)!;
  const collection = await agentTemp.ensureUploadsDir(String(conv.tmp_key));
  return (await addUpload(
    collection,
    owner,
    body,
    filename,
  )) as unknown as Json;
}

const realReadContextUsage = reads.readContextUsage.bind(reads);
reads.readContextUsage = async (cid: string) => {
  const view = await realReadContextUsage(cid);
  if (view && view.used_tokens === 341_800) {
    view.model = "openai-codex/gpt-5.6-sol";
    view.model_label = "GPT-5.6 Sol";
    view.usage_model = "openai-codex/gpt-5.6-sol";
    view.context_window = 372_000;
    view.unused_tokens = 30_200;
    view.estimated_tokens = {
      system: 100_000,
      prompts: 20_000,
      messages: 80_000,
      tool_calls: 40_000,
      tool_outputs: 101_800,
    };
  }
  return view;
};

async function helperApplyClear(cid: string): Promise<boolean> {
  return (await instance.durable.clear(cid)) !== null;
}

async function waitTurn(cid: string): Promise<void> {
  const task = nodes.node(cid).turnTask;
  if (task !== null)
    await Promise.race([
      task.catch(() => undefined),
      Bun.sleep(15_000).then(() => {
        throw new Error("turn did not finish in 15 s");
      }),
    ]);
}

async function readoptBinding(cid: string, conv: Conv): Promise<void> {
  const prior = conv.reap_deferred;
  conv.reap_deferred = true;
  try {
    await save(conv);
    if (!(await instance.durable.retire(cid)))
      throw new Error("fixture storage did not close");
    await instance.durable.importPi(
      conv,
      {
        state: () => ({ running: false, queued: 0 }),
        publish: (commit) => commit(),
      },
      new AbortController().signal,
    );
  } finally {
    if (prior === undefined) delete conv.reap_deferred;
    else conv.reap_deferred = prior;
    await save(conv);
  }
}

async function appendNative(
  conv: Conv,
  content: string,
  reply: string,
): Promise<void> {
  await submitDurable(conv.id, `${content}\nReply only ${reply}`);
  conv.updated = nowSeconds();
}

async function publishTurn(
  cid: string,
  name: string,
  body: string | Uint8Array,
): Promise<string> {
  const conv = load(cid)!;
  const workdir = await mkdtemp(join(tmpdir(), "published-file-"));
  await writeFile(join(workdir, name), body);
  const collection = await agentTemp.ensureUploadsDir(String(conv.tmp_key));
  const callId = `call-publish-${hex(8)}`;
  const published = await registerFile(
    collection,
    cid,
    hex(32),
    callId,
    join(workdir, name),
    workdir,
  );
  const n = hex(8);
  const entries: Json[] = [
    piUser(`published-user-${n}`, `Publish ${name}`, null, 100),
    {
      type: "message",
      id: `published-call-${n}`,
      parentId: `published-user-${n}`,
      timestamp: 101,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: callId,
            name: "publish_attachment",
            arguments: { path: join(workdir, name) },
          },
        ],
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: `published-result-${n}`,
      parentId: `published-call-${n}`,
      timestamp: 102,
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "publish_attachment",
        content: [{ type: "text", text: JSON.stringify(published) }],
      },
    },
    piAssistant(
      `published-reply-${n}`,
      `${name} is attached.`,
      `published-result-${n}`,
      "stop",
      103,
    ),
  ];
  await appendPiTurn(conv, entries);
  return String(published.id);
}

async function publishDraftsTurn(
  cid: string,
  files: Record<string, string | Uint8Array>,
): Promise<void> {
  const workdir = await mkdtemp(join(tmpdir(), "published-drafts-"));
  for (const [name, body] of Object.entries(files))
    await writeFile(join(workdir, name), body);
  durableFast.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("publish", {
          paths: Object.keys(files).map((name) => join(workdir, name)),
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Both drafts are published."),
  ]);
  await submitDurable(cid, "Publish the drafts.");
}

async function appendPiTurn(conv: Conv, entries: Json[]): Promise<void> {
  if (!conv.session_file) {
    await seedPiSession(conv, entries);
  } else {
    const path = String(conv.session_file);
    let lastId: string | null = null;
    for (const line of (await readFile(path, "utf8")).split("\n").reverse()) {
      try {
        const row = JSON.parse(line) as Json;
        if (row?.type === "message" && row.id) {
          lastId = String(row.id);
          break;
        }
      } catch {
        continue;
      }
    }
    (entries[0] as Record<string, unknown>).parentId = lastId;
    await appendFile(path, entries.map((row) => pyDumps(row) + "\n").join(""));
    conv.updated = nowSeconds();
    await readoptBinding(conv.id, conv);
  }
  await save(conv);
}

let filesFixture: Json | null = null;
let publishedFixture: Json | null = null;
let mediaFixture: Json | null = null;
let pdfFixture: Json | null = null;

function pdfFile(objects: string[]): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const stream = (text: string) =>
  `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;

function rectanglePdf(pages: number): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + 2 * i} 0 R`).join(" ")}] >>`,
  ];
  for (let i = 0; i < pages; i++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${4 + 2 * i} 0 R >>`,
      stream("1 0 0 rg 50 50 200 100 re f"),
    );
  return pdfFile(objects);
}

function japanesePdf(): Uint8Array {
  return pdfFile([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("BT /F1 24 Tf 20 90 Td <30533093306B3061306F> Tj ET"),
    "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R >>",
    "<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
  ]);
}

function silentWav(): Uint8Array {
  const samples = 800;
  const out = Buffer.alloc(44 + samples, 0x80);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(8000, 28);
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples, 40);
  return new Uint8Array(out);
}
let imageNavigationFixture: Json | null = null;
let autoOpenDraft = 0;

const routes: Record<string, (request: Request) => Promise<Json>> = {
  "seed-shared-trees": async () => {
    const ids = Array.from({ length: 6 }, () => hex(12));
    for (const [index, id] of ids.entries())
      await save({
        id,
        title: `Shared tree fixture ${index}`,
        parent: index % 2 ? ids[index - 1]! : null,
        updated: Date.now() / 1000 - index,
        backend: "durable",
      });
    return { ids };
  },
  "seed-sidebar-compact": async () => {
    const root = rootAgentId();
    const titles = [
      "Modal deploy tool",
      "Test strict",
      "Pi upgrade",
      "Dev full check",
      "iPhone WebKit tests",
      "Design system audit",
      "Isolated browser check",
      "Deploy verification",
      "Keyboard navigation",
    ];
    for (const [index, title] of titles.entries())
      await save({
        id: `compact-sidebar-${index}`,
        title,
        parent: root,
        updated: Date.now() / 1000 - index,
        backend: "durable",
      });
    return { root };
  },
  "seed-sidebar-order": async (request) => {
    const { phase } = (await request.json()) as { phase: number };
    const now = Date.now() / 1000;
    const operatorAt = now - (phase ? 60 : 300);
    for (const [id, operatorMessageAt, updated] of [
      ["operator-recent", operatorAt, operatorAt],
      ["agent-active", now - 3600, now - 30],
      ["no-operator", null, now - 120],
    ] as const) {
      if (!phase)
        await save({
          id,
          title: id,
          parent: null,
          updated,
          backend: "durable",
        });
      conversations.saveActivity(id, updated, operatorMessageAt ?? undefined);
    }
    return { operator_message_at: operatorAt };
  },
  "seed-pane-reading": async () => {
    const context = {
      artifactsDir: instance.config.paths.ARTIFACTS_DIR,
      trashDir: instance.config.paths.TRASH_DIR,
    };
    const item = await artifacts.create(context, {
      owner: rootAgentId(),
      title: "Reading document",
    });
    const content =
      "# First document line\n\n" +
      Array.from(
        { length: 100 },
        (_, i) => `## Section ${i + 1}\n\nDocument paragraph ${i + 1}.\n\n`,
      ).join("");
    await Bun.write(join(String(item.repo_path), "index.md"), content);
    await artifacts.publish(context, rootAgentId(), String(item.id));
    const conv = load(rootAgentId())!;
    await seedPiSession(conv, [
      piAssistant(
        "reading-link",
        `[Reading document](#artifact=${item.id})`,
        null,
      ),
    ]);
    await save(conv);
    const demo = "pane-reading-files";
    if (!load(demo)) await create(demo, "Reading files", rootAgentId());
    for (const draft of [1, 2, 3])
      await publishTurn(demo, "reading.md", `${content}\nDraft ${draft}.\n`);
    return { id: item.id, cwd: item.repo_path, demo };
  },
  "seed-artifact-app": async (request) => {
    const reader = new URL(request.url).searchParams.get("reader");
    const owner =
      new URL(request.url).searchParams.get("agent") || rootAgentId();
    const context = {
      artifactsDir: instance.config.paths.ARTIFACTS_DIR,
      trashDir: instance.config.paths.TRASH_DIR,
    };
    const item = await artifacts.create(context, {
      owner,
      title: "Browser app",
    });
    const repo = String(item.repo_path);
    await Bun.write(
      join(repo, "index.html"),
      '<!doctype html><link rel="stylesheet" href="./style.css"><img src="./dot.png" alt="dot"><button id="count">0</button><button id="boom">Break</button><script type="module" src="./app.ts"></script>' +
        (reader === "long"
          ? Array.from(
              { length: 100 },
              (_, i) =>
                `<section style="padding:16px;border-bottom:1px solid var(--border)"><h2>Artifact section ${i + 1}</h2><p>A full-width reading surface with one continuous scroll.</p></section>`,
            ).join("")
          : reader === "viewport"
            ? '<main style="height:100vh">Viewport-sized app</main><p>App footer</p>'
            : ""),
    );
    await Bun.write(
      join(repo, "style.css"),
      "#count { color: rgb(0, 128, 0); border: 2px solid var(--accent) }",
    );
    await Bun.write(join(repo, "dot.png"), PNG_1X1);
    await Bun.write(
      join(repo, "app.ts"),
      'const button = document.getElementById("count")!;\nbutton.onclick = () => (button.textContent = String(Number(button.textContent) + 1));\ndocument.getElementById("boom")!.onclick = () => {\n  throw new TypeError("the chart data is null");\n};\ndocument.body.dataset.ready = "1";\n',
    );
    const published = await artifacts.publish(context, owner, String(item.id));
    const conv = load(owner)!;
    await seedPiSession(conv, [
      piAssistant("artifact-link", `[Browser app](#artifact=${item.id})`, null),
    ]);
    await save(conv);
    const sourceId = "artifact-link-source";
    if (!load(sourceId)) await create(sourceId, "Artifact links", owner);
    const source = load(sourceId)!;
    const shared = `[Shared](#agent=${owner}&artifact=${item.id})`;
    await seedPiSession(source, [piAssistant("shared-link", shared, null)]);
    await save(source);
    return { ...published, cwd: repo };
  },
  "revise-artifact-app": async (request) => {
    const id = new URL(request.url).searchParams.get("id")!;
    const context = {
      artifactsDir: instance.config.paths.ARTIFACTS_DIR,
      trashDir: instance.config.paths.TRASH_DIR,
    };
    const item = await artifacts.get(context, rootAgentId(), id);
    await Bun.write(
      join(String(item.repo_path), "revision.txt"),
      "New version",
    );
    return artifacts.publish(context, rootAgentId(), id);
  },
  "seed-pr-references": async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pr-references-"));
    const plain = await mkdtemp(join(tmpdir(), "pr-plain-"));
    await Bun.spawn(["git", "init"], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    await Bun.spawn(
      ["git", "remote", "add", "origin", "https://github.com/Owner/Repo"],
      { cwd },
    ).exited;
    for (const cid of ["pr-checkout", "pr-plain"]) {
      await create(cid, cid, rootAgentId());
      const conv = load(cid)!;
      conv.workdir = cid === "pr-checkout" ? cwd : plain;
      await seedPiSession(conv, [
        piUser(`${cid}-user`, "Show PR references", null),
        piAssistant(
          `${cid}-reply`,
          `Review #42 from ${cid}. \`#42\`\n\n\`\`\`\n#42\n\`\`\`\n\n[#42](https://example.com)\n\n\`<span title="</code>">#42</span>\``,
          `${cid}-user`,
        ),
      ]);
      await writeFile(
        instance.agentTemp.workdirFile(String(conv.tmp_key)),
        JSON.stringify({ version: 1, cwd: conv.workdir }),
      );
    }
    return { checkout: "pr-checkout", plain: "pr-plain" };
  },
  "seed-files-pane": async () => {
    if (filesFixture !== null) return filesFixture;
    if (load("files-empty") === null)
      await create("files-empty", "Files empty agent", rootAgentId());
    if (load("files-demo") === null)
      await create("files-demo", "Files demo agent", rootAgentId());
    const enc = new TextEncoder();
    const text = await seedUpload(
      "files-demo",
      enc.encode("bounded browser text preview\n"),
      "browser-notes.txt",
    );
    const image = await seedUpload("files-demo", PNG_1X1, "browser-image.png");
    const emptyText = await seedUpload(
      "files-empty",
      enc.encode("empty agent first durable file\n"),
      "empty-agent.txt",
    );
    const conv = load("files-demo")!;
    conv.settled_attachment_ids = [text.id, image.id];
    await seedPiSession(conv, [
      piUser(
        "browser-files-user",
        "Browser files source message\n" +
          `[browser-notes.txt](/api/conversations/files-demo/attachments/${text.id})\n` +
          `![browser-image.png](/api/conversations/files-demo/attachments/${image.id})`,
        null,
      ),
    ]);
    await save(conv);
    filesFixture = {
      text: text.id,
      image: image.id,
      empty_text: emptyText.id,
      demo: "files-demo",
      empty: "files-empty",
    };
    return filesFixture;
  },
  "seed-theme-surfaces": async () => {
    const cid = "theme-surfaces";
    if (!load(cid)) await create(cid, "Theme surfaces", rootAgentId());
    const conv = load(cid)!;
    await seedPiSession(conv, [
      piUser("theme-user", "Show a diagram and a long explanation.", null),
      piAssistant(
        "theme-reply",
        "```mermaid\ngraph LR\n A[Operator] --> B[Agent]\n B --> C[Result]\n```\n\n" +
          "**Readable text** with a [link](https://example.com) and inline `code`.\n\n".repeat(
            40,
          ),
        "theme-user",
      ),
    ]);
    await save(conv);
    return { demo: cid };
  },
  "seed-published-markdown": async () => {
    if (publishedFixture !== null) return publishedFixture;
    const cid = "files-published";
    if (load(cid) === null) await create(cid, "Published files", rootAgentId());
    await publishTurn(
      cid,
      "diagram.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="400"><rect width="160" height="400" fill="teal"/><text x="12" y="40" fill="white">Shared image</text></svg>',
    );
    const id = await publishTurn(
      cid,
      "report.md",
      '# Weekly report\n\n- shipped **previews**\n\n```mermaid\ngraph LR\n A[Files] --> B[Artifacts]\n```\n\nInline \\(x^2\\) and display math:\n\n\\[E = mc^2\\]\n\n![Local diagram](./diagram.svg)\n\n| Wide table | Value |\n| --- | --- |\n| WideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumn | readable |\n\n<img src="https://example.com/x.png" alt="remote">\n',
    );
    publishedFixture = { demo: cid, id };
    return publishedFixture;
  },
  "seed-published-media": async () => {
    if (mediaFixture !== null) return mediaFixture;
    const cid = "files-published-media";
    if (load(cid) === null) await create(cid, "Published media", rootAgentId());
    await publishTurn(
      cid,
      "chart.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>',
    );
    await publishTurn(cid, "tone.wav", silentWav());
    await publishTurn(cid, "clip.webm", "not a real video");
    mediaFixture = { demo: cid };
    return mediaFixture;
  },
  "seed-published-sizes": async () => {
    const cid = "files-published-sizes";
    if (load(cid) === null) {
      await create(cid, "Published sizes", rootAgentId());
      await publishTurn(cid, "small.bin", new Uint8Array(1024));
      await publishTurn(cid, "large.bin", new Uint8Array(5 * 1024 * 1024));
    }
    return { demo: cid };
  },
  "seed-files-newest-first": async () => {
    const cid = "files-newest-first";
    if (load(cid) === null) {
      await create(cid, "Newest files first", rootAgentId());
      await publishTurn(cid, "report.md", "# Original report\n");
      await seedUpload(
        cid,
        new TextEncoder().encode("Uploaded notes\n"),
        "notes.txt",
      );
      await publishTurn(cid, "summary.md", "# Summary\n");
      await publishTurn(cid, "report.md", "# Updated report\n");
    }
    return { demo: cid };
  },
  "seed-published-versions": async () => {
    const cid = "files-published-versions";
    if (load(cid) === null) {
      await create(cid, "Published versions", rootAgentId());
      for (const draft of [1, 2, 3])
        await publishTurn(cid, "report.md", `# Draft ${draft}\n`);
    }
    return { demo: cid };
  },
  "seed-published-bash": async () => {
    const cid = "files-published-bash";
    if (load(cid) === null) {
      await createDurable(cid, "Published drafts", "fauxfast/faux-1");
      await publishDraftsTurn(cid, {
        "plan.md": "# Plan\n",
        "notes.txt": "notes",
      });
    }
    return { demo: cid };
  },
  "seed-posted-quadrants": async (request) => {
    const cid = `files-quadrants-${hex(4)}`;
    await createDurable(cid, "Published quadrant image", "fauxfast/faux-1");
    const cwd = await mkdtemp(join(tmpdir(), "published-quadrants-"));
    await writeFile(
      join(cwd, "quadrants.png"),
      new Uint8Array(await request.arrayBuffer()),
    );
    durableFast.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("publish", {
            paths: [join(cwd, "quadrants.png")],
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Quadrants published."),
      fauxAssistantMessage("Acknowledged."),
    ]);
    await submitDurable(cid, "Publish the quadrant image.");
    return { demo: cid };
  },
  "seed-posted-pdf": async (request) => {
    const cid = "files-posted-pdf";
    if (load(cid) === null) await create(cid, "Posted PDF", rootAgentId());
    const body = new Uint8Array(await request.arrayBuffer());
    await publishTurn(cid, "report.pdf", body);
    return { demo: cid };
  },
  "seed-published-pdf": async () => {
    if (pdfFixture !== null) return pdfFixture;
    const cid = "files-published-pdf";
    if (load(cid) === null) await create(cid, "Published PDF", rootAgentId());
    await publishTurn(cid, "slides.pdf", rectanglePdf(2));
    await publishTurn(cid, "broken.pdf", "not a PDF");
    await publishTurn(cid, "notes-ja.pdf", japanesePdf());
    await publishTurn(cid, "long.pdf", rectanglePdf(16));
    pdfFixture = { demo: cid };
    return pdfFixture;
  },
  "seed-published-later": async () => {
    const cid = "files-published-later";
    if (load(cid) === null)
      await create(cid, "Later published files", rootAgentId());
    await publishTurn(cid, "first.md", "# First file\n");
    return { demo: cid };
  },
  "publish-later-file": async () => {
    const cid = "files-published-later";
    const name = `later-${hex(6)}.md`;
    const id = await publishTurn(cid, name, `# ${name}\n`);
    return { name, id };
  },
  "seed-files-auto-open": async () => {
    const cid = "files-auto-open";
    if (load(cid) === null) {
      await create(cid, "Auto-opened files", rootAgentId());
      await publishTurn(cid, "earlier.md", "# Earlier\n");
    }
    return { demo: cid };
  },
  "republish-auto-open": async () => {
    autoOpenDraft += 1;
    await publishTurn(
      "files-auto-open",
      "report.md",
      `# Draft ${autoOpenDraft}\n`,
    );
    return { draft: autoOpenDraft };
  },
  "seed-published-image-navigation": async () => {
    const cid = "published-image-navigation";
    if (load(cid) === null) {
      await createDurable(cid, "Published image navigation", "fauxfast/faux-1");
      await publishDraftsTurn(
        cid,
        Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [
            `published-${index + 1}.png`,
            NAVIGATION_IMAGES[index % NAVIGATION_IMAGES.length],
          ]),
        ),
      );
      await publishDraftsTurn(cid, { "next-reply.png": NAVIGATION_IMAGES[0] });
      await publishDraftsTurn(cid, { "published-2.png": NAVIGATION_IMAGES[2] });
      const upload = await seedUpload(
        cid,
        NAVIGATION_IMAGES[1],
        "operator.png",
      );
      durableFast.setResponses([
        fauxAssistantMessage("Operator image received."),
        fauxAssistantMessage("Acknowledged."),
      ]);
      await submitDurable(
        cid,
        `![operator.png](/api/conversations/${cid}/attachments/${upload.id})`,
      );
    }
    return { demo: cid };
  },
  "seed-large-image-gallery": async () => {
    const cid = "large-image-gallery";
    if (load(cid) === null) {
      await createDurable(cid, "Large image gallery", "fauxfast/faux-1");
      await publishDraftsTurn(
        cid,
        Object.fromEntries(
          Array.from({ length: 30 }, (_, index) => [
            `gallery-${index + 1}.png`,
            NAVIGATION_IMAGES[index % NAVIGATION_IMAGES.length],
          ]),
        ),
      );
    }
    return { demo: cid };
  },
  "seed-image-navigation": async () => {
    if (imageNavigationFixture !== null) return imageNavigationFixture;
    const cid = "files-image-navigation";
    if (load(cid) === null)
      await create(cid, "Files image navigation", rootAgentId());
    const names = ["nav-1.png", "nav-2.png", "nav-3.png"];
    const images = [];
    for (const [index, name] of names.entries())
      images.push(await seedUpload(cid, NAVIGATION_IMAGES[index], name));
    const conv = load(cid)!;
    conv.settled_attachment_ids = images.map((image) => image.id);
    await seedPiSession(conv, [
      piUser(
        "browser-image-navigation-user",
        images
          .map(
            (image, index) =>
              `![${names[index]}](/api/conversations/${cid}/attachments/${image.id})`,
          )
          .join("\n"),
        null,
      ),
    ]);
    await save(conv);
    imageNavigationFixture = {
      demo: cid,
      image_ids: images.map((image) => image.id),
    };
    return imageNavigationFixture;
  },
  "append-empty-file": async () => {
    const conv = load("files-empty")!;
    const content = `First durable file\n[empty-agent.txt](/api/conversations/files-empty/attachments/${filesFixture!.empty_text})`;
    conv.settled_attachment_ids = [filesFixture!.empty_text];
    await appendNative(conv, content, "File recorded.");
    await save(conv);
    return { ok: true };
  },
  "remove-empty-file": async () => {
    if (!(await helperApplyClear("files-empty")))
      throw new Error("clear did not land");
    return { ok: true };
  },
  "append-files-message": async () => {
    const conv = load("files-demo")!;
    const content =
      "Browser files source message\n" +
      `[browser-notes.txt](/api/attachments/${filesFixture!.text})\n` +
      `![browser-image.png](/api/attachments/${filesFixture!.image})`;
    await appendNative(conv, content, "Files recorded.");
    conv.updated = nowSeconds();
    await save(conv);
    return { ok: true };
  },
  "seed-stale-thread": async () => {
    const cid = rootAgentId();
    await waitTurn(cid);
    const conv = load(cid)!;
    const stale = await seedUpload(
      cid,
      new TextEncoder().encode("stale attachment\n"),
      "stale.txt",
    );
    const marker = `STALE CLEARED ROW #${hex(8)}`;
    await seedPiSession(
      conv,
      [
        piUser(
          "stale-user",
          `seed stale row\n[stale.txt](/api/conversations/${cid}/attachments/${stale.id})`,
          null,
        ),
        piAssistant("stale-assistant", marker, "stale-user"),
      ],
      `browser-stale-${hex()}`,
      CHECKOUT_ROOT,
    );
    conv.updated = nowSeconds();
    await save(conv);
    await readoptBinding(cid, conv);
    return { ok: true, marker };
  },
  "synchronous-clear": async () => {
    if (!(await helperApplyClear(rootAgentId())))
      throw new Error("clear did not land");
    return { ok: true };
  },
  "seed-bulk-thread": async () => {
    const cid = rootAgentId();
    await waitTurn(cid);
    const conv = load(cid)!;
    const stale = await seedUpload(
      cid,
      new TextEncoder().encode("stale attachment\n"),
      "stale.txt",
    );
    const entries: Json[] = [];
    let parent: string | null = null;
    for (let n = 0; n < 300; n++) {
      entries.push(
        piUser(`bulk-u${n}`, `bulk filler ${n} ` + "x".repeat(1024), parent),
      );
      entries.push(
        piAssistant(
          `bulk-a${n}`,
          `bulk answer ${n} ` + "y".repeat(1024),
          `bulk-u${n}`,
        ),
      );
      parent = `bulk-a${n}`;
    }
    entries.push(
      piUser(
        "stale-user",
        `seed stale row\n[stale.txt](/api/conversations/${cid}/attachments/${stale.id})`,
        parent,
      ),
    );
    const marker = `STALE CLEARED ROW #${hex(8)}`;
    entries.push(piAssistant("stale-assistant", marker, "stale-user"));
    await seedPiSession(conv, entries, `browser-bulk-${hex()}`, CHECKOUT_ROOT);
    conv.updated = nowSeconds();
    await save(conv);
    await readoptBinding(cid, conv);
    return { ok: true, marker };
  },
  "seed-reveal-backfill": async () => {
    const cid = `reveal-backfill-${hex(8)}`;
    await create(cid, "Reveal backfill", rootAgentId());
    const commentary =
      "Stage0 reveal-backfill marker: the eye must load this reply.";
    const filler = Array.from(
      { length: 220 },
      (_, n) =>
        `filler line ${n} pads the running tail so the viewport fills. token ${cid} end.`,
    ).join(" ");
    const call = (id: string, name: string, args: Json) => ({
      type: "toolCall",
      id,
      name,
      arguments: args,
    });
    const result = (id: string, parentId: string, text: string) => ({
      type: "message",
      id,
      parentId,
      message: { role: "toolResult", content: text },
    });
    const assistant = (
      id: string,
      parentId: string,
      content: Json[],
      stopReason: string,
    ) => ({
      type: "message",
      id,
      parentId,
      message: { role: "assistant", content, stopReason },
    });
    const agentNote = (body: string) =>
      `[recurse-origin: agent]\n[recurse-from: kid123]\n[recurse-from-name: Kid]\n${body}`;
    const conv = load(cid)!;
    await seedPiSession(
      conv,
      [
        piUser("rb-u1", "Please fix the frontend reveal bug.", null),
        assistant(
          "rb-a1",
          "rb-u1",
          [
            { type: "text", text: "Reviewing the reveal path now." },
            call("rb-c1", "read", { path: "web/conversation.ts" }),
          ],
          "toolUse",
        ),
        result("rb-r1", "rb-a1", "read ok"),
        assistant(
          "rb-a2",
          "rb-r1",
          [
            { type: "text", text: commentary },
            call("rb-c2", "bash", { command: "git fetch origin main" }),
          ],
          "toolUse",
        ),
        result("rb-r2", "rb-a2", "fetch ok"),
        piUser(
          "rb-u2",
          agentNote("Child report one: baseline green."),
          "rb-r2",
        ),
        assistant(
          "rb-a3",
          "rb-u2",
          [call("rb-c3", "grep", { pattern: "turn-eye" })],
          "toolUse",
        ),
        result("rb-r3", "rb-a3", "grep ok"),
        piUser(
          "rb-u3",
          agentNote("Child report two: fixtures ready."),
          "rb-r3",
        ),
        assistant(
          "rb-a4",
          "rb-u3",
          [call("rb-c4", "bash", { command: "git fetch origin main" })],
          "toolUse",
        ),
        result("rb-r4", "rb-a4", "fetch ok"),
        assistant("rb-a5", "rb-r4", [{ type: "text", text: filler }], "stop"),
      ],
      `browser-reveal-${hex()}`,
    );
    conv.status = "running";
    conv.updated = nowSeconds();
    await save(conv);
    reads.viewCache.drop(cid);
    await readoptBinding(cid, conv);
    return { agent: cid };
  },
  "seed-model-selection-error": async (request) => {
    const body = (await request.json()) as { agent: string; model: string };
    await createDurable(body.agent, "Choose a model", "fauxordinary/faux-1");
    const conv = load(body.agent)!;
    conv.level = null;
    conv.model = body.model;
    conv[SET_MODEL_MARKER] = true;
    await save(conv);
    durableModel.set(body.agent, null);
    return { agent: body.agent };
  },
  "seed-durable": async () => {
    await createDurable("durable-demo", "Durable demo", "faux/faux-1");
    const held = new Promise<void>((resolve) => (durableGate = resolve));
    durableFaux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("**Listing the files**\nI will run a short command."),
          fauxToolCall(
            "bash",
            { command: "printf 'tick 1\\n'; sleep 3; printf 'tick 2\\n'" },
            { id: "durable-bash" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      async () => {
        await held;
        return fauxAssistantMessage(
          [
            fauxText(
              "Durable answer: the command printed two ticks. " +
                "It ran in the work directory. ".repeat(12) +
                "This sentence streams slowly so the live answer shows.",
            ),
          ],
          {},
        );
      },
      fauxAssistantMessage("Second durable answer."),
    ]);
    return { agent: "durable-demo" };
  },
  "seed-published-diff": async () => {
    const agent = "published-diff";
    if (load(agent)) return { demo: agent };
    await createDurable(agent, "Published diff", "fauxfast/faux-1");
    const cwd = await mkdtemp(join(tmpdir(), "published-diff-"));
    await writeFile(
      join(cwd, "old.py"),
      'def report():\n    return "old report with a sufficiently long description"\n'.repeat(
        650,
      ),
    );
    await writeFile(
      join(cwd, "new.py"),
      'def report():\n    return "new report with a sufficiently long description"\n'.repeat(
        650,
      ),
    );
    durableFast.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command: `cd ${JSON.stringify(cwd)}; printf '%s\\n' '-- old' > before.txt; printf '%s\\n' '++ new' > after.txt; git diff --no-index -- before.txt after.txt > review.diff; git diff --no-index -- old.py new.py >> review.diff; cp review.diff review.patch; cp review.diff review.txt`,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("publish", {
            paths: ["review.diff", "review.patch", "review.txt"].map((name) =>
              join(cwd, name),
            ),
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("The Python diff is attached."),
    ]);
    await submitDurable(agent, "Publish the Python diff.");
    return { demo: agent };
  },
  "seed-visible-attachments": async () => {
    const agent = "visible-attachments";
    await createDurable(agent, "Visible attachments", "fauxfast/faux-1");
    const conv = load(agent)!;
    const image = await seedUpload(
      agent,
      NAVIGATION_IMAGES[0],
      "report-image.png",
    );
    durableFast.setResponses([
      fauxAssistantMessage("I will collect reports."),
      ...["first-report.txt", "second-report.txt"].flatMap((name) => [
        fauxAssistantMessage(
          [
            fauxText(`Preparing ${name}.`),
            fauxToolCall("write", {
              path: name,
              content: "Published report\n",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxToolCall("publish", { paths: [name] })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(`${name} is ready.`),
      ]),
    ]);
    await appendNative(conv, "Collect reports.", "I will collect reports.");
    for (const name of ["first-report.txt", "second-report.txt"])
      await submitDurable(
        agent,
        `[recurse-origin: ${name.startsWith("first") ? "agent" : "platform"}]\n[recurse-from: child]\n![${name} image](/api/conversations/${agent}/attachments/${image.id})`,
      );
    return { agent };
  },
  "seed-folded-images": async () => {
    const agent = "folded-images";
    await createDurable(agent, "Folded images", "fauxfast/faux-1");
    const image = await seedUpload(agent, NAVIGATION_IMAGES[0], "folded.png");
    const href = `/api/conversations/${agent}/attachments/${image.id}`;
    for (const origin of ["operator", "platform"]) {
      durableFast.setResponses([
        ...["first", "middle", "last"].map((part) =>
          fauxAssistantMessage(
            [
              fauxText(
                `Hidden ${origin} ${part} prose.\n\n` +
                  (part === "middle"
                    ? `![${origin}-${part}][shot]\n\n[shot]: ${href}`
                    : `![${origin}-${part}](${href})`),
              ),
              fauxToolCall("bash", { command: "printf image-step" }),
            ],
            { stopReason: "toolUse" },
          ),
        ),
        fauxAssistantMessage(`${origin} images finished.`),
      ]);
      await submitDurable(
        agent,
        `[recurse-origin: ${origin}]\nShow the images.`,
      );
    }
    return { agent };
  },
  "seed-durable-queued-agent": async () => {
    await createDurable("durable-queued", "Queued repro", "fauxfast/faux-1");
    const call = fauxToolCall("bash", { command: "sleep 8" });
    durableFast.setResponses([
      fauxAssistantMessage([call], { stopReason: "toolUse" }),
      fauxAssistantMessage("PARENT_COMPLETE"),
    ]);
    return { agent: "durable-queued", sender: rootAgentId() };
  },
  "durable-platform-note": async () => {
    await instance.durable.send(
      "durable-queued",
      "[recurse-origin: platform]\nA platform update is waiting for the next boundary.",
      "queued-platform",
    );
    return { ok: true };
  },
  "seed-durable-inspector": async () => {
    const agent = "durable-inspector";
    await createDurable(agent, "Inspector child", "fauxfast/faux-1");
    let delivered: unknown;
    durableFast.setResponses([
      (request) => {
        delivered = request.messages.find(
          (message) => message.role === "user",
        )?.content;
        return fauxAssistantMessage("Parent input received.");
      },
    ]);
    await instance.delivery.deliver(agent, "INSPECT_PARENT_INPUT", {
      origin: "agent",
      sender: rootAgentId(),
    });
    const end = Date.now() + 10000;
    while (delivered === undefined && Date.now() < end) await Bun.sleep(20);
    if (delivered === undefined)
      throw new Error("Parent input was not delivered");
    const { conversation } = await instance.durable.open(agent);
    const entries = await conversation.entries(
      {},
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const stored = entries.items.find(
      (entry) => entry.model?.[0]?.role === "user",
    )?.model?.[0]?.content;
    return { agent, delivered, stored };
  },
  "seed-provider-replay": async (request) => {
    const body = (await request.json()) as {
      name: RecordingName;
      copies?: number;
    };
    if (
      !recordingNames.includes(body.name) ||
      ![1, 2].includes(body.copies ?? 1)
    )
      throw new Error("Invalid recording");
    const replay = await recordedModels(body.name, body.copies ?? 1);
    durableModels.setProvider(replay.provider);
    const cid = `provider-replay-${hex(4)}`;
    recordedRuns.set(cid, replay);
    await createDurable(cid, "Recorded provider", replay.modelId);
    const conv = await conversations.load(cid);
    await writeFile(
      join(String(conv!.workdir), "live-seed.txt"),
      "E2E_FINDABLE ALPHA_ORBITAL\nE2E_SECOND BETA\n",
    );
    return { agent: cid };
  },
  "provider-replay-status": async (request) => {
    const { agent, close, message } = (await request.json()) as {
      agent: string;
      close?: boolean;
      message?: string;
    };
    const replay = recordedRuns.get(agent)!;
    if (message)
      await instance.delivery.deliver(agent, message, {
        origin: "agent",
        sender: rootAgentId(),
      });
    if (close) {
      replay.replay.assertComplete();
      replay.close();
    }
    return {
      requests: replay.replay.requests.length,
      failures: replay.replay.failures,
    };
  },
  "seed-safety-review": async () => {
    const cid = `safety-browser-${hex(4)}`;
    const faux = fauxProvider({ provider: cid, tokensPerSecond: 20_000 });
    let unavailable = true;
    const reply: import("@earendil-works/pi-ai").FauxResponseFactory = (
      context,
    ) => {
      faux.appendResponses([reply]);
      if (
        JSON.stringify(context).includes(
          "untrusted record of a user's interaction",
        )
      ) {
        if (unavailable) {
          unavailable = false;
          throw new Error("Reviewer provider error");
        }
        return fauxAssistantMessage("OK");
      }
      return context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("SAFETY_TURN_DONE")
        : fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: "printf SAFETY_TOOL_RAN > safety-state.txt",
              }),
            ],
            { stopReason: "toolUse" },
          );
    };
    faux.setResponses([reply]);
    durableModels.setProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Test reviewer",
          resolve: async () => ({
            auth: { apiKey: "browser-test" },
            source: "browser fixture",
          }),
        },
      },
    });
    await createDurable(cid, "Safety reviewer availability", `${cid}/faux-1`);
    return { agent: cid };
  },
  "seed-model-response": async (request) => {
    const body = (await request.json()) as {
      agent?: string;
      downgrade: boolean;
    };
    const cid = body.agent ?? `model-response-${hex(4)}`;
    if (!body.agent)
      await createDurable(cid, "Recorded model response", "fauxfast/faux-1");
    const { conversation } = await instance.durable.open(cid);
    const message = await replayResponse(body.downgrade);
    const entry = await conversation.commit(
      (tx) =>
        tx.appendEntry(conversation.id, {
          kind: "pi.assistant",
          model: [message],
        }),
      BACKGROUND_CONTEXT,
    );
    return { agent: cid, entryId: entry.id };
  },
  "server-log": async () => {
    console.log("browser server stdout probe");
    console.error("browser server stderr probe");
    return { ok: true };
  },
  "seed-durable-thinking": async (request) => {
    const agent =
      new URL(request.url).searchParams.get("agent") ?? "durable-thinking";
    thinkingCommit = new Promise<void>(
      (resolve) => (releaseThinkingCommit = resolve),
    );
    const recorded = await import("./fixtures/thinking-stream.json");
    await createDurable(agent, "Thinking stream", "fauxthinking/faux-1");
    const held = new Promise<void>((resolve) => (durableGate = resolve));
    durableThinking.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking(recorded.thinking),
          fauxToolCall(
            "bash",
            { command: recorded.command },
            { id: "thinking-bash" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      async () => {
        await held;
        return fauxAssistantMessage(
          [
            fauxThinking(recorded.thinking),
            fauxToolCall(
              "bash",
              { command: "sleep 20" },
              { id: "thinking-bash" },
            ),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("Thinking stream finished."),
    ]);
    return { agent };
  },
  "durable-thinking-commit": async () => {
    releaseThinkingCommit();
    return { ok: true };
  },
  "durable-thinking-cleanup": async (request) => {
    const agent =
      new URL(request.url).searchParams.get("agent") ?? "durable-thinking";
    releaseThinkingCommit();
    durableGate();
    await instance.durable.stop(agent);
    await instance.durable.stopProcesses(agent);
    return { ok: true };
  },
  "seed-durable-clear": async () => {
    await createDurable("durable-clear", "Durable clear", "fauxfast/faux-1");
    durableFast.setResponses([
      fauxAssistantMessage("Before Durable clear."),
      fauxAssistantMessage("After Durable clear."),
    ]);
    return { agent: "durable-clear" };
  },
  "seed-durable-rejected": async (request) => {
    const params = new URL(request.url).searchParams;
    const agent = params.get("agent")!;
    const failure =
      params.get("kind") === "overloaded"
        ? fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage:
              '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
          })
        : {
            ...fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "The model refused to complete the request",
            }),
            rawStopReason: "refusal",
          };
    await createDurable(agent, "Durable rejected", "fauxfast/faux-1");
    durableFast.setResponses([
      fauxAssistantMessage("First answer."),
      ...Array.from(
        { length: params.get("kind") === "overloaded" ? 4 : 1 },
        () => failure,
      ),
      (context) =>
        fauxAssistantMessage(
          JSON.stringify(context.messages).includes("Rejected question")
            ? "The rejected question is in my context."
            : "The rejected question is not in my context.",
        ),
    ]);
    return { agent };
  },
  "seed-script-read-diagnostics": async () => {
    const agent = `script-read-${hex(4)}`;
    await writeFile(
      join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          probe: {
            command: process.execPath,
            args: [
              join(import.meta.dir, "../backend/fixtures/mcp_probe_server.mjs"),
            ],
          },
        },
      }),
    );
    await createDurable(
      agent,
      "Script and read diagnostics",
      "fauxfast/faux-1",
    );
    await instance.durable.setSafetyReviewOff(agent, true);
    const file = join(
      await mkdtemp(join(tmpdir(), "read-diagnostics-")),
      "note.txt",
    );
    await writeFile(file, "first\nsecond\nthird\n");
    durableFast.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("read", { path: file, limit: 1 }),
          fauxToolCall("codemode", {
            code: `await tools.write({ path: ${JSON.stringify(file)}, content: 'written'.repeat(100) }); await tools.bash({ command: 'printf nested' }); for (let i = 0; i < 101; i++) await tools.mcp__probe__echo({ text: 'nested' }); await tools.bash({ command: 'printf tail' });`,
          }),
          fauxToolCall("codemode", { code: "return 'no nested calls'" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Script and read finished."),
    ]);
    return { agent };
  },
  "clear-script-read-diagnostics": async (request) => {
    const { agent } = (await request.json()) as { agent: string };
    if (!(await instance.durable.retire(agent)))
      throw new Error("Script host did not retire");
    await writeFile(
      join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"),
      JSON.stringify({ mcpServers: {} }),
    );
    return { ok: true };
  },
  "seed-live-tools": async (request) => {
    const { mode = "long" } = (await request.json()) as { mode?: string };
    const agent = `live-tools-${mode}-${hex(4)}`;
    await createDurable(agent, "Live tools", "fauxfast/faux-1");
    const outputGate = mode.includes("output")
      ? join(
          await agentTemp.agentTempPath(conversations.load(agent)!),
          "live-output-ready",
        )
      : undefined;
    const commands = mode.includes("output")
      ? Array.from(
          {
            length:
              mode === "many-output" ? 3 : mode === "background-output" ? 2 : 1,
          },
          (_, i) =>
            `printf '%020000d\\n' 0; printf 'line-%s\\n' 1 2 3 4 5 6 7 8 9; while [ ! -f '${outputGate!.replaceAll("'", "'\\''")}' ]; do sleep 0.05; done; printf '${mode === "secret-output" ? "token=sk-example123456789" : `latest-${i}`}\\n'; sleep 30 # ${"safe ".repeat(430)}END_OF_COMMAND`,
        )
      : ["sleep 30"];
    const held = new Promise<void>((resolve) => (durableGate = resolve));
    durableFast.setResponses([
      fauxAssistantMessage(
        commands.map((command, i) =>
          fauxToolCall("bash", {
            command,
            ...(mode === "background-output" && i === 0
              ? { background: true }
              : {}),
          }),
        ),
        { stopReason: "toolUse" },
      ),
      () => held.then(() => fauxAssistantMessage("Live tools finished.")),
    ]);
    return { agent, outputGate };
  },
  "seed-durable-stop": async (request) => {
    const agent =
      new URL(request.url).searchParams.get("agent") ?? "durable-stop";
    await createDurable(agent, "Durable stop", "fauxfast/faux-1");
    const call = fauxToolCall("bash", { command: "sleep 31.25" });
    const toolUse = { stopReason: "toolUse" } as const;
    durableFast.setResponses([fauxAssistantMessage([call], toolUse)]);
    return { agent };
  },
  "durable-release": async () => {
    durableGate();
    return { ok: true };
  },
  "seed-pi-twin": async () => {
    const cid = "pi-twin";
    if (load(cid) === null) await create(cid, "Pi twin", rootAgentId());
    const { conversation } = await instance.durable.open("durable-demo");
    const page = await conversation.entries(
      {},
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const entries: Json[] = [];
    let parentId: string | null = null;
    for (const entry of [...page.items].reverse()) {
      const message = entry.model?.[0];
      if (!message || entry.kind === "pi.system") continue;
      const id = `twin-${entry.id}`;
      entries.push({ type: "message", id, parentId, message });
      parentId = id;
    }
    const conv = load(cid)!;
    await seedPiSession(conv, entries, `pi-twin-${hex()}`);
    await save(conv);
    reads.viewCache.drop(cid);
    await readoptBinding(cid, conv);
    return { agent: cid };
  },
  "forget-conversation-request": async (request) => {
    const { agent } = (await request.json()) as { agent: string };
    (await instance.durable.open(agent)).captures.forget(agent);
    return { ok: true };
  },
  "seed-conversation-title": async () => {
    const [selected] = instance.config.resolveEffortLevel(1);
    const slash = selected.indexOf("/");
    const naming = fauxProvider({
      provider: selected.slice(0, slash),
      models: [{ id: selected.slice(slash + 1) }],
      tokensPerSecond: 20_000,
    });
    naming.setResponses([fauxAssistantMessage(titleRecording.rawReply)]);
    durableModels.setProvider(naming.provider);
    return { title: titleRecording.appliedTitle };
  },
  "seed-durable-context": async () => {
    const cid = "durable-context";
    const model = instance.config.chatSettings(null)[0];
    const [provider, ...id] = model.split("/");
    const faux = fauxProvider({
      provider,
      models: [{ id: id.join("/") }],
      tokensPerSecond: 20_000,
    });
    durableModels.setProvider(faux.provider);
    await createDurable(cid, "Recorded Durable context", model);
    const { storage } = await instance.durable.open(cid);
    await storage.commit(
      contextEntries.map((value) => ({ type: "entry" as const, value })),
      BACKGROUND_CONTEXT,
    );
    faux.setResponses([contextEntries.at(-2)!.model![0] as AssistantMessage]);
    await submitDurable(cid, "Placeholder operator input");
    return {
      agent: cid,
      tokens: promptTokens((await instance.durable.contextUsage(cid)).usage),
    };
  },
  "seed-side-history": async () => {
    const cid = "side-history";
    await createDurable(cid, "Side history", "fauxfast/faux-1");
    for (let n = 0; n < 70; n += 1)
      await sayDurable(
        cid,
        `Side history question ${n}`,
        `Side history answer ${n}`,
      );
    return { agent: cid };
  },
  "seed-durable-history": async (request) => {
    const body = (await request.json().catch(() => ({}))) as {
      agent?: string;
      neighbours?: number;
    };
    const cid = body.agent ?? "durable-history";
    await createDurable(cid, "Durable history", "fauxfast/faux-1");
    for (let n = 0; n < (body.neighbours ?? 0); n += 1)
      await create(`${cid}-${n}`, `Neighbour ${n}`, rootAgentId());
    await create(`${cid}-kid`, "Kid", cid);
    for (let n = 0; n < 60; n += 1) await sayDurableHistory(cid, n);
    await compactDurableHistory(cid, "Summary of turns 0-19.");
    for (let n = 60; n < 70; n += 1) await sayDurableHistory(cid, n);
    return { agent: cid };
  },
  "durable-history-more": async (request) => {
    const body = (await request.json()) as {
      agent: string;
      from: number;
      to: number;
      compact?: boolean;
      report?: boolean;
    };
    for (let n = body.from; n < body.to; n += 1)
      await sayDurableHistory(body.agent, n, body.report);
    if (body.compact)
      await compactDurableHistory(body.agent, `Summary before ${body.to}.`);
    return { ok: true };
  },
  "seed-durable-compactable": async () => {
    const cid = "durable-compactable";
    await createDurable(cid, "Durable compactable", "fauxfast/faux-1");
    for (let n = 0; n < 30; n += 1)
      await sayDurable(cid, `Task ${n} ${"y".repeat(4000)}`, `Reply ${n}`);
    const held = new Promise<void>((resolve) => (durableGate = resolve));
    durableFast.setResponses([
      async () => {
        await held;
        return fauxAssistantMessage("Summary of the early tasks.");
      },
    ]);
    return { agent: cid };
  },
  "durable-summary-release": async () => {
    durableGate();
    return { ok: true };
  },
  "seed-context-viewer": async () => {
    const rootId = rootAgentId();
    const conv = load(rootId)!;
    if (load("context-other") === null)
      await create("context-other", "Context other", rootId);
    conv.model = "openai-codex/gpt-5.6-sol";
    conv.latest_context_usage = {
      input: 41_800,
      output: 1_200,
      cacheRead: 298_000,
      cacheWrite: 2_000,
      selectors: ["openai-codex/gpt-5.6-sol"],
      selectorPartial: false,
    };
    await seedPiSession(conv, [
      piUser("browser-context-user", "Browser context category input", null),
      piAssistant(
        "browser-context-reply",
        "Browser context category response",
        "browser-context-user",
      ),
    ]);
    await save(conv);
    return { ok: true };
  },
};

let ready = false;
for (const [name, work] of Object.entries(routes)) {
  const handler: Handler = async (ex) => jsonResponse(await work(ex.request));
  router.post(`/__browser-test/${name}`, handler);
}
router.get("/__browser-test/ready", async () =>
  jsonResponse({ ready }, ready ? 200 : 503),
);

const running = await app.serve({
  host: "127.0.0.1",
  port,
  installSignals: true,
});
await publishLoopbackToken(instance.config.paths.DATA_DIR, running.port);
process.send?.({ type: "browser-test-listening", port: running.port });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    running.close().finally(() => {
      const stopped = (globalThis as { browserTestServerStopped?: () => void })
        .browserTestServerStopped;
      if (stopped) stopped();
      else process.exit(0);
    });
  });
while (!instance.lifecycle.readinessSnapshot().ready) await Bun.sleep(50);
if (load("main") === null) await create("main", "Agent", null);
ready = true;
