import assert from "node:assert/strict";
import { test } from "node:test";
import { filterCodexReplay } from "../../../../src/extensions/extra/codex/codex-replay.ts";

const thinking = (id: string) => ({
  type: "thinking" as const,
  thinking: "",
  thinkingSignature: JSON.stringify({ type: "reasoning", id }),
});
const text = (value: string, phase: "commentary" | "final_answer") => ({
  type: "text" as const,
  text: value,
  textSignature: JSON.stringify({ v: 1, id: `msg_${phase}`, phase }),
});
const assistant = (content: unknown[]) => ({
  role: "assistant",
  content,
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: "gpt-5.6",
  usage: {},
  stopReason: "stop",
  timestamp: 1,
});

// Regression: #1840 empty Codex final replay items and orphaned reasoning
test("drops an empty Codex final and only its orphaned reasoning", () => {
  const commentaryReasoning = thinking("commentary");
  const commentary = text("Visible answer", "commentary");
  const finalReasoning = thinking("final");
  const emptyFinal = text(" \n\t", "final_answer");
  const original = assistant([
    commentaryReasoning,
    commentary,
    finalReasoning,
    emptyFinal,
  ]);

  const result = filterCodexReplay([original] as never);
  assert.deepEqual((result[0] as { content: unknown[] })?.content, [
    commentaryReasoning,
    commentary,
  ]);
  assert.deepEqual(original.content, [
    commentaryReasoning,
    commentary,
    finalReasoning,
    emptyFinal,
  ]);
});

// Regression: #1840 empty Codex final replay items and orphaned reasoning
test("preserves a turn whose empty item is its only output", () => {
  const original = [
    assistant([thinking("only"), text("", "final_answer")]),
  ] as never;
  assert.equal(filterCodexReplay(original), original);
});

// Regression: #1840 empty Codex final replay items and orphaned reasoning
test("keeps reasoning that does not belong only to the empty item", () => {
  const sharedReasoning = thinking("shared");
  const toolCall = {
    type: "toolCall",
    id: "call_1|fc_1",
    name: "read",
    arguments: {},
  };
  const visible = text("visible", "commentary");
  const trailingReasoning = thinking("trailing");
  const result = filterCodexReplay([
    assistant([sharedReasoning, text("", "final_answer"), toolCall]),
    assistant([visible, text("", "final_answer"), trailingReasoning]),
  ] as never) as Array<{ content: unknown[] }>;
  assert.deepEqual(result[0]?.content, [sharedReasoning, toolCall]);
  assert.deepEqual(result[1]?.content, [visible, trailingReasoning]);
});

test("preserves system messages in the full-list hook", () => {
  const system = { role: "system", content: "prompt" };
  const assistantMessage = assistant([
    text("answer", "commentary"),
    text("", "final_answer"),
  ]);
  const result = filterCodexReplay([system, assistantMessage] as never);
  assert.equal(result[0], system as never);
  assert.equal(result.length, 2);
});
