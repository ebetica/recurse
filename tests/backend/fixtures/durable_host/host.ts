/** A DurableHost over one Durable conversation "c1" with a faux model. */
import { mkdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Config } from "../../../../src/config";
import { buildInstance } from "../../../../src/agents/instance";
import { PiSwitchover } from "../../../../src/agents/supervisor/switchover";
import { join } from "node:path";
import {
  type AssistantMessage,
  createModels,
  type FauxResponseStep,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { DurableHost } from "../../../../src/agents/durable/host.ts";
import { ProcessLifecycle } from "../../../../src/process_lifecycle.ts";
import type { LogSink } from "../../../../src/observability/runtime_logging.ts";

/** Stops shell groups the way the server does (verified TERM, then KILL). */
export const lifecycle = new ProcessLifecycle({
  registry: {} as never,
  shellStateDir: "/nonexistent",
  termGraceMs: 500,
  killGraceMs: 500,
});

/** Test host deps without a conversation store or Settings. */
export function testDeps(
  dataDir: string,
  load: (cid: string) => Record<string, unknown> | null,
  liveIds: () => string[],
  model = "faux/faux-1",
) {
  const tmp = join(dataDir, "tmp");
  // Private, like a real agent temp dir: pi-safety refuses a shared one.
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return {
    dataDir,
    trashDir: join(dataDir, "trash"),
    piAgentDir: dataDir,
    load,
    liveIds,
    settings: (): [string, string] => [model, "off"],
    agentEnv: async () => ({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmp,
      RECURSE_AGENT_TMPDIR: tmp,
      RECURSE_AGENT_ENV_FILE: join(tmp, "env.sh"),
    }),
    promptSnapshot: async () => ({
      foreword: "You are a test agent.",
      recurse_agent: "agent",
      recurse_memory: "memory",
      recurse_runtime: "runtime",
      recurse_tree: "tree",
      recurse_tools: "tools",
      contextFiles: [],
      skills: [],
    }),
    stopGroup: (group: Parameters<ProcessLifecycle["stopGroup"]>[0]) =>
      lifecycle.stopGroup(group),
    ownProcess: async (
      proc: Parameters<ProcessLifecycle["registerProcess"]>[0],
      cid: string,
    ) => void (await lifecycle.registerProcess(proc, "mcp", cid)),
    releaseProcess: async (
      proc: Parameters<ProcessLifecycle["cleanupProcessObject"]>[0],
    ) => (await lifecycle.cleanupProcessObject(proc)) !== false,
    log: () => undefined,
  };
}

/** A keyed faux provider: pi-safety's reviewer can call it too. */
function reviewerFaux() {
  const core = createFauxCore({ tokensPerSecond: 20_000 });
  const provider = createProvider({
    id: core.provider,
    auth: {
      apiKey: {
        name: "Test",
        resolve: async () => ({ auth: { apiKey: "k" } }),
      },
    },
    models: core.models,
    api: { stream: core.stream, streamSimple: core.streamSimple },
  });
  return { ...core, provider };
}

export function fauxHost(
  dataDir: string,
  model = "faux/faux-1",
  reviewed = false,
  focusWaitMs?: number,
) {
  const faux = reviewed
    ? reviewerFaux()
    : fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const work = join(dataDir, "work");
  mkdirSync(work, { recursive: true });
  const records: Record<string, Record<string, unknown>> = {
    c1: { id: "c1", backend: "durable", workdir: work },
  };
  const host = new DurableHost(
    {
      ...testDeps(
        dataDir,
        (cid) => records[cid] ?? null,
        () => Object.keys(records),
        model,
      ),
      models,
    },
    focusWaitMs,
  );
  return { faux, host, records, work };
}

/** Poll `check` every 10 ms until it holds; throws after `ms`. */
export async function until(
  check: () => Promise<boolean> | boolean,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

/** True once "c1" has no run and nothing pending. */
export const idle = (host: DurableHost) => async () =>
  host.runningCount() === 0 && host.metadata("c1").pending.length === 0;

/**
 * A faux answer that waits for `release()`, or ends when its request is
 * aborted; `started` resolves when its request arrives.
 */
export function held(answer: AssistantMessage) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const started = new Promise<void>((resolve) => (reached = resolve));
  const step: FauxResponseStep = async (_request, options) => {
    reached();
    const signal = options?.signal;
    if (!signal?.aborted)
      await Promise.race([
        gate,
        new Promise((resolve) => signal?.addEventListener("abort", resolve)),
      ]);
    return answer;
  };
  return { step, release, started };
}

/** Real collection/maintenance owners with captured Pi history and private roots. */
export async function switchoverWorld(sink: LogSink = { write: () => {} }) {
  const root = await mkdtemp(join(tmpdir(), "pi-switchover-"));
  const data = join(root, "data");
  const captured = JSON.parse(
    await readFile(
      join(import.meta.dir, "../durable_rows/recorded.json"),
      "utf8",
    ),
  ).entries[0].model[0];
  const requests: unknown[] = [];
  let requestGate:
    | {
        started(): void;
        released: Promise<void>;
        tool?: { name: string; args: Record<string, unknown> };
      }
    | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push(await request.json());
      const gate = requestGate;
      requestGate = undefined;
      if (gate) {
        gate.started();
        await gate.released;
      }
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(
        (gate?.tool
          ? chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "read-note",
                  type: "function",
                  function: {
                    name: gate.tool.name,
                    arguments: JSON.stringify(gate.tool.args),
                  },
                },
              ],
            }) + chunk({}, "tool_calls")
          : chunk({ role: "assistant", content: "CUSTOM-SWITCHED" }) +
            chunk({}, "stop")) + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  await mkdir(join(data, "config"), { recursive: true });
  await writeFile(
    join(data, "config/model-providers.json"),
    JSON.stringify({
      default: "recurse-test/scripted",
      providers: {
        "recurse-test": {
          base_url: `http://127.0.0.1:${server.port}/v1`,
          env_key: "RECURSE_TEST_KEY",
          wire_api: "completions",
          models: [{ id: "scripted", context_window: 100000 }],
        },
      },
    }),
  );
  const env = {
    ...process.env,
    CHAT_DATA_DIR: data,
    HOME: join(root, "home"),
    RECURSE_HOME: join(root, "settings"),
    PI_BG_SHELL: "0",
    RECURSE_TEST_KEY: "test-key",
  };
  for (const key of [
    "CHAT_REPO_URL",
    "RECURSE_SELF_DEPLOY",
    "RECURSE_ISOLATED_DATA_DIR",
    "RECURSE_ISOLATED_ROOT",
    "PI_CODING_AGENT_DIR",
    "RECURSE_SAFETY_DIR",
  ])
    delete (env as Record<string, unknown>)[key];
  const instance = await buildInstance({
    config: new Config({ env }),
    sink,
  });
  // Drive the maintenance owner directly, without a background watcher.
  instance.lifecycle.importFinal = true;
  const faux = fauxProvider({ tokensPerSecond: 20000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const load = (cid: string) =>
    instance.conversations.load(cid, { withPending: false });
  const host = new DurableHost({
    ...testDeps(data, load, () =>
      instance.conversations.allConvs().map((c) => String(c.id)),
    ),
    settings: (conv) => [String(conv.model), "off"],
    models,
    customProviders: () => instance.config.customModelProviders(),
    customProviderEnvValue: () => "test-key",
  });
  const events: string[] = [];
  let now = 1000;
  const move = new PiSwitchover({
    ...instance,
    durable: host,
    hasReports: (cid) => instance.delivery.hasReports(cid),
    now: () => now,
    log: (event, fields) => events.push(`${event}:${fields.conversation_id}`),
  });
  async function row(
    cid: string,
    parent: string | null = null,
    model = "faux/faux-1",
  ) {
    const sessionDir = join(data, "pi_sessions");
    await mkdir(sessionDir, { recursive: true });
    const file = join(sessionDir, `recorded_${cid}.jsonl`);
    const header = {
      type: "session",
      version: 3,
      id: cid,
      cwd: root,
      timestamp: new Date(captured.timestamp).toISOString(),
    };
    await writeFile(
      file,
      [
        header,
        {
          type: "message",
          id: "e7",
          parentId: null,
          timestamp: header.timestamp,
          message: captured,
        },
      ]
        .map((e) => JSON.stringify(e) + "\n")
        .join(""),
    );
    await instance.conversations.save({
      id: cid,
      parent,
      backend: "pi",
      model,
      effort: "off",
      workdir: root,
      session_id: cid,
      session_file: file,
      session_cwd: root,
      title: cid,
      status: "idle",
    });
    return file;
  }
  return {
    root,
    instance,
    host,
    faux,
    move,
    load,
    row,
    events,
    requests,
    holdNextRequest: (tool?: {
      name: string;
      args: Record<string, unknown>;
    }) => {
      let started!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      requestGate = { started, released, tool };
      return { started: waiting, release };
    },
    advance: () => {
      now += 1000;
    },
    close: async () => {
      await host.close();
      await instance.shutdown();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}
