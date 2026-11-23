// Instance paths and cached Settings files. Server snapshots refresh off-thread;
// zero-window CLI reads stay synchronous.
import { ConfigFiles, isObject, valueError } from "./config_files";
import { EffortLadder, ModelCatalog } from "./models";
import { recordMessage } from "./observability/runtime_logging";
import { SafetyReviewRoutes } from "./safety_review";
import { join, resolve } from "node:path";
import {
  RECURSE_REPO_URL,
  statePaths,
  type Environment,
  type StatePaths,
} from "./state_paths";

interface ConfigOptions {
  readonly env?: Environment;
  readonly cwd?: string;
  readonly toolsDir?: string | null;
  // Logged-in provider prefixes; omission means no providers.
  readonly authenticatedProviders?: () => Iterable<string>;
  // Refresh window in ms; 0 reads synchronously, server preloads then uses 1s.
  readonly settingsRecheckMs?: number;
  /** Monotonic milliseconds for that window; defaults to performance.now. */
  readonly now?: () => number;
  readonly storedCustomProviders?: () => Iterable<string>;
  readonly warn?: (event: string, fields: Record<string, number>) => void;
}
const AGENT_HISTORY_RETENTION_DAYS = 90;
const DEFAULT_MAXIMUM_CONTEXT_WINDOW = 400_000;
const MINIMUM_CONTEXT_WINDOW = 64_000;
const MAXIMUM_CONTEXT_WINDOW = 1_000_000;

// Server Settings file-read cache window.
export const SETTINGS_RECHECK_MS = 1000;

export class Config {
  readonly env: Environment;
  readonly paths: StatePaths;
  readonly displayName: string;
  readonly repoUrl: string;
  readonly models: ModelCatalog;
  readonly levels: EffortLadder;
  readonly safetyReview: SafetyReviewRoutes;
  private readonly settingsFiles: ConfigFiles;

  constructor(options: ConfigOptions = {}) {
    this.env = options.env ?? process.env;
    const now = options.now ?? (() => performance.now());
    const settingsRecheckMs = options.settingsRecheckMs ?? 0;
    const warn: NonNullable<ConfigOptions["warn"]> =
      options.warn ??
      ((event, fields) => console.warn(recordMessage(event, fields)));
    const cwd = resolve(options.cwd ?? process.cwd());
    this.paths = statePaths(this.env, cwd, options.toolsDir);
    this.displayName = this.env.CHAT_APP_NAME ?? "Recurse";
    this.repoUrl = this.env.CHAT_REPO_URL ?? RECURSE_REPO_URL;
    this.settingsFiles = new ConfigFiles(settingsRecheckMs, now, (path) =>
      this.safetyReview.noteSettingsChanged(path),
    );
    this.models = new ModelCatalog(
      this.settingsFiles,
      this.paths,
      this.env,
      options.authenticatedProviders ?? (() => []),
      options.storedCustomProviders ?? (() => []),
      warn,
    );
    this.levels = new EffortLadder(this.models, this.settingsFiles, this.paths);
    this.safetyReview = new SafetyReviewRoutes(
      this.settingsFiles,
      this.paths.CONFIG_DIR,
      this.levels,
      this.models,
    );
  }

  /** Load server settings before use, or explicitly await external edits. */
  async refreshSettings(): Promise<void> {
    await Promise.all(
      [
        this.paths.MODEL_PROVIDERS_FILE,
        this.paths.DEFAULT_EFFORTS_FILE,
        this.paths.PI_MODEL_LIST_FILE,
        this.paths.EFFORT_LEVELS_FILE,
        this.paths.AVAILABLE_MODELS_FILE,
        this.paths.DELETED_AGENT_HISTORY_FILE,
        this.paths.MAXIMUM_CONTEXT_WINDOW_FILE,
        join(this.paths.CONFIG_DIR, "prompt-cache-warming.json"),
        join(this.paths.CONFIG_DIR, "idle-compaction.json"),
        this.safetyReview.settingsPath,
      ].map((path) => this.settingsFiles.refresh(path)),
    );
  }

  /** Stop background reads and drain writes when the server closes. */
  close(): Promise<void> {
    return this.settingsFiles.close();
  }

