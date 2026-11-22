// Model and reasoning choices from Pi's list, custom providers and logins.
// The catalog rebuilds only when one of its three stored inputs changes.
import {
  isObject,
  valueError,
  type ConfigFiles,
  type Dict,
} from "../config_files";
import {
  readProvidersDocument,
  upsertCustomProvider,
  type ProviderSpec,
} from "./custom_providers";
import {
  checkPiModels,
  PI_BUILTIN_PROVIDERS,
  PI_MODEL_LIST_VERSION,
  PI_MODEL_ROUTES,
  readPiModelList,
  type StoredPiModelList,
} from "./pi_model_list";
import { parseThinking, type Thinking } from "./thinking";

interface ModelPolicy {
  label: string;
  catalog_provider: string;
  conversation_effort: Thinking;
  context_window: number | null;
}
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  effort: string;
  context_window?: number;
}

type CatalogInputs = StoredPiModelList & {
  providers: Record<string, ProviderSpec>;
  providerEntries: [string, ProviderSpec][];
  default_raw: string;
  efforts: Record<string, Thinking>;
  /** Every catalog policy, built lazily once per cache key. */
  policies?: Record<string, ModelPolicy>;
  // Lazily cached catalog options; unlisted CHAT_MODEL appears first.
  options?: ModelOption[];
  /** The catalog's ids, built with `options`. */
  ids?: Set<string>;
  /** Pi's reasoning levels per catalog id, built lazily once per cache key. */
  reasoningLevels?: Map<string, Thinking[]>;
};

// Built-in routes follow Pi's list; custom providers follow them.
export const DEFAULT_CHAT_MODEL = "anthropic/claude-opus-5-5";

/** Recurse's suggested conversation reasoning for model families. */
const SUGGESTED_EFFORTS: readonly [RegExp, Thinking][] = [
  [/.*sonnet.*5$/iu, "xhigh"],
  [/.*opus.*5$/iu, "medium"],
  [/.*fable.*5-[12]$/iu, "low"],
  [/.*fable.*5$/iu, "medium"],
  [/.*gpt-5\.6-sol$/iu, "high"],
  [/.*luna$/iu, "xhigh"],
  [/.*astra$/iu, "low"],
  [/.*kimi.*k2\.6$/iu, "high"],
];
function patternEffort(model: string): Thinking | null {
  for (const [pattern, effort] of SUGGESTED_EFFORTS)
    if (pattern.test(model)) return effort;
  return null;
}

type CatalogPaths = {
  MODEL_PROVIDERS_FILE: string;
  DEFAULT_EFFORTS_FILE: string;
  PI_MODEL_LIST_FILE: string;
};

export class ModelCatalog {
  readonly CHAT_MODEL: string;
  private readonly chatEffortOverride: string | undefined;
  private optionsBuildCount = 0;
  private catalogCache: { revision: number; value: CatalogInputs } | null =
    null;

  constructor(
    private readonly settingsFiles: ConfigFiles,
    private readonly paths: CatalogPaths,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly authenticatedProviderSource: () => Iterable<string>,
    private readonly storedCustomProviderSource: () => Iterable<string>,
    private readonly warn: (
      event: string,
      fields: Record<string, number>,
    ) => void,
  ) {
    this.CHAT_MODEL = this.canonicalModelId(
      this.env.CHAT_MODEL ?? DEFAULT_CHAT_MODEL,
    );
    this.chatEffortOverride = this.env.CHAT_EFFORT;
    if (this.chatEffortOverride !== undefined)
      parseThinking(this.chatEffortOverride);
  }

  get CHAT_EFFORT(): string {
    return String(this.defaultEffort(this.CHAT_MODEL));
  }

  canonicalModelId(model: string): string {
    const prefix = "claude-bridge/";
    return model.startsWith(prefix)
      ? `anthropic/${model.slice(prefix.length)}`
      : model;
  }

  modelParts(model: string, useAlias = true): [string, string] {
    const id = useAlias ? this.canonicalModelId(model) : model;
    const slash = id.indexOf("/");
    return slash < 0 ? ["", id] : [id.slice(0, slash), id.slice(slash + 1)];
  }

  modelPolicy(model: string): ModelPolicy {
    const canonical = this.canonicalModelId(model);
    const policies = this.policies();
    const known = Object.hasOwn(policies, canonical)
      ? policies[canonical]
      : undefined;
    if (known) return { ...known };
    return {
      label: canonical,
      catalog_provider: "Custom",
      conversation_effort: "high",
      context_window: null,
    };
  }

