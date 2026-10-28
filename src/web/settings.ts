// Thin operator Settings/provider-auth routes; agent markers never qualify.
// Auth bumps revision/refreshes snapshot, then rewrites catalog best-effort.
// Provider credentials and instance storage retain separate ownership.
// Home sync uses only settings_sync's four-route inventory.

import { THINKING_LEVELS, type Config } from "../config";
import {
  brandingFile,
  brandResponse,
  readBrand,
  readIcon,
  writeBrand,
} from "../branding";
import { join } from "node:path";
import {
  mcpConfig,
  mcpStatuses,
  mcpStatusVersion,
  recordMcpStatus,
} from "../extensions/extra/mcp/status.ts";
import { signsIn } from "../extensions/extra/mcp/mcp.ts";
import {
  callbackUrl,
  finishMcpSignIn,
  MCP_CALLBACK_PATH,
  mcpSignedIn,
  McpSignInError,
  pastedAnswer,
  signInEntry,
  signOutMcp,
  startMcpSignIn,
} from "../mcp_sign_in";
import { htmlResponse } from "./request_auth";
import { readTheme, writeTheme, themeResponse } from "../themes";
import { AuthInputError, HttpStatusError } from "../auth/oauth";
import type { AnthropicAuth } from "../auth/anthropic";
import type { CodexAuth } from "../auth/codex";
import type { MuseAuth } from "../auth/muse";
import type { OpenRouterAuth } from "../auth/openrouter";
import type { ProviderSnapshot } from "../auth/provider_snapshot";
import { pyStrip } from "../auth/provider_store";
import {
  McpConfigError,
  MCP_FILE_NAME,
  readMaskedMcpConfig,
  saveMcpConfig,
} from "../mcp_config";
import { conditionalJson } from "./caching";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Router } from "./router";
import type { PiModelUpdater } from "../pi_model_list";
import type { RecurseUpdates } from "../recurse_update";
import { requireOperator } from "./backend_keys";
import { McpCheckBusy, type McpChecks } from "../mcp_checks";

type Rec = Record<string, unknown>;

/** Pi's model providers and their labels, in menu order. */
export const PI_PROVIDER_LABELS: readonly (readonly [string, string])[] = [
  ["claude", "Claude"],
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
];

// Serve ladder choices separately from full searchable Settings catalog.
// Stored unlisted/logged-out IDs stay visible with a reachability reason.
function ladderModels(
  config: Config,
  levels: Record<number, { model: string }>,
): Rec[] {
  const catalog = new Map(
    config.chatModels().map((option) => [option.id, option]),
  );
  const shown: Rec[] = [];
  const seen = new Set<string>();
  for (const level of Object.keys(levels)
    .map(Number)
    .sort((a, b) => a - b)) {
    const model = levels[level]!.model;
    if (seen.has(model)) continue;
    seen.add(model);
    const option = catalog.get(model);
    const policy = option ? null : config.modelPolicy(model);
    shown.push({
      id: model,
      label: option ? option.label : policy!.label,
      context_window: option
        ? (option.context_window ?? null)
        : policy!.context_window,
    });
  }
  return shown;
}

/** Every model a Settings model box offers: logged-in routes and configured
 * custom providers only, Anthropic, ChatGPT subscription, OpenAI API,
 * OpenRouter, then custom, each in Pi's order. `reasoning_levels` is null
 * when Pi's list does not give a model's levels; any level is then allowed. */
function settingsModelList(config: Config): Rec[] {
  return config.authedChatModels().map((option) => ({
    id: option.id,
    label: option.label,
    route: option.provider,
    context_window: option.context_window ?? null,
    reasoning_levels: config.modelReasoningLevels(option.id),
  }));
}

export function logicalProviderAuthed(
  provider: string,
  authed: ReadonlySet<string>,
): boolean {
  if (provider === "claude") return authed.has("anthropic");
  if (provider === "openai")
    return authed.has("openai-codex") || authed.has("openai");
  if (provider === "openrouter") return authed.has("openrouter");
  return false;
}

