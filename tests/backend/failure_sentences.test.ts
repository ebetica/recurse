import { expect, test } from "bun:test";
import {
  describeSendFailure,
  describeTurnFailure,
  retriedNotice,
  retryReason,
  type FailureContext,
} from "../../src/agents/view/failure_sentences";
import fixture from "./fixtures/failure_sentences/cases.json";

interface Case {
  fn: string;
  args: unknown[];
  kwargs: { provider?: string; model?: string; known_models?: string[] };
  out?: string | null;
}

function context(kwargs: Case["kwargs"]): FailureContext {
  const { provider, model, known_models: knownModels } = kwargs;
  return { provider, model, knownModels: knownModels && new Set(knownModels) };
}

const run: Record<string, (c: Case) => string | null> = {
  describe_send_failure: (c) => describeSendFailure(c.args[0]),
  describe_turn_failure: (c) =>
    describeTurnFailure(c.args[0], context(c.kwargs)),
  retry_reason: (c) => retryReason(c.args[0]),
};

const cases = fixture.cases as Case[];

test("displayed sentences never leak raw internals", () => {
  const shown = cases.filter((c) => c.fn.startsWith("describe_"));
  let pathSentences = 0;
  for (const c of shown) {
    const got = run[c.fn]!(c)!;
    expect(got).not.toContain("PiRPCError");
    expect(got).not.toMatch(
      /iso-root|var\/lib|fixture\/runtime|\/login|\{"|\n/,
    );
    expect(Array.from(got).length).toBeLessThanOrEqual(200);
    if (
      /\/fixture\/runtime\/(?:session\.jsonl|\.config\/)/.test(
        String(c.args[0]),
      )
    ) {
      expect(got).not.toBe("");
      expect(c.out).toBe(got);
      pathSentences++;
    }
  }
  expect(pathSentences).toBe(4);

  const retries = cases.filter((c) => c.fn === "retry_reason");
  expect(retries).toHaveLength(4);
  expect(retries.map((c) => [run[c.fn]!(c), retriedNotice(c.args[0])])).toEqual(
    [
      ["WebSocket error", "Connection dropped (WebSocket error); retried"],
      [null, "Connection dropped; retried"],
      ["connection error", "Connection dropped (connection error); retried"],
      ["timeout", "Connection dropped (timeout); retried"],
    ],
  );
});
