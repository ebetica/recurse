// Instance paths, cached Settings files, and trusted reviewer routing.
// Server snapshots refresh off-thread; zero-window CLI reads stay synchronous.
// Endpoint identity and safety eligibility never derive from cached lists.
import { createHash } from "node:crypto";
import {
  ConfigFiles,
  isObject,
  pythonJson,
  valueError,
  type Dict,
} from "./config_files";
import {
  EffortLadder,
  ModelCatalog,
  PI_MODEL_ROUTES,
  validModelScopeKey,
  type Thinking,
} from "./models";
import type { StoredModelSignIns } from "./safety_review_models";
import { recordMessage } from "./observability/runtime_logging";
import fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_TEMP_KEY_RE = /^\p{Nd}{8}-[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/u;
export const AGENT_DRAFT_KEY_RE = /^draft-\p{Nd}{8}-[a-f0-9]{32}$/u;

interface ModelRoute {
  provider: string;
  model: string;
  effort: Thinking;
}
interface ReviewRoutes {
  reviewer: ModelRoute;
  summary: ModelRoute;
  reviewer_fallbacks: ModelRoute[];
}
type Environment = Readonly<Record<string, string | undefined>>;
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
interface StatePaths {
  DATA_DIR: string;
  RECURSE_SERVICE_TOKEN_FILE: string | null;
  RECURSE_SERVICE_PRINCIPALS_FILE: string | null;
  RECURSE_TAILSCALE_LOGIN: string | null;
  REPO_DIR: string;
  ARTIFACTS_DIR: string;
  WORKTREES: string;
  MEMORIES_DIR: string;
  AGENT_MEMORIES_DIR: string;
  GLOBAL_MEMORIES_DIR: string;
  SERVICE_BINDINGS_DIR: string;
  WORKTREE_OWNERS: string;
  CONFIG_DIR: string;
  AGENTS_MD: string;
  TOOLS_DIR: string | null;
  MAXIMUM_CONTEXT_WINDOW_FILE: string;
  DELETED_AGENT_HISTORY_FILE: string;
  DEFAULT_EFFORTS_FILE: string;
  MODEL_PROVIDERS_FILE: string;
  EFFORT_LEVELS_FILE: string;
  THEMES_FILE: string;
  AVAILABLE_MODELS_FILE: string;
  PI_MODEL_LIST_FILE: string;
  DEFAULT_MAXIMUM_CONTEXT_WINDOW: number;
  MINIMUM_CONTEXT_WINDOW: number;
  MAXIMUM_CONTEXT_WINDOW: number;
  CONV_DIR: string;
  EXTERNAL_KEY_DIR: string;
  MSG_DIR: string;
  TOOL_DETAILS_DIR: string;
  SPAWN_OUTCOME_DIR: string;
  INTERRUPT_SOCKET: string;
  TITLE_LOCK_DIR: string;
  MUTE_LOCK_DIR: string;
  AGENT_TEMP_IN_DATA_DIR: boolean;
  AGENT_TEMP_USES_SHORT_DEFAULT: boolean;
  AGENT_TEMP_ROOT: string;
  AGENT_TEMP_SCOPE: string;
  AGENT_TEMP_INSTANCE_DIR: string;
  AGENT_FILES_DIR: string;
  AGENT_TEMP_PATH_MAX_BYTES: number;
  AGENT_RUNTIME_ROOT: string;
  AGENT_RUNTIME_INSTANCE_DIR: string;
  AGENT_TEMP_DRAFT_TTL: number;
  TRASH_DIR: string;
  AGENT_HISTORY_DIR: string;
  AGENT_HISTORY_RETENTION_DAYS: number;
  AGENT_HISTORY_EXPIRY_LIMIT: number;
  AGENT_TEMP_TRASH_NAME: string;
  AGENT_TEMP_TRASH_DIR: string;
  AGENT_RUNTIME_TRASH_DIR: string;
  AGENT_STORE_TRASH_DIR: string;
  TRASH_SWEEP_LIMIT: number;
  DELETED_DIR: string;
  DELETED_RETENTION_DAYS: number;
  DELETED_EXPIRY_LIMIT: number;
  AGENT_ATTACHMENTS_DIR: string;
  TURN_PROMPT_DIR: string;
  HTTP_REQUEST_DECOMPRESSION_ENABLED: boolean;
  HTTP_RESPONSE_COMPRESSION_ENABLED: boolean;
  PI_BG_SHELL_STATE_DIR: string;
  PI_BG_SHELL_ENABLED: boolean;
  PI_RECURSE_ENABLED: boolean;
  PI_BG_SHELL_LIVENESS_POLL_INTERVAL: number;
  PI_BG_SHELL_LIVENESS_RETRIES: number;
  PI_BG_SHELL_LIVENESS_RETRY_INTERVAL: number;
  COMPACT_TIMEOUT: number;
  PI_SAFETY_ENABLED: boolean;
}

const DEFAULT_MAXIMUM_CONTEXT_WINDOW = 400_000;
const MINIMUM_CONTEXT_WINDOW = 64_000;
const MAXIMUM_CONTEXT_WINDOW = 1_000_000;
export const RECURSE_REPO_URL = "https://github.com/ebetica/recurse.git";

// Server Settings file-read cache window.
export const SETTINGS_RECHECK_MS = 1000;

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
const route = (
  provider: string,
  model: string,
  effort: Thinking,
): ModelRoute => ({ provider, model, effort });
const PYTHON_WHITESPACE =
  /[\t-\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
function pythonStrip(value: string): string {
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;
  while (start < end && PYTHON_WHITESPACE.test(characters[start]!)) start += 1;
  while (end > start && PYTHON_WHITESPACE.test(characters[end - 1]!)) end -= 1;
  return characters.slice(start, end).join("");
}
function pythonInt(env: Environment, name: string, fallback: string): number {
  const raw = env[name] ?? fallback;
  const stripped = pythonStrip(raw);
  if (!/^[+-]?\d+$/u.test(stripped))
    throw valueError(`invalid literal for int(): ${raw}`);
  const value = Number(stripped);
  if (!Number.isSafeInteger(value))
    throw valueError(`invalid literal for int(): ${raw}`);
  return value;
}
const PYTHON_DIGITS = String.raw`[0-9](?:_?[0-9])*`;
const PYTHON_FLOAT_RE = new RegExp(
  String.raw`^[+-]?(?:(?:${PYTHON_DIGITS}(?:\.(?:${PYTHON_DIGITS})?|)|\.${PYTHON_DIGITS})(?:[eE][+-]?${PYTHON_DIGITS})?|inf(?:inity)?|nan)$`,
  "iu",
);
function pythonFloat(env: Environment, name: string, fallback: string): number {
  const raw = env[name] ?? fallback;
  const stripped = pythonStrip(raw);
  if (!PYTHON_FLOAT_RE.test(stripped))
    throw valueError(`could not convert string to float: '${raw}'`);
  const normalized = stripped.replaceAll("_", "");
  if (/^[+-]?inf(?:inity)?$/iu.test(normalized))
    return normalized.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/iu.test(normalized)) return Number.NaN;
  return Number(normalized);
}
function pythonPath(path: string): string {
  const root =
    path.startsWith("//") && !path.startsWith("///")
      ? "//"
      : path.startsWith("/")
        ? "/"
        : "";
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return parts.length ? `${root}${parts.join("/")}` : root || ".";
}
function pythonPathJoin(base: string, ...parts: string[]): string {
  let result = base;
  for (const part of parts) {
    if (!part) continue;
    result = pythonPath(
      isAbsolute(part)
        ? part
        : `${result.endsWith("/") ? result : `${result}/`}${part}`,
    );
  }
  return result;
}
function pythonResolvePath(path: string, cwd: string): string {
  let candidate = isAbsolute(path) ? "/" : resolve(cwd);
  try {
    // oxlint-disable-next-line no-restricted-properties -- known: Config filesystem path validation
    candidate = fs.realpathSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      candidate = dirname(candidate);
      continue;
    }
    const next = pythonPathJoin(candidate, part);
    try {
      // oxlint-disable-next-line no-restricted-properties -- known: Config filesystem path validation
      candidate = fs.realpathSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      candidate = next;
    }
  }
  return pythonPath(candidate);
}
function defaultOn(env: Environment, name: string): boolean {
  const value = pythonStrip(env[name] ?? "").toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}