export interface SettingsRoutesDeps {
  readonly config: Config;
  readonly modelUpdates: Pick<PiModelUpdater, "start" | "status">;
  readonly recurseUpdates: Pick<RecurseUpdates, "apply" | "status">;
  readonly mcpChecks?: Pick<McpChecks, "start" | "statuses" | "resolve">;
  readonly anthropic: AnthropicAuth;
  readonly codex: CodexAuth;
  readonly muse: MuseAuth;
  readonly openrouter: OpenRouterAuth;
  /** auth.oauth replace_credentials/remove_credentials. */
  readonly credentials: {
    replaceCredentials(provider: string, credential: Rec): Promise<unknown>;
    removeCredentials(providers: string[]): Promise<void>;
  };
  readonly providers: Pick<ProviderSnapshot, "refresh">;
  /** The prepared Pi agent dir that holds mcp.json. */
  piAgentDir(): Promise<string>;
  /** mutation_guard.mutate_external_storage: run under the lifecycle lease. */
  mutateExternalStorage<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * The MCP servers file as masked JSON text, `{text}` both ways. A refused
 * save or an unreadable file is a 400 with a message safe to show.
 */
export function registerMcpServerRoutes(
  router: Router,
  deps: Pick<
    SettingsRoutesDeps,
    "piAgentDir" | "mutateExternalStorage" | "mcpChecks"
  >,
): void {
  const plain = async (work: () => Promise<string>) => {
    try {
      return jsonResponse({ text: await work() });
    } catch (error) {
      if (error instanceof McpConfigError)
        throw new HttpError(400, error.message);
      throw error;
    }
  };
  const PRIVATE = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  const configPath = async () => join(await deps.piAgentDir(), MCP_FILE_NAME);
  const resolve = async (value: string) => {
    if (!deps.mcpChecks) throw new Error("MCP checks unavailable");
    return deps.mcpChecks.resolve(value);
  };
  router.get("/api/settings/mcp-servers/status", async () => {
    try {
      const path = await configPath();
      const servers = deps.mcpChecks
        ? await deps.mcpChecks.statuses()
        : await mcpStatuses(path);
      const signedIn = mcpSignedIn(path, await mcpConfig(path));
      return jsonResponse({
        servers: servers.map((server) =>
          signedIn.has(server.name)
            ? { ...server, signedIn: signedIn.get(server.name) }
            : server,
        ),
      });
    } catch {
      throw new HttpError(400, "MCP configuration unavailable");
    }
  });
  const signIn = async <T>(work: (path: string) => Promise<T>) => {
    try {
      const path = await configPath();
      return await deps.mutateExternalStorage(() => work(path));
    } catch (error) {
      if (error instanceof McpSignInError)
        throw new HttpError(400, error.message);
      throw new HttpError(400, "MCP configuration unavailable");
    }
  };
  router.post(
    "/api/settings/mcp-servers/sign-in",
    async (ex) => {
      const name = field(await jsonDictBody(ex), "name");
      if (typeof name !== "string") throw new HttpError(400, "name required");
      const started = await signIn(async (path) =>
        startMcpSignIn(
          path,
          signInEntry(await mcpConfig(path), name),
          callbackUrl(ex.request.headers),
          resolve,
        ),
      );
      return jsonResponse(started ?? { signedIn: true });
    },
    { longRunning: true },
  );
  router.post("/api/settings/mcp-servers/sign-out", async (ex) => {
    const name = field(await jsonDictBody(ex), "name");
    if (typeof name !== "string") throw new HttpError(400, "name required");
    await signIn(async (path) => {
      const entry = (await mcpConfig(path)).find((each) => each.name === name);
      if (!entry || !signsIn(entry.config))
        throw new McpSignInError("Unknown MCP server");
      await signOutMcp(path, name, entry.config.url);
      await recordMcpStatus(
        path,
        name,
        { needsSignIn: true },
        () => {},
        mcpStatusVersion(path),
      );
    });
    return jsonResponse({ signedIn: false });
  });
  router.get(
    MCP_CALLBACK_PATH,
    async (ex) => {
      let name: string;
      try {
        name = await signIn(async (path) =>
          finishMcpSignIn(
            path,
            await mcpConfig(path),
            ex.url.searchParams,
            (redirect) =>
              new URL(redirect).pathname === MCP_CALLBACK_PATH &&
              new URL(redirect).host === ex.request.headers.get("host"),
            resolve,
          ),
        );
      } catch (error) {
        const detail =
          error instanceof HttpError ? String(error.detail) : "Sign-in failed";
        return htmlResponse(
          `<!doctype html><meta name="viewport" content="width=device-width"><title>MCP sign-in failed</title><p>MCP sign-in failed: ${Bun.escapeHTML(detail)}.</p><p><a href="/">Back to Recurse</a></p>`,
          400,
          PRIVATE,
        );
      }
      void deps.mcpChecks?.start(name).catch(() => {});
      return new Response(null, {
        status: 303,
        headers: { ...PRIVATE, location: "/" },
      });
    },
    { longRunning: true },
  );
  router.post(
    "/api/settings/mcp-servers/finish-sign-in",
    async (ex) => {
      const url = field(await jsonDictBody(ex), "url");
      if (typeof url !== "string") throw new HttpError(400, "url required");
      const name = await signIn(async (path) => {
        const { query, accepts } = pastedAnswer(url);
        return finishMcpSignIn(
          path,
          await mcpConfig(path),
          query,
          accepts,
          resolve,
        );
      });
      void deps.mcpChecks?.start(name).catch(() => {});
      return jsonResponse({ signedIn: true });
    },
    { longRunning: true },
  );
  router.post("/api/settings/mcp-servers/check", async (ex) => {
    const name = field(await jsonDictBody(ex), "name");
    if (typeof name !== "string") throw new HttpError(400, "name required");
    if (!deps.mcpChecks) throw new HttpError(503, "MCP checks unavailable");
    try {
      await deps.piAgentDir();
      await deps.mcpChecks.start(name);
    } catch (error) {
      if (error instanceof McpCheckBusy)
        throw new HttpError(409, "An MCP check is already running");
      if (error instanceof McpConfigError)
        throw new HttpError(400, error.message);
      throw new HttpError(400, "MCP configuration unavailable");
    }
    return jsonResponse({ checking: true }, 202);
  });
  router.get("/api/settings/mcp-servers", async () =>
    plain(async () => readMaskedMcpConfig(await deps.piAgentDir())),
  );
  router.put("/api/settings/mcp-servers", async (ex) => {
    const text = field(await jsonDictBody(ex), "text");
    if (typeof text !== "string") throw new HttpError(400, "text required");
    return plain(() =>
      deps.mutateExternalStorage(async () => {
        const path = await configPath();
        const before = await mcpConfig(path).catch(() => []);
        const saved = await saveMcpConfig(await deps.piAgentDir(), text);
        const after = await mcpConfig(path).catch(() => []);
        // Invariant: Remove sign-in when a server, URL or OAuth app changes.
        for (const { name, config } of before)
          if (
            signsIn(config) &&
            !after.some(
              (next) =>
                next.name === name &&
                signsIn(next.config) &&
                next.config.url === config.url &&
                JSON.stringify(next.config.oauth) ===
                  JSON.stringify(config.oauth),
            )
          )
            await signOutMcp(path, name, config.url);
        return saved;
      }),
    );
  });
}

const isValueError = (error: unknown) =>
  error instanceof AuthInputError ||
  (error instanceof Error && error.name === "ValueError");

/** Python str(exc) for the 502 texts. */
function excText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (["KeyError", "AuthKeyError"].includes(error.name))
    return /^'.*'$/s.test(error.message) ? error.message : `'${error.message}'`;
  return error.message;
}

