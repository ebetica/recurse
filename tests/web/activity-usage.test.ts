import { describe, expect, test } from "bun:test";
import {
  activityTotalCostLabel,
  activityUsage,
  activityUsageCaption,
  activityUsageLabel,
} from "../../web/thread-render/activity-usage";
import type {
  MessageEntry,
  Turn,
  TurnSummary,
  TurnUsageTotal,
} from "../../web/types";

const WORK: TurnSummary = {
  tools: 0,
  shell: 0,
  read_files: 0,
  edit_files: 0,
  added: 0,
  removed: 0,
  write_files: 0,
  agents: 0,
  searches: 0,
  web: 0,
  prs: [],
  truncated: false,
};
const usage = (over: Partial<TurnUsageTotal> = {}): TurnUsageTotal => ({
  input: 10,
  output: 2,
  cacheRead: 20,
  cacheWrite: 3,
  calls: 1,
  replies: 1,
  partial: false,
  cost: 0.01,
  costPartial: false,
  ...over,
});
const reply = (reported = usage()): MessageEntry => ({
  kind: "assistant",
  role: "assistant",
  content: "done",
  offset: 1,
  usage: reported,
});
const turn = (
  id: string,
  summary: TurnSummary,
  assistant?: MessageEntry,
): Turn => ({
  turn_id: id,
  started_at: 1,
  ended_at: 2,
  open: false,
  status: "idle",
  summary,
  partial: false,
  segments: assistant
    ? [{ user: [], tools: [], assistant, summary: null }]
    : [],
});
const withUsage = (id: string, model: TurnUsageTotal, safety = false): Turn => {
  const summary: TurnSummary = { ...WORK, usage: model };
  if (safety)
    summary.safety_usage = {
      calls: 1,
      partial: false,
      groups: [
        {
          selector: "reviewer/model",
          calls: 1,
          costPartial: false,
          input: 4,
          output: 1,
          cacheRead: 5,
          cacheWrite: 0,
          cost: 0.002,
        },
      ],
    };
  return turn(id, summary);
};

