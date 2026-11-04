// Reload additive operator rules asynchronously at each new run.
import { readFile } from "node:fs/promises";
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

async function loadSafetyPrompt(configDir: string): Promise<{
  text?: string;
  error?: string;
}> {
  const path = safetyPromptPath(configDir);
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text ? { text } : {};
  } catch (error) {
    if (isMissing(error)) return {};
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `${path}: could not load (${detail})` };
  }
}

export async function loadSafetyConfig(
  configDir: string,
): Promise<SafetyConfig> {
  const path = safetyConfigPath(configDir);
  const [prompt, config] = await Promise.all([
    loadSafetyPrompt(configDir),
    loadJsonConfig(path),
  ]);
  if (config.error || prompt.error)
    return { ...config, error: config.error ?? prompt.error };
  return prompt.text
    ? { ...config, additionalRules: [...config.additionalRules, prompt.text] }
    : config;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function loadJsonConfig(path: string): Promise<SafetyConfig> {
  try {
    return parseSafetyConfig(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if (isMissing(error)) return { additionalRules: [], path };
    const detail = error instanceof Error ? error.message : String(error);
    return {
      additionalRules: [],
      path,
      error: `${path}: could not load config (${detail})`,
    };
  }
}
