import { spawn } from "node:child_process";
import { Config } from "../src/config.ts";
import { createInterface } from "node:readline";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  InMemoryCredentialStore,
  type Usage,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { systemBeforeUserHook } from "../src/agents/durable/system_order.ts";
import { Prompts, type PromptsDeps } from "../src/agents/runtime/prompts";
import { AgentTools, type AgentToolsDeps } from "../src/agents/tools";
import {
  captureMemorySnapshot,
  renderMemoryPrompt,
} from "../src/agents/runtime/memory_snapshot";
import { projectStatuses } from "../src/agents/tree_view";
import { escapeReminderMarkers } from "../src/reminder_text";
import {
  assertAuthUnchanged,
  assertOAuthCredentialsFresh,
  authSnapshot,
  liveModel,
  ROOT,
} from "./live_e2e_helpers.ts";

const settings = new Config();
const PROVIDER = "anthropic";
let MODEL: string;
const THINKING = "low";
const NOW = 1_791_300_000;
const PI_CLI = join(
  ROOT,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const PROMPTS = [
  "Without tools, reply with exactly ALPHA.",
  "Without tools, reply with exactly BETA.",
  "Without tools, list the ids of your immediate child agents from the agent tree digest, comma separated, nothing else.",
  "Without tools, reply with exactly DELTA.",
];

type Conv = Record<string, unknown>;
type TurnUsage = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
};
const zero = (): TurnUsage => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  cost: 0,
});
const add = (sum: TurnUsage, usage: Partial<Usage> | undefined): TurnUsage => ({
  input: sum.input + (usage?.input ?? 0),
  cacheRead: sum.cacheRead + (usage?.cacheRead ?? 0),
  cacheWrite: sum.cacheWrite + (usage?.cacheWrite ?? 0),
  output: sum.output + (usage?.output ?? 0),
  cost: sum.cost + (usage?.cost?.total ?? 0),
});

export async function recurseSections(
  root: string,
  repo: string,
  dataDir: string,
  changed: boolean,
): Promise<Record<string, string>> {
  const cid = "a1b2c3d4e5f6";
  const parent = {
    id: "0f0e0d0c0b0a",
    title: "Coordinator",
    status: "running",
    updated: NOW - 60,
  };
  const self: Conv = {
    id: cid,
    parent: parent.id,
    title: "durable-cache-probe",
    status: "running",
    level: 4,
    updated: NOW,
  };
  const children: Conv[] = [
    {
      id: "c0ffee000001",
      parent: cid,
      title: "probe-child-one",
      status: "idle",
      updated: NOW - 300,
    },
  ];
  if (changed)
    children.push({
      id: "c0ffee000002",
      parent: cid,
      title: "probe-child-two",
      status: "running",
      updated: NOW - 5,
    });
  const ladder = Object.fromEntries(
    Object.entries(settings.effortLevels()).map(([level, entry]) => [
      level,
      { ...entry, reachable: true },
    ]),
  );
  const config = {
    repoUrl: repo,
    paths: {
      TOOLS_DIR: join(ROOT, "tools"),
      AGENTS_MD: join(repo, "AGENTS.md"),
      CONFIG_DIR: join(root, "config"),
    },
    effortLevelReachability: () => ladder,
    defaultEffortLevel: () => 3,
    chatModels: () => settings.chatModels(),
    resolveEffortLevel: (level: number) => [
      ladder[level]!.model,
      ladder[level]!.reasoning,
    ],
  };
  const agentTools = await AgentTools.create({
    config,
    gitReady: () => true,
    targetIsGitRepo: () => true,
  } as unknown as AgentToolsDeps);
  const prompts = new Prompts({
    displayName: "Recurse",
    dataDir,
    toolsDir: join(ROOT, "tools"),
    toolsSection: () => agentTools.toolsSection(),
    conversationEffortLine: (conv: Conv) =>
      agentTools.conversationEffortLine(conv),
    projectStatuses,
    effectiveWorkdir: () => repo,
    memoryPrompt: async (id: string) =>
      renderMemoryPrompt(await captureMemorySnapshot(id, dataDir), dataDir),
    now: () => NOW,
  } as unknown as PromptsDeps);
  const convs = [parent, self, ...children];
  return {
    recurse_agent: escapeReminderMarkers(prompts.buildContextBlock(self)),
    recurse_memory: escapeReminderMarkers(
      await prompts.captureMemoryPrompt(self),
    ),
    recurse_runtime: escapeReminderMarkers(
      prompts.runtimeContextBlock(self, repo),
    ),
    recurse_tree: escapeReminderMarkers(
      prompts.treeDigestSnapshot(self, { convs, live: {} }),
    ),
    recurse_tools: escapeReminderMarkers(prompts.recurseToolsSection()),
  };
}

