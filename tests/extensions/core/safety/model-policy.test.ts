import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  loadTrustedModelPolicy,
  MODEL_POLICY_ENV,
  pickReviewerCandidates,
} from "../../../../src/extensions/core/safety/model-policy.ts";

const valid = {
  version: 1,
  active: { provider: "openai", model: "gpt-5.6-luna" },
  reviewer: { provider: "openai", model: "gpt-5.6-luna", effort: "low" },
  summary: { provider: "openai", model: "gpt-5.6-luna", effort: "low" },
};

test("trusted policy parser preserves explicit provider/model/effort", () => {
  expect(
    loadTrustedModelPolicy({
      [MODEL_POLICY_ENV]: JSON.stringify(valid),
    }),
  ).toEqual({ status: "valid", policy: valid } as any);
});

test("trusted policy parser distinguishes absence from every invalid value", () => {
  expect(loadTrustedModelPolicy({})).toEqual({ status: "absent" });
  for (const raw of [
    "",
    "not-json",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({
      ...valid,
      reviewer: { ...valid.reviewer, effort: "turbo" },
    }),
    JSON.stringify({
      ...valid,
      summary: { provider: 7, model: "x", effort: "low" },
    }),
  ]) {
    expect(loadTrustedModelPolicy({ [MODEL_POLICY_ENV]: raw })).toEqual({
      status: "invalid",
    });
  }
});

test("registry selection never substitutes another provider or active model", () => {
  const directLuna = {
    provider: "openai",
    id: "gpt-5.6-luna",
    reasoning: true,
  };
  const codexLuna = {
    provider: "openai-codex",
    id: "gpt-5.6-luna",
    reasoning: true,
  };
  const active = { ...directLuna };
  const found: Array<[string, string]> = [];
  const ctx = {
    model: active,
    modelRegistry: {
      find(provider: string, id: string) {
        found.push([provider, id]);
        if (provider === "openai" && id === "gpt-5.6-luna") return directLuna;
        return codexLuna;
      },
    },
  } as unknown as ExtensionContext;
  const policy = loadTrustedModelPolicy({
    [MODEL_POLICY_ENV]: JSON.stringify(valid),
  });

  expect(pickReviewerCandidates(ctx, policy, "reviewer")?.[0]).toEqual({
    model: directLuna as any,
    effort: "low",
  });
  expect(found).toEqual([["openai", "gpt-5.6-luna"]]);

  const wrongActive = { ...ctx, model: codexLuna } as ExtensionContext;
  expect(
    pickReviewerCandidates(wrongActive, policy, "reviewer")?.[0],
  ).toBeUndefined();
  expect(found).toHaveLength(1);

  const wrongLookup = {
    ...ctx,
    modelRegistry: { find: () => codexLuna },
  } as unknown as ExtensionContext;
  expect(
    pickReviewerCandidates(wrongLookup, policy, "reviewer")?.[0],
  ).toBeUndefined();
});

test("reviewer candidates are ordered, normalized, and summary never falls back", () => {
  const fallbackPolicy = {
    ...valid,
    reviewer: {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      effort: "low",
      candidates: [
        { provider: "openai-codex", model: "gpt-5.6-luna", effort: "high" },
        { provider: "anthropic", model: "claude-sonnet-5", effort: "low" },
        { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      ],
    },
  };
  const state = loadTrustedModelPolicy({
    [MODEL_POLICY_ENV]: JSON.stringify(fallbackPolicy),
  });
  expect(state).toEqual({
    status: "valid",
    policy: {
      ...valid,
      reviewer: {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        effort: "low",
        candidates: [
          { provider: "anthropic", model: "claude-sonnet-5", effort: "low" },
        ],
      },
    },
  } as any);
  if (state.status !== "valid")
    throw new Error("candidate policy unexpectedly invalid");
  const calls: Array<[string, string]> = [];
  const ctx = {
    model: { provider: "openai", id: "gpt-5.6-luna" },
    modelRegistry: {
      find(provider: string, model: string) {
        calls.push([provider, model]);
        return provider === "anthropic" ? { provider, id: model } : undefined;
      },
    },
  } as unknown as ExtensionContext;
  expect(pickReviewerCandidates(ctx, state, "reviewer")?.[0]).toEqual({
    model: { provider: "anthropic", id: "claude-sonnet-5" } as any,
    effort: "low",
  });
  expect(calls).toEqual([
    ["openai-codex", "gpt-5.6-luna"],
    ["anthropic", "claude-sonnet-5"],
  ]);
  expect(pickReviewerCandidates(ctx, state, "summary")?.[0]).toBeUndefined();
});

test("candidate lists reject malformed entries and empty lists", () => {
  for (const candidates of [
    null,
    [],
    [{ provider: "anthropic", model: "claude-sonnet-5" }],
    [{ provider: "anthropic", model: "claude-sonnet-5", effort: "turbo" }],
    [
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        effort: "low",
        candidates: [],
      },
    ],
  ]) {
    expect(
      loadTrustedModelPolicy({
        [MODEL_POLICY_ENV]: JSON.stringify({
          ...valid,
          reviewer: { ...valid.reviewer, candidates },
        }),
      }),
    ).toEqual({ status: "invalid" });
  }
  expect(
    loadTrustedModelPolicy({
      [MODEL_POLICY_ENV]: JSON.stringify({
        ...valid,
        summary: { ...valid.summary, candidates: [valid.reviewer] },
      }),
    }),
  ).toEqual({ status: "invalid" });
});

// test-check-allow: T9 Invalid policy must not fall back to the active model.
test("only an absent policy uses the exact active model compatibility route", () => {
  const active = {
    provider: "anthropic",
    id: "claude-opus-5",
    reasoning: true,
  };
  const ctx = { model: active } as unknown as ExtensionContext;

  expect(
    pickReviewerCandidates(ctx, { status: "absent" }, "reviewer")?.[0],
  ).toEqual({ model: active as any, effort: "low" });
  expect(
    pickReviewerCandidates(ctx, { status: "absent" }, "summary")?.[0],
  ).toEqual({ model: active as any, effort: "low" });
  expect(
    pickReviewerCandidates(ctx, { status: "invalid" }, "reviewer")?.[0],
  ).toBeUndefined();
});
