// Built-ins use Settings auth only; custom providers use their own key/env_key.
// Anthropic OAuth uses Recurse refresh; auth/catalog I/O is lazy and async.
// Full Anthropic requests keep captures and cache replays self-contained.
// Fable 5.2 OAuth requires a newer Claude CLI identity than Pi 1.5.1 sends.
import {
  type ApiKeyAuth,
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
} from "@earendil-works/pi-ai/providers/all";
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
import { createModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { FileModelsStore } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import {
  withPersonalizedCatalog,
  withRemoteCatalog,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/remote-catalog-provider.js";
import { join } from "node:path";

/** No environment variables and no ambient credential files. */
export const STORED_CREDENTIALS_ONLY: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

/** Recurse token refresh and independently inspectable Anthropic requests. */
function withRecurseAnthropicRefresh(provider: Provider): Provider {
  const oauth = provider.auth.oauth;
  if (provider.id !== "anthropic" || oauth === undefined) return provider;
  const auth = {
    ...provider.auth,
    oauth: {
      name: oauth.name,
      isSubscription: oauth.isSubscription,
      loginLabel: oauth.loginLabel,
      login: oauth.login.bind(oauth),
      toAuth: oauth.toAuth.bind(oauth),
      refresh: async (credential: OAuthCredential, signal: AbortSignal) => ({
        ...credential,

        ...(await (
          await import("../../auth/anthropic_oauth.ts")
        ).refreshAnthropicToken(credential.refresh, signal)),
        type: "oauth" as const,
      }),
    },
  };
  return new Proxy(provider, {
    get(target, key) {
      if (key === "auth") return auth;
      if (key === "getModels" || key === "getAllModels")
        return () =>
          (key === "getAllModels"
            ? (target.getAllModels?.() ?? target.getModels())
            : target.getModels()
          ).map((model) =>
            model.type !== undefined && model.type !== "chat"
              ? model
              : {
                  ...model,
                  compat: { ...model.compat, supportsMessageThreads: false },
                  ...(model.id === "claude-fable-5-2"
                    ? {
                        headers: {
                          ...model.headers,
                          "user-agent": "claude-cli/2.1.290",
                        },
                      }
                    : {}),
                },
          );
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Stamp responses with the effort frozen into the provider request. */
export function withRequestedEffort(models: Models): Models {
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple")
        return (...args: Parameters<Models["streamSimple"]>) => {
          const stream = target.streamSimple(...args);
          const thinkingLevel = args[2]?.reasoning ?? "off";
          return new Proxy(stream, {
            get(response, property) {
              if (property === "result")
                return async () =>
                  Object.assign(await response.result(), { thinkingLevel });
              if (property === Symbol.asyncIterator)
                return async function* () {
                  for await (const event of response) {
                    const message =
                      event.type === "done"
                        ? event.message
                        : event.type === "error"
                          ? event.error
                          : event.partial;
                    message.thinkingLevel = thinkingLevel;
                    yield event;
                  }
                };
              const value = Reflect.get(response, property, response);
              return typeof value === "function" ? value.bind(response) : value;
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Settings-owned credentials and Pi's catalog; restore offline only. */
export function durableModels(piAgentDir: string): MutableModels {
  const models = createModels({
    credentials: AuthStorage.createLazy(join(piAgentDir, "auth.json")),
    authContext: STORED_CREDENTIALS_ONLY,
    modelsStore: new FileModelsStore(join(piAgentDir, "models-store.json")),
  });
  const generatedAt = getBuiltinModelDataGeneratedAt();
  for (const provider of builtinProviders()) {
    const catalog =
      provider.id === "radius"
        ? provider
        : provider.id === "openrouter"
          ? withPersonalizedCatalog(
              provider,
              personalizeOpenRouterCatalog,
              undefined,
              generatedAt,
            )
          : withRemoteCatalog(provider, undefined, generatedAt);
    models.setProvider(withRecurseAnthropicRefresh(catalog));
  }
  return models;
}

/** `provider`'s Settings login token, as Pi's model registry gives MCP
 * servers with `"auth": { "provider" }`; undefined when signed out. */
export async function providerToken(
  models: Models,
  provider: string,
): Promise<string | undefined> {
  try {
    return (await models.getAuth(provider))?.auth.apiKey;
  } catch {
    return undefined;
  }
}

export interface CustomProviderSpec {
  base_url: string;
  wire_api: string;
  env_key: string;
  models: readonly {
    id: string;
    label?: string | null;
    context_window?: number | null;
  }[];
}

/** A custom provider's key: its stored key, else its own env_key. */
function customKey(
  id: string,
  spec: CustomProviderSpec,
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
  spec: CustomProviderSpec,
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
// with the same object as the last one (Config's cache) does nothing; a removed
// provider is deleted, and a built-in one it replaced comes back.
export function customProviderSync(
  models: MutableModels,
  envValue: (provider: string) => string | undefined,
): (providers: Record<string, CustomProviderSpec>) => void {
  let applied: Record<string, CustomProviderSpec> = {};
  const builtins = new Map(models.getProviders().map((p) => [p.id, p]));
  return (providers) => {
    if (providers === applied) return;
    for (const id of Object.keys(applied)) {
      if (Object.hasOwn(providers, id)) continue;
      const builtin = builtins.get(id);
      if (builtin === undefined) models.deleteProvider(id);
      else models.setProvider(withRecurseAnthropicRefresh(builtin));
    }
    for (const [id, spec] of Object.entries(providers))
      models.setProvider(customProvider(id, spec, envValue));
    applied = providers;
  };
}