const SECTIONS_EXTENSION = `import { readFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_agent_start", (event) => {
    const sections = JSON.parse(readFileSync(process.env.PROBE_SECTIONS_FILE, "utf8"));
    for (const [name, value] of Object.entries(sections)) event.systemPromptOptions.sections[name] = value;
  });
}
`;

function replay(rows: Record<string, any>[]): Map<string, string> {
  const shown = new Map<string, string>();
  for (const row of rows) {
    const message = row.message;
    if (message?.role !== "system" || !message.sections) continue;
    for (const [name, value] of Object.entries(
      message.sections as Record<string, string | null>,
    )) {
      if (value === null) shown.delete(name);
      else shown.set(name, value);
    }
  }
  return shown;
}

async function piPath(o: {
  root: string;
  repo: string;
  agentDir: string;
  skills: string[];
  foreword: string;
  sections: (turn: number) => Promise<Record<string, string>>;
}) {
  const sessionDir = join(o.root, "pi-sessions");
  const sectionsFile = join(o.root, "sections.json");
  const extension = join(o.root, "probe-sections.mjs");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(extension, SECTIONS_EXTENSION);
  await writeFile(sectionsFile, JSON.stringify(await o.sections(0)));
  const argv = [
    PI_CLI,
    "--no-approve",
    "--mode",
    "rpc",
    "--model",
    `${PROVIDER}/${MODEL}`,
    "--provider",
    PROVIDER,
    "--thinking",
    THINKING,
  ];
  argv.push(
    "--system-prompt",
    o.foreword,
    "--session-dir",
    sessionDir,
    "--no-extensions",
    "-e",
    extension,
  );
  for (const path of o.skills) argv.push("--skill", path);
  const child = spawn(process.execPath, argv, {
    cwd: o.repo,
    env: {
      PATH: process.env.PATH!,
      HOME: o.root,
      PI_CODING_AGENT_DIR: o.agentDir,
      PI_OFFLINE: "1",
      PROBE_SECTIONS_FILE: sectionsFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const lines = createInterface({ input: child.stdout });
  const events: Record<string, any>[] = [];
  let wake: (() => void) | null = null;
  lines.on("line", (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      return;
    }
    wake?.();
  });
  const next = async (match: (event: Record<string, any>) => boolean) => {
    for (;;) {
      const at = events.findIndex(match);
      if (at >= 0) return events.splice(0, at + 1);
      if (child.exitCode !== null)
        throw new Error(`pi exited: ${stderr.slice(-2000)}`);
      await new Promise<void>((done) => {
        wake = done;
        setTimeout(done, 1000);
      });
    }
  };
  const turns: { usage: TurnUsage; reply: string; requests: number }[] = [];
  const snapshots: Map<string, string>[] = [];
  try {
    for (let turn = 0; turn < PROMPTS.length; turn++) {
      await writeFile(sectionsFile, JSON.stringify(await o.sections(turn)));
      child.stdin.write(
        JSON.stringify({
          id: `t${turn}`,
          type: "prompt",
          message: PROMPTS[turn],
        }) + "\n",
      );
      const batch = await next((event) => event.type === "agent_end");
      const assistant = batch
        .filter(
          (event) =>
            event.type === "message_end" && event.message?.role === "assistant",
        )
        .map((event) => event.message);
      if (assistant.some((message) => message.stopReason === "error"))
        throw new Error(`pi provider error: ${assistant.at(-1)?.errorMessage}`);
      turns.push({
        usage: assistant.reduce(
          (sum, message) => add(sum, message.usage),
          zero(),
        ),
        reply: assistant
          .map((message) =>
            (message.content ?? [])
              .filter((block: any) => block.type === "text")
              .map((block: any) => block.text)
              .join(""),
          )
          .join("\n"),
        requests: assistant.length,
      });
      const [file] = (await readdir(sessionDir, { recursive: true })).filter(
        (name) => String(name).endsWith(".jsonl"),
      );
      const rows = (await readFile(join(sessionDir, String(file)), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      snapshots.push(replay(rows));
    }
  } finally {
    const exited = new Promise((done) => child.once("exit", done));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
  }
  return { turns, snapshots };
}

async function durablePath(o: {
  repo: string;
  credential: Record<string, unknown>;
  snapshots: Map<string, string>[];
  reorder: boolean;
}) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => o.credential as never);
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(anthropicProvider());
  const requests: {
    systemMessages: number;
    messages: number;
    payload?: unknown;
  }[] = [];
  const capture = new Proxy(models, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== "stream" && key !== "streamSimple")
        return typeof value === "function" ? value.bind(target) : value;
      return (
        model: unknown,
        request: { messages: { role: string }[] },
        options: {
          onPayload?: (payload: unknown, model: unknown) => unknown;
        } = {},
      ) => {
        const record: {
          systemMessages: number;
          messages: number;
          payload?: unknown;
        } = {
          systemMessages: request.messages.filter(
            (message) => message.role === "system",
          ).length,
          messages: request.messages.length,
        };
        requests.push(record);
        return value.call(target, model, request, {
          ...options,
          onPayload: (payload: unknown, payloadModel: unknown) => {
            record.payload = structuredClone(payload);
            return options.onPayload?.(payload, payloadModel);
          },
        });
      };
    },
  });
  let current = o.snapshots[0]!;
  const names = [
    ...new Set(o.snapshots.flatMap((snapshot) => [...snapshot.keys()])),
  ];
  const recurse = defineExtension({
    name: "recurse-sections",
    sections: names.map((name) =>
      section(name, () => current.get(name), { tag: false }),
    ),
    hooks: o.reorder ? [systemBeforeUserHook] : [],
  });
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(recurse);
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: capture,
      registry,
      env: () => new NodeExecutionEnv({ cwd: o.repo }),
      settings: { compaction: { enabled: false } },
    },
    context,
  );
  const turns: { usage: TurnUsage; reply: string; requests: number }[] = [];
  try {
    const conversation = await harness.root(context, {
      agent: {
        model: { provider: PROVIDER, modelId: MODEL },
        thinkingLevel: THINKING,
        cwd: o.repo,
      },
    });
    for (let turn = 0; turn < PROMPTS.length; turn++) {
      current = o.snapshots[turn]!;
      const before = requests.length;
      const usage = await harness.usage(context);
      const prior = (usage.models[`${PROVIDER}/${MODEL}`] ??
        {}) as Partial<Usage>;
      const settled = await (
        await conversation.submit(
          { type: "input", content: PROMPTS[turn]!, requestId: `turn-${turn}` },
          context,
        )
      ).wait(context);
      if (settled.status !== "done")
        throw new Error(
          `durable turn ${turn + 1}: ${JSON.stringify(settled).slice(0, 500)}`,
        );
      const after = (await harness.usage(context)).models[
        `${PROVIDER}/${MODEL}`
      ] as Usage;
      const answer = (await conversation.context(context)).messages.findLast(
        (message) => message.role === "assistant",
      );
      turns.push({
        usage: {
          input: after.input - (prior.input ?? 0),
          cacheRead: after.cacheRead - (prior.cacheRead ?? 0),
          cacheWrite: after.cacheWrite - (prior.cacheWrite ?? 0),
          output: after.output - (prior.output ?? 0),
          cost: after.cost.total - (prior.cost?.total ?? 0),
        },
        reply:
          answer?.role === "assistant"
            ? answer.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("")
            : "",
        requests: requests.length - before,
      });
    }
  } finally {
    await harness.close(context);
  }
  return { turns, requests };
}

