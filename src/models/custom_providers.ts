// Validate model-providers.json on read and write, preserving provider order.
import { readFile, stat } from "node:fs/promises";
import {
  isObject,
  valueError,
  type ConfigFiles,
  type Dict,
} from "../config_files";
import { pyCompactJson } from "../utils/python-json";
import { validModelScopeKey } from "./model_id";
import { parseThinking, type Thinking } from "./thinking";

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

function validProviderName(name: string): boolean {
  return !/^\d+$/u.test(name) && validModelScopeKey(name);
}

function providerHeader(
  value: unknown,
): (Omit<ProviderSpec, "models"> & { models: unknown[] }) | null {
  if (!isObject(value)) return null;
  const { base_url, env_key, wire_api, models } = value;
  if (
    typeof base_url !== "string" ||
    !/^https?:\/\//u.test(base_url) ||
    typeof env_key !== "string" ||
    !validEnvironmentKey(env_key) ||
    (wire_api !== "responses" && wire_api !== "completions") ||
    !Array.isArray(models)
  )
    return null;
  return { base_url, env_key, wire_api, models };
}

function parseProviderModel(
  name: string,
  value: unknown,
  strict = false,
): ProviderModel | null {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !validModelScopeKey(`${name}/${value.id}`)
  )
    return null;
  const entry: ProviderModel = { id: value.id, effort: null };
  if (typeof value.label === "string" && value.label) entry.label = value.label;
  if (
    typeof value.context_window === "number" &&
    Number.isInteger(value.context_window) &&
    value.context_window > 0
  )
    entry.context_window = value.context_window;
  if (value.effort != null) {
    try {
      entry.effort = parseThinking(value.effort);
    } catch {
      if (strict) return null;
    }
  }
  return entry;
}

export function readProvidersDocument(
  data: unknown,
): [Record<string, ProviderSpec>, string] {
  if (!isObject(data)) return [{}, ""];
  const defaultRaw = typeof data.default === "string" ? data.default : "";
  const providers: Record<string, ProviderSpec> = {};
  if (!isObject(data.providers)) return [providers, defaultRaw];
  for (const [name, raw] of Object.entries(data.providers)) {
    if (!validProviderName(name)) continue;
    const parsed = providerHeader(raw);
    if (!parsed) continue;
    const { models: rawModels, ...header } = parsed;
    const models = rawModels
      .map((model) => parseProviderModel(name, model))
      .filter((model) => model !== null);
    if (models.length) providers[name] = { ...header, models };
  }
  return [providers, defaultRaw];
}

export async function upsertCustomProvider(
  settingsFiles: ConfigFiles,
  path: string,
  name: string,
  spec: Dict,
): Promise<boolean> {
  if (!validProviderName(name))
    throw valueError(`invalid custom provider name: '${name}'`);
  if (!isObject(spec))
    throw valueError("custom provider spec must be an object");
  const parsed = providerHeader(spec);
  if (!parsed?.models.length)
    throw valueError(`invalid custom provider spec for '${name}'`);
  const { models: rawModels, ...header } = parsed;
  const models = Array.from(rawModels, (rawModel) => {
    const model = parseProviderModel(name, rawModel, true);
    if (!model) throw valueError(`invalid custom provider spec for '${name}'`);
    const { effort, ...entry } = model;
    return effort === null ? entry : { ...entry, effort };
  });
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
    providers[name] = { ...header, models };
    const mode = await stat(path)
      .then((info) => info.mode & 0o777)
      .catch(() => 0o600);
    const text = pyCompactJson(document, {
      indent: 2,
      javascriptScalars: true,
    });
    return { text: `${text}\n`, mode, value: true };
  });
}