  private readDefaultEfforts(data: unknown): Record<string, Thinking> {
    if (!isObject(data)) return {};
    const parsed: [string, Thinking][] = [];
    for (const [model, level] of Object.entries(data)) {
      try {
        parsed.push([model, parseThinking(level)]);
      } catch {
        // Invariant: Fail safe to built-in reasoning.
      }
    }
    const efforts = Object.create(null) as Record<string, Thinking>;
    for (const [model, effort] of parsed)
      if (this.canonicalModelId(model) === model) efforts[model] = effort;
    for (const [model, effort] of parsed) {
      const canonical = this.canonicalModelId(model);
      if (canonical !== model && !Object.hasOwn(efforts, canonical))
        efforts[canonical] = effort;
    }
    return efforts;
  }

  defaultEfforts(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.catalogInputs().efforts).map(([model, effort]) => [
        model,
        effort,
      ]),
    );
  }

  private catalogInputs(): CatalogInputs {
    const providers = this.settingsFiles.versioned(
      this.paths.MODEL_PROVIDERS_FILE,
    );
    const efforts = this.settingsFiles.versioned(
      this.paths.DEFAULT_EFFORTS_FILE,
    );
    const pi = this.settingsFiles.versioned(this.paths.PI_MODEL_LIST_FILE);
    const revision = providers.revision + efforts.revision + pi.revision;
    if (this.catalogCache?.revision === revision)
      return this.catalogCache.value;
    const [parsedProviders, defaultRaw, providerEntries] =
      readProvidersDocument(providers.text);
    const value = {
      providers: parsedProviders,
      providerEntries,
      default_raw: defaultRaw,
      efforts: this.readDefaultEfforts(efforts.value),
      ...readPiModelList(pi.value, this.warn),
    };
    this.catalogCache = { revision, value };
    return value;
  }

  revision(): number {
    this.catalogInputs();
    return this.catalogCache!.revision;
  }

  /** Replace the stored Pi model list; returns how many models it holds. */
  async setPiModelList(entries: unknown, updatedAt?: number): Promise<number> {
    if (!Array.isArray(entries)) throw valueError("invalid Pi model list");
    const listed = checkPiModels(entries, this.warn);
    const models = Object.entries(listed).flatMap(([provider, entries]) =>
      entries.map((model) => ({ provider, ...model })),
    );
    // Invariant: A plain relist keeps the time of the last update from pi.dev.
    await this.settingsFiles.writeJson(
      this.paths.PI_MODEL_LIST_FILE,
      () => {
        const updated = updatedAt ?? this.catalogInputs().piUpdatedAt;
        return {
          version: PI_MODEL_LIST_VERSION,
          ...(updated === null ? {} : { updated_at: updated }),
          models,
        };
      },
      false,
    );
    return models.length;
  }

  /** How many models Pi's stored list holds (null before the first listing)
   * and when Settings last updated it from pi.dev (epoch seconds). */
  piModelListState(): { count: number | null; updated_at: number | null } {
    const { pi, piUpdatedAt } = this.catalogInputs();
    return {
      count:
        pi === null
          ? null
          : Object.values(pi).reduce((sum, models) => sum + models.length, 0),
      updated_at: piUpdatedAt,
    };
  }

  // The actionable sentence for a model Pi's list lacks, else null. Before the
  // server first lists Pi's models nothing is refused: Pi decides.
  unlistedModelSentence(model: string, level: number | null): string | null {
    const ids = this.catalogModelIds();
    const canonical = this.canonicalModelId(model);
    if (ids === null || ids.has(canonical)) return null;
    return level === null
      ? `Model ${canonical} is not in Pi's model list. Choose an effort level for this conversation.`
      : `Model ${canonical} is not in Pi's model list. Choose another model for level ${level} in Settings > Effort levels.`;
  }

  suggestedEffort(model: string): Thinking {
    return patternEffort(model) ?? this.modelPolicy(model).conversation_effort;
  }

  defaultEffort(model: string): Thinking {
    if (this.chatEffortOverride !== undefined)
      return parseThinking(this.chatEffortOverride);
    const efforts = this.catalogInputs().efforts;
    return Object.hasOwn(efforts, model)
      ? efforts[model]!
      : this.suggestedEffort(model);
  }

  customModelProviders(): Record<string, ProviderSpec> {
    return this.catalogInputs().providers;
  }

  upsertCustomProvider(name: string, spec: Dict): Promise<boolean> {
    return upsertCustomProvider(
      this.settingsFiles,
      this.paths.MODEL_PROVIDERS_FILE,
      name,
      spec,
    );
  }

  firstCustomModel(authed: Set<string>): string | undefined {
    return this.catalogInputs().providerEntries.flatMap(([provider, spec]) =>
      authed.has(provider)
        ? spec.models.map((entry) => `${provider}/${entry.id}`)
        : [],
    )[0];
  }

  customDefaultModel(): string {
    const { default_raw: value, providers } = this.catalogInputs();
    if (!value) return "";
    const slash = value.indexOf("/");
    if (slash < 0) return "";
    const providerName = value.slice(0, slash);
    const provider = Object.hasOwn(providers, providerName)
      ? providers[providerName]
      : undefined;
    const modelId = value.slice(slash + 1);
    return provider?.models.some((model) => model.id === modelId) ? value : "";
  }

  private policies(): Record<string, ModelPolicy> {
    const inputs = this.catalogInputs();
    if (inputs.policies) return inputs.policies;
    const out: Record<string, ModelPolicy> = Object.create(null);
    const providers = new Set([
      ...PI_MODEL_ROUTES.map(([id]) => id),
      ...Object.keys(inputs.pi ?? {}),
    ]);
    for (const provider of providers)
      for (const model of inputs.pi?.[provider] ?? []) {
        const id = `${provider}/${model.id}`;
        out[id] = {
          label: model.name,
          catalog_provider:
            PI_MODEL_ROUTES.find(([id]) => id === provider)?.[1] ?? provider,
          conversation_effort: patternEffort(id) ?? "high",
          context_window: model.context_window,
        };
      }
    for (const [name, provider] of inputs.providerEntries)
      for (const model of provider.models) {
        const id = `${name}/${model.id}`;
        if (Object.hasOwn(out, id)) continue;
        out[id] = {
          label: model.label || model.id,
          catalog_provider: name,
          conversation_effort: model.effort ?? "high",
          context_window: model.context_window ?? null,
        };
      }
    inputs.policies = out;
    return out;
  }

  /** The catalog for the current settings files, built once per cache key.
   * CHAT_MODEL is always offered (first) even when Pi does not list it, so
   * the configured default is never refused as unlisted. */
  private catalogOptions(): { options: ModelOption[]; ids: Set<string> } {
    const inputs = this.catalogInputs();
    if (inputs.options && inputs.ids)
      return { options: inputs.options, ids: inputs.ids };
    const policies = this.policies();
    const effort = (id: string, policy: ModelPolicy | undefined): string =>
      String(
        this.chatEffortOverride !== undefined
          ? parseThinking(this.chatEffortOverride)
          : Object.hasOwn(inputs.efforts, id)
            ? inputs.efforts[id]!
            : (patternEffort(id) ??
              (policy ?? this.modelPolicy(id)).conversation_effort),
      );
    const options: ModelOption[] = Object.entries(policies).map(
      ([id, value]) => ({
        id,
        label: value.label,
        provider: value.catalog_provider,
        effort: effort(id, value),
        ...(value.context_window === null
          ? {}
          : { context_window: value.context_window }),
      }),
    );
    const defaults = [this.CHAT_MODEL];
    if (this.isFileProviderModel(this.CHAT_MODEL))
      defaults.push(DEFAULT_CHAT_MODEL);
    for (const model of defaults)
      if (!Object.hasOwn(policies, model))
        options.unshift({
          id: model,
          label: model,
          provider: "Custom",
          effort: effort(model, undefined),
        });
    inputs.options = options;
    inputs.ids = new Set(options.map((option) => option.id));
    this.optionsBuildCount += 1;
    return { options, ids: inputs.ids };
  }

  get catalogBuildCount(): number {
    return this.optionsBuildCount;
  }

  chatModels(): ModelOption[] {
    return this.catalogOptions().options.map((option) => ({ ...option }));
  }

  /** Pi's reasoning levels for a listed model, or null when Pi's list does
   * not give them (custom providers, unlisted ids, or a list read without
   * them): then any level may be chosen and Pi clamps it at run time. */
  modelReasoningLevels(model: string): Thinking[] | null {
    const inputs = this.catalogInputs();
    if (!inputs.reasoningLevels) {
      const levels = new Map<string, Thinking[]>();
      for (const [provider, entries] of Object.entries(inputs.pi ?? {}))
        for (const entry of entries)
          if (entry.reasoning_levels)
            levels.set(`${provider}/${entry.id}`, entry.reasoning_levels);
      inputs.reasoningLevels = levels;
    }
    const levels = inputs.reasoningLevels.get(this.canonicalModelId(model));
    return levels ? [...levels] : null;
  }

  defaultChatModel(): string {
    const configured = this.customDefaultModel() || this.CHAT_MODEL;
    const want = this.isFileProviderModel(configured)
      ? DEFAULT_CHAT_MODEL
      : configured;
    let authedCatalog: string[];
    try {
      const providers = this.authedModelProviders();
      authedCatalog = this.chatModels()
        .filter((option) => providers.has(this.providerOf(option.id)))
        .map((option) => option.id);
    } catch {
      authedCatalog = [];
    }
    if (!authedCatalog.length) return want;
    return authedCatalog.includes(want) ? want : authedCatalog[0]!;
  }

  validateDefaultEfforts(value: unknown): Record<string, string> {
    if (!isObject(value))
      throw valueError("default efforts must map models to reasoning levels");
    const enabled = new Set(this.chatModels().map((option) => option.id));
    const resolved: Record<string, string> = {};
    for (const [model, level] of Object.entries(value)) {
      if (!enabled.has(model))
        throw valueError(`unsupported chat model: ${model}`);
      if (level === null) continue;
      try {
        resolved[model] = parseThinking(level);
      } catch {
        throw valueError(
          `unsupported reasoning level for ${model}: ${String(level)}`,
        );
      }
    }
    return resolved;
  }

  async setDefaultEfforts(value: unknown): Promise<Record<string, string>> {
    const resolved = this.validateDefaultEfforts(value);
    const sorted = Object.fromEntries(
      Object.keys(resolved)
        .sort()
        .map((model) => [model, resolved[model]]),
    );
    await this.settingsFiles.writeJson(
      this.paths.DEFAULT_EFFORTS_FILE,
      sorted,
      false,
    );
    return this.defaultEfforts();
  }

  modelContextWindow(modelId: string): number | null {
    return this.modelPolicy(modelId).context_window;
  }

  providerOf(modelId: string): string {
    const slash = this.canonicalModelId(modelId).indexOf("/");
    return slash < 0 ? "" : this.canonicalModelId(modelId).slice(0, slash);
  }

  /** File endpoints require a saved choice, never automatic selection. */
  isFileProviderModel(model: string): boolean {
    const provider = this.providerOf(model);
    return (
      provider !== "" &&
      !PI_BUILTIN_PROVIDERS.has(provider) &&
      !Object.hasOwn(this.customModelProviders(), provider)
    );
  }

  configuredCustomProviders(): Set<string> {
    let providers: Record<string, ProviderSpec>;
    try {
      providers = this.customModelProviders();
    } catch {
      return new Set();
    }
    const stored = new Set(this.storedCustomProviderSource());
    return new Set(
      Object.entries(providers)
        .filter(
          ([name, provider]) =>
            stored.has(name) || Boolean(this.env[provider.env_key]),
        )
        .map(([name]) => name),
    );
  }

  authedModelProviders(): Set<string> {
    try {
      const custom = this.customModelProviders();
      return new Set(
        [
          ...this.authenticatedProviderSource(),
          ...this.configuredCustomProviders(),
        ].filter(
          (provider) =>
            PI_BUILTIN_PROVIDERS.has(provider) ||
            Object.hasOwn(custom, provider),
        ),
      );
    } catch {
      return new Set();
    }
  }

  authedChatModels(): ModelOption[] {
    const authed = this.authedModelProviders();
    return this.chatModels().filter(
      (option) =>
        authed.has(this.providerOf(option.id)) ||
        this.isFileProviderModel(option.id),
    );
  }

  chatModel(model?: string | null): ModelOption {
    const selected = model
      ? this.canonicalModelId(model)
      : this.defaultChatModel();
    const option = this.chatModels().find(
      (candidate) => candidate.id === selected,
    );
    if (!option) throw valueError(`unsupported chat model: ${selected}`);
    return option;
  }

  chatSettings(model?: string | null): [string, string] {
    if (model === undefined || model === null) {
      const selected = this.defaultChatModel();
      return [selected, String(this.defaultEffort(selected))];
    }
    const canonical = this.canonicalModelId(model);
    try {
      return [canonical, this.chatModel(canonical).effort];
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ValueError") throw error;
      return [canonical, String(this.defaultEffort(canonical))];
    }
  }

  /** Listed models, or null before the server first lists Pi's models. */
  catalogModelIds(): Set<string> | null {
    if (this.catalogInputs().pi === null) return null;
    return this.catalogOptions().ids;
  }
}