async function run(): Promise<void> {
  const [source = process.env.PI_CODING_AGENT_DIR, destination] =
    process.argv.slice(2);
  const authFile = source ? join(resolve(source), "auth.json") : "";
  const found =
    authFile &&
    (await access(authFile).then(
      () => true,
      () => false,
    ));
  const credential = found
    ? JSON.parse(await readFile(authFile, "utf8"))[PROVIDER]
    : undefined;
  if (credential?.type !== "oauth") {
    console.log(
      "skip: no Anthropic OAuth credential in AUTH_DIRECTORY/auth.json",
    );
    return;
  }
  MODEL = liveModel(PROVIDER, settings).route.modelId;
  const auth = JSON.stringify({ [PROVIDER]: credential });
  assertOAuthCredentialsFresh(auth);
  const snapshot = authSnapshot(auth);
  const tmp = process.env.RECURSE_AGENT_TMPDIR ?? tmpdir();
  const output = resolve(
    destination ?? (await mkdtemp(join(tmp, "durable-probe-out-"))),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  const root = await mkdtemp(join(tmp, "durable-probe-"));
  try {
    await chmod(root, 0o700);
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(join(agentDir, "auth.json"), auth, { mode: 0o600 });
    const repo = join(root, "repo");
    const dataDir = join(root, "data");
    await mkdir(repo);
    await writeFile(
      join(repo, "AGENTS.md"),
      await readFile(join(ROOT, "AGENTS.md"), "utf8"),
    );
    const memory = join(dataDir, "memories/agents/a1b2c3d4e5f6");
    await mkdir(memory, { recursive: true, mode: 0o700 });
    await mkdir(join(dataDir, "memories/global"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(memory, "probe-notes.md"),
      "---\ntitle: Probe notes\ndate: 2026-10-07\n---\nNotes.\n",
    );
    const skills: string[] = [];
    const rendered = [
      await recurseSections(root, repo, dataDir, false),
      await recurseSections(root, repo, dataDir, true),
    ];
    const foreword = new Prompts({
      displayName: "Recurse",
    } as PromptsDeps).foreword();
    console.log("Pi RPC path");
    const pi = await piPath({
      root,
      repo,
      agentDir,
      skills,
      foreword,
      sections: async (turn) => rendered[turn < 2 ? 0 : 1]!,
    });
    console.log("Pi Durable path");
    const durable = await durablePath({
      repo,
      credential,
      snapshots: pi.snapshots,
      reorder: false,
    });
    console.log("Pi Durable path, system before user");
    const reordered = await durablePath({
      repo,
      credential,
      snapshots: pi.snapshots,
      reorder: true,
    });
    assertAuthUnchanged(
      snapshot,
      await readFile(join(agentDir, "auth.json"), "utf8"),
    );
    const rows = pi.turns.map((turn, index) => ({
      turn: index + 1,
      pi: turn,
      durable: durable.turns[index]!,
      reordered: reordered.turns[index]!,
    }));
    const lines = [
      "turn | path    | input | cacheRead | cacheWrite | output | cost $   | requests | reply",
    ];
    for (const row of rows)
      for (const [name, turn] of [
        ["pi", row.pi],
        ["durable", row.durable],
        ["reorder", row.reordered],
      ] as const)
        lines.push(
          `${row.turn}    | ${name.padEnd(7)} | ${String(turn.usage.input).padStart(5)} | ${String(turn.usage.cacheRead).padStart(9)} | ${String(turn.usage.cacheWrite).padStart(10)} | ${String(turn.usage.output).padStart(6)} | ${turn.usage.cost.toFixed(5)} | ${turn.requests}        | ${turn.reply.replace(/\s+/g, " ").slice(0, 40)}`,
        );
    const later = (path: "pi" | "durable" | "reordered") =>
      rows.slice(1).reduce((sum, row) => sum + row[path].usage.cacheRead, 0);
    const delta = (path: "durable" | "reordered") =>
      `${((later(path) / later("pi") - 1) * 100).toFixed(2)}%`;
    const spend = rows.reduce(
      (sum, row) =>
        sum +
        row.pi.usage.cost +
        row.durable.usage.cost +
        row.reordered.usage.cost,
      0,
    );
    lines.push(
      `turns 2-${rows.length} cache read: pi ${later("pi")}, durable ${later("durable")} (${delta("durable")}), reorder ${later("reordered")} (${delta("reordered")}); total cost $${spend.toFixed(4)}`,
    );
    console.log(lines.join("\n"));
    await writeFile(join(output, "summary.txt"), lines.join("\n") + "\n", {
      mode: 0o600,
    });
    console.log(`evidence: ${output}`);
    await writeFile(
      join(output, "observations.json"),
      JSON.stringify(
        {
          rows,
          durableRequests: durable.requests,
          reorderedRequests: reordered.requests,
          sections: pi.snapshots.map((shown) => Object.fromEntries(shown)),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main)
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