  /** Days deleted history remains available; applied each maintenance pass. */
  deletedAgentHistoryDays(): number {
    const data = this.settingsFiles.json(this.paths.DELETED_AGENT_HISTORY_FILE);
    const value = isObject(data) ? data.days : undefined;
    return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 36500
      ? value
      : AGENT_HISTORY_RETENTION_DAYS;
  }

  /** Await the retention policy before a destructive expiry pass. */
  async refreshDeletedAgentHistoryDays(): Promise<number> {
    await this.settingsFiles.refresh(this.paths.DELETED_AGENT_HISTORY_FILE);
    return this.deletedAgentHistoryDays();
  }

  async setDeletedAgentHistoryDays(value: unknown): Promise<number> {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 36500
    )
      throw valueError(
        "deleted agents' history must be kept for between 1 and 36500 days",
      );
    await this.settingsFiles.writeJson(this.paths.DELETED_AGENT_HISTORY_FILE, {
      days: value,
    });
    return value;
  }

  keepPromptCacheWarm(): boolean {
    const data = this.settingsFiles.json(
      join(this.paths.CONFIG_DIR, "prompt-cache-warming.json"),
    );
    return !isObject(data) || data.enabled !== false;
  }

  async setKeepPromptCacheWarm(value: unknown): Promise<boolean> {
    if (typeof value !== "boolean")
      throw valueError("Keep prompt cache warm must be a boolean");
    await this.settingsFiles.writeJson(
      join(this.paths.CONFIG_DIR, "prompt-cache-warming.json"),
      { enabled: value },
    );
    return value;
  }

  compactIdleConversations(): boolean {
    const data = this.settingsFiles.json(
      join(this.paths.CONFIG_DIR, "idle-compaction.json"),
    );
    return isObject(data) && data.enabled === true;
  }

  idleCompactionMinimumTokens(): number {
    const data = this.settingsFiles.json(
      join(this.paths.CONFIG_DIR, "idle-compaction.json"),
    );
    const value = isObject(data) ? data.minimum_tokens : undefined;
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 32000
      ? value
      : 120000;
  }

  async setCompactIdleConversations(
    value: unknown,
    minimum: unknown = this.idleCompactionMinimumTokens(),
  ): Promise<boolean> {
    if (typeof value !== "boolean")
      throw valueError("Compact idle conversations must be a boolean");
    if (
      typeof minimum !== "number" ||
      !Number.isSafeInteger(minimum) ||
      minimum < 32000
    )
      throw valueError(
        "Minimum conversation length must be an integer of at least 32000 tokens",
      );
    await this.settingsFiles.writeJson(
      join(this.paths.CONFIG_DIR, "idle-compaction.json"),
      { enabled: value, minimum_tokens: minimum },
    );
    return value;
  }

  maximumContextWindow(): number {
    try {
      const data = this.settingsFiles.json(
        this.paths.MAXIMUM_CONTEXT_WINDOW_FILE,
      );
      return this.validateMaximumContextWindow(
        isObject(data) ? data.maximum_context_window : undefined,
      );
    } catch {
      return DEFAULT_MAXIMUM_CONTEXT_WINDOW;
    }
  }

  validateMaximumContextWindow(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < MINIMUM_CONTEXT_WINDOW ||
      value > MAXIMUM_CONTEXT_WINDOW
    ) {
      throw valueError(
        `maximum context window must be between ${MINIMUM_CONTEXT_WINDOW} and ${MAXIMUM_CONTEXT_WINDOW} tokens`,
      );
    }
    return value;
  }

  async setMaximumContextWindow(value: unknown): Promise<number> {
    const checked = this.validateMaximumContextWindow(value);
    await this.settingsFiles.writeJson(this.paths.MAXIMUM_CONTEXT_WINDOW_FILE, {
      maximum_context_window: checked,
    });
    return checked;
  }

  contextBarWindow(modelId: string): number | null {
    const capacity = this.models.modelPolicy(modelId).context_window;
    return capacity === null
      ? null
      : Math.min(capacity, this.maximumContextWindow());
  }
}

/** Construct settings against an explicit environment and state root. */
export function createConfig(options: ConfigOptions = {}): Config {
  return new Config(options);
}
