// Read local Pi catalogs at startup; failure keeps the previous list.
// Only Settings update reaches pi.dev: no auth, 15s bound, single-flight.
// Failed providers keep catalogs; missing reasoning levels log why.
// The stored list is bounded and validated; login filtering lives in ModelCatalog.
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { isObject, valueError } from "../config_files";
import { slowSpan } from "../observability/slow-span";
import type { ModelCatalog } from "./catalog";
import { validModelScopeKey } from "./model_id";
import { THINKING_LEVELS, type Thinking } from "./thinking";

const MAX_LIST_BYTES = 4 * 1024 * 1024;

export const PI_BUILTIN_PROVIDERS = new Set<string>(getBuiltinProviders());
export const PI_MODEL_ROUTES: readonly (readonly [string, string])[] = [
  ["anthropic", "Claude"],
  ["openai-codex", "ChatGPT subscription"],
  ["openai", "OpenAI API key"],
  ["google", "Gemini"],
  ["openrouter", "OpenRouter"],
];
export const AUTOMATIC_REVIEW_ROUTES = PI_MODEL_ROUTES.filter(
  ([provider]) => provider !== "google",
);
// Schema version; unknown stored lists permit all until relisted.
export const PI_MODEL_LIST_VERSION = 1;
// Bound agent-writable catalogs before validating or grouping their rows.
const MAX_PI_MODELS = 2_000;

interface PiModel {
  id: string;
  name: string;
  context_window: number;
  file_provider?: true;
  // Supported reasoning; absent worker result offers every level.
  reasoning_levels?: Thinking[];
}

export interface StoredPiModelList {
  /** Pi's listed models per route; null until the server first lists them. */
  pi: Record<string, PiModel[]> | null;
  /** Epoch seconds of the last Settings update from pi.dev, if any. */
  piUpdatedAt: number | null;
}

type Warn = (event: string, fields: Record<string, number>) => void;

/** The stored Pi model list per route (unreadable reads as not listed) and
 * when Settings last updated Pi's catalogs from pi.dev, if ever. */
export function readPiModelList(data: unknown, warn: Warn): StoredPiModelList {
  const none = { pi: null, piUpdatedAt: null };
  if (
    !isObject(data) ||
    data.version !== PI_MODEL_LIST_VERSION ||
    !Array.isArray(data.models)
  )
    return none;
  const updatedAt = data.updated_at;
  try {
    return {
      pi: checkPiModels(data.models, warn),
      piUpdatedAt:
        typeof updatedAt === "number" && Number.isFinite(updatedAt)
          ? updatedAt
          : null,
    };
  } catch {
    return none;
  }
}

export function checkPiModels(
  entries: unknown[],
  warn: Warn,
): Record<string, PiModel[]> {
  const routes = [...PI_BUILTIN_PROVIDERS];
  const out: Record<string, PiModel[]> = Object.create(null);
  if (entries.length > MAX_PI_MODELS)
    warn("pi_model_list_truncated", {
      accepted: MAX_PI_MODELS,
      ignored: entries.length - MAX_PI_MODELS,
    });
  for (const entry of entries.slice(0, MAX_PI_MODELS)) {
    if (
      !isObject(entry) ||
      typeof entry.provider !== "string" ||
      entry.provider.includes("/") ||
      !validModelScopeKey(entry.provider) ||
      (!routes.includes(entry.provider) && entry.file_provider !== true) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      !entry.name ||
      typeof entry.context_window !== "number" ||
      !Number.isSafeInteger(entry.context_window) ||
      entry.context_window <= 0 ||
      (entry.reasoning_levels !== undefined &&
        (!Array.isArray(entry.reasoning_levels) ||
          !entry.reasoning_levels.length ||
          entry.reasoning_levels.some(
            (level) => !THINKING_LEVELS.includes(level as Thinking),
          )))
    )
      throw valueError("invalid Pi model list entry");
    // Invariant: Ids outside Recurse's model-id charset (OpenRouter's `~`
    // aliases) cannot be stored in a ladder or conversation, so they are not
    // offered.
    if (!validModelScopeKey(`${entry.provider}/${entry.id}`)) continue;
    (out[entry.provider] ??= []).push({
      id: entry.id,
      name: entry.name,
      context_window: entry.context_window,
      ...(!routes.includes(entry.provider)
        ? { file_provider: true as const }
        : {}),
      ...(entry.reasoning_levels === undefined
        ? {}
        : {
            reasoning_levels: THINKING_LEVELS.filter((level) =>
              (entry.reasoning_levels as unknown[]).includes(level),
            ),
          }),
    });
  }
  return out;
}

