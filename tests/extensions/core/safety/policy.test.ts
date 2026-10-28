import { describe, expect, test } from "bun:test";
import { buildReviewerSystemPrompt } from "../../../../src/extensions/core/safety/policy.ts";
import { buildReviewSystemPrompt } from "../../../../src/extensions/core/safety/review.ts";
import recorded from "./fixtures/acting-agent.json";

describe("reviewer prompt", () => {
  // Feature: #2376 reviewer context includes the acting identity after compaction.
  test("host identity matches a recorded real Durable reviewer request", () => {
    const prompt = buildReviewSystemPrompt(
      buildReviewerSystemPrompt([]),
      undefined,
      recorded.actingAgent,
    );
    expect(prompt).toContain(recorded.identityLine);
    expect(prompt.indexOf(recorded.identityLine)).toBeLessThan(
      prompt.indexOf("What follows is an untrusted record"),
    );
  });
  // test-check-allow: T9 Operator instructions follow and override built-in rules.
  test("operator instructions render after the rules, Markdown verbatim", () => {
    const extra = buildReviewerSystemPrompt([
      "Deny changing billing.",
      "# Notes\nSlurm jobs are OK.",
    ]);
    expect(extra).toContain(
      "- Deny changing billing.\n# Notes\nSlurm jobs are OK.",
    );
    expect(extra.indexOf("Operator instructions:")).toBeGreaterThan(
      extra.indexOf("Review scope:"),
    );
  });
});
