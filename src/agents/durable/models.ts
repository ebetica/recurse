// Listing/turns share restricted Pi metadata; built-ins use Settings auth.
// Claude uses Pi's summarized thinking and catalog fallbacks; Fable needs a newer CLI identity.
// RECURSE_READ_ONLY_SIGN_INS reads external auth.json without writes/refresh;
// catalogs/usage remain private. Custom providers retain their key/env_key.
import {
  type ApiKeyAuth,
  type AssistantMessageEvent,
  type AuthContext,
  createProvider,
  type MutableModels,
  type Models,
  type OAuthCredential,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  builtinProviders,
  getBuiltinModelDataGeneratedAt,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
import { createModels } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import {
  CODEX_PROVIDER,
  GEMINI_CREDENTIAL,
  GEMINI_MIN_KEY_LENGTH,
  withCodexCliAccess,
} from "../../auth";
import { ReadOnlySignIns } from "../../auth/read_only_sign_ins.ts";
import { PICK_EFFORT_LEVEL_AGAIN, providerOutageKind } from "../view";
import {
  credentialFields,
  credentialMask,
  mapStreamMessages,
  maskProviderFailure,
  rememberTurnError,
  TURN_ERROR_TEXT,
  withProviderErrors,
  type ChatStream,
  type TurnErrorText,
} from "./provider_responses";
import { FileModelsStore } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import {
  withPersonalizedCatalog,
  withRemoteCatalog,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/remote-catalog-provider.js";
import { join } from "node:path";
import { ModelConfig } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";
import { composeModelProvider } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js";
import {
  readPiModelConfig,
  reportPiModelConfigError,
  type PiModelConfigSnapshot,
} from "../../pi_model_config";
import type { ProviderSpec } from "../../models";

/** No environment variables and no ambient credential files. */
export const STORED_CREDENTIALS_ONLY: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

const TRUSTED_CATALOG = Symbol("trusted model catalog");
const ADD_FILE_MODELS = Symbol("add file models to Settings provider");
const STORED_CODEX_AUTH = Symbol("stored Codex auth for MCP");
const CHAT_ONLY_AUTH = Symbol("chat-only provider auth");

/** Shipped models and Settings providers, never file-backed catalogs. */
export function trustedModelCatalog<T extends Models>(models: T): T {
  return (Reflect.get(models, TRUSTED_CATALOG) as T | undefined) ?? models;
}

/** Pi also supports OpenAI OAuth on the platform route; Recurse doesn't. */
function withPlatformKeyOnly(provider: Provider): Provider {
  if (provider.id !== "openai") return provider;
  const auth = { apiKey: provider.auth.apiKey };
  return new Proxy(provider, {
    get(target, key) {
      if (key === "auth") return auth;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Recurse token refresh and independently inspectable Anthropic requests. */
function withRecurseAnthropicRefresh(provider: Provider): Provider {
  if (provider.id !== "anthropic") return provider;
  const anthropicModels = new WeakMap<
    object,
    ReturnType<Provider["getModels"]>[number]
  >();
  const oauth = provider.auth.oauth;
  const auth = oauth
    ? {
        ...provider.auth,
        oauth: {
          name: oauth.name,
          isSubscription: oauth.isSubscription,
          loginLabel: oauth.loginLabel,
          login: oauth.login.bind(oauth),
          toAuth: oauth.toAuth.bind(oauth),
          refresh: async (
            credential: OAuthCredential,
            signal: AbortSignal,
          ) => ({
            ...credential,
            ...(await (
              await import("../../auth/anthropic_oauth.ts")
            ).refreshAnthropicToken(credential.refresh, signal)),
            type: "oauth" as const,
          }),
        },
      }
    : provider.auth;
  return new Proxy(provider, {
    get(target, key) {
      if (key === "auth") return auth;
      if (key === "getModels" || key === "getAllModels")
        return () =>
          (key === "getAllModels"
            ? (target.getAllModels?.() ?? target.getModels())
            : target.getModels()
          ).map((model) => {
            if (model.type !== undefined && model.type !== "chat") return model;
            const prior = anthropicModels.get(model);
            if (prior) return prior;
            const value = {
              ...model,
              compat: { ...model.compat, supportsMessageThreads: false },
              ...(model.id === "claude-fable-5-2" &&
              !Object.keys(model.headers ?? {}).some(
                (name) => name.toLowerCase() === "user-agent",
              )
                ? {
                    headers: {
                      ...model.headers,
                      "user-agent": "claude-cli/2.1.290",
                    },
                  }
                : {}),
            };
            anthropicModels.set(model, value);
            return value;
          });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type ChatReply = Awaited<ReturnType<ChatStream["result"]>>;

/** One stream's redaction. Open text and thinking blocks hold back a trailing
 * key prefix, so no concatenation of deltas or snapshots spells the key. The
 * mask's ends never occur in the key. Field names stay intact for keys shorter
 * than Settings accepts, which would otherwise rename message fields. */
function geminiRedaction(
  apiKey: string,
  options: Parameters<Provider["streamSimple"]>[2],
) {
  const { patterns, mask, redact } = credentialMask([apiKey]);
  const fields = credentialFields(
    redact,
    apiKey.length >= GEMINI_MIN_KEY_LENGTH,
  );
  type Streaming = { field: "text" | "thinking"; shown: string; read: number };
  const streaming = new Map<number, Streaming>();
  const ended = new Set<number>();
  const advance = (block: Streaming, raw: string) => {
    for (;;) {
      const found = patterns
        .map((pattern) => ({ pattern, at: raw.indexOf(pattern, block.read) }))
        .filter(({ at }) => at >= 0)
        .sort((a, b) => a.at - b.at || b.pattern.length - a.pattern.length)[0];
      if (!found) break;
      block.shown += raw.slice(block.read, found.at) + mask;
      block.read = found.at + found.pattern.length;
    }
    const unread = raw.length - block.read;
    const held = Math.max(
      ...patterns.map((key) => {
        let size = Math.min(key.length - 1, unread);
        while (size > 0 && !raw.endsWith(key.slice(0, size))) size--;
        return size;
      }),
    );
    const safe = raw.length - held;
    block.shown += raw.slice(block.read, safe);
    block.read = safe;
  };
  const keep = ["role", "api", "provider", "model", "stopReason"];
  const message = (reply: ChatReply) => {
    const safe = fields(reply, keep);
    rememberTurnError(options, reply, safe);
    return safe;
  };
  const partial = (reply: ChatReply): ChatReply => ({
    ...fields(reply, [...keep, "content"]),
    content: reply.content.map((block, index) => {
      if (
        ended.has(index) ||
        (block.type !== "text" && block.type !== "thinking")
      )
        return fields(block);
      const shown = streaming.get(index);
      return {
        ...fields(block, [block.type]),
        [block.type]: shown?.field === block.type ? shown.shown : "",
      };
    }),
  });
  return {
    // The adapter can emit text and tool deltas before it knows the turn failed.
    message,
    event: (event: AssistantMessageEvent): AssistantMessageEvent => {
      if (event.type === "done" || event.type === "error") {
        streaming.clear();
        return event.type === "done"
          ? { ...event, message: message(event.message) }
          : { ...event, error: message(event.error) };
      }
      let delta: string | undefined;
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        const field = event.type === "text_delta" ? "text" : "thinking";
        let block = streaming.get(event.contentIndex);
        if (block?.field !== field)
          streaming.set(
            event.contentIndex,
            (block = { field, shown: "", read: 0 }),
          );
        const current = event.partial.content[event.contentIndex];
        const before = block.shown.length;
        if (current?.type === "text") advance(block, current.text);
        if (current?.type === "thinking") advance(block, current.thinking);
        delta = block.shown.slice(before);
      }
      if (event.type === "text_end" || event.type === "thinking_end") {
        streaming.delete(event.contentIndex);
        ended.add(event.contentIndex);
      }
      return {
        ...fields(event, ["type", "partial"]),
        partial: partial(event.partial),
        ...(delta === undefined ? {} : { delta }),
      };
    },
    failure: (error: unknown) =>
      maskProviderFailure(
        options,
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Gemini request failed.",
        redact,
      ),
  };
}

/** Pi hands us the resolved key here, before any errors leave the provider. */
function withProviderTransport(provider: Provider): Provider {
  if (provider.id !== "google") return withProviderErrors(provider);
  return new Proxy(provider, {
    get(target, key) {
      if (key === CHAT_ONLY_AUTH) return true;
      if (key === "stream" || key === "streamSimple")
        return (
          ...[model, context, options]: Parameters<Provider["streamSimple"]>
        ) => {
          const apiKey = options?.apiKey;
          if (!apiKey) return target[key](model, context, options);
          // Pi's Google provider sends every model through the Gemini API, even
          // a model kept from an earlier custom `google` route.
          if (model.api !== "google-generative-ai")
            throw new Error(
              `The Gemini API key works only with Gemini API models, not ${model.provider}/${model.id}. Choose the model again.`,
            );
          const redaction = geminiRedaction(apiKey, options);
          // Raw chunks would carry a key split across them, so Pi extensions
          // see only the redacted Pi events for Gemini.
          const { onProviderStreamEvent: _raw, ...sent } = options;
          let stream: ChatStream;
          try {
            stream = target[key](model, context, sent);
          } catch (error) {
            throw redaction.failure(error);
          }
          return mapStreamMessages(stream, redaction.message, redaction);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Stamp responses with the requested effort. */
export function withRequestedEffort(models: Models): Models {
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple")
        return (
          ...[model, context, options]: Parameters<Models["streamSimple"]>
        ) => {
          const thinkingLevel = options?.reasoning ?? "off";
          const errors: TurnErrorText = { replies: new WeakMap() };
          const request = { ...options, [TURN_ERROR_TEXT]: errors };
          const stream = target.streamSimple(model, context, request);
          let offerPicker: boolean | undefined;
          return mapStreamMessages(stream, (message, terminal) => {
            message.thinkingLevel = thinkingLevel;
            const action = PICK_EFFORT_LEVEL_AGAIN;
            if (!terminal || message.stopReason !== "error") return message;
            const rejected = errors.rejected;
            const raw =
              errors.replies.get(message) ??
              (rejected && rejected.masked === message.errorMessage
                ? rejected.raw
                : undefined);
            errors.replies.delete(message);
            errors.rejected = undefined;
            if (message.errorMessage?.endsWith(action)) return message;
            if (offerPicker === undefined) {
              const kind = providerOutageKind(raw ?? message.errorMessage, {
                model: `${model.provider}/${model.id}`,
              });
              offerPicker =
                kind === "provider authentication failed" ||
                kind === "model was not available";
            }
            if (offerPicker)
              message.errorMessage = `${message.errorMessage || "Model request failed."} ${action}`;
            return message;
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** File routes discard ambient SDK headers; Gemini uses Pi's native headers. */
function withConfiguredHeaders(
  provider: Provider,
  headers: Map<string, Record<string, string>> | undefined,
  isCatalogModel: (id: string) => boolean,
  fileKey?: string,
): Provider {
  if (!headers?.size && fileKey === undefined) return provider;
  return new Proxy(provider, {
    get(target, key) {
      if (key === "stream" || key === "streamSimple")
        return (...args: Parameters<Provider["streamSimple"]>) => {
          const [model, context, options] = args;
          const extra = isCatalogModel(model.id)
            ? undefined
            : headers?.get(model.id);
          const ambient =
            fileKey === undefined
              ? []
              : [
                  "openai-organization",
                  "openai-project",
                  "authorization",
                  "x-api-key",
                  ...((model.api === "anthropic-messages"
                    ? process.env.ANTHROPIC_CUSTOM_HEADERS
                    : process.env.OPENAI_CUSTOM_HEADERS
                  )
                    ?.split("\n")
                    .flatMap((line) => {
                      const colon = line.indexOf(":");
                      return colon < 0
                        ? []
                        : [line.slice(0, colon).trim().toLowerCase()];
                    }) ?? []),
                ];
          const names = new Set([
            ...Object.keys(extra ?? {}).map((name) => name.toLowerCase()),
            ...ambient,
          ]);
          if (!names.size) return target[key](model, context, options);
          const omit = <T>(values: Record<string, T> | undefined) =>
            values &&
            Object.fromEntries(
              Object.entries(values).filter(
                ([name]) => !names.has(name.toLowerCase()),
              ),
            );
          if (model.api === "google-generative-ai" && fileKey === undefined)
            return target[key](
              { ...model, headers: omit(model.headers) },
              context,
              { ...options, headers: { ...omit(options?.headers), ...extra } },
            );
          const fetch = options?.fetch ?? globalThis.fetch;
          // Pi sets this literal header using only the completed payload.
          const configuredBeta =
            model.api === "anthropic-messages"
              ? extra?.["anthropic-beta"]
              : undefined;
          const keepProviderBeta = (name: string) =>
            name === "anthropic-beta" && configuredBeta !== undefined;
          const modelHeaders = omit(model.headers);
          return target[key](
            {
              ...model,
              headers:
                configuredBeta === undefined
                  ? modelHeaders
                  : { ...modelHeaders, "anthropic-beta": configuredBeta },
            },
            context,
            {
              ...options,
              ...(model.api === "openai-codex-responses"
                ? { transport: "sse" as const }
                : {}),
              headers: omit(options?.headers),
              fetch: (async (...input: Parameters<typeof globalThis.fetch>) => {
                const request = new Request(...input);
                if (fileKey !== undefined) {
                  for (const name of ambient)
                    if (!keepProviderBeta(name)) request.headers.delete(name);
                  if (
                    model.api === "anthropic-messages" &&
                    !fileKey.includes("sk-ant-oat")
                  )
                    request.headers.set("x-api-key", fileKey);
                  else
                    request.headers.set("authorization", `Bearer ${fileKey}`);
                }
                for (const [name, value] of Object.entries(extra ?? {}))
                  if (!keepProviderBeta(name)) request.headers.set(name, value);
                return fetch(request);
              }) as typeof globalThis.fetch,
            },
          );
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Shared Pi catalog; config/store I/O begins at refresh. */
export function durableModels(
  piAgentDir: string,
  warn: (message: string, note?: boolean) => void = (message) =>
    console.warn(message),
  reservedProviders: () => string[] = () => [],
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): MutableModels {
  const readOnly = ambient.RECURSE_READ_ONLY_SIGN_INS;
  const authPath = join(piAgentDir, "auth.json");
  const stored = readOnly
    ? new ReadOnlySignIns(readOnly)
    : AuthStorage.createLazy(authPath);
  const options = {
    credentials: readOnly
      ? stored
      : withCodexCliAccess(stored, authPath, ambient),
    authContext: STORED_CREDENTIALS_ONLY,
    modelsStore: new FileModelsStore(join(piAgentDir, "models-store.json")),
  };
  const storedCodex = createModels({
    credentials: stored,
    authContext: options.authContext,
  });
  const trusted = createModels({
    credentials: options.credentials,
    authContext: options.authContext,
  });
  const baseCatalog = createModels(options);
  const models = createModels(options);
  const generatedAt = getBuiltinModelDataGeneratedAt();
  const builtins = new Map<string, Provider>();
  const builtinIds = new Map<string, string[]>();
  let openRouterCatalogIds: string[] = [];
  for (const builtin of builtinProviders()) {
    const provider: Provider =
      builtin.id === "google"
        ? {
            ...builtin,
            auth: {
              apiKey: {
                name: "Gemini API key",
                resolve: async ({ signal }) => {
                  const saved = await options.credentials.read(
                    GEMINI_CREDENTIAL,
                    { signal },
                  );
                  if (saved?.type !== "api_key" || !saved.key) return undefined;
                  return {
                    auth: { apiKey: saved.key },
                    source: "stored credential",
                  };
                },
              },
            },
          }
        : withPlatformKeyOnly(builtin);
    if (provider.id === CODEX_PROVIDER) storedCodex.setProvider(provider);
    builtinIds.set(
      provider.id,
      (provider.getAllModels?.() ?? provider.getModels()).map(
        (model) => model.id,
      ),
    );
    const catalog =
      provider.id === "radius"
        ? provider
        : provider.id === "openrouter"
          ? withPersonalizedCatalog(
              provider,
              async (catalog, context) => {
                openRouterCatalogIds = catalog.map((model) => model.id);
                return personalizeOpenRouterCatalog(catalog, context);
              },
              undefined,
              generatedAt,
            )
          : withRemoteCatalog(provider, undefined, generatedAt);
    const base = withRecurseAnthropicRefresh(catalog);
    builtins.set(provider.id, base);
    trusted.setProvider(
      withProviderErrors(
        withRecurseAnthropicRefresh(
          provider.id === "google" ? builtin : provider,
        ),
      ),
    );
    baseCatalog.setProvider(base);
    models.setProvider(withProviderTransport(base));
  }
  const catalogIds = (id: string) => {
    const base = builtins.get(id)!;
    return new Set([
      ...(builtinIds.get(id) ?? []),
      ...(id === "openrouter" ? openRouterCatalogIds : []),
      ...(base.getAllModels?.() ?? base.getModels()).map((model) => model.id),
      ...trusted.getAllModels(id).map((model) => model.id),
    ]);
  };
  const path = join(piAgentDir, "models.json");
  let revision: string | undefined;
  let catalogRevision: string | undefined;
  let snapshot: PiModelConfigSnapshot | undefined;
  let loading: Promise<void> | undefined;
  const fileProviders = new Map<string, Provider>();
  let addFileModels = (provider: Provider): Provider => provider;
  const refreshConfig = async () => {
    const catalog: [string, string[]][] = [...builtins.keys()].map((id) => [
      id,
      [...catalogIds(id)],
    ]);
    const reserved = [
      ...new Set([
        ...reservedProviders(),
        ...trusted
          .getProviders()
          .filter((provider) => !builtins.has(provider.id))
          .map((provider) => provider.id),
      ]),
    ];
    const currentCatalog = JSON.stringify([catalog, reserved]);
    const loaded = await readPiModelConfig(
      path,
      catalog,
      currentCatalog === catalogRevision ? revision : undefined,
      reserved,
    );
    if (loaded) {
      snapshot = loaded.snapshot;
      revision = loaded.revision;
      catalogRevision = currentCatalog;
    }
    if (!snapshot) return;
    const diagnostics = new Set(snapshot.diagnostics);
    const note = (id: string, reason: string) =>
      diagnostics.add(`provider:${id},reason:${reason}`);
    const entries = new Map(
      snapshot.providers
        .map(([id, provider]) => {
          const existing = catalogIds(id);
          const added = (provider.models ?? []).filter((model) => {
            if (!existing.has(model.id)) return true;
            note(id, "model_id_collision");
            return false;
          });
          return [id, { models: added }] as const;
        })
        .filter(([, provider]) => provider.models.length),
    );
    const headers = new Map(
      snapshot.headers.map(([id, values]) => [
        id,
        new Map(
          values.filter(
            ([model]) =>
              entries.get(id)?.models.some((value) => value.id === model) ||
              snapshot!.fileProviders?.some(
                ([provider, spec]) =>
                  provider === id &&
                  spec.models.some((value) => value.id === model),
              ),
          ),
        ),
      ]),
    );
    const empty = await ModelConfig.load(undefined);
    const config = new Proxy(empty, {
      get(base, property) {
        if (property === "getProvider") return (id: string) => entries.get(id);
        return Reflect.get(base, property, base);
      },
    });
    const providers = new Map(builtins);
    const invalid = snapshot.invalid;
    addFileModels = (provider) => {
      const additions = entries
        .get(provider.id)
        ?.models.filter(
          (model) =>
            !(provider.getAllModels?.() ?? provider.getModels()).some(
              (existing) => existing.id === model.id,
            ),
        );
      if (invalid || !additions?.length) return provider;
      const config = new Proxy(empty, {
        get(base, property) {
          if (property === "getProvider") return () => ({ models: additions });
          return Reflect.get(base, property, base);
        },
      });
      return withConfiguredHeaders(
        composeModelProvider(provider.id, provider, config, undefined),
        headers.get(provider.id),
        (id) => !additions.some((model) => model.id === id),
      );
    };
    for (const id of entries.keys()) {
      try {
        const composed = withRecurseAnthropicRefresh(
          composeModelProvider(id, builtins.get(id), config, undefined),
        );
        const additions = () => {
          const existing = catalogIds(id);
          return composed
            .getModels()
            .filter((model) => !existing.has(model.id));
        };
        const provider = new Proxy(composed, {
          get(target, key) {
            if (key === "getModels")
              return () => [...builtins.get(id)!.getModels(), ...additions()];
            if (key === "getAllModels")
              return () => [
                ...(builtins.get(id)!.getAllModels?.() ??
                  builtins.get(id)!.getModels()),
                ...additions(),
              ];
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        providers.set(
          id,
          withConfiguredHeaders(provider, headers.get(id), (model) =>
            catalogIds(id).has(model),
          ),
        );
      } catch {
        note(id, "invalid_provider_metadata");
      }
    }
    for (const [id, spec] of snapshot.fileProviders ?? []) {
      try {
        if (
          reserved.includes(id) ||
          builtins.has(id) ||
          (models.getProvider(id) &&
            models.getProvider(id) !== fileProviders.get(id)) ||
          (await options.modelsStore.read(id))
        ) {
          note(id, "provider_id_collision");
          continue;
        }
        const config = new Proxy(empty, {
          get(base, property) {
            if (property === "getProvider")
              return () => ({
                api: spec.api,
                baseUrl: spec.baseUrl,
                models: spec.models,
              });
            return Reflect.get(base, property, base);
          },
        });
        const metadata = composeModelProvider(
          id,
          undefined,
          config,
          undefined,
        ).getModels();
        const provider = createProvider({
          id,
          baseUrl: spec.baseUrl,
          api: getApiProvider(spec.api)!,
          auth: {
            apiKey: {
              name: "Literal file key",
              resolve: async () => ({
                auth: { apiKey: spec.apiKey },
                source: "models_json_literal",
              }),
            },
          },
          models: metadata,
        });
        providers.set(
          id,
          withConfiguredHeaders(
            provider,
            headers.get(id),
            () => false,
            spec.apiKey,
          ),
        );
      } catch {
        note(id, "invalid_provider_metadata");
      }
    }
    if (invalid) {
      headers.clear();
      providers.clear();
      for (const [id, provider] of builtins) providers.set(id, provider);
    }
    if (invalid)
      diagnostics.add(
        "reason:invalid_json_or_file_limits,action:fix_models.json_and_refresh",
      );
    for (const message of diagnostics)
      reportPiModelConfigError(
        message,
        () =>
          warn(
            message,
            /^provider:[A-Za-z0-9][A-Za-z0-9._+-]{0,63},note:provider_fields_ignored,models_added:\d+$/.test(
              message,
            ),
          ),
        path,
      );
    for (const [id, provider] of fileProviders) {
      if (!providers.has(id) && models.getProvider(id) === provider)
        models.deleteProvider(id);
    }
    fileProviders.clear();
    for (const provider of providers.values()) {
      const installed = withProviderTransport(provider);
      models.setProvider(installed);
      if (!builtins.has(provider.id)) fileProviders.set(provider.id, installed);
    }
  };
  return new Proxy(models, {
    get(target, key) {
      if (key === TRUSTED_CATALOG) return trusted;
      if (key === ADD_FILE_MODELS) return addFileModels;
      if (key === STORED_CODEX_AUTH) return storedCodex;
      if (key === "refresh")
        return async (...args: Parameters<MutableModels["refresh"]>) => {
          const result = await baseCatalog.refresh(...args);
          loading ??= refreshConfig().finally(() => {
            loading = undefined;
          });
          await loading;
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** MCP provider tokens exclude the chat-only Gemini Settings credential. */
export async function providerToken(
  models: Models,
  provider: string,
): Promise<string | undefined> {
  const source =
    provider === CODEX_PROVIDER
      ? ((Reflect.get(models, STORED_CODEX_AUTH) as Models | undefined) ??
        models)
      : models;
  try {
    const installed = source.getProvider(provider);
    if (!installed || Reflect.get(installed, CHAT_ONLY_AUTH)) return undefined;
    return (await source.getAuth(provider))?.auth.apiKey;
  } catch {
    return undefined;
  }
}

/** A custom provider's key: its stored key, else its own env_key. */
function customKey(
  id: string,
  spec: ProviderSpec,
  envValue: (provider: string) => string | undefined,
): ApiKeyAuth {
  return {
    name: `${spec.env_key} API key`,
    resolve: async ({ credential }) => {
      if (credential?.key)
        return {
          auth: { apiKey: credential.key },
          source: "stored credential",
        };
      const value = envValue(id);
      return value
        ? { auth: { apiKey: value }, source: spec.env_key }
        : undefined;
    },
  };
}

function customProvider(
  id: string,
  spec: ProviderSpec,
  envValue: (provider: string) => string | undefined,
): Provider {
  const api =
    spec.wire_api === "responses" ? "openai-responses" : "openai-completions";
  return createProvider({
    id,
    baseUrl: spec.base_url,
    auth: { apiKey: customKey(id, spec, envValue) },
    api:
      api === "openai-responses"
        ? openAIResponsesApi()
        : openAICompletionsApi(),
    models: spec.models.map((model) => ({
      id: model.id,
      name: model.label || model.id,
      api,
      provider: id,
      baseUrl: spec.base_url,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window || 128000,
      maxTokens: 16384,
    })),
  });
}

// Keeps `models`' custom providers equal to the latest Settings value. A call
// with the same object does nothing unless a Pi config reload replaced it;
// removed providers restore the latest underlying Pi provider. The trusted
// catalog reserves built-in provider names for the shipped providers.
export function customProviderSync(
  models: MutableModels,
  envValue: (provider: string) => string | undefined,
  reserved?: ReadonlySet<string>,
): (providers: Record<string, ProviderSpec>) => void {
  const trusted = trustedModelCatalog(models);
  const syncTrusted =
    trusted === models
      ? undefined
      : customProviderSync(trusted, envValue, new Set(getBuiltinProviders()));
  let applied: Record<string, ProviderSpec> = {};
  const builtins = new Map(models.getProviders().map((p) => [p.id, p]));
  const installed = new Map<string, Provider>();
  return (providers) => {
    syncTrusted?.(providers);
    if (
      providers === applied &&
      [...installed].every(
        ([id, provider]) => models.getProvider(id) === provider,
      )
    )
      return;
    for (const id of Object.keys(applied)) {
      if (
        Object.hasOwn(providers, id) ||
        models.getProvider(id) !== installed.get(id)
      )
        continue;
      const builtin = builtins.get(id);
      if (builtin === undefined) models.deleteProvider(id);
      else models.setProvider(builtin);
    }
    for (const [id, spec] of Object.entries(providers)) {
      if (reserved?.has(id)) continue;
      const current = models.getProvider(id);
      if (current !== installed.get(id)) {
        if (current) builtins.set(id, current);
        else builtins.delete(id);
      }
      const add = Reflect.get(models, ADD_FILE_MODELS) as
        | ((provider: Provider) => Provider)
        | undefined;
      const base = customProvider(id, spec, envValue);
      const provider = withProviderErrors(add ? add(base) : base);
      models.setProvider(provider);
      installed.set(id, provider);
    }
    for (const id of installed.keys())
      if (!Object.hasOwn(providers, id)) installed.delete(id);
    applied = providers;
  };
}
