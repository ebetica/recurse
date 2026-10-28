import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SafetyConfig = {
  additionalRules: string[];
  path: string;
  error?: string;
};

export function safetyConfigPath(configDir: string): string {
  return join(configDir, "pi-safety.json");
}

export function parseSafetyConfig(value: unknown, path: string): SafetyConfig {
  const base: SafetyConfig = { additionalRules: [], path };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...base, error: `${path}: root must be an object` };
  }

  const rules = (value as { rules?: unknown }).rules;
  if (rules === undefined) return base;
  if (
    !Array.isArray(rules) ||
    rules.some((rule) => typeof rule !== "string" || !rule.trim())
  ) {
    return {
      ...base,
      error: `${path}: rules must be an array of non-empty strings`,
    };
  }

  const additionalRules = [
    ...new Set(rules.map((rule) => (rule as string).trim())),
  ];
  if (
    additionalRules.length > 100 ||
    additionalRules.some((rule) => rule.length > 4_000)
  ) {
    return {
      ...base,
      error: `${path}: rules exceed the 100-rule or 4,000-character limit`,
    };
  }
  return { additionalRules, path };
}

// Recurse-global operator instructions for the reviewer, as free-form Markdown,
// beside pi-safety.json. The file is optional.
export function safetyPromptPath(configDir: string): string {
  return join(configDir, "pi-safety.md");
}

function loadSafetyPrompt(configDir: string): {
  text?: string;
  error?: string;
} {
  const path = safetyPromptPath(configDir);
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf8").trim();
    return text ? { text } : {};
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `${path}: could not load (${detail})` };
  }
}

export function loadSafetyConfig(configDir: string): SafetyConfig {
  const path = safetyConfigPath(configDir);
  const prompt = loadSafetyPrompt(configDir);
  const config = loadJsonConfig(path);
  if (config.error || prompt.error)
    return { ...config, error: config.error ?? prompt.error };
  return prompt.text
    ? { ...config, additionalRules: [...config.additionalRules, prompt.text] }
    : config;
}

function loadJsonConfig(path: string): SafetyConfig {
  if (!existsSync(path)) return { additionalRules: [], path };
  try {
    return parseSafetyConfig(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      additionalRules: [],
      path,
      error: `${path}: could not load config (${detail})`,
    };
  }
}