/** Python truthiness of a parsed JSON value. */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** `(body or {}).get(name, fallback)`. */
const field = (body: Rec, name: string, fallback: unknown = null) =>
  Object.hasOwn(body, name) ? body[name] : fallback;

export function registerSettingsRoutes(
  router: Router,
  deps: SettingsRoutesDeps,
): void {
  const { config } = deps;
  const json = (value: unknown) => jsonResponse(value);
  const long = { longRunning: true };
  const brandPath = brandingFile(config.paths.CONFIG_DIR);
  router.get("/api/settings/branding", async () =>
    json(brandResponse(await readBrand(brandPath), config.displayName)),
  );
  router.post("/api/settings/branding", async (ex) => {
    const fields = await jsonDictBody(ex);
    if (
      fields.name !== undefined &&
      fields.name !== null &&
      typeof fields.name !== "string"
    )
      throw new HttpError(400, "Name must be text.");
    if (fields.icon !== undefined && fields.icon !== null)
      throw new HttpError(400, "Upload an icon file instead.");
    try {
      return json(
        brandResponse(
          await writeBrand(brandPath, {
            ...(fields.name === undefined
              ? {}
              : { name: fields.name as string | null }),
            ...(fields.icon === null ? { icon: null } : {}),
          }),
          config.displayName,
        ),
      );
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });
  router.post("/api/settings/branding/icon", async (ex) => {
    try {
      if (!ex.request.body) throw new Error("Choose a PNG or SVG icon.");
      const icon = await readIcon(ex.request.body);
      return json(
        brandResponse(
          await writeBrand(brandPath, { icon }),
          config.displayName,
        ),
      );
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });
  router.get("/api/settings/theme", async () =>
    json(themeResponse(await readTheme(config.paths.THEMES_FILE))),
  );
  router.post("/api/settings/theme", async (ex) => {
    const fields = await jsonDictBody(ex);
    try {
      return json(
        themeResponse(await writeTheme(config.paths.THEMES_FILE, fields)),
      );
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  async function providerAuthUpdated<T>(value: T): Promise<T> {
    config.noteCredentialsUpdated();
    await deps.providers.refresh();
    // Invariant: A login change re-checks reachability; never fatal to the
    // login.
    try {
      config.writeAvailableModels();
    } catch {}
    return value;
  }

  const mutate = async <T>(work: () => T): Promise<T> => {
    try {
      return await deps.mutateExternalStorage(async () => work());
    } catch (error) {
      if (isValueError(error))
        throw new HttpError(422, (error as Error).message);
      throw error;
    }
  };

  router.get("/api/models", async (ex) => {
    // Invariant: Only models whose provider is logged in are offered;
    // `providers` reports each login state so the UI can prompt a first login.
    const authed = config.authedModelProviders();
    const providers: Rec[] = PI_PROVIDER_LABELS.map(([id, label]) => ({
      id,
      label,
      authed: logicalProviderAuthed(id, authed),
    }));
    const catalog = config
      .chatModels()
      .filter((option) => authed.has(config.providerOf(option.id)));
    for (const name of Object.keys(config.customModelProviders()))
      providers.push({
        id: name,
        label: name,
        custom: true,
        authed: authed.has(name),
      });
    const want = config.defaultChatModel();
    const fallback = catalog.length ? catalog[0]!.id : null;
    return conditionalJson(ex.request, {
      default: catalog.some((option) => option.id === want) ? want : fallback,
      models: catalog,
      backend: "pi",
      providers,
    });
  });

  // Invariant: Settings > Update model list: the only trigger that refreshes
  // Pi's model catalogs from pi.dev. POST starts (or joins) a background
  // update; GET reads its status. Neither waits for the update.
  router.get("/api/settings/model-list-update", async () =>
    json(deps.modelUpdates.status()),
  );
  router.post("/api/settings/model-list-update", async () =>
    jsonResponse(deps.modelUpdates.start(), 202),
  );

  router.get("/api/settings/update", async () =>
    json(await deps.recurseUpdates.status()),
  );
  // Invariant: Only an operator session updates Recurse; agents, service
  // principals, backend keys and the loopback token never do.
  router.post("/api/settings/update", async (ex) => {
    requireOperator(ex);
    const refused = deps.recurseUpdates.apply();
    if (refused) throw new HttpError(409, refused);
    return jsonResponse(await deps.recurseUpdates.status(), 202);
  });

  router.get("/api/settings/deleted-agent-history", async () =>
    json({ days: config.deletedAgentHistoryDays() }),
  );
  router.post("/api/settings/deleted-agent-history", async (ex) => {
    const body = await jsonDictBody(ex);
    return json({
      days: await mutate(() =>
        config.setDeletedAgentHistoryDays(field(body, "days")),
      ),
    });
  });

  router.get("/api/settings/maximum-context-window", async () =>
    json({ maximum_context_window: config.maximumContextWindow() }),
  );

  router.get("/api/settings/default-efforts", async () => {
    const overrides = config.defaultEfforts();
    return json({
      levels: [...THINKING_LEVELS],
      efforts: overrides,
      models: config.authedChatModels().map((option) => ({
        id: option.id,
        label: option.label,
        effort: option.effort,
        suggested: String(config.suggestedEffort(option.id)),
        override: overrides[option.id] ?? null,
        context_window: option.context_window ?? null,
      })),
    });
  });

  router.get("/api/settings/model-list", async (ex) =>
    conditionalJson(ex.request, {
      models: settingsModelList(config),
      reasoning: [...THINKING_LEVELS],
    }),
  );

  router.get("/api/settings/effort-levels", async (ex) => {
    // Invariant: Content-derived validator: reachability flips on login without
    // touching the ladder file, so an unchanged ladder is a cheap 304 only
    // while the payload is identical.
    const levels = config.effortLevels();
    const reachability = config.effortLevelReachability();
    const byLevel = <T>(record: Record<number, T>) =>
      Object.fromEntries(
        Object.keys(record)
          .map(Number)
          .sort((a, b) => a - b)
          .map((level) => [String(level), record[level]]),
      );
    return conditionalJson(ex.request, {
      default_level: config.defaultEffortLevel(),
      levels: byLevel(levels),
      reachability: byLevel(reachability),
      models: ladderModels(config, levels),
      reasoning: [...THINKING_LEVELS],
    });
  });

  router.post("/api/settings/effort-levels", async (ex) => {
    const body = await jsonDictBody(ex);
    return json({ levels: await mutate(() => config.setEffortLevels(body)) });
  });

  router.post("/api/settings/default-efforts", async (ex) => {
    const body = await jsonDictBody(ex);
    return json({
      efforts: await mutate(() =>
        config.setDefaultEfforts(field(body, "efforts")),
      ),
    });
  });

  router.post("/api/settings/maximum-context-window", async (ex) => {
    const body = await jsonDictBody(ex);
    return json({
      maximum_context_window: await mutate(() =>
        config.setMaximumContextWindow(field(body, "maximum_context_window")),
      ),
    });
  });

  registerMcpServerRoutes(router, deps);

  /** The code-exchange routes of Claude and Codex share one error mapping. */
  function oauthRoutes(
    prefix: string,
    title: string,
    auth: AnthropicAuth | CodexAuth,
    importAmbient: () => Promise<boolean>,
  ) {
    router.get(prefix, async () => {
      const imported = await importAmbient();
      const status = await auth.authStatus();
      return json(imported ? await providerAuthUpdated(status) : status);
    });

    router.post(`${prefix}/login-url`, async () =>
      json(await auth.startLogin()),
    );

    router.post(
      `${prefix}/code`,
      async (ex) => {
        // Invariant: A rate-limited server-side exchange falls back to a
        // command the operator runs from their own IP: {"fallback": "local",
        // ...}.
        const body = await jsonDictBody(ex);
        const code = field(body, "code", "") as string;
        try {
          return json(
            await providerAuthUpdated(await auth.completeLogin(code)),
          );
        } catch (error) {
          if (isValueError(error))
            throw new HttpError(422, (error as Error).message);
          if (error instanceof HttpStatusError && error.status === 429) {
            try {
              return json({
                fallback: "local",
                ...(await auth.localExchangeCommand(code)),
              });
            } catch (inner) {
              if (isValueError(inner))
                throw new HttpError(422, (inner as Error).message);
              throw inner;
            }
          }
          throw new HttpError(502, `${title} login failed: ${excText(error)}`);
        }
      },
      long,
    );

    router.post(
      `${prefix}/token-json`,
      async (ex) => {
        // Invariant: The pasted JSON carries tokens: it stays on this channel,
        // unlogged.
        const body = await jsonDictBody(ex);
        try {
          return json(
            await providerAuthUpdated(
              await auth.completeLoginWithToken(
                field(body, "token", "") as string,
              ),
            ),
          );
        } catch (error) {
          if (isValueError(error))
            throw new HttpError(422, (error as Error).message);
          throw new HttpError(502, `${title} login failed: ${excText(error)}`);
        }
      },
      long,
    );

    router.post(
      `${prefix}/api-key`,
      async (ex) => {
        const body = await jsonDictBody(ex);
        try {
          await auth.setApiKey(field(body, "key", "") as string);
        } catch (error) {
          if (isValueError(error))
            throw new HttpError(422, (error as Error).message);
          throw error;
        }
        return json(await providerAuthUpdated(await auth.authStatus()));
      },
      long,
    );

    router.post(
      `${prefix}/logout`,
      async () => {
        await auth.logout();
        return json(await providerAuthUpdated(await auth.authStatus()));
      },
      long,
    );
  }

  oauthRoutes("/api/pi/auth", "Claude", deps.anthropic, () =>
    deps.anthropic.importClaudeCodeLogin(),
  );
  oauthRoutes("/api/pi/codex-auth", "Codex", deps.codex, () =>
    deps.codex.importCodexCliLogin(),
  );

  router.get("/api/pi/muse-auth", async () =>
    json(await deps.muse.authStatus()),
  );

  router.post(
    "/api/pi/muse-auth/start",
    async () => {
      try {
        return json(await deps.muse.startLogin());
      } catch (error) {
        throw new HttpError(502, `Muse login failed: ${excText(error)}`);
      }
    },
    long,
  );

  router.post(
    "/api/pi/muse-auth/poll",
    async () => {
      let result: Rec;
      try {
        result = await deps.muse.pollLogin();
      } catch (error) {
        if (isValueError(error))
          throw new HttpError(422, (error as Error).message);
        throw new HttpError(502, `Muse login failed: ${excText(error)}`);
      }
      return json(
        result.configured === true ? await providerAuthUpdated(result) : result,
      );
    },
    long,
  );

  router.post(
    "/api/pi/muse-auth/logout",
    async () => {
      await deps.muse.logout();
      return json(await providerAuthUpdated(await deps.muse.authStatus()));
    },
    long,
  );

  router.get("/api/pi/openrouter-auth", async () =>
    json(await deps.openrouter.authStatus()),
  );

  router.post(
    "/api/pi/openrouter-auth/api-key",
    async (ex) => {
      const body = await jsonDictBody(ex);
      try {
        await deps.openrouter.setApiKey(field(body, "key", "") as string);
      } catch (error) {
        if (isValueError(error))
          throw new HttpError(422, (error as Error).message);
        throw error;
      }
      return json(
        await providerAuthUpdated(await deps.openrouter.authStatus()),
      );
    },
    long,
  );

  router.post(
    "/api/pi/openrouter-auth/logout",
    async () => {
      await deps.openrouter.logout();
      return json(
        await providerAuthUpdated(await deps.openrouter.authStatus()),
      );
    },
    long,
  );

  router.get("/api/pi/custom-provider-auth", async () => {
    const configured = config.configuredCustomProviders();
    return json(
      Object.fromEntries(
        Object.keys(config.customModelProviders()).map((name) => [
          name,
          { configured: configured.has(name) },
        ]),
      ),
    );
  });

  router.post(
    "/api/pi/custom-provider-auth/{name}/api-key",
    async (ex) => {
      const name = ex.params.name!;
      const body = await jsonDictBody(ex);
      if (!Object.hasOwn(config.customModelProviders(), name))
        throw new HttpError(404, "no such custom provider");
      const raw = field(body, "key");
      const key = truthy(raw) ? raw : "";
      if (typeof key !== "string")
        throw new TypeError("'strip' is not a method of a non-str value");
      const trimmed = pyStrip(key);
      if (!trimmed) throw new HttpError(422, "empty API key");
      await deps.credentials.replaceCredentials(name, {
        type: "api_key",
        key: trimmed,
      });
      return json(await providerAuthUpdated({ [name]: { configured: true } }));
    },
    long,
  );

  router.post(
    "/api/pi/custom-provider-auth/{name}/logout",
    async (ex) => {
      const name = ex.params.name!;
      if (!Object.hasOwn(config.customModelProviders(), name))
        throw new HttpError(404, "no such custom provider");
      await deps.credentials.removeCredentials([name]);
      // Invariant: An ambient env key survives the removal and still
      // authenticates: recompute after the snapshot refresh.
      await providerAuthUpdated(null);
      return json({
        [name]: { configured: config.configuredCustomProviders().has(name) },
      });
    },
    long,
  );
}
