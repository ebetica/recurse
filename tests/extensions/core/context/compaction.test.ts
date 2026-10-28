import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCompactionInstructions,
  ensureHistoricalContext,
} from "../../../../src/extensions/core/context/durable-compaction.ts";

// Regression: #1597 preserve prior Historical Context when the model drops it
test("Historical Context is preserved, condensed, or synthesized when missing", () => {
  const previous =
    "## Historical Context\nPrior decisions\n## Next Steps\nContinue";
  const instructions = buildCompactionInstructions("focus", previous, {
    reserveTokens: 2000,
    modelMaxTokens: 4000,
  });
  assert.equal(instructions.priorContext, "Prior decisions");
  const authored =
    "## Historical Context\nNew history\n## Next Steps\nContinue";
  assert.equal(
    ensureHistoricalContext(authored, "Prior decisions", []),
    authored,
  );
  const missing = ensureHistoricalContext(
    "## Goal\nWork",
    instructions.priorContext,
    [{ timestamp: 1 }, { timestamp: 2 }],
  );
  assert.match(missing, /^## Historical Context\nPrior decisions\n/);
  assert.match(missing, /2 messages, timestamps 1 to 2/);
  assert.match(
    ensureHistoricalContext("## Goal\nWork", undefined, []),
    /^## Historical Context\n/,
  );
  const long =
    "## Historical Context\n" +
    "history ".repeat(300) +
    "\n## Next Steps\nContinue";
  const condensed = ensureHistoricalContext(long, undefined, []);
  assert.ok(condensed.length < long.length);
  assert.ok(condensed.endsWith("## Next Steps\nContinue"));
});
