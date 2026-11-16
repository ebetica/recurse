import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type AssistantMessageEventStream,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { recordedModels } from "../../backend/fixtures/provider_replay/models.ts";
import type { Instance } from "../../../src/agents/instance";
import type { Conv, Json, Storage } from "./fixture";
import { nowSeconds } from "./fixture";
export function createAgents(instance: Instance, { rootAgentId }: Storage) {
  const { nodes } = instance;
  const agents = new Map<
    string,
    { model: string | null; faux?: FauxProviderHandle }
  >();
  const gates = new Map<string, Array<() => Promise<void>>>();

  function hold(agent: string, name = "reply", action = async () => {}) {
    const key = JSON.stringify([agent, name]);
    const queue = gates.get(key) ?? [];
    gates.set(key, queue);
    return new Promise<void>((resolve) =>
      queue.push(async () => {
        await action();
        resolve();
      }),
    );
  }

  async function release(agent: string, name = "reply") {
    const key = JSON.stringify([agent, name]);
    const queue = gates.get(key);
    const next = queue?.shift();
    if (!queue?.length) gates.delete(key);
    await next?.();
  }

  function paceThinking(
    source: AssistantMessageEventStream,
    commit: Promise<void>,
  ) {
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
        if (event.type === "toolcall_end") await commit;
        paced.push(event);
      }
      paced.end(await copied.result());
    })();
    return paced;
  }
  function script(
    agent: string,
    tokensPerSecond = 20_000,
    commit?: Promise<void>,
  ) {
    const existing = agents.get(agent)?.faux;
    if (existing) return existing;
    const faux = fauxProvider({
      provider: agent,
      tokensPerSecond: commit ? undefined : tokensPerSecond,
    });
    durableModels.setProvider(
      commit
        ? {
            ...faux.provider,
            stream: (...args) =>
              paceThinking(faux.provider.stream(...args), commit),
            streamSimple: (...args) =>
              paceThinking(faux.provider.streamSimple(...args), commit),
          }
        : faux.provider,
    );
    agents.set(agent, { model: `${agent}/faux-1`, faux });
    return faux;
  }
  const durableOrdinary = fauxProvider({
    provider: "fauxordinary",
    tokensPerSecond: 20_000,
  });
  const ordinaryReply: FauxResponseFactory = (context) => {
    durableOrdinary.appendResponses([ordinaryReply]);
    return fauxAssistantMessage(
      JSON.stringify(
        context.messages.findLast((message) => message.role === "user")
          ?.content,
      ).match(/Reply only ([^"\\]+)/)?.[1] ?? "Acknowledged.",
    );
  };
  durableOrdinary.setResponses([ordinaryReply]);
  const durableModels = createModels();
  durableModels.setProvider(durableOrdinary.provider);
  const reviewer = fauxProvider({ provider: "browser-reviewer" });
  const reviewReply: FauxResponseFactory = () => {
    reviewer.appendResponses([reviewReply]);
    return fauxAssistantMessage("OK");
  };
  reviewer.setResponses([reviewReply]);
  durableModels.setProvider({
    ...reviewer.provider,
    auth: {
      apiKey: {
        name: "Browser fixture reviewer",
        resolve: async () => ({
          auth: { apiKey: "browser-test" },
          source: "browser fixture",
        }),
      },
    },
  });
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
    deps.agentEnv = async (conv) => {
      const env = await agentEnv(conv);
      if (String(conv.id).startsWith("safety-browser-"))
        return { ...env, RECURSE_MODEL_POLICY: undefined };
      const model = deps.settings(conv)[0];
      const slash = model.indexOf("/");
      const reviewRoute = {
        provider: "browser-reviewer",
        model: "faux-1",
        effort: "low",
      };
      return {
        ...env,
        RECURSE_MODEL_POLICY: JSON.stringify({
          version: 1,
          active: {
            provider: model.slice(0, slash),
            model: model.slice(slash + 1),
          },
          reviewer: reviewRoute,
          summary: reviewRoute,
        }),
      };
    };
    const storedSettings = deps.settings;
    deps.settings = (conv) => {
      const model = agents.get(String(conv.id))?.model;
      return model === null
        ? storedSettings(conv)
        : [
            model ?? "fauxordinary/faux-1",
            recordedRuns.has(String(conv.id)) ? "low" : "high",
          ];
    };
  }
  async function create(
    cid: string,
    title: string,
    parent: string | null = rootAgentId(),
    model = "fauxordinary/faux-1",
    workdir?: string,
  ) {
    agents.set(cid, { model });
    await instance.create.create({ cid, title, parent, workdir });
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
  async function sayDurable(
    cid: string,
    question: string,
    answer: string,
    before: FauxResponseStep[] = [],
    during?: () => Promise<void>,
  ) {
    script(cid).setResponses([...before, fauxAssistantMessage(answer)]);
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
    script(cid).setResponses([fauxAssistantMessage(summary)]);
    await harness.waitForTask(
      await conversation.compact(undefined, BACKGROUND_CONTEXT),
      BACKGROUND_CONTEXT,
    );
  }
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

  async function appendNative(
    conv: Conv,
    content: string,
    reply: string,
  ): Promise<void> {
    await submitDurable(conv.id, `${content}\nReply only ${reply}`);
    conv.updated = nowSeconds();
  }

  async function publishFiles(
    cid: string,
    files: Record<string, string | Uint8Array>,
    {
      directory,
      reply = `${Object.keys(files).join(", ")} is attached.`,
      beforePublish,
    }: {
      directory?: string;
      reply?: string;
      beforePublish?: Promise<void>;
    } = {},
  ): Promise<string> {
    const workdir = directory ?? (await mkdtemp(join(tmpdir(), "published-")));
    for (const [name, body] of Object.entries(files))
      await writeFile(join(workdir, name), body);
    const call = fauxToolCall("publish", {
      paths: Object.keys(files).map((name) => join(workdir, name)),
    });
    const response = fauxAssistantMessage([call], { stopReason: "toolUse" });
    await sayDurable(cid, "Publish the files.", reply, [
      beforePublish ? async () => (await beforePublish, response) : response,
    ]);
    return call.id;
  }

  async function publishedId(cid: string, call: string): Promise<string> {
    const view = await instance.durable.view(cid);
    const blocks = view.blocks as Array<{
      id: string;
      files?: Array<{ id: string }>;
    }>;
    const files = blocks.find((block) => block.id.endsWith(`#${call}`))?.files;
    if (files?.length !== 1)
      throw new Error("publication did not return one file");
    return files[0]!.id;
  }

  return {
    agents,
    gates,
    hold,
    release,
    script,
    durableModels,
    recordedRuns,
    create,
    submitDurable,
    sayDurable,
    sayDurableHistory,
    compactDurableHistory,
    helperApplyClear,
    waitTurn,
    appendNative,
    publishFiles,
    publishedId,
  };
}
