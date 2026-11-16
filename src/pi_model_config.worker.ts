// models.json is bounded untrusted data, never input to Pi's value resolvers.
// File-only auth stays separate from model metadata and SDK-visible headers.
import { parentPort } from "node:worker_threads";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Compile } from "typebox/compile";
import {
  ModelsConfigSchema,
  type ModelsJsonModel,
  type ModelsJsonModelOverride,
  type ModelsJsonProvider,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";
import { stripJsonComments } from "../node_modules/@earendil-works/pi-coding-agent/dist/utils/json.js";
import { stripBom } from "../node_modules/@earendil-works/pi-coding-agent/dist/utils/text.js";

export interface PiModelConfigSnapshot {
  providers: [string, ModelsJsonProvider][];
  fileProviders?: [
    string,
    { api: string; baseUrl: string; apiKey: string; models: ModelsJsonModel[] },
  ][];
  headers: [string, [string, Record<string, string>][]][];
  diagnostics?: string[];
  invalid: boolean;
  restricted: boolean;
}

const validate = Compile(ModelsConfigSchema);
const MAX_ENTRIES = 128;
const MAX_HEADERS = 32;
const MAX_HEADER_BYTES = 8192;
const metadataFields = [
  "name",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "inputLimits",
  "cost",
  "promptCache",
  "contextWindow",
  "maxTokens",
] as const satisfies readonly (keyof ModelsJsonModelOverride)[];

function hasExpression(value: unknown): boolean {
  if (typeof value === "string")
    return (
      value.trimStart().startsWith("!") || /\$(?:[A-Za-z_]|\{)/.test(value)
    );
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).some(hasExpression)
  );
}

function authHeader(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    /auth|cookie|token|secret|credential|apikey|accesskey|signature|assertion|bearer|jwt|session|subscription|organization|organisation|project|account|workspace|tenant|host|authority|proxy|forwarded|^xamz|contentlength|transferencoding|httpmethodoverride/.test(
      key,
    ) ||
    ["key", "xkey", "secwebsocketprotocol", "connection", "upgrade"].includes(
      key,
    )
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(id: string, reason: string, model?: string): string {
  const safe = (value: string) =>
    /^[A-Za-z0-9_.:@/+,-]{1,64}$/.test(value) ? value : "unsupported_id";
  return `provider:${safe(id)},${model === undefined ? "" : `model:${safe(model)},`}reason:${reason}`;
}

async function contents(path: string, maxBytes: number): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("unsupported file");
    const buffer = new Uint8Array(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        used,
      );
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > maxBytes) throw new Error("oversized file");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, used),
    );
  } finally {
    await file.close();
  }
}

