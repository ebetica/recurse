import assert from "node:assert/strict";
import { test } from "node:test";
import { detailedReasoningSummary } from "../../../../src/extensions/extra/codex/reasoning-summary.ts";

const codex = {
  model: "gpt-6.1-sol",
  reasoning: { effort: "high", summary: "auto" },
};
const claude = {
  model: "claude-opus-5-5",
  thinking: {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  },
  output_config: { effort: "high" },
};

test("Codex requests detailed summaries without changing effort or the input", () => {
  assert.deepEqual(
    detailedReasoningSummary(codex, { provider: "openai-codex" }),
    { ...codex, reasoning: { effort: "high", summary: "detailed" } },
  );
  assert.equal(codex.reasoning.summary, "auto");
});

test("Claude and the unverified OpenAI platform route keep Pi's settings", () => {
  assert.equal(
    detailedReasoningSummary(claude, { provider: "anthropic" }),
    claude,
  );
  assert.equal(detailedReasoningSummary(codex, { provider: "openai" }), codex);
});