function routeKey(value: ModelRoute): string {
  return `${value.provider}\u0000${value.model}`;
}

function buildPaths(
  env: Environment,
  cwd: string,
  explicitToolsDir: string | null | undefined,
): { paths: StatePaths; displayName: string; repoUrl: string } {
  const declared = env.RECURSE_ISOLATED_DATA_DIR;
  let dataDir: string;
  if (declared === undefined) {
    const configured = env.CHAT_DATA_DIR;
    dataDir = pythonResolvePath(configured || ".recurse-data", cwd);
  } else {
    if (!pythonStrip(declared))
      throw valueError("RECURSE_ISOLATED_DATA_DIR must not be empty");
    if (!isAbsolute(declared))
      throw valueError("RECURSE_ISOLATED_DATA_DIR must be an absolute path");
    dataDir = pythonResolvePath(declared, cwd);
    const ambient = env.CHAT_DATA_DIR;
    if (ambient !== undefined && pythonResolvePath(ambient, cwd) !== dataDir) {
      throw valueError(
        "CHAT_DATA_DIR conflicts with RECURSE_ISOLATED_DATA_DIR; refusing to start an isolated process against inherited state",
      );
    }
  }
  const path = (name: string) => join(dataDir, name);
  const servicePath = (name: string): string | null => {
    const value = env[name];
    if (!value) return null;
    if (!isAbsolute(value))
      throw valueError(`${name} must be an absolute path`);
    return pythonPath(value);
  };
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const toolsDir =
    explicitToolsDir !== undefined
      ? explicitToolsDir
      : ([resolve(sourceDir, "../tools"), "/root/tools"].find((candidate) => {
          try {
            // oxlint-disable-next-line no-restricted-properties -- known: Config filesystem path validation
            return fs.statSync(candidate).isDirectory();
          } catch {
            return false;
          }
        }) ?? null);
  const tempOverride = env.RECURSE_TEMP_ROOT;
  const tempInData = env.RECURSE_TEMP_IN_DATA_DIR;
  if (tempInData !== undefined && !["0", "1"].includes(tempInData)) {
    throw valueError("RECURSE_TEMP_IN_DATA_DIR must be 0 or 1");
  }
  const tempInDataDir = tempInData === "1";
  if (tempInDataDir && tempOverride !== undefined) {
    throw valueError(
      "RECURSE_TEMP_ROOT and RECURSE_TEMP_IN_DATA_DIR=1 are mutually exclusive",
    );
  }
  const shortDefault = !tempInDataDir && tempOverride === undefined;
  const tempRoot = tempInDataDir
    ? path("agent_tmp")
    : pythonPath(tempOverride ?? "/tmp/recurse");
  if (!isAbsolute(tempRoot))
    throw valueError("RECURSE_TEMP_ROOT must be an absolute path");
  const resolvedTemp = pythonResolvePath(tempRoot, cwd);
  const tempIsWithinData =
    resolvedTemp === dataDir ||
    resolvedTemp.startsWith(dataDir.endsWith("/") ? dataDir : `${dataDir}/`);
  if (!tempInDataDir && (resolvedTemp === "/" || tempIsWithinData)) {
    throw valueError(
      "RECURSE_TEMP_ROOT must be a dedicated directory outside CHAT_DATA_DIR",
    );
  }
  const scope = `recurse-${createHash("sha256").update(dataDir, "utf8").digest("hex").slice(0, 12)}`;
  const tempInstance = pythonPathJoin(tempRoot, scope);
  const runtimeRoot = tempInDataDir ? "/tmp/recurse" : tempRoot;
  const runtimeInstance = pythonPathJoin(runtimeRoot, scope);
  const agentDraftTtl = Math.max(
    3600,
    pythonInt(env, "RECURSE_TEMP_DRAFT_TTL", String(24 * 3600)),
  );
  const trashSweepLimit = Math.max(
    1,
    pythonInt(env, "RECURSE_TRASH_SWEEP_LIMIT", "16"),
  );
  const deletedRetentionDays = Math.max(
    1,
    pythonInt(env, "RECURSE_DELETED_RETENTION_DAYS", "7"),
  );
  const deletedExpiryLimit = Math.max(
    1,
    pythonInt(env, "RECURSE_DELETED_EXPIRY_LIMIT", "4"),
  );
  const tokenPath = servicePath("RECURSE_SERVICE_TOKEN_FILE");
  const principalsPath = servicePath("RECURSE_SERVICE_PRINCIPALS_FILE");
  const paths: StatePaths = {
    DATA_DIR: dataDir,
    RECURSE_SERVICE_TOKEN_FILE: tokenPath,
    RECURSE_SERVICE_PRINCIPALS_FILE: principalsPath,
    RECURSE_TAILSCALE_LOGIN: env.RECURSE_TAILSCALE_LOGIN?.trim() || null,
    REPO_DIR: path("repo"),
    ARTIFACTS_DIR: path("artifact_repos"),
    WORKTREES: path("worktrees"),
    MEMORIES_DIR: path("memories"),
    AGENT_MEMORIES_DIR: path("memories/agents"),
    GLOBAL_MEMORIES_DIR: path("memories/global"),
    SERVICE_BINDINGS_DIR: path("service_bindings"),
    WORKTREE_OWNERS: path("worktree_owners"),
    CONFIG_DIR: path("config"),
    AGENTS_MD: join(path("repo"), "AGENTS.md"),
    TOOLS_DIR: toolsDir,
    MAXIMUM_CONTEXT_WINDOW_FILE: path("config/maximum-context-window.json"),
    DELETED_AGENT_HISTORY_FILE: path("config/deleted-agent-history.json"),
    DEFAULT_EFFORTS_FILE: path("config/default-efforts.json"),
    MODEL_PROVIDERS_FILE: path("config/model-providers.json"),
    EFFORT_LEVELS_FILE: path("config/effort-levels.json"),
    THEMES_FILE: path("config/themes.json"),
    AVAILABLE_MODELS_FILE: path("config/available-models.json"),
    PI_MODEL_LIST_FILE: path("config/pi-model-list.json"),
    DEFAULT_MAXIMUM_CONTEXT_WINDOW,
    MINIMUM_CONTEXT_WINDOW,
    MAXIMUM_CONTEXT_WINDOW,
    CONV_DIR: path("conversations"),
    EXTERNAL_KEY_DIR: path("external_keys"),
    MSG_DIR: path("messages"),
    TOOL_DETAILS_DIR: path("tool_artifacts"),
    SPAWN_OUTCOME_DIR: path("spawn_outcomes"),
    INTERRUPT_SOCKET: `/tmp/recurse-interrupt-${createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}.sock`,
    TITLE_LOCK_DIR: path("title_locks"),
    MUTE_LOCK_DIR: path("mute_locks"),
    AGENT_TEMP_IN_DATA_DIR: tempInDataDir,
    AGENT_TEMP_USES_SHORT_DEFAULT: shortDefault,
    AGENT_TEMP_ROOT: tempRoot,
    AGENT_TEMP_SCOPE: scope,
    AGENT_TEMP_INSTANCE_DIR: tempInstance,
    AGENT_FILES_DIR: path("agent_files"),
    AGENT_TEMP_PATH_MAX_BYTES: 65,
    AGENT_RUNTIME_ROOT: runtimeRoot,
    AGENT_RUNTIME_INSTANCE_DIR: runtimeInstance,
    AGENT_TEMP_DRAFT_TTL: agentDraftTtl,
    TRASH_DIR: path("trash"),
    AGENT_HISTORY_DIR: path("history"),
    AGENT_HISTORY_RETENTION_DAYS: 90,
    AGENT_HISTORY_EXPIRY_LIMIT: 4,
    AGENT_TEMP_TRASH_NAME: ".trash",
    AGENT_TEMP_TRASH_DIR: pythonPathJoin(tempInstance, ".trash"),
    AGENT_RUNTIME_TRASH_DIR: pythonPathJoin(runtimeInstance, ".trash"),
    AGENT_STORE_TRASH_DIR: path("agents/.trash"),
    TRASH_SWEEP_LIMIT: trashSweepLimit,
    DELETED_DIR: path("deleted"),
    DELETED_RETENTION_DAYS: deletedRetentionDays,
    DELETED_EXPIRY_LIMIT: deletedExpiryLimit,
    AGENT_ATTACHMENTS_DIR: path("agent_attachments"),
    TURN_PROMPT_DIR: path("turn_prompts"),
    HTTP_REQUEST_DECOMPRESSION_ENABLED: defaultOn(
      env,
      "RECURSE_HTTP_REQUEST_DECOMPRESSION",
    ),
    HTTP_RESPONSE_COMPRESSION_ENABLED: defaultOn(
      env,
      "RECURSE_HTTP_RESPONSE_COMPRESSION",
    ),
    PI_BG_SHELL_STATE_DIR: pythonPath(
      env.PI_BG_SHELL_STATE_DIR ?? path("pi_bg_shell_state"),
    ),
    PI_BG_SHELL_ENABLED: defaultOn(env, "PI_BG_SHELL"),
    PI_RECURSE_ENABLED: defaultOn(env, "PI_RECURSE"),
    PI_BG_SHELL_LIVENESS_POLL_INTERVAL: pythonFloat(
      env,
      "PI_BG_SHELL_LIVENESS_POLL_INTERVAL",
      "300",
    ),
    PI_BG_SHELL_LIVENESS_RETRIES: Math.max(
      1,
      pythonInt(env, "PI_BG_SHELL_LIVENESS_RETRIES", "3"),
    ),
    PI_BG_SHELL_LIVENESS_RETRY_INTERVAL: pythonFloat(
      env,
      "PI_BG_SHELL_LIVENESS_RETRY_INTERVAL",
      "1",
    ),
    COMPACT_TIMEOUT: 180,
    PI_SAFETY_ENABLED: defaultOn(env, "PI_SAFETY"),
  };
  return {
    paths,
    displayName: env.CHAT_APP_NAME ?? "Recurse",
    repoUrl: env.CHAT_REPO_URL ?? RECURSE_REPO_URL,
  };
}