parentPort!.on(
  "message",
  async (request: {
    path: string;
    builtins: [string, string[]][];
    reserved?: string[];
    maxBytes: number;
  }) => {
    try {
      const parsed: unknown = JSON.parse(
        stripJsonComments(
          stripBom(await contents(request.path, request.maxBytes)),
        ),
      );
      if (!object(parsed) || !object(parsed.providers))
        throw new Error("invalid schema");
      const builtins = new Map(
        request.builtins.map(([id, models]) => [id, new Set(models)]),
      );
      const reserved = new Set(request.reserved);
      const apis = new Set([
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
      ]);
      const providers: PiModelConfigSnapshot["providers"] = [];
      const fileProviders: NonNullable<PiModelConfigSnapshot["fileProviders"]> =
        [];
      const allHeaders: PiModelConfigSnapshot["headers"] = [];
      const diagnostics = new Set<string>();
      const skip = (id: string, reason: string, model?: string) =>
        diagnostics.add(diagnostic(id, reason, model));
      let entries = 0;
      if (Object.keys(parsed.providers).length > MAX_ENTRIES)
        throw new Error("too many providers");
      for (const [id, provider] of Object.entries(parsed.providers)) {
        if (
          !object(provider) ||
          !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(id)
        ) {
          skip(id, "invalid_provider");
          continue;
        }
        const existing = builtins.get(id);
        const fileOnly = existing === undefined;
        if (fileOnly && reserved.has(id)) {
          skip(id, "provider_id_collision");
          continue;
        }
        if (fileOnly) {
          if (
            typeof provider.apiKey !== "string" ||
            !provider.apiKey.trim() ||
            hasExpression(provider.apiKey) ||
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKey.trim())
          ) {
            skip(id, "literal_api_key_required");
            continue;
          }
          if (/[^\u0020-\u007e\u0080-\u00ff]/.test(provider.apiKey)) {
            skip(id, "invalid_api_key_header");
            continue;
          }
          if (typeof provider.api !== "string" || !apis.has(provider.api)) {
            skip(id, "unsupported_api");
            continue;
          }
          try {
            if (typeof provider.baseUrl !== "string")
              throw new Error("missing URL");
            const url = new URL(provider.baseUrl);
            if (
              !["http:", "https:"].includes(url.protocol) ||
              url.username ||
              url.password ||
              hasExpression(provider.baseUrl)
            )
              throw new Error("unsupported URL");
          } catch {
            skip(id, "http_base_url_required");
            continue;
          }
        } else {
          const { models: _models, ...fields } = provider;
          if (hasExpression(fields)) {
            skip(id, "provider_expression");
            continue;
          }
        }
        if (provider.models !== undefined && !Array.isArray(provider.models)) {
          skip(id, "invalid_models");
          continue;
        }
        entries += provider.models?.length ?? 0;
        if (entries > MAX_ENTRIES) throw new Error("too many entries");
        const headers = new Map<string, Record<string, string>>();
        const safeModels: ModelsJsonModel[] = [];
        let badProviderHeaders = false;
        let providerHeaders: Record<string, string> = {};
        if (fileOnly && provider.headers !== undefined) {
          if (
            !object(provider.headers) ||
            Object.values(provider.headers).some(
              (value) => typeof value !== "string",
            ) ||
            hasExpression(provider.headers)
          ) {
            skip(id, "literal_headers_required");
            continue;
          }
          providerHeaders = provider.headers as Record<string, string>;
        }
        for (const entry of provider.models ?? []) {
          if (!object(entry) || typeof entry.id !== "string" || !entry.id) {
            skip(id, "invalid_model");
            continue;
          }
          const modelId = entry.id;
          if (existing?.has(modelId) || headers.has(modelId)) {
            skip(id, "model_id_collision", entry.id);
            continue;
          }
          const model = Object.fromEntries(
            ["id", "headers", ...metadataFields]
              .filter((key) => entry[key] !== undefined)
              .map((key) => [key, entry[key]]),
          );
          if (!validate.Check({ providers: { [id]: { models: [model] } } })) {
            skip(id, "invalid_model_metadata", entry.id);
            continue;
          }
          if (hasExpression(model)) {
            skip(id, "model_expression", entry.id);
            continue;
          }
          if (Object.keys(entry).some((key) => !(key in model)))
            skip(id, "model_fields_ignored", entry.id);
          const values = Object.fromEntries(
            Object.entries({
              ...providerHeaders,
              ...(model.headers as Record<string, string> | undefined),
            }).filter(([key]) => {
              if (!authHeader(key)) return true;
              skip(id, "auth_header_ignored", modelId);
              return false;
            }),
          );
          try {
            if (
              Object.keys(values).length > MAX_HEADERS ||
              Buffer.byteLength(JSON.stringify(values)) > MAX_HEADER_BYTES
            )
              throw new Error("header limit");
            headers.set(entry.id, Object.fromEntries(new Headers(values)));
          } catch {
            skip(id, "invalid_or_oversized_headers", entry.id);
            badProviderHeaders = true;
            break;
          }
          delete model.headers;
          safeModels.push(model as unknown as ModelsJsonModel);
        }
        if (!fileOnly && Object.keys(provider).some((key) => key !== "models"))
          diagnostics.add(
            diagnostic(id, "provider_fields_ignored").replace(
              "reason:",
              "note:",
            ) + `,models_added:${badProviderHeaders ? 0 : safeModels.length}`,
          );
        if (badProviderHeaders || !safeModels.length) continue;
        if (fileOnly)
          fileProviders.push([
            id,
            {
              api: provider.api as string,
              baseUrl: provider.baseUrl as string,
              apiKey: provider.apiKey as string,
              models: safeModels,
            },
          ]);
        else providers.push([id, { models: safeModels }]);
        allHeaders.push([id, [...headers]]);
      }
      parentPort!.postMessage({
        providers,
        fileProviders,
        headers: allHeaders,
        diagnostics: [...diagnostics],
        invalid: false,
        restricted: diagnostics.size > 0,
      } satisfies PiModelConfigSnapshot);
    } catch {
      parentPort!.postMessage({
        providers: [],
        headers: [],
        invalid: true,
        restricted: false,
      } satisfies PiModelConfigSnapshot);
    }
  },
);
