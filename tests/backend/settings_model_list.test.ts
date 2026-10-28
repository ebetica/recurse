import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../../src/config";
import { Router } from "../../src/web/router";
import { registerSettingsRoutes } from "../../src/web/settings";
import { serveOpen } from "./http_open_app";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const LISTED = [
  {
    provider: "anthropic",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    context_window: 1_000_000,
    reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    context_window: 1_000_000,
  },
  {
    provider: "openai-codex",
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    context_window: 272_000,
    reasoning_levels: ["off", "low", "medium", "high", "xhigh"],
  },
  {
    provider: "openrouter",
    id: "vendor/fresh",
    name: "Fresh",
    context_window: 128_000,
    reasoning_levels: ["off"],
  },
  {
    provider: "openai",
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    context_window: 272_000,
    reasoning_levels: ["high", "low"],
  },
];

function world(authed: string[]) {
  const root = mkdtempSync(join(tmpdir(), "settings-model-list-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(join(data, "config"), { recursive: true });
  writeFileSync(
    join(data, "config", "model-providers.json"),
    JSON.stringify({
      providers: {
        lab: {
          base_url: "https://lab.example/v1",
          env_key: "LAB_KEY",
          wire_api: "completions",
          models: [{ id: "tiny", label: "Tiny", context_window: 32_000 }],
        },
      },
    }),
  );
  const config = new Config({
    env: {
      CHAT_DATA_DIR: data,
      HOME: join(root, "home"),
      LAB_KEY: "not-a-real-key",
    },
    authenticatedProviders: () => authed,
  });
  config.setPiModelList(LISTED);
  return { root, data, config };
}

async function serve(config: Config, root: string) {
  const router = new Router();
  registerSettingsRoutes(router, {
    config,
  } as unknown as Parameters<typeof registerSettingsRoutes>[1]);
  return (await serveOpen(router, join(root, "data"))).running;
}

test("the Settings list holds only logged-in routes and custom providers, in route order", async () => {
  const { config, root } = world(["openrouter", "anthropic", "openai"]);
  const running = await serve(config, root);
  try {
    const url = `${running.url}/api/settings/model-list`;
    const first = await fetch(url);
    const body = (await first.json()) as {
      models: Record<string, unknown>[];
      reasoning: string[];
    };

    expect(body.models).toEqual([
      {
        id: "anthropic/claude-opus-5-5",
        label: "Claude Opus 5.5",
        route: "Claude",
        context_window: 1_000_000,
        reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "anthropic/claude-sonnet-5",
        label: "Claude Sonnet 5",
        route: "Claude",
        context_window: 1_000_000,
        reasoning_levels: null,
      },
      {
        id: "openai/gpt-6-sol",
        label: "GPT-6 Sol",
        route: "OpenAI API",
        context_window: 272_000,
        reasoning_levels: ["low", "high"],
      },
      {
        id: "openrouter/vendor/fresh",
        label: "Fresh",
        route: "OpenRouter",
        context_window: 128_000,
        reasoning_levels: ["off"],
      },
      {
        id: "lab/tiny",
        label: "Tiny",
        route: "lab",
        context_window: 32_000,
        reasoning_levels: null,
      },
    ]);
    const tag = first.headers.get("etag");
    expect(tag).toBeTruthy();
    const again = await fetch(url, { headers: { "if-none-match": tag! } });
    expect(again.status).toBe(304);
  } finally {
    await running.close();
  }
});

test("effort-levels carries only the ladder's own models", async () => {
  const { config, root } = world(["anthropic", "openai-codex", "openrouter"]);
  const entry = (model: string) => ({ model, reasoning: "high" });
  config.setEffortLevels({
    levels: {
      1: entry("anthropic/claude-sonnet-5"),
      2: entry("openai-codex/gpt-6-sol"),
      3: entry("anthropic/claude-opus-5-5"),
      4: entry("anthropic/claude-opus-5-5"),
      5: entry("openrouter/vendor/fresh"),
    },
    default_level: 3,
  });
  const running = await serve(config, root);
  try {
    const body = (await (
      await fetch(`${running.url}/api/settings/effort-levels`)
    ).json()) as { models: Record<string, unknown>[] };
    expect(body.models).toEqual([
      {
        id: "anthropic/claude-sonnet-5",
        label: "Claude Sonnet 5",
        context_window: 1_000_000,
      },
      {
        id: "openai-codex/gpt-6-sol",
        label: "GPT-6 Sol",
        context_window: 272_000,
      },
      {
        id: "anthropic/claude-opus-5-5",
        label: "Claude Opus 5.5",
        context_window: 1_000_000,
      },
      {
        id: "openrouter/vendor/fresh",
        label: "Fresh",
        context_window: 128_000,
      },
    ]);
  } finally {
    await running.close();
  }
});
