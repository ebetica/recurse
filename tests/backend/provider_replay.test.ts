import { expect, test } from "bun:test";
import {
  createModels,
  cleanupSessionResources,
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
    const turns = name.endsWith("auto") ? 3 : 1;
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
    try {
      const models = createModels();
      const provider = builtinProviders().find(
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
            baseUrl:
              replay.baseUrl +
              new URL(recording.model.baseUrl).pathname.replace(/\/$/, ""),
          },
          context,
          {
            apiKey,
            sessionId,
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
        expect((replay.requests[1]!.input as unknown[]).length).toBe(3);
        expect((replay.requests[2]!.input as unknown[]).length).toBe(1);
      }
      replay.assertComplete();
    } finally {
      cleanupSessionResources(sessionId);
      if (turns === 3 && replay.websocketConnections)
        await replay.websocketClosed;
      await replay.server.stop(true);
    }
  }, 10000);
}

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