describe("activity usage aggregate", () => {
  // Regression: #1847 truthful activity counts and usage captions
  test("sums single and multiple completed turns, including exact grouped cost", () => {
    const first = usage({
      model_usage_partial: false,
      model_groups: [
        {
          selector: "provider/a",
          calls: 1,
          costPartial: false,
          input: 10,
          output: 2,
          cacheRead: 20,
          cacheWrite: 3,
          cost: 0.01,
        },
      ],
    });
    const second = usage({
      input: 7,
      output: 3,
      cacheRead: 11,
      cacheWrite: 1,
      calls: 2,
      cost: 0.025,
      model_usage_partial: false,
      model_groups: [
        {
          selector: "provider/a",
          calls: 1,
          costPartial: true,
          input: 2,
          output: 1,
          cacheRead: 6,
          cacheWrite: 1,
          cost: 0.005,
        },
        {
          selector: "provider/b",
          calls: 1,
          costPartial: false,
          input: 5,
          output: 2,
          cacheRead: 5,
          cacheWrite: 0,
          cost: 0.02,
        },
      ],
    });
    const single = activityUsage([withUsage("one", first)]);
    expect(activityUsageCaption(single)).toBe(
      "Totals for 1 turn: 1 message and 0 tool calls.",
    );

    const aggregate = activityUsage([
      withUsage("one", first, true),
      withUsage("automatic", second),
    ]);
    expect(aggregate).toMatchObject({
      completedTurns: 2,
      reportedTurns: 2,
      modelTokens: 57,
      safetyTokens: 10,
      modelPartial: false,
      safetyPartial: false,
    });
    expect(aggregate.modelTotal).toMatchObject({
      input: 17,
      output: 5,
      cacheRead: 31,
      cacheWrite: 4,
      calls: 3,
      replies: 2,
      cost: 0.035,
    });
    expect(aggregate.modelTotal?.model_groups).toEqual([
      {
        selector: "provider/a",
        calls: 2,
        costPartial: true,
        input: 12,
        output: 3,
        cacheRead: 26,
        cacheWrite: 4,
        cost: 0.015,
      },
      {
        selector: "provider/b",
        calls: 1,
        costPartial: false,
        input: 5,
        output: 2,
        cacheRead: 5,
        cacheWrite: 0,
        cost: 0.02,
      },
    ]);
    expect(activityUsageLabel(aggregate)).toBe(
      "57 model tokens · 10 safety-review tokens",
    );
    expect(activityUsageCaption(aggregate)).toBe(
      "Totals for 2 turns: 2 messages and 0 tool calls (3 model requests).",
    );
  });

  // Regression: #1847 truthful activity counts and usage captions
  test("makes every known subtotal a lower bound for live or fail-open ambiguity", () => {
    const aggregate = activityUsage(
      [withUsage("reviewed", usage(), true)],
      true,
    );
    expect(aggregate).toMatchObject({
      modelPartial: true,
      safetyPartial: true,
    });
    expect(aggregate.modelTotal?.costPartial).toBeTrue();
    expect(aggregate.safetyTotal?.groups[0]?.costPartial).toBeTrue();
    expect(activityUsageLabel(aggregate)).toBe(
      "35 model tokens · 10 safety-review tokens",
    );
    expect(activityUsageCaption(aggregate)).toBe(
      "Totals for 1 turn: 1 message and 0 tool calls.",
    );
  });

  // Regression: #1847 truthful activity counts and usage captions
  test("mixed legacy and authoritative turns retain only the known lower bound", () => {
    const aggregate = activityUsage([
      withUsage("known", usage(), true),
      turn("legacy", WORK, reply(usage({ input: 50_000 }))),
    ]);
    expect(aggregate.completedTurns).toBe(2);
    expect(aggregate.reportedTurns).toBe(1);
    expect(aggregate.modelTokens).toBe(35);
    expect(aggregate.safetyTokens).toBe(10);
    expect(aggregate.modelPartial).toBeTrue();
    expect(aggregate.safetyPartial).toBeFalse();
    expect(aggregate.safetyTotal?.groups[0]?.costPartial).toBeFalse();
    expect(activityUsageLabel(aggregate)).toBe(
      "35 model tokens · 10 safety-review tokens",
    );
  });

  // Regression: #1847 truthful activity counts and usage captions
  test("selector-less totals keep numeric details with truthful turn captions", () => {
    const one = activityUsage([withUsage("one", usage())]);
    expect(one.modelTotal).toMatchObject({
      input: 10,
      output: 2,
      calls: 1,
      cost: 0.01,
      costPartial: false,
    });
    expect(one.modelTotal?.model_groups).toEqual([]);
    expect(activityUsageCaption(one)).toBe(
      "Totals for 1 turn: 1 message and 0 tool calls.",
    );
    expect(
      activityUsageCaption(
        activityUsage([withUsage("one", usage()), withUsage("two", usage())]),
      ),
    ).toBe("Totals for 2 turns: 2 messages and 0 tool calls.");
    expect(activityUsageCaption(one)).not.toContain("whole turn");
  });

  // Regression: #1847 truthful activity counts and usage captions
  test("keeps authoritative total cost separate from model and safety bars", () => {
    const partialBreakdown = usage({
      cost: 0.3,
      model_usage_partial: false,
      model_groups: [
        {
          selector: "provider/a",
          calls: 1,
          costPartial: true,
          input: 10,
          output: 2,
          cacheRead: 20,
          cacheWrite: 3,
          cost: 0.1,
        },
      ],
    });
    const exactBreakdown = usage({
      cost: 0.3,
      model_usage_partial: false,
      model_groups: [
        {
          selector: "provider/a",
          calls: 1,
          costPartial: false,
          input: 10,
          output: 2,
          cacheRead: 20,
          cacheWrite: 3,
          cost: 0.3,
        },
      ],
    });
    expect(
      activityTotalCostLabel(
        activityUsage([withUsage("partial-breakdown", partialBreakdown, true)]),
      ),
    ).toBe("Total cost: $0.30");
    expect(
      activityTotalCostLabel(
        activityUsage([withUsage("exact-breakdown", exactBreakdown, true)]),
      ),
    ).toBe("Total cost: $0.30");
    expect(
      activityTotalCostLabel(
        activityUsage([
          withUsage(
            "partial-total",
            usage({
              cost: 0.3,
              costPartial: true,
            }),
          ),
        ]),
      ),
    ).toBe("Total cost: $0.30+");
    expect(
      activityTotalCostLabel(
        activityUsage([
          withUsage(
            "invalid",
            usage({
              cost: Number.POSITIVE_INFINITY,
            }),
          ),
        ]),
      ),
    ).toBe("");
    expect(activityTotalCostLabel(activityUsage([turn("legacy", WORK)]))).toBe(
      "",
    );
  });
});
