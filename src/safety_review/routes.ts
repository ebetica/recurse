// Generate the runner-owned reviewer policy from Settings and the acting model.
// Default identities never come from the cached Pi model list. The JSON bytes
// and the reviewer revision are part of the cache identity.
import {
  isObject,
  valueError,
  type ConfigFiles,
  type Dict,
} from "../config_files";
import type { EffortLadder, ModelCatalog, Thinking } from "../models";
import { pyCompactJson } from "../utils/python-json";
import { join } from "node:path";
import { signedInReviewModels, type StoredModelSignIns } from "./models";

interface ModelRoute {
  provider: string;
  model: string;
  effort: Thinking;
}
interface ReviewRoutes {
  reviewer: ModelRoute;
  /** Path-only preference when it differs from the reviewer order. */
  summary?: ModelRoute;
  reviewer_fallbacks: ModelRoute[];
}

const SONNET_ROUTE: ModelRoute = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  effort: "low",
};
const CODEX_LUNA_ROUTE: ModelRoute = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  effort: "low",
};
const PLATFORM_LUNA_ROUTE: ModelRoute = {
  ...CODEX_LUNA_ROUTE,
  provider: "openai",
};
const route = (
  provider: string,
  model: string,
  effort: Thinking,
): ModelRoute => ({ provider, model, effort });
function routeKey(value: ModelRoute): string {
  return `${value.provider}\u0000${value.model}`;
}

export class SafetyReviewRoutes {
  readonly settingsPath: string;
  private revision = 0;

  constructor(
    private readonly settingsFiles: ConfigFiles,
    configDir: string,
    private readonly levels: EffortLadder,
    private readonly models: ModelCatalog,
  ) {
    this.settingsPath = join(configDir, "safety-review-model.json");
  }

  noteSettingsChanged(path: string): void {
    if (path === this.settingsPath) this.revision += 1;
  }

  /** Reviewer and summary routes follow the provider, never the model. */
  private routePolicy(
    provider: string,
    modelId: string,
    reviewerProvider: string,
  ): ReviewRoutes {
    const current = route(provider, modelId, "low");
    let reviewer: ModelRoute;
    let fallbacks: ModelRoute[];
    let summary: ModelRoute | undefined;
    if (provider === "anthropic") {
      reviewer =
        reviewerProvider === "openai" ? PLATFORM_LUNA_ROUTE : CODEX_LUNA_ROUTE;
      fallbacks = [SONNET_ROUTE];
    } else if (provider === "openai-codex") {
      reviewer = { ...CODEX_LUNA_ROUTE };
      fallbacks = [];
      summary = { ...CODEX_LUNA_ROUTE };
    } else if (provider === "openai") {
      reviewer = PLATFORM_LUNA_ROUTE;
      fallbacks = [];
      summary = { ...reviewer };
    } else if (provider === "google") {
      reviewer = CODEX_LUNA_ROUTE;
      fallbacks = [];
    } else {
      [reviewer, fallbacks] = this.codexFirstRoute(current);
      summary = current;
    }
    return {
      reviewer: { ...reviewer },
      summary: summary && { ...summary },
      reviewer_fallbacks: fallbacks.map((entry) => ({ ...entry })),
    };
  }

  async trustedModelPolicy(
    model: string | { provider: string; id: string },
  ): Promise<string> {
    const [provider, modelId] =
      typeof model === "string"
        ? this.models.modelParts(model)
        : [model.provider, model.id];
    const choice = this.model();
    if (choice === undefined) return "null";
    const pin = choice
      ? route(...this.models.modelParts(choice, false), "low")
      : await this.ladderReviewer();
    const defaults = this.routePolicy(provider, modelId, pin.provider);
    // For Claude, level 1 can select the OpenAI billing route, not the reviewer.
    const selected =
      !choice && provider === "anthropic"
        ? defaults
        : this.pinLadderReviewer(defaults, pin);
    const routeValue = (value: ModelRoute): Dict => ({
      provider: value.provider,
      model: value.model,
      effort: value.effort,
    });
    const reviewer: Dict = routeValue(selected.reviewer);
    if (!choice && selected.reviewer_fallbacks.length)
      reviewer.candidates = selected.reviewer_fallbacks.map(routeValue);
    return pyCompactJson(
      {
        version: 1,
        active: { provider, model: modelId },
        reviewer_pin: {
          provider: selected.reviewer.provider,
          model: selected.reviewer.model,
        },
        ...(choice ? { reviewer_explicit: true } : {}),
        reviewer_revision: this.revision,
        reviewer,
        summary: routeValue(selected.summary ?? selected.reviewer),
      },
      { sortKeys: true, javascriptScalars: true },
    );
  }

