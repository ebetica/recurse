import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableHost } from "../../src/agents/durable/host";
import { durableModels } from "../../src/agents/durable/models";
import { testDeps, until } from "./fixtures/durable_host/host";
import {
  createModels,
  cleanupSessionResources,
  type AnthropicMessagesCompat,
  type Context,
  type Tool,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  replayProvider,
  type Recording,
} from "./fixtures/provider_replay/server";

for (const name of ["openai-codex-sse", "openai-codex-auto", "anthropic-sse"]) {
  test(`real Pi parser reads recorded ${name} reply`, async () => {
    const recording: Recording = await Bun.file(
      `${import.meta.dir}/fixtures/provider_replay/${name}.json`,
    ).json();
    const anthropic = recording.model.provider === "anthropic";
    const turns = name.endsWith("auto") ? 3 : anthropic ? 2 : 1;
    for (let turn = 1; turn < turns; turn++)
      recording.exchanges.push(structuredClone(recording.exchanges[0]!));
    const replay = replayProvider(recording, { timeScale: 0 });
    const sessionId = `recorded-parser-${name}`;
    const request = recording.exchanges[0]!.request;
    const context: Context = {
      systemPrompt: "Reply only with the public marker.",
      messages: [
        {
          role: "user",
          content: "Reply with exactly RECORDED_PROVIDER_OK. Do not use tools.",
          timestamp: 0,
        },
      ],
      tools: (request.tools as Record<string, any>[])
        .filter((tool) => tool.name !== "__pi_deferred_placeholder__")
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? tool.input_schema,
        })) as Tool[],
    };
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "recorded-test" } })).toString("base64url")}.test`;
    const apiKey =
      recording.model.provider === "anthropic"
        ? "sk-ant-oat-recorded-test"
        : token;
    const agentDir = mkdtempSync(join(tmpdir(), "provider-models-"));
    try {
      const models = anthropic ? durableModels(agentDir) : createModels();
      const provider =
        models.getProvider(recording.model.provider) ??
        builtinProviders().find(
          (provider) => provider.id === recording.model.provider,
        )!;
      models.setProvider({
        ...provider,
        auth: {
          apiKey: {
            name: "Recorded test",
            resolve: async () => ({
              auth: { apiKey },
              source: "recorded fixture",
            }),
          },
        },
      });
      let previousResponseId: string | undefined;
      for (let turn = 0; turn < turns; turn++) {
        const stream = models.stream(
          {
            ...recording.model,
            ...(anthropic
              ? models.getModel("anthropic", recording.model.id)
              : {}),
            baseUrl: anthropic
              ? recording.model.baseUrl
              : replay.baseUrl +
                new URL(recording.model.baseUrl).pathname.replace(/\/$/, ""),
          },
          context,
          {
            apiKey,
            sessionId,
            ...(anthropic
              ? {
                  fetch: (url: string | URL | Request, init?: RequestInit) =>
                    fetch(
                      replay.baseUrl +
                        new URL(String(url)).pathname +
                        new URL(String(url)).search,
                      init,
                    ),
                }
              : {}),
            ...(recording.model.provider === "openai-codex"
              ? {
                  reasoningEffort: "low" as const,
                  reasoningSummary: "detailed" as const,
                }
              : { thinkingEnabled: true, effort: "low" as const }),
            ...(turn > 0 ? { transport: "auto" as const } : {}),
            ...(name.endsWith("sse") && name.startsWith("openai")
              ? { transport: "sse" as const }
              : {}),
          },
        );
        const deltas: string[] = [];
        for await (const event of stream)
          if (event.type === "text_delta") deltas.push(event.delta);
        const result = await stream.result();
        expect(replay.failures).toEqual([]);
        expect(result.errorMessage).toBeUndefined();
        expect(result.stopReason).toBe("stop");
        expect(
          result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text),
        ).toEqual(["RECORDED_PROVIDER_OK"]);
        expect(result.content.some((block) => block.type === "toolCall")).toBe(
          false,
        );
        expect(deltas.join("")).toBe("RECORDED_PROVIDER_OK");
        expect(replay.requests).toHaveLength(turn + 1);
        if (turn === 2)
          expect(replay.requests[turn]!.previous_response_id).toBe(
            previousResponseId,
          );
        previousResponseId = result.responseId;
        context.messages.push(result, {
          role: "user",
          content: "Reply with the same public marker again.",
          timestamp: turn + 1,
        });
      }
      if (turns === 3) {
        expect(replay.websocketConnections).toBe(1);
        expect(replay.requests[0]!.previous_response_id).toBeUndefined();
        expect(replay.requests[1]!.previous_response_id).toBeUndefined();
        expect(replay.requests[2]!.previous_response_id).toEqual(
          expect.any(String),
        );
        expect(
          (replay.requests[1]!.input as Record<string, unknown>[]).map(
            (item) => item.role ?? item.type,
          ),
        ).toEqual(["developer", "user", "assistant", "user"]);
        expect((replay.requests[2]!.input as unknown[]).length).toBe(1);
      }
      if (anthropic) {
        expect(
          replay.requests.every((request) => request.thread === undefined),
        ).toBe(true);
        expect(
          (replay.requests[1]!.messages as { role: string }[]).map(
            (message) => message.role,
          ),
        ).toEqual(["user", "system", "assistant", "user", "system"]);
      }
      replay.assertComplete();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      cleanupSessionResources(sessionId);
      if (turns === 3 && replay.websocketConnections)
        await replay.websocketClosed;
      await replay.server.stop(true);
    }
  }, 10000);
}

// Regression: #3617 Claude uses summarized thinking without a progress reminder and keeps provider fallbacks.
test("Claude turns request summarized thinking and preserve fallbacks", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "thinking-display-"));
  const configuredModel = "operator-summary";
  const configuredBeta = "fine-grained-tool-streaming-2025-05-14";
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        anthropic: {
          models: [
            {
              id: configuredModel,
              reasoning: true,
              headers: { "anthropic-beta": configuredBeta },
            },
          ],
        },
      },
    }),
  );
  const models = durableModels(agentDir);
  await models.refresh({ allowNetwork: false });
  const provider = models.getProvider("anthropic")!;
  const catalog = builtinProviders()
    .find(({ id }) => id === "anthropic")!
    .getModels();
  const compat = (model: (typeof catalog)[number]) =>
    model.compat as AnthropicMessagesCompat | undefined;
  const opus = catalog.find(
    (model) =>
      /\bOpus\b/i.test(model.name) &&
      compat(model)?.supportsMidConvoEffort &&
      model.thinkingLevelMap?.low,
  )!;
  const fable = catalog.find((model) => model.name === "Claude Fable 5.2")!;
  const cases = [
    ["opus", opus.id, "low"],
    ["fable", fable.id, "xhigh"],
    ["disabled", configuredModel, "off"],
  ] as const;
  const recording: Recording = await Bun.file(
    `${import.meta.dir}/fixtures/provider_replay/anthropic-sse.json`,
  ).json();
  const replay = replayProvider(
    {
      ...recording,
      exchanges: cases.map(([, model]) => ({
        ...recording.exchanges[0]!,
        request: { model },
        requestHeaders: {},
      })),
    },
    { timeScale: 0 },
  );
  models.setProvider({
    ...provider,
    getModels: provider.getModels,
    getAllModels: provider.getAllModels,
    auth: {
      apiKey: {
        name: "Recorded test",
        resolve: async () => ({ auth: { apiKey: "sk-ant-oat-recorded-test" } }),
      },
    },
    streamSimple: (model, context, options) =>
      provider.streamSimple(
        { ...model, baseUrl: replay.baseUrl },
        context,
        options,
      ),
  });
  const host = new DurableHost({
    ...testDeps(
      agentDir,
      (cid) => ({ id: cid, backend: "durable", workdir: agentDir }),
      () => cases.map(([cid]) => cid),
    ),
    settings: (conv) => {
      const [, model, effort] = cases.find(([cid]) => cid === conv.id)!;
      return [`anthropic/${model}`, effort];
    },
    models,
  });
  try {
    for (const [index, [cid, model, effort]] of cases.entries()) {
      await host.send(cid, "Check the public marker.", `wire-${cid}`);
      await until(async () => {
        const blocks = (await host.view(cid)).blocks as Array<{
          text?: string;
          live?: boolean;
        }>;
        return (
          replay.failures.length > 0 ||
          blocks.some((row) => row.text === "RECORDED_PROVIDER_OK" && !row.live)
        );
      });
      expect(replay.failures).toEqual([]);
      const wire = replay.requests[index]!;
      const beta = replay.requestHeaders[index]!["anthropic-beta"];
      if (effort === "off") {
        expect(wire.thinking).toEqual({ type: "disabled" });
        expect(beta).toBe(configuredBeta);
      } else {
        expect(wire.thinking).toMatchObject({
          type: "adaptive",
          display: "summarized",
        });
        const original = model === fable.id ? fable : opus;
        const fallbacks = compat(original)?.allowedFallbackModels;
        if (model === fable.id)
          expect(fallbacks?.length ?? 0).toBeGreaterThan(0);
        expect(wire.fallbacks).toEqual(
          fallbacks?.map(({ model }) => ({ model })),
        );
      }
      expect(beta).not.toMatch(
        /thinking-display-updates|mid-conversation-system-clear-at/,
      );
      expect(wire.messages).not.toContainEqual(
        expect.objectContaining({ clear_at: "next_user_message" }),
      );
      const { request } = (await host.prompt(cid)) as {
        request: {
          options: { thinkingDisplay?: string };
          context: { messages: Array<{ clearAt?: string; content: unknown }> };
        };
      };
      expect(request.options.thinkingDisplay).toBeUndefined();
      expect(request.context.messages).not.toContainEqual(
        expect.objectContaining({ clearAt: "next_user_message" }),
      );
      expect(JSON.stringify(request.context.messages)).not.toContain(
        "Briefly tell the user what you found",
      );
    }
    replay.assertComplete();
  } finally {
    await host.close();
    await replay.server.stop(true);
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test.each(["model", "tools", "reasoning"])(
  "HTTP request missing %s is rejected, not replayed",
  async (field) => {
    const recording: Recording = await Bun.file(
      `${import.meta.dir}/fixtures/provider_replay/openai-codex-sse.json`,
    ).json();
    const replay = replayProvider(recording);
    try {
      const body = {
        ...recording.exchanges[0]!.request,
        input: [{ role: "user", content: "Public request" }],
      };
      delete (body as Record<string, unknown>)[field];
      const response = await fetch(
        replay.baseUrl + recording.exchanges[0]!.path,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`request mismatch: ${field}`);
      expect(replay.requests).toHaveLength(0);
      expect(replay.failures).toHaveLength(1);
    } finally {
      await replay.server.stop(true);
    }
  },
);
