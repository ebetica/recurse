import { expect, test } from "bun:test";
import { responseRow } from "../../web/response-row";
import { formatTokenCount } from "../../web/thread-render/turn-usage";
import { replayResponse } from "../backend/fixtures/model_response/replay";

// test-check-allow: T9 Recorded provider response variants exercise missing metadata and mismatch presentation.
// Feature: #2657 recorded request rows show compact metadata and explicit mismatches.
test("request rows compact recorded responses and warn only about known differences", async () => {
  const message = await replayResponse(false);
  const name = (id: string | undefined) => id ?? "unavailable";
  const row = responseRow(message, name);
  expect(row.model).toBe(message.model);
  expect(row.modelChanged).toBeFalse();
  expect(row.effort).toBe(
    message.providerThinkingLevel ?? message.thinkingLevel!,
  );
  expect(row.effortChanged).toBeFalse();
  expect(row.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  const changed = await replayResponse(true);
  expect(responseRow(changed, name).model).toBe(
    `requested ${changed.model} → served ${changed.responseModel}`,
  );
  expect(responseRow(changed, name).modelChanged).toBeTrue();
  expect(
    responseRow({ ...message, thinkingLevel: undefined }, name).effort,
  ).toBe(message.providerThinkingLevel!);
  expect(
    responseRow(
      { ...message, thinkingLevel: "low", providerThinkingLevel: "high" },
      name,
    ).effort,
  ).toBe("requested low → served high");
  expect(
    responseRow(
      { inputTokens: message.usage.input, outputTokens: message.usage.output },
      name,
    ).tokens,
  ).toBe(
    `${formatTokenCount(message.usage.input)} in / ${formatTokenCount(message.usage.output)} out`,
  );
});
