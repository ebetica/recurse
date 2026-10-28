// Read local Pi catalogs at startup; failure keeps the previous list.
// Only Settings update reaches pi.dev: no auth, 15s bound, single-flight.
// Failed providers keep catalogs; missing reasoning levels log why.
// Config filters login state on reads, not in this catalog loader.
import { PI_MODEL_ROUTES, type Config } from "./config";

const MAX_LIST_BYTES = 4 * 1024 * 1024;

export interface PiModelListDeps {
  nativeRequest(
    request: Record<string, unknown>,
    opts?: { timeoutMs?: number; maxOutputBytes?: number },
  ): Promise<Record<string, unknown>>;
  config: Pick<Config, "setPiModelList">;
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
      ...(update ? { update: true } : {}),
    },
    { timeoutMs: update ? 60_000 : 30_000, maxOutputBytes: MAX_LIST_BYTES },
  );
  if (result.kind !== "models" || !Array.isArray(result.models))
    throw new Error("Pi returned no model list");
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
  return deps.config.setPiModelList(models);
}

export interface PiModelUpdateStatus {
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
      config: Pick<Config, "setPiModelList" | "piModelListState">;
      /** Run detached work that stops at shutdown (instance.tasks.spawn). */
      spawn(name: string, work: () => Promise<void>): Promise<void>;
      /** Rewrite files derived from the list (available-models.json). */
      afterUpdate(): Promise<void>;
      now?: () => number;
    },
  ) {}

  status(): PiModelUpdateStatus {
    return {
      updating: this.running !== null,
      ...this.deps.config.piModelListState(),
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
    this.deps.config.setPiModelList(
      models,
      errors.length ? undefined : started,
    );
    await this.deps.afterUpdate();
    if (errors.length) throw new Error(errors.join("; ").slice(0, 300));
  }
}
