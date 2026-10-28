import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PI_MODEL_LIST_VERSION } from "../../src/config";

export const TEST_PI_MODELS = [
  ["anthropic", "claude-opus-5", "Claude Opus 5", 1_000_000],
  ["anthropic", "claude-opus-5-5", "Claude Opus 5.5", 1_000_000],
  ["anthropic", "claude-sonnet-5", "Claude Sonnet 5", 1_000_000],
  ["anthropic", "claude-fable-5-1", "Claude Fable 5.1", 1_000_000],
  ["openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", 372_000],
  ["openai-codex", "gpt-5.6-luna", "GPT-5.6 Luna", 372_000],
  ["openai-codex", "gpt-6-astra", "GPT-6 Astra", 1_050_000],
  ["openai-codex", "gpt-6-sol", "GPT-6 Sol", 1_050_000],
  ["openai-codex", "gpt-6-luna", "GPT-6 Luna", 1_050_000],
  ["openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol", 1_050_000],
].map(([provider, id, name, context_window]) => ({
  provider,
  id,
  name,
  context_window,
}));

export function piModelListText(models = TEST_PI_MODELS): string {
  return JSON.stringify({ version: PI_MODEL_LIST_VERSION, models });
}

export function seedPiModelList(configDir: string, models = TEST_PI_MODELS) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "pi-model-list.json"), piModelListText(models));
}
