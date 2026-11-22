// Read and write model-providers.json, keeping provider names in source order.
import { readFile, stat } from "node:fs/promises";
import {
  isObject,
  valueError,
  type ConfigFiles,
  type Dict,
} from "../config_files";
import { validModelScopeKey } from "./model_id";
import { parseThinking, type Thinking } from "./thinking";

type JsonPropertyPosition = { key: string; valueStart: number };

// JSON.parse gives correct values but JavaScript reorders integer-like object
// keys. Keep source order for provider names.
function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[\t\n\r ]/u.test(text[index]!)) index++;
  return index;
}

function endOfJsonString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index++;
  }
  return text.length;
}

function endOfJsonValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') return endOfJsonString(text, start);
  if (first === "{" || first === "[") {
    const closers = [first === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < text.length && closers.length) {
      const char = text[index]!;
      if (char === '"') {
        index = endOfJsonString(text, index);
        continue;
      }
      if (char === "{" || char === "[") {
        closers.push(char === "{" ? "}" : "]");
        index++;
        continue;
      }
      if (char === "}" || char === "]") {
        if (closers.at(-1) === char) closers.pop();
        index++;
        continue;
      }
      index++;
    }
    return index;
  }
  let index = start;
  while (index < text.length && !/[\t\n\r ,}\]]/u.test(text[index]!)) index++;
  return index;
}

function jsonObjectProperties(
  text: string,
  start: number,
): JsonPropertyPosition[] {
  let index = skipJsonWhitespace(text, start);
  if (text[index] !== "{") return [];
  index++;
  const properties: JsonPropertyPosition[] = [];
  const positions = new Map<string, number>();
  while (index < text.length) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") return properties;
    if (text[index] !== '"') return properties;
    const keyEnd = endOfJsonString(text, index);
    const key = JSON.parse(text.slice(index, keyEnd)) as string;
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ":") return properties;
    const valueStart = skipJsonWhitespace(text, index + 1);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, properties.length);
      properties.push({ key, valueStart });
    } else {
      properties[position] = { key, valueStart };
    }
    index = skipJsonWhitespace(text, endOfJsonValue(text, valueStart));
    if (text[index] === ",") {
      index++;
      continue;
    }
    if (text[index] === "}") return properties;
    return properties;
  }
  return properties;
}

interface ProviderModel {
  id: string;
  label?: string;
  context_window?: number;
  effort: Thinking | null;
}
export interface ProviderSpec {
  base_url: string;
  env_key: string;
  wire_api: "responses" | "completions";
  models: ProviderModel[];
}

function validEnvironmentKey(value: string): boolean {
  const alphanumeric = value.replaceAll("_", "");
  return (
    /^[\p{L}\p{N}]+$/u.test(alphanumeric) &&
    /\p{Lu}/u.test(value) &&
    !/\p{Ll}/u.test(value)
  );
}

