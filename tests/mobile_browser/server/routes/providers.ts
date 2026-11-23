import { commitWrites } from "@earendil-works/pi-durable/testing";
import { SET_MODEL_MARKER } from "../../../../src/agents/storage/conversation_store";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { entries as contextEntries } from "../../../backend/fixtures/durable_context_usage/entries";
import { promptTokens } from "../../../../src/agents/runtime/context_usage";
import titleRecording from "../../../backend/fixtures/conversation_title/recording.json";
import {
  recordedModels,
  recordingNames,
  type RecordingName,
} from "../../../backend/fixtures/provider_replay/models.ts";
import { type Fixture, type Routes, hex } from "../fixture";
import { replayResponse } from "../../../backend/fixtures/model_response/replay";

export function routes(fx: Fixture): Routes {
  const { instance, load, save, rootAgentId } = fx;
  const { conversations } = instance;
  const { agents, durableModels, recordedRuns, create, submitDurable } =
    fx.agents;
  const fileEditRequests = new Map<string, string[]>();
  return {
    "seed-theme-css": async (body) => {
      const { agent, workdir, name, cssPath, destination } = body as {
        agent: string;
        workdir: string;
        name: string;
        cssPath: string;
        destination: string;
      };
      await create(agent, "Custom CSS", rootAgentId(), undefined, workdir);
      const faux = fx.agents.script(agent);
      const reply: FauxResponseFactory = (context) => {
        faux.appendResponses([reply]);
        if (
          JSON.stringify(context).includes(
            "untrusted record of a user's interaction",
          )
        )
          return fauxAssistantMessage("OK");
        return context.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage(
              `Theme CSS selected. Open ${destination} to edit it.`,
            )
          : fauxAssistantMessage(
              [
                fauxToolCall("recurse_settings", {
                  action: "select_theme",
                  name,
                  css_path: cssPath,
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
            name: "Browser theme fixture",
            resolve: async () => ({
              auth: { apiKey: "browser-test" },
              source: "browser fixture",
            }),
          },
        },
      });
      return { agent };
    },
    "seed-file-edit": async (body) => {
      const { agent, workdir } = body as { agent: string; workdir: string };
      const requests: string[] = [];
      fileEditRequests.set(agent, requests);
      const faux = fauxProvider({ provider: agent, tokensPerSecond: 20_000 });
      const reply: FauxResponseFactory = (context) => {
        requests.push(JSON.stringify(context));
        faux.appendResponses([reply]);
        return fauxAssistantMessage(
          JSON.stringify(
            context.messages.findLast((message) => message.role === "user")
              ?.content,
          ).match(/Reply only ([^"\\]+)/)?.[1] ?? "Acknowledged.",
        );
      };
      faux.setResponses([reply]);
      durableModels.setProvider(faux.provider);
      await create(
        agent,
        "File editor",
        rootAgentId(),
        `${agent}/faux-1`,
        workdir,
      );
      return { agent };
    },
    "file-edit-captures": async (body) => {
      const { agent } = body as { agent: string };
      const opened = await instance.durable.open(agent);
      return {
        running: instance.durable.isRunning(agent),
        providerRequests: fileEditRequests.get(agent) ?? [],
        capture: (await opened.captures.latest(agent))?.json ?? null,
      };
    },
    "file-edit-log-barrier": async (body) => {
      const { marker } = body as { marker: string };
      if (!/^browser-log-barrier-[a-f0-9-]+$/.test(marker))
        throw new Error("Invalid log marker");
      process.stdout.write(`${marker}\n`);
      process.stderr.write(`${marker}\n`);
      return {};
    },
    "subscription-token-urls": async (body) => {
      const urls = body as { claude: string; chatgpt: string };
      instance.anthropic.options.tokenUrl = urls.claude;
      instance.codex.options.tokenUrl = urls.chatgpt;
      return {};
    },
    "seed-model-selection-error": async (body) => {
      body = body as {
        agent: string;
        model: string;
        effort?: "default" | null;
        workdir?: string;
      };
      await create(body.agent, "Choose a model");
      const conv = load(body.agent)!;
      if (body.workdir) conv.workdir = body.workdir;
      conv.level = null;
      conv.model = body.model;
      if (body.effort === null) delete conv.effort;
      else if (body.effort !== undefined) conv.effort = body.effort;
      conv[SET_MODEL_MARKER] = true;
      await save(conv);
      agents.set(body.agent, { model: null });
      return { agent: body.agent };
    },
    "seed-recorded-effort-choice": async () => {
      const agent = `recorded-effort-${hex(4)}`;
      const model = "fauxordinary/faux-1";
      const effort = "low";
      await create(agent, "Recorded effort");
      const conv = load(agent)!;
      Object.assign(conv, {
        level: 3,
        model,
        effort,
        [SET_MODEL_MARKER]: true,
      });
      await save(conv);
      return { agent, model, effort };
    },
    "seed-provider-replay": async (body) => {
      body = body as {
        name: RecordingName;
        copies?: number;
        headers?: Record<string, string>;
      };
      const copies = body.copies ?? 1;
      if (!recordingNames.includes(body.name) || ![1, 2].includes(copies))
        throw new Error("Invalid recording");
      const replay = await recordedModels(body.name, copies, body.headers);
      durableModels.setProvider(replay.provider);
      const cid = `provider-replay-${hex(4)}`;
      recordedRuns.set(cid, replay);
      await create(cid, "Recorded provider", rootAgentId(), replay.modelId);
      const conv = await conversations.load(cid);
      await writeFile(
        join(String(conv!.workdir), "live-seed.txt"),
        "E2E_FINDABLE ALPHA_ORBITAL\nE2E_SECOND BETA\n",
      );
      return { agent: cid };
    },
    "provider-replay-status": async (body) => {
      const { agent, close, message } = body as {
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
      let completedTurns = 0;
      const reply: FauxResponseFactory = (context) => {
        faux.appendResponses([reply]);
        if (
          JSON.stringify(context).includes(
            "untrusted record of a user's interaction",
          )
        ) {
          if (unavailable) {
            unavailable = false;
            throw new Error(
              `503: Mammoth rejected <b>review context</b>\nUse a shorter request. The reviewer could not process the evidence for the tool call. The tool already ran, so use its output to decide what to do next.\nX-API-Key: abc123\n${"Provider response padding. ".repeat(12)}`,
            );
          }
          return fauxAssistantMessage("OK");
        }
        return context.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage(
              completedTurns++ === 0
                ? "SAFETY_TURN_DONE"
                : "SAFETY_RECOVERY_DONE",
            )
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
      const priced = (
        source: ReturnType<typeof createAssistantMessageEventStream>,
        cost: number,
      ) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          for await (const event of source) {
            if (event.type === "done") {
              const total = event.message.stopReason === "toolUse" ? 0.1 : cost;
              event.message.usage.cost.output = total;
              event.message.usage.cost.total = total;
              event.message.usage.cost.totalFromProvider = true;
            }
            stream.push(event);
          }
          stream.end();
        })();
        return stream;
      };
      durableModels.setProvider({
        ...faux.provider,
        stream: (...args) => priced(faux.provider.stream(...args), 0.3),
        streamSimple: (...args) =>
          priced(
            faux.provider.streamSimple(...args),
            args[2]?.sessionId?.startsWith("pi-safety-") ? 0.2 : 0.3,
          ),
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
      await create(
        cid,
        "Safety reviewer availability",
        rootAgentId(),
        `${cid}/faux-1`,
      );
      return { agent: cid };
    },
    "seed-model-response": async (body) => {
      const cid =
        body.agent ?? `model-response-${crypto.randomUUID().slice(0, 8)}`;
      const faux = fauxProvider({ provider: cid, tokensPerSecond: 20_000 });
      if (!body.agent) durableModels.setProvider(faux.provider);
      const selector = `${cid}/faux-1`;
      if (body.run) {
        const catalog = faux.provider.getModels();
        const served = {
          ...catalog[0]!,
          id: "faux-served",
          name: "Served model",
        };
        faux.setResponses([
          {
            ...fauxAssistantMessage("NORMAL_MODEL_OK"),
            responseModel: served.id,
          },
          {
            ...fauxAssistantMessage("REASONING_MISMATCH_OK"),
            responseModel: served.id,
            providerThinkingLevel: "low",
          },
        ]);
        durableModels.setProvider({
          ...faux.provider,
          getModels: () => [...catalog, served],
        });
      }
      if (!body.agent)
        await create(cid, "Model response", rootAgentId(), selector);
      if (body.run) return { agent: cid };
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
    "seed-conversation-title": async () => {
      const [selected] = instance.config.levels.resolveEffortLevel(1);
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
      const cid = `durable-context-${crypto.randomUUID().slice(0, 8)}`;
      const model = instance.config.models.chatSettings(null)[0];
      const [provider, ...id] = model.split("/");
      const faux = fauxProvider({
        provider,
        models: [{ id: id.join("/") }],
        tokensPerSecond: 20_000,
      });
      durableModels.setProvider(faux.provider);
      await create(cid, "Recorded Durable context", rootAgentId(), model);
      const { storage } = await instance.durable.open(cid);
      await commitWrites(
        storage,
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
  };
}