export class Config {
  readonly env: Environment;
  readonly paths: StatePaths;
  readonly displayName: string;
  readonly repoUrl: string;
  readonly models: ModelCatalog;
  readonly levels: EffortLadder;
  private credentialRevisionValue = 0;
  private mcpFileStampValue: string | null = null;
  private readonly settingsFiles: ConfigFiles;
  private safetyReviewRevision = 0;

  constructor(options: ConfigOptions = {}) {
    this.env = options.env ?? process.env;
    const now = options.now ?? (() => performance.now());
    const settingsRecheckMs = options.settingsRecheckMs ?? 0;
    const warn: NonNullable<ConfigOptions["warn"]> =
      options.warn ??
      ((event, fields) => console.warn(recordMessage(event, fields)));
    const cwd = resolve(options.cwd ?? process.cwd());
    const resolved = buildPaths(this.env, cwd, options.toolsDir);
    this.paths = resolved.paths;
    this.settingsFiles = new ConfigFiles(settingsRecheckMs, now, (path) => {
      if (path === join(this.paths.CONFIG_DIR, "safety-review-model.json"))
        this.safetyReviewRevision += 1;
    });
    this.displayName = resolved.displayName;
    this.repoUrl = resolved.repoUrl;
    this.models = new ModelCatalog(
      this.settingsFiles,
      this.paths,
      this.env,
      options.authenticatedProviders ?? (() => []),
      options.storedCustomProviders ?? (() => []),
      warn,
    );
    this.levels = new EffortLadder(this.models, this.settingsFiles, this.paths);
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
        join(this.paths.CONFIG_DIR, "safety-review-model.json"),
      ].map((path) => this.settingsFiles.refresh(path)),
    );
  }

  /** Stop background reads and drain writes when the server closes. */
  close(): Promise<void> {
    return this.settingsFiles.close();
  }

  credentialRevision(): number {
    return this.credentialRevisionValue;
  }

  noteCredentialsUpdated(): void {
    this.credentialRevisionValue += 1;
  }

  // Observe MCP file stamp; a change bumps credential revision/config keys
  // so subsequent agent turns refresh config. First observation only records.
  noteMcpFileStamp(stamp: string): void {
    if (this.mcpFileStampValue !== null && this.mcpFileStampValue !== stamp)
      this.credentialRevisionValue += 1;
    this.mcpFileStampValue = stamp;
  }

  agentTempLeaf(key: string): string {
    const instance = this.paths.AGENT_TEMP_INSTANCE_DIR;
    if (
      !this.paths.AGENT_TEMP_USES_SHORT_DEFAULT ||
      Buffer.byteLength(pythonPathJoin(instance, key)) <=
        this.paths.AGENT_TEMP_PATH_MAX_BYTES
    )
      return key;
    const dash = key.indexOf("-");
    const day = dash < 0 ? "" : key.slice(0, dash);
    if (dash < 0 || !/^\p{N}{8}$/u.test(day)) return key;
    const leaf = `${day}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    if (
      Buffer.byteLength(join(instance, leaf)) >
      this.paths.AGENT_TEMP_PATH_MAX_BYTES
    ) {
      throw valueError(
        "default agent temp scope exceeds socket-safe path budget",
      );
    }
    return leaf;
  }

  ensureDir(path: string): string {
    const normalized = pythonPath(path);
    // oxlint-disable-next-line no-restricted-properties -- known: Config directory creation
    fs.mkdirSync(normalized, { recursive: true });
    return normalized;
  }

  /** Reviewer and summary routes follow the provider, never the model. */
  private routePolicy(provider: string, modelId: string): ReviewRoutes {
    const current = route(provider, modelId, "low");
    let reviewer: ModelRoute;
    let fallbacks: ModelRoute[];
    let summary: ModelRoute;
    if (provider === "anthropic") {
      [reviewer, fallbacks] = this.claudeReviewRoutes();
      summary = { ...SONNET_ROUTE };
    } else if (provider === "openai-codex") {
      reviewer = { ...CODEX_LUNA_ROUTE };
      fallbacks = [];
      summary = { ...CODEX_LUNA_ROUTE };
    } else if (provider === "openai") {
      reviewer = route(provider, "gpt-5.6-luna", "low");
      fallbacks = [];
      summary = { ...reviewer };
    } else {
      [reviewer, fallbacks] = this.codexFirstRoute(current);
      summary = current;
    }
    return {
      reviewer: { ...reviewer },
      summary: { ...summary },
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
    const choice = this.safetyReviewModel();
    if (choice === undefined) return "null";
    const pin = choice
      ? route(...this.models.modelParts(choice, false), "low")
      : await this.ladderReviewer();
    const selected = this.pinLadderReviewer(
      this.routePolicy(provider, modelId),
      pin,
    );
    const routeValue = (value: ModelRoute): Dict => ({
      provider: value.provider,
      model: value.model,
      effort: value.effort,
    });
    const reviewer: Dict = routeValue(selected.reviewer);
    if (!choice && selected.reviewer_fallbacks.length)
      reviewer.candidates = selected.reviewer_fallbacks.map(routeValue);
    return pythonJson(
      {
        version: 1,
        active: { provider, model: modelId },
        reviewer_pin: { provider: pin.provider, model: pin.model },
        ...(choice ? { reviewer_explicit: true } : {}),
        reviewer_revision: this.safetyReviewRevision,
        reviewer,
        summary: routeValue(selected.summary),
      },
      true,
      true,
    );
  }

  private codexFirstRoute(current: ModelRoute): [ModelRoute, ModelRoute[]] {
    if (routeKey(current) === routeKey(CODEX_LUNA_ROUTE) || !current.provider)
      return [{ ...CODEX_LUNA_ROUTE }, []];
    return [{ ...CODEX_LUNA_ROUTE }, [{ ...current }]];
  }

  private claudeReviewRoutes(): [ModelRoute, ModelRoute[]] {
    return [{ ...CODEX_LUNA_ROUTE }, [{ ...SONNET_ROUTE }]];
  }

  private async ladderReviewer(): Promise<ModelRoute> {
    const levelOne = this.levels.levelOneModel();
    let model: string;
    if ("model" in levelOne) {
      model = levelOne.model;
    } else {
      const { authed } = levelOne;
      const { getBuiltinModels } =
        await import("@earendil-works/pi-ai/providers/all");
      const native = PI_MODEL_ROUTES.filter(([provider]) =>
        authed.has(provider),
      )
        .flatMap(([provider]) =>
          getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]),
        )
        .find((entry) => validModelScopeKey(`${entry.provider}/${entry.id}`));
      const custom = this.models.firstCustomModel(authed);
      model = native
        ? `${native.provider}/${native.id}`
        : (custom ?? this.models.CHAT_MODEL);
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

  /** Parsed Settings snapshot (undefined when unreadable); never mutate it. */
  private settingsJson(path: string): unknown {
    return this.settingsFiles.json(path);
  }

  /** Days deleted history remains available; applied each maintenance pass. */
  deletedAgentHistoryDays(): number {
    const data = this.settingsJson(this.paths.DELETED_AGENT_HISTORY_FILE);
    const value = isObject(data) ? data.days : undefined;
    return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 36500
      ? value
      : this.paths.AGENT_HISTORY_RETENTION_DAYS;
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

  /** Null selects level 1; undefined preserves an invalid saved choice. */
  safetyReviewModel(): string | null | undefined {
    const path = join(this.paths.CONFIG_DIR, "safety-review-model.json");
    const data = this.settingsJson(path);
    if (data === undefined)
      return this.settingsFiles.text(path) === undefined ? null : undefined;
    if (!isObject(data)) return undefined;
    if (!Object.hasOwn(data, "model") || data.model === null) return null;
    return typeof data.model === "string" && data.model
      ? data.model
      : undefined;
  }

  async safetyReviewModels(signedIn: StoredModelSignIns) {
    const { signedInReviewModels } = await import("./safety_review_models");
    return signedInReviewModels(signedIn, PI_MODEL_ROUTES);
  }

  async setSafetyReviewModel(
    value: unknown,
    storedProviders: () => Promise<StoredModelSignIns>,
  ): Promise<string | null> {
    if (
      value !== null &&
      (typeof value !== "string" ||
        !(await this.safetyReviewModels(await storedProviders())).some(
          (model) => model.id === value,
        ))
    )
      throw valueError("Choose an available safety review model");
    await this.settingsFiles.writeJson(
      join(this.paths.CONFIG_DIR, "safety-review-model.json"),
      { model: value },
    );
    return value as string | null;
  }

  keepPromptCacheWarm(): boolean {
    const data = this.settingsJson(
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
    const data = this.settingsJson(
      join(this.paths.CONFIG_DIR, "idle-compaction.json"),
    );
    return isObject(data) && data.enabled === true;
  }

  idleCompactionMinimumTokens(): number {
    const data = this.settingsJson(
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
      const data = this.settingsJson(this.paths.MAXIMUM_CONTEXT_WINDOW_FILE);
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
    const capacity = this.models.modelContextWindow(modelId);
    return capacity === null
      ? null
      : Math.min(capacity, this.maximumContextWindow());
  }
}

/** Construct settings against an explicit environment and state root. */
export function createConfig(options: ConfigOptions = {}): Config {
  return new Config(options);
}