  private codexFirstRoute(current: ModelRoute): [ModelRoute, ModelRoute[]] {
    if (routeKey(current) === routeKey(CODEX_LUNA_ROUTE) || !current.provider)
      return [{ ...CODEX_LUNA_ROUTE }, []];
    return [{ ...CODEX_LUNA_ROUTE }, [{ ...current }]];
  }

  private async ladderReviewer(): Promise<ModelRoute> {
    const levelOne = this.levels.levelOneModel();
    let model: string;
    if ("model" in levelOne) {
      model = levelOne.model;
    } else {
      const { authed } = levelOne;
      // The extension shares the shipped reviewer catalog without loading Settings' model catalog.
      const [
        { getBuiltinModels },
        { AUTOMATIC_REVIEW_ROUTES, validModelScopeKey },
      ] = await Promise.all([
        import("@earendil-works/pi-ai/providers/all"),
        import("../models"),
      ]);
      const native = AUTOMATIC_REVIEW_ROUTES.filter(([provider]) =>
        authed.has(provider),
      )
        .flatMap(([provider]) =>
          getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]),
        )
        .find((entry) => validModelScopeKey(`${entry.provider}/${entry.id}`));
      const custom = this.models.firstCustomModel(authed);
      const fallback = this.models.CHAT_MODEL;
      model = native
        ? `${native.provider}/${native.id}`
        : (custom ??
          (this.models.providerOf(fallback) === "google"
            ? this.models.automaticFallbackModel()
            : fallback));
    }
    const [provider, modelId] = this.models.modelParts(model);
    return route(provider, modelId, "low");
  }

  private pinLadderReviewer(
    value: ReviewRoutes,
    reviewer: ModelRoute,
  ): ReviewRoutes {
    const seen = new Set([routeKey(reviewer)]);
    const fallbacks: ModelRoute[] = [];
    for (const candidate of [value.reviewer, ...value.reviewer_fallbacks]) {
      const key = routeKey(candidate);
      if (!seen.has(key)) {
        seen.add(key);
        fallbacks.push({ ...candidate });
      }
    }
    return { ...value, reviewer, reviewer_fallbacks: fallbacks };
  }

  /** Null selects level 1; undefined preserves an invalid saved choice. */
  model(): string | null | undefined {
    const data = this.settingsFiles.json(this.settingsPath);
    if (data === undefined)
      return this.settingsFiles.text(this.settingsPath) === undefined
        ? null
        : undefined;
    if (!isObject(data)) return undefined;
    if (!Object.hasOwn(data, "model") || data.model === null) return null;
    return typeof data.model === "string" && data.model
      ? data.model
      : undefined;
  }

  async modelsForSignIns(signedIn: StoredModelSignIns) {
    const { PI_MODEL_ROUTES } = await import("../models");
    return signedInReviewModels(signedIn, PI_MODEL_ROUTES);
  }

  async setModel(
    value: unknown,
    storedProviders: () => Promise<StoredModelSignIns>,
  ): Promise<string | null> {
    if (
      value !== null &&
      (typeof value !== "string" ||
        !(await this.modelsForSignIns(await storedProviders())).some(
          (model) => model.id === value,
        ))
    )
      throw valueError("Choose an available safety review model");
    await this.settingsFiles.writeJson(this.settingsPath, { model: value });
    return value as string | null;
  }
}