interface PiModelListDeps {
  nativeRequest(
    request: Record<string, unknown>,
    opts?: { timeoutMs?: number; maxOutputBytes?: number },
  ): Promise<Record<string, unknown>>;
  catalog: Pick<ModelCatalog, "setPiModelList"> &
    Partial<Pick<ModelCatalog, "customModelProviders">>;
  /** One log line per listing that got no per-model reasoning levels. */
  warn?(event: string, fields: Record<string, string>): void;
}

async function requestList(
  deps: PiModelListDeps,
  update: boolean,
): Promise<{ models: unknown[]; errors: string[] }> {
  const result = await deps.nativeRequest(
    {
      action: "list_models",
      providers: PI_MODEL_ROUTES.map(([provider]) => provider),
      custom_providers: Object.keys(
        deps.catalog.customModelProviders?.() ?? {},
      ),
      ...(update ? { update: true } : {}),
    },
    { timeoutMs: update ? 60_000 : 30_000, maxOutputBytes: MAX_LIST_BYTES },
  );
  if (result.kind !== "models" || !Array.isArray(result.models))
    throw new Error("No model list was returned");
  const catalogErrors = Array.isArray(result.catalog_errors)
    ? result.catalog_errors
    : [result.catalog_error];
  for (const message of catalogErrors)
    if (typeof message === "string")
      deps.warn?.("pi_model_config_invalid", { message });
  for (const message of Array.isArray(result.catalog_notes)
    ? result.catalog_notes
    : [])
    if (typeof message === "string")
      deps.warn?.("pi_model_config_note", { message });
  // Invariant: The worker reads reasoning levels through pi-ai, which Pi does
  // not export as a public surface; without them Settings offers every level.
  const unavailable = result.reasoning_levels_unavailable;
  if (unavailable !== undefined)
    deps.warn?.("pi_reasoning_levels_unavailable", {
      reason:
        typeof unavailable === "string" && /^[a-z_]{1,64}$/u.test(unavailable)
          ? unavailable
          : "unknown",
    });
  const errors = (Array.isArray(result.errors) ? result.errors : [])
    .slice(0, 16)
    .map((error) => {
      const { provider, message } = (error ?? {}) as Record<string, unknown>;
      const text = String(message ?? "").slice(0, 200);
      return provider ? `${String(provider).slice(0, 64)}: ${text}` : text;
    });
  return { models: result.models, errors };
}

/** List Pi's models and store them; returns how many were stored. */
export async function listPiModels(deps: PiModelListDeps): Promise<number> {
  const { models } = await requestList(deps, false);
  return slowSpan("pi_model_list_store_call", undefined, () =>
    deps.catalog.setPiModelList(models),
  );
}

interface PiModelUpdateStatus {
  updating: boolean;
  /** Epoch seconds of the last successful update from pi.dev. */
  updated_at: number | null;
  /** Models in the stored list; null before the first listing. */
  count: number | null;
  /** Why the last update in this server run failed, else null. */
  error: string | null;
}

export class PiModelUpdater {
  private running: Promise<void> | null = null;
  private error: string | null = null;

  constructor(
    private readonly deps: PiModelListDeps & {
      catalog: Pick<ModelCatalog, "setPiModelList" | "piModelListState">;
      /** Run detached work that stops at shutdown (instance.tasks.spawn). */
      spawn(name: string, work: () => Promise<void>): Promise<void>;
      now?: () => number;
    },
  ) {}

  status(): PiModelUpdateStatus {
    return {
      updating: this.running !== null,
      ...this.deps.catalog.piModelListState(),
      error: this.error,
    };
  }

  /** Start an update, or join the running one; never waits for it. */
  start(): PiModelUpdateStatus {
    if (this.running === null) {
      this.error = null;
      const run = this.deps
        .spawn("pi-model-update", () => this.update())
        .catch((error: unknown) => {
          this.error =
            error instanceof Error ? error.message.slice(0, 300) : "failed";
        })
        .finally(() => {
          if (this.running === run) this.running = null;
        });
      this.running = run;
    }
    return this.status();
  }

  /** Settles when the running update does (tests and shutdown). */
  async settled(): Promise<void> {
    await this.running;
  }

  private async update(): Promise<void> {
    const started = (this.deps.now ?? (() => Date.now() / 1000))();
    const { models, errors } = await requestList(this.deps, true);
    // Invariant: Pi's store keeps a failed provider's previous catalog, so the
    // list is still current; only a clean update moves the "updated" time.
    await this.deps.catalog.setPiModelList(
      models,
      errors.length ? undefined : started,
    );
    if (errors.length) throw new Error(errors.join("; ").slice(0, 300));
  }
}
