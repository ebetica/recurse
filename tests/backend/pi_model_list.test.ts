import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../../src/config";
import { TEST_PI_MODELS, seedPiModelList } from "./pi_model_list_fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function makeConfig(authed: () => Iterable<string> = () => []): Config {
  const root = mkdtempSync(join(tmpdir(), "pi-model-list-"));
  roots.push(root);
  return new Config({
    env: { CHAT_DATA_DIR: join(root, "data"), HOME: join(root, "home") },
    authenticatedProviders: authed,
  });
}

const listText = (config: Config) =>
  readFileSync(config.paths.PI_MODEL_LIST_FILE, "utf8");

test("the stored list follows route order and a bad entry keeps the old list", () => {
  const config = makeConfig();
  const stored = config.setPiModelList([
    { provider: "openrouter", id: "vendor/m", name: "M", context_window: 9 },
    { provider: "anthropic", id: "a", name: "A", context_window: 5 },
  ]);
  expect(stored).toBe(2);
  expect(config.chatModels().map((option) => option.id)).toEqual([
    "anthropic/claude-opus-5-5",
    "anthropic/a",
    "openrouter/vendor/m",
  ]);
  const before = listText(config);
  expect(() =>
    config.setPiModelList([
      { provider: "anthropic", id: "b", name: "", context_window: 5 },
    ]),
  ).toThrow("invalid Pi model list entry");
  expect(() =>
    config.setPiModelList([
      { provider: "not-a-route", id: "b", name: "B", context_window: 5 },
    ]),
  ).toThrow("invalid Pi model list entry");
  expect(listText(config)).toBe(before);
});

test("login and logout change the shown routes at once, with no relist", () => {
  let authed = ["anthropic"];
  const config = makeConfig(() => authed);
  seedPiModelList(config.paths.CONFIG_DIR);
  const stat = () => statSync(config.paths.PI_MODEL_LIST_FILE).mtimeMs;
  const before = [listText(config), stat()];
  const shown = () =>
    new Set(config.authedChatModels().map((option) => option.provider));
  expect(shown()).toEqual(new Set(["Claude"]));
  authed = ["anthropic", "openai-codex"];
  expect(shown()).toEqual(new Set(["Claude", "ChatGPT subscription"]));
  authed = ["openai-codex"];
  expect(shown()).toEqual(new Set(["ChatGPT subscription"]));
  expect([listText(config), stat()]).toEqual(before);
});

test("a stored ladder id Pi no longer lists is kept, named, and refused", () => {
  const config = makeConfig(() => ["anthropic"]);
  seedPiModelList(config.paths.CONFIG_DIR);
  const ladder = {
    version: 1,
    default_level: 3,
    levels: Object.fromEntries(
      [1, 2, 3, 4, 5].map((level) => [
        String(level),
        {
          model:
            level === 2 ? "anthropic/claude-gone-4" : "anthropic/claude-opus-5",
          reasoning: "high",
        },
      ]),
    ),
  };
  const text = JSON.stringify(ladder);
  writeFileSync(config.paths.EFFORT_LEVELS_FILE, text);
  expect(config.effortLevels()[2]).toEqual({
    model: "anthropic/claude-gone-4",
    reasoning: "high",
  });
  expect(config.effortLevelReachability()[2]!.reason).toBe(
    "level 2 model anthropic/claude-gone-4 is not in Pi's model list",
  );
  expect(config.unlistedModelSentence("anthropic/claude-gone-4", 2)).toContain(
    "not in Pi's model list",
  );
  expect(
    config.unlistedModelSentence("anthropic/claude-gone-4", null),
  ).toContain("not in Pi's model list");
  expect(config.unlistedModelSentence("anthropic/claude-opus-5", 1)).toBeNull();
  expect(readFileSync(config.paths.EFFORT_LEVELS_FILE, "utf8")).toBe(text);
  const edited = structuredClone(ladder);
  edited.levels["4"]!.reasoning = "low";
  expect(config.setEffortLevels(edited)).toMatchObject({
    levels: { "2": { model: "anthropic/claude-gone-4" } },
  });
  edited.levels["3"]!.model = "anthropic/claude-gone-4";
  expect(() => config.setEffortLevels(edited)).toThrow(
    "unsupported model for effort level 3",
  );
});

test("custom providers follow Pi's routes", () => {
  const config = makeConfig();
  seedPiModelList(config.paths.CONFIG_DIR, TEST_PI_MODELS.slice(0, 1));
  writeFileSync(
    config.paths.MODEL_PROVIDERS_FILE,
    JSON.stringify({
      providers: {
        mine: {
          base_url: "https://example.test/v1",
          env_key: "MINE_KEY",
          wire_api: "responses",
          models: [{ id: "m1" }],
        },
      },
    }),
  );
  expect(config.chatModels().map((option) => option.id)).toEqual([
    "anthropic/claude-opus-5-5",
    "anthropic/claude-opus-5",
    "mine/m1",
  ]);
});

test("a list of hundreds of models is built once, not per call", () => {
  const config = makeConfig(() => ["openrouter"]);
  config.setPiModelList(
    Array.from({ length: 500 }, (_, n) => ({
      provider: "openrouter",
      id: `vendor/m${n}`,
      name: `M${n}`,
      context_window: 1000,
    })),
  );
  expect(config.chatModels()).toHaveLength(501);
  expect(config.chatModels()).toHaveLength(501);
  expect(config.unlistedModelSentence("openrouter/vendor/m7", 1)).toBeNull();
  expect(config.unlistedModelSentence("openrouter/vendor/gone", 1)).toContain(
    "not in Pi's model list",
  );
  expect(config.authedChatModels()).toHaveLength(500);

  config.chatModels()[1]!.label = "edited";
  expect(config.chatModels()[1]!.label).toBe("M0");
});