function pythonJsonIndented(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[^\x00-\x7f]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function readProvidersDocument(
  text: string | undefined,
): [Record<string, ProviderSpec>, string, [string, ProviderSpec][]] {
  if (text === undefined) return [{}, "", []];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [{}, "", []];
  }
  if (!isObject(data)) return [{}, "", []];
  const defaultRaw = typeof data.default === "string" ? data.default : "";
  const providers: Record<string, ProviderSpec> = {};
  const providerEntries: [string, ProviderSpec][] = [];
  if (!isObject(data.providers))
    return [providers, defaultRaw, providerEntries];
  const providerProperty = jsonObjectProperties(text, 0).find(
    ({ key }) => key === "providers",
  );
  const providerNames =
    providerProperty === undefined
      ? Object.keys(data.providers)
      : jsonObjectProperties(text, providerProperty.valueStart).map(
          ({ key }) => key,
        );
  for (const name of providerNames) {
    if (!name || !Object.hasOwn(data.providers, name)) continue;
    const rawProvider = data.providers[name];
    if (
      !name ||
      !validModelScopeKey(name) ||
      name.startsWith("_") ||
      !isObject(rawProvider)
    )
      continue;
    const baseUrl = rawProvider.base_url;
    const envKey = rawProvider.env_key;
    const wireApi = rawProvider.wire_api;
    if (
      typeof baseUrl !== "string" ||
      !/^https?:\/\//u.test(baseUrl) ||
      typeof envKey !== "string" ||
      !validEnvironmentKey(envKey) ||
      (wireApi !== "responses" && wireApi !== "completions") ||
      !Array.isArray(rawProvider.models)
    )
      continue;
    const models: ProviderModel[] = [];
    for (const rawModel of rawProvider.models) {
      if (!isObject(rawModel)) continue;
      const modelId = rawModel.id;
      if (
        typeof modelId !== "string" ||
        !modelId ||
        !validModelScopeKey(`${name}/${modelId}`)
      )
        continue;
      const entry: ProviderModel = { id: modelId, effort: null };
      if (typeof rawModel.label === "string" && rawModel.label)
        entry.label = rawModel.label;
      if (
        typeof rawModel.context_window === "number" &&
        Number.isInteger(rawModel.context_window) &&
        rawModel.context_window > 0
      )
        entry.context_window = rawModel.context_window;
      if (rawModel.effort !== undefined && rawModel.effort !== null) {
        try {
          entry.effort = parseThinking(rawModel.effort);
        } catch {
          entry.effort = null;
        }
      }
      models.push(entry);
    }
    if (models.length) {
      const provider: ProviderSpec = {
        base_url: baseUrl,
        env_key: envKey,
        wire_api: wireApi,
        models,
      };
      providers[name] = provider;
      providerEntries.push([name, provider]);
    }
  }
  return [providers, defaultRaw, providerEntries];
}

export async function upsertCustomProvider(
  settingsFiles: ConfigFiles,
  path: string,
  name: string,
  spec: Dict,
): Promise<boolean> {
  if (!name || name.startsWith("_") || !validModelScopeKey(name))
    throw valueError(`invalid custom provider name: '${name}'`);
  if (!isObject(spec))
    throw valueError("custom provider spec must be an object");
  const baseUrl = spec.base_url;
  const envKey = spec.env_key;
  const wireApi = spec.wire_api;
  const rawModels = spec.models;
  if (
    typeof baseUrl !== "string" ||
    !/^https?:\/\//u.test(baseUrl) ||
    typeof envKey !== "string" ||
    !validEnvironmentKey(envKey) ||
    (wireApi !== "responses" && wireApi !== "completions") ||
    !Array.isArray(rawModels) ||
    !rawModels.length
  ) {
    throw valueError(`invalid custom provider spec for '${name}'`);
  }
  const models: Dict[] = [];
  for (const model of rawModels) {
    if (!isObject(model))
      throw valueError(`invalid custom provider spec for '${name}'`);
    if (typeof model.id !== "string" || !model.id)
      throw valueError(`invalid custom provider spec for '${name}'`);
    const entry: Dict = { id: model.id };
    if (typeof model.label === "string" && model.label)
      entry.label = model.label;
    if (
      typeof model.context_window === "number" &&
      Number.isInteger(model.context_window) &&
      model.context_window > 0
    )
      entry.context_window = model.context_window;
    if (model.effort !== undefined && model.effort !== null) {
      try {
        entry.effort = parseThinking(model.effort);
      } catch {
        throw valueError(`invalid custom provider spec for '${name}'`);
      }
    }
    models.push(entry);
  }
  return settingsFiles.write<boolean>(path, async () => {
    let document: Dict;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isObject(parsed)) throw new Error("invalid");
      document = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") document = {};
      else throw new Error(`cannot seed '${name}': ${path} is invalid`);
    }
    let providers = document.providers;
    if (providers === undefined || providers === null) {
      providers = {};
      document.providers = providers;
    }
    if (!isObject(providers))
      throw new Error(`cannot seed '${name}': ${path} is invalid`);
    if (Object.hasOwn(providers, name)) return { value: false };
    providers[name] = {
      base_url: baseUrl,
      env_key: envKey,
      wire_api: wireApi,
      models,
    };
    const mode = await stat(path)
      .then((info) => info.mode & 0o777)
      .catch(() => 0o600);
    return { text: `${pythonJsonIndented(document)}\n`, mode, value: true };
  });
}
