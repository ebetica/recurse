import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host";
import {
  fauxHost,
  held,
  idle,
  testDeps,
  until,
} from "./fixtures/durable_host/host";
import {
  loadRecording,
  replayResponse,
} from "./fixtures/model_response/replay";

// Regression: #2657 Durable requests retain their own effort after settings change.
test("generated responses retain requested effort and provider token counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-response-generation-"));
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const record = { id: "c1", backend: "durable", workdir: root };
  let effort = "high";
  const deps = {
    ...testDeps(
      root,
      () => record,
      () => ["c1"],
    ),
    models,
    settings: (): [string, string] => ["faux/faux-1", effort],
  };
  let host = new DurableHost(deps);
  try {
    const answer = await replayResponse(false);
    delete answer.thinkingLevel;
    for (const requested of ["high", "off"] as const) {
      effort = requested;
      const gate = held(structuredClone(answer));
      faux.setResponses([gate.step]);
      await host.send("c1", "Reply without tools", requested);
      await gate.started;
      effort = requested === "off" ? "high" : "off";
      gate.release();
      await until(idle(host));
      const view = await host.view("c1", {});
      const row = (view.blocks as Record<string, any>[]).findLast(
        (item) => item.role === "assistant",
      )!;
      expect(row.model_response.thinkingLevel).toBe(requested);
      const { conversation } = await host.open("c1");
      const entries = await conversation.entries({}, 100, undefined, context);
      const stored = entries.items.find(
        (entry) => entry.kind === "pi.assistant",
      )!;
      const message = stored.model![0] as typeof answer;
      expect(message.thinkingLevel).toBe(requested);
      expect(row.model_response.inputTokens).toBe(
        message.usage.input +
          message.usage.cacheRead +
          message.usage.cacheWrite,
      );
      expect(row.model_response.outputTokens).toBe(message.usage.output);
      expect((await host.turnPrompt("c1", stored.id))!.model_response).toEqual(
        row.model_response,
      );
    }
    await host.close();
    host = new DurableHost(deps);
    const reopened = await host.view("c1", {});
    expect(
      (reopened.blocks as Record<string, any>[])
        .filter((row) => row.role === "assistant")
        .map((row) => row.model_response.thinkingLevel),
    ).toEqual(["high", "off"]);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Anthropic recording with served model id changed survives Durable storage", async () => {
  const recording = await loadRecording();
  const root = await mkdtemp(join(tmpdir(), "model-response-"));
  const { host } = fauxHost(root);
  try {
    const { conversation } = await host.open("c1");
    for (const changed of [true, false]) {
      const message = await replayResponse(changed);
      expect(message.stopReason).toBe("stop");
      expect(message.model).toBe(recording.requestedModel);
      expect(message.thinkingLevel).toBe(recording.requestedEffort);
      expect(message.providerThinkingLevel).toBeDefined();
      if (changed) expect(message.responseModel).toBe(recording.servedModel);
      else expect(message.responseModel).toBeUndefined();
      const { id } = await conversation.commit(
        (tx) =>
          tx.appendEntry(conversation.id, {
            kind: "pi.assistant",
            model: [message],
          }),
        context,
      );
      const stored = await conversation.entries(
        { minEntryId: id, maxEntryId: id },
        1,
        undefined,
        context,
      );
      expect(stored.items[0]!.model![0]).toMatchObject(message);
      const view = await host.view("c1", {});
      const response = (view.blocks as Record<string, any>[]).findLast(
        (row) => row.role === "assistant",
      )!.model_response;
      expect(response?.model).toBe(recording.requestedModel);
      expect(response?.responseModel).toBe(
        changed ? recording.servedModel : undefined,
      );
      expect(response?.thinkingLevel).toBe(message.thinkingLevel);
      expect(response?.inputTokens).toBe(
        message.usage.input +
          message.usage.cacheRead +
          message.usage.cacheWrite,
      );
      expect(response?.outputTokens).toBe(message.usage.output);
      expect(response?.timestamp).toBe(message.timestamp);
      expect(response?.providerThinkingLevel).toBe(
        message.providerThinkingLevel,
      );
      expect((await host.turnPrompt("c1", id))!.model_response).toEqual(
        response,
      );
    }
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
