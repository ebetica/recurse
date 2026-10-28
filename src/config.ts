// Shared Config: bounded fail-safe atomic Settings; injected auth snapshots.
// Pi alone supplies built-ins; custom providers follow. Unlisted stored IDs
// stay stored and fail turns, never fallback (no refusal before first list).
// Settings/effort reads cache up to 1s; own writes and auth apply immediately.
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const Thinking = {
  OFF: "off",
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  XHIGH: "xhigh",
  MAX: "max",
} as const;
export const THINKING_LEVELS = Object.values(Thinking);
export type Thinking = (typeof Thinking)[keyof typeof Thinking];
export const AGENT_TEMP_KEY_RE = /^\p{Nd}{8}-[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/u;
export const AGENT_DRAFT_KEY_RE = /^draft-\p{Nd}{8}-[a-f0-9]{32}$/u;

export interface ModelRoute {
  provider: string;
  model: string;
  effort: Thinking;
}
export interface ModelPolicy {
  label: string;
  catalog_provider: string;
  conversation_effort: Thinking;
  reviewer: ModelRoute;
  summary: ModelRoute;
  reviewer_fallbacks: ModelRoute[];
  context_window: number | null;
}
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  effort: string;
  context_window?: number;
}
export type Environment = Readonly<Record<string, string | undefined>>;
export interface ConfigOptions {
  readonly env?: Environment;
  readonly cwd?: string;
  readonly toolsDir?: string | null;
  // Logged-in provider prefixes; omission means no providers.
  readonly authenticatedProviders?: () => Iterable<string>;
  // Settings read freshness in ms; 0 reads each time, server uses 1s.
  readonly settingsRecheckMs?: number;
  /** Monotonic milliseconds for that window; defaults to performance.now. */
  readonly now?: () => number;
  readonly storedCustomProviders?: () => Iterable<string>;
}
export interface StatePaths {
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

export const DEFAULT_MAXIMUM_CONTEXT_WINDOW = 400_000;
export const MINIMUM_CONTEXT_WINDOW = 64_000;
export const MAXIMUM_CONTEXT_WINDOW = 1_000_000;
export const EFFORT_MIN_LEVEL = 1;
export const EFFORT_MAX_LEVEL = 5;
export const DEFAULT_EFFORT_LEVEL = 3;
export const EFFORT_LEVELS_VERSION = 1;
export const AVAILABLE_MODELS_VERSION = 1;
export const RECURSE_REPO_URL = "https://github.com/ebetica/recurse.git";

type Dict = Record<string, unknown>;
type Ladder = Record<number, { model: string; reasoning: Thinking }>;
type JsonPropertyPosition = { key: string; valueStart: number };

// JSON.parse gives correct values but JavaScript reorders integer-like object
// keys. Keep source order for provider names.
function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[\t\n\r ]/u.test(text[index]!)) index++;
  return index;
}

function endOfJsonString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index++;
  }
  return text.length;
}

function endOfJsonValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') return endOfJsonString(text, start);
  if (first === "{" || first === "[") {
    const closers = [first === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < text.length && closers.length) {
      const char = text[index]!;
      if (char === '"') {
        index = endOfJsonString(text, index);
        continue;
      }
      if (char === "{" || char === "[") {
        closers.push(char === "{" ? "}" : "]");
        index++;
        continue;
      }
      if (char === "}" || char === "]") {
        if (closers.at(-1) === char) closers.pop();
        index++;
        continue;
      }
      index++;
    }
    return index;
  }
  let index = start;
  while (index < text.length && !/[\t\n\r ,}\]]/u.test(text[index]!)) index++;
  return index;
}

function jsonObjectProperties(
  text: string,
  start: number,
): JsonPropertyPosition[] {
  let index = skipJsonWhitespace(text, start);
  if (text[index] !== "{") return [];
  index++;
  const properties: JsonPropertyPosition[] = [];
  const positions = new Map<string, number>();
  while (index < text.length) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") return properties;
    if (text[index] !== '"') return properties;
    const keyEnd = endOfJsonString(text, index);
    const key = JSON.parse(text.slice(index, keyEnd)) as string;
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ":") return properties;
    const valueStart = skipJsonWhitespace(text, index + 1);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, properties.length);
      properties.push({ key, valueStart });
    } else {
      properties[position] = { key, valueStart };
    }
    index = skipJsonWhitespace(text, endOfJsonValue(text, valueStart));
    if (text[index] === ",") {
      index++;
      continue;
    }
    if (text[index] === "}") return properties;
    return properties;
  }
  return properties;
}

type CatalogInputs = {
  providers: Record<string, ProviderSpec>;
  providerEntries: [string, ProviderSpec][];
  default_raw: string;
  efforts: Record<string, Thinking>;
  /** Pi's listed models per route; null until the server first lists them. */
  pi: Record<string, PiModel[]> | null;
  /** Epoch seconds of the last Settings update from pi.dev, if any. */
  piUpdatedAt: number | null;
  /** Every catalog policy, built lazily once per cache key. */
  policies?: Record<string, ModelPolicy>;
  // Lazily cached catalog options; unlisted CHAT_MODEL appears first.
  options?: ModelOption[];
  /** The catalog's ids, built with `options`. */
  ids?: Set<string>;
  /** Pi's reasoning levels per catalog id, built lazily once per cache key. */
  reasoningLevels?: Map<string, Thinking[]>;
};

export interface PiModel {
  id: string;
  name: string;
  context_window: number;
  // Supported reasoning; absent worker result offers every level.
  reasoning_levels?: Thinking[];
}
interface ProviderModel {
  id: string;
  label?: string;
  context_window?: number;
  effort: Thinking | null;
}
interface ProviderSpec {
  base_url: string;
  env_key: string;
  wire_api: "responses" | "completions";
  models: ProviderModel[];
}
interface CatalogCache {
  key: string;
  value: CatalogInputs;
  checkedAt: number;
}

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
const policy = (
  label: string,
  catalogProvider: string,
  conversationEffort: Thinking,
  reviewer: ModelRoute,
  summary: ModelRoute,
  fallbacks: ModelRoute[] = [],
  contextWindow: number | null = null,
): ModelPolicy => ({
  label,
  catalog_provider: catalogProvider,
  conversation_effort: conversationEffort,
  reviewer: { ...reviewer },
  summary: { ...summary },
  reviewer_fallbacks: fallbacks.map((entry) => ({ ...entry })),
  context_window: contextWindow,
});

// Built-in routes follow Pi's list; custom providers follow them.
export const PI_MODEL_ROUTES: readonly (readonly [string, string])[] = [
  ["anthropic", "Claude"],
  ["openai-codex", "ChatGPT subscription"],
  ["openai", "OpenAI API"],
  ["openrouter", "OpenRouter"],
];
// Schema version; unknown stored lists permit all until relisted.
export const PI_MODEL_LIST_VERSION = 1;

/** Recurse's suggested conversation reasoning for model families. */
const SUGGESTED_EFFORTS: readonly [RegExp, Thinking][] = [
  [/.*sonnet.*5$/iu, "xhigh"],
  [/.*opus.*5$/iu, "medium"],
  [/.*fable.*5-1$/iu, "low"],
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

const MODEL_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
function validModelScopeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x00-\x7f]+$/u.test(value) &&
    MODEL_SCOPE_RE.test(value)
  );
}
function validEnvironmentKey(value: string): boolean {
  const alphanumeric = value.replaceAll("_", "");
  return (
    /^[\p{L}\p{N}]+$/u.test(alphanumeric) &&
    /\p{Lu}/u.test(value) &&
    !/\p{Ll}/u.test(value)
  );
}
function isObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function valueError(message: string): Error {
  const error = new Error(message);
  error.name = "ValueError";
  return error;
}
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
function parseThinking(value: unknown): Thinking {
  if (
    typeof value === "string" &&
    THINKING_LEVELS.includes(value as Thinking)
  ) {
    return value as Thinking;
  }
  throw valueError(`'${String(value)}' is not a valid Thinking`);
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
    candidate = realpathSync(candidate);
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
      candidate = realpathSync(next);
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
function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[^\x00-\x7f]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function pythonJson(value: unknown, sortKeys = false, compact = false): string {
  const encode = (item: unknown): string => {
    if (typeof item === "string") return asciiJsonString(item);
    if (
      item === null ||
      typeof item === "boolean" ||
      typeof item === "number"
    ) {
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map(encode).join(compact ? "," : ", ")}]`;
    }
    if (isObject(item)) {
      const separator = compact ? "," : ", ";
      const colon = compact ? ":" : ": ";
      const entries = Object.entries(item);
      if (sortKeys)
        entries.sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
      return `{${entries
        .map(
          ([key, member]) => `${asciiJsonString(key)}${colon}${encode(member)}`,
        )
        .join(separator)}}`;
    }
    return "null";
  };
  return encode(value);
}
function pythonJsonIndented(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[^\x00-\x7f]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function routeKey(value: ModelRoute): string {
  return `${value.provider}\u0000${value.model}`;
}
function clonePolicy(value: ModelPolicy): ModelPolicy {
  return {
    ...value,
    reviewer: { ...value.reviewer },
    summary: { ...value.summary },
    reviewer_fallbacks: value.reviewer_fallbacks.map((entry) => ({ ...entry })),
  };
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
            return statSync(candidate).isDirectory();
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
  readonly CHAT_MODEL: string;
  readonly CHAT_EFFORT: string;
  private readonly chatEffortOverride: string | undefined;
  private readonly authenticatedProviderSource: () => Iterable<string>;
  private readonly storedCustomProviderSource: () => Iterable<string>;
  private credentialRevisionValue = 0;
  private mcpFileStampValue: string | null = null;
  private catalogCache: CatalogCache | null = null;
  private effortLevelsCache: {
    document: unknown;
    catalog: CatalogInputs;
    providers: string;
    levels: Ladder;
  } | null = null;
  private readonly settingsFiles = new Map<
    string,
    { checkedAt: number; value: unknown }
  >();
  private readonly now: () => number;
  private readonly settingsRecheckMs: number;

  constructor(options: ConfigOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => performance.now());
    this.settingsRecheckMs = options.settingsRecheckMs ?? 0;
    const cwd = resolve(options.cwd ?? process.cwd());
    const resolved = buildPaths(this.env, cwd, options.toolsDir);
    this.paths = resolved.paths;
    this.displayName = resolved.displayName;
    this.repoUrl = resolved.repoUrl;
    this.authenticatedProviderSource =
      options.authenticatedProviders ?? (() => []);
    this.storedCustomProviderSource =
      options.storedCustomProviders ?? (() => []);
    this.CHAT_MODEL = this.canonicalModelId(
      this.env.CHAT_MODEL ?? "anthropic/claude-opus-5-5",
    );
    this.chatEffortOverride = this.env.CHAT_EFFORT;
    this.CHAT_EFFORT = String(this.defaultEffort(this.CHAT_MODEL));
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
    mkdirSync(normalized, { recursive: true });
    return normalized;
  }

  canonicalModelId(model: string): string {
    const prefix = "claude-bridge/";
    return model.startsWith(prefix)
      ? `anthropic/${model.slice(prefix.length)}`
      : model;
  }

  private modelParts(model: string): [string, string] {
    const canonical = this.canonicalModelId(model);
    const slash = canonical.indexOf("/");
    return slash < 0
      ? ["", canonical]
      : [canonical.slice(0, slash), canonical.slice(slash + 1)];
  }

  modelPolicy(model: string): ModelPolicy {
    const canonical = this.canonicalModelId(model);
    const policies = this.policies();
    const known = Object.hasOwn(policies, canonical)
      ? policies[canonical]
      : undefined;
    if (known) return clonePolicy(known);
    const [provider, modelId] = this.modelParts(canonical);
    return this.routePolicy(provider, modelId, canonical, "Custom", "high");
  }

  /** Reviewer and summary routes follow the provider, never the model. */
  private routePolicy(
    provider: string,
    modelId: string,
    label: string,
    catalogProvider: string,
    effort: Thinking,
    contextWindow: number | null = null,
  ): ModelPolicy {
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
      [reviewer, fallbacks] = this.codexFirstRoute(this.lunaRoute(provider));
      summary = this.lunaRoute(provider);
    } else {
      [reviewer, fallbacks] = this.codexFirstRoute(current);
      summary = current;
    }
    return policy(
      label,
      catalogProvider,
      effort,
      reviewer,
      summary,
      fallbacks,
      contextWindow,
    );
  }

  trustedModelPolicy(model: string): string {
    const [provider, modelId] = this.modelParts(model);
    const selected = this.pinLadderReviewer(this.modelPolicy(model));
    const routeValue = (value: ModelRoute): Dict => ({
      provider: value.provider,
      model: value.model,
      effort: value.effort,
    });
    const reviewer: Dict = routeValue(selected.reviewer);
    if (selected.reviewer_fallbacks.length)
      reviewer.candidates = selected.reviewer_fallbacks.map(routeValue);
    return pythonJson(
      {
        version: 1,
        active: { provider, model: modelId },
        reviewer,
        summary: routeValue(selected.summary),
      },
      true,
      true,
    );
  }

  private lunaRoute(provider: string): ModelRoute {
    return route(provider, "gpt-5.6-luna", "low");
  }

  private codexFirstRoute(current: ModelRoute): [ModelRoute, ModelRoute[]] {
    if (routeKey(current) === routeKey(CODEX_LUNA_ROUTE) || !current.provider)
      return [{ ...CODEX_LUNA_ROUTE }, []];
    return [{ ...CODEX_LUNA_ROUTE }, [{ ...current }]];
  }

  private claudeReviewRoutes(): [ModelRoute, ModelRoute[]] {
    return [{ ...CODEX_LUNA_ROUTE }, [{ ...SONNET_ROUTE }]];
  }

  private ladderReviewer(): ModelRoute {
    const [model] = this.resolveEffortLevel(EFFORT_MIN_LEVEL);
    const [provider, modelId] = this.modelParts(model);
    return route(provider, modelId, "low");
  }

  private pinLadderReviewer(value: ModelPolicy): ModelPolicy {
    const reviewer = this.ladderReviewer();
    const seen = new Set([routeKey(reviewer)]);
    const fallbacks: ModelRoute[] = [];
    for (const candidate of [value.reviewer, ...value.reviewer_fallbacks]) {
      const key = routeKey(candidate);
      if (!seen.has(key)) {
        seen.add(key);
        fallbacks.push({ ...candidate });
      }
    }
    return { ...clonePolicy(value), reviewer, reviewer_fallbacks: fallbacks };
  }

  private readDefaultEfforts(): Record<string, Thinking> {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.paths.DEFAULT_EFFORTS_FILE, "utf8"));
    } catch {
      return {};
    }
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

  private catalogStat(path: string): [string, number] | null {
    try {
      const info = statSync(path, { bigint: true });
      return [String(info.mtimeNs), Number(info.size)];
    } catch {
      return null;
    }
  }

  private readProvidersDocument(): [
    Record<string, ProviderSpec>,
    string,
    [string, ProviderSpec][],
  ] {
    let text: string;
    let data: unknown;
    try {
      text = readFileSync(this.paths.MODEL_PROVIDERS_FILE, "utf8");
      data = JSON.parse(text);
    } catch {
      return [{}, "", []];
    }
    if (!isObject(data)) return [{}, "", []];
    const defaultRaw = typeof data.default === "string" ? data.default : "";
    const providers: Record<string, ProviderSpec> = {};
    const providerEntries: [string, ProviderSpec][] = [];
    if (!isObject(data.providers))
      return [providers, defaultRaw, providerEntries];
    const providerProperty = jsonObjectProperties(text, 0).find(
      ({ key }) => key === "providers",
    );
    const providerNames =
      providerProperty === undefined
        ? Object.keys(data.providers)
        : jsonObjectProperties(text, providerProperty.valueStart).map(
            ({ key }) => key,
          );
    for (const name of providerNames) {
      if (!name || !Object.hasOwn(data.providers, name)) continue;
      const rawProvider = data.providers[name];
      if (
        !name ||
        !validModelScopeKey(name) ||
        name.startsWith("_") ||
        !isObject(rawProvider)
      )
        continue;
      const baseUrl = rawProvider.base_url;
      const envKey = rawProvider.env_key;
      const wireApi = rawProvider.wire_api;
      if (
        typeof baseUrl !== "string" ||
        !/^https?:\/\//u.test(baseUrl) ||
        typeof envKey !== "string" ||
        !validEnvironmentKey(envKey) ||
        (wireApi !== "responses" && wireApi !== "completions") ||
        !Array.isArray(rawProvider.models)
      )
        continue;
      const models: ProviderModel[] = [];
      for (const rawModel of rawProvider.models) {
        if (!isObject(rawModel)) continue;
        const modelId = rawModel.id;
        if (
          typeof modelId !== "string" ||
          !modelId ||
          !validModelScopeKey(`${name}/${modelId}`)
        )
          continue;
        const entry: ProviderModel = { id: modelId, effort: null };
        if (typeof rawModel.label === "string" && rawModel.label)
          entry.label = rawModel.label;
        if (
          typeof rawModel.context_window === "number" &&
          Number.isInteger(rawModel.context_window) &&
          rawModel.context_window > 0
        )
          entry.context_window = rawModel.context_window;
        if (rawModel.effort !== undefined && rawModel.effort !== null) {
          try {
            entry.effort = parseThinking(rawModel.effort);
          } catch {
            entry.effort = null;
          }
        }
        models.push(entry);
      }
      if (models.length) {
        const provider: ProviderSpec = {
          base_url: baseUrl,
          env_key: envKey,
          wire_api: wireApi,
          models,
        };
        providers[name] = provider;
        providerEntries.push([name, provider]);
      }
    }
    return [providers, defaultRaw, providerEntries];
  }

  private catalogInputs(): CatalogInputs {
    const now = this.now();
    const cached = this.catalogCache;
    if (cached !== null && now - cached.checkedAt < this.settingsRecheckMs)
      return cached.value;
    const providersStat = this.catalogStat(this.paths.MODEL_PROVIDERS_FILE);
    const effortsStat = this.catalogStat(this.paths.DEFAULT_EFFORTS_FILE);
    const piStat = this.catalogStat(this.paths.PI_MODEL_LIST_FILE);
    const key = JSON.stringify([providersStat, effortsStat, piStat]);
    if (cached?.key === key) {
      cached.checkedAt = now;
      return cached.value;
    }
    const [providers, defaultRaw, providerEntries] =
      this.readProvidersDocument();
    const value = {
      providers,
      providerEntries,
      default_raw: defaultRaw,
      efforts: this.readDefaultEfforts(),
      ...(piStat === null
        ? { pi: null, piUpdatedAt: null }
        : this.readPiModelList()),
    };
    this.catalogCache = { key, value, checkedAt: now };
    return value;
  }

  /** Forget every cached Settings read: the next read checks the files. */
  private dropCatalogCache(): void {
    this.catalogCache = null;
    this.settingsFiles.clear();
  }

  /** A Settings file's parsed JSON (undefined when unreadable), read again
   * at most once per settingsRecheckMs. Callers must not mutate it. */
  private settingsJson(path: string): unknown {
    const now = this.now();
    const cached = this.settingsFiles.get(path);
    if (cached !== undefined && now - cached.checkedAt < this.settingsRecheckMs)
      return cached.value;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      value = undefined;
    }
    this.settingsFiles.set(path, { checkedAt: now, value });
    return value;
  }

  /** The stored Pi model list per route (unreadable reads as not listed) and
   * when Settings last updated Pi's catalogs from pi.dev, if ever. */
  private readPiModelList(): Pick<CatalogInputs, "pi" | "piUpdatedAt"> {
    const none = { pi: null, piUpdatedAt: null };
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.paths.PI_MODEL_LIST_FILE, "utf8"));
    } catch {
      return none;
    }
    if (
      !isObject(data) ||
      data.version !== PI_MODEL_LIST_VERSION ||
      !Array.isArray(data.models)
    )
      return none;
    const updatedAt = data.updated_at;
    try {
      return {
        pi: this.checkPiModels(data.models),
        piUpdatedAt:
          typeof updatedAt === "number" && Number.isFinite(updatedAt)
            ? updatedAt
            : null,
      };
    } catch {
      return none;
    }
  }

  private checkPiModels(entries: unknown[]): Record<string, PiModel[]> {
    const routes = new Set(PI_MODEL_ROUTES.map(([provider]) => provider));
    const out: Record<string, PiModel[]> = Object.create(null);
    for (const entry of entries) {
      if (
        !isObject(entry) ||
        typeof entry.provider !== "string" ||
        !routes.has(entry.provider) ||
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

  /** Replace the stored Pi model list; returns how many models it holds. */
  setPiModelList(entries: unknown, updatedAt?: number): number {
    if (!Array.isArray(entries)) throw valueError("invalid Pi model list");
    const listed = this.checkPiModels(entries);
    const models = PI_MODEL_ROUTES.flatMap(([provider]) =>
      (listed[provider] ?? []).map((model) => ({ provider, ...model })),
    );
    // Invariant: A plain relist keeps the time of the last update from pi.dev.
    const updated = updatedAt ?? this.catalogInputs().piUpdatedAt;
    this.writePrivateJson(
      this.paths.PI_MODEL_LIST_FILE,
      {
        version: PI_MODEL_LIST_VERSION,
        ...(updated === null ? {} : { updated_at: updated }),
        models,
      },
      false,
    );
    this.dropCatalogCache();
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
      : `Model ${canonical} is not in Pi's model list. Choose another model for level ${level} in Settings > Effort ladder.`;
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

  upsertCustomProvider(name: string, spec: Dict): boolean {
    if (!name || name.startsWith("_") || !validModelScopeKey(name))
      throw valueError(`invalid custom provider name: '${name}'`);
    if (!isObject(spec))
      throw valueError("custom provider spec must be an object");
    const baseUrl = spec.base_url;
    const envKey = spec.env_key;
    const wireApi = spec.wire_api;
    const rawModels = spec.models;
    if (
      typeof baseUrl !== "string" ||
      !/^https?:\/\//u.test(baseUrl) ||
      typeof envKey !== "string" ||
      !validEnvironmentKey(envKey) ||
      (wireApi !== "responses" && wireApi !== "completions") ||
      !Array.isArray(rawModels) ||
      !rawModels.length
    ) {
      throw valueError(`invalid custom provider spec for '${name}'`);
    }
    const models: Dict[] = [];
    for (const model of rawModels) {
      if (!isObject(model))
        throw valueError(`invalid custom provider spec for '${name}'`);
      if (typeof model.id !== "string" || !model.id)
        throw valueError(`invalid custom provider spec for '${name}'`);
      const entry: Dict = { id: model.id };
      if (typeof model.label === "string" && model.label)
        entry.label = model.label;
      if (
        typeof model.context_window === "number" &&
        Number.isInteger(model.context_window) &&
        model.context_window > 0
      )
        entry.context_window = model.context_window;
      if (model.effort !== undefined && model.effort !== null) {
        try {
          entry.effort = parseThinking(model.effort);
        } catch {
          throw valueError(`invalid custom provider spec for '${name}'`);
        }
      }
      models.push(entry);
    }
    const path = this.paths.MODEL_PROVIDERS_FILE;
    let document: Dict;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(parsed)) throw new Error("invalid");
      document = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") document = {};
      else throw new Error(`cannot seed '${name}': ${path} is invalid`);
    }
    let providers = document.providers;
    if (providers === undefined || providers === null) {
      providers = {};
      document.providers = providers;
    }
    if (!isObject(providers))
      throw new Error(`cannot seed '${name}': ${path} is invalid`);
    if (Object.hasOwn(providers, name)) return false;
    providers[name] = {
      base_url: baseUrl,
      env_key: envKey,
      wire_api: wireApi,
      models,
    };
    let mode = 0o600;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {}
    this.ensureDir(dirname(path));
    const tmp = join(
      dirname(path),
      `.${path.slice(dirname(path).length + 1)}.${process.pid}.tmp`,
    );
    try {
      writeFileSync(tmp, `${pythonJsonIndented(document)}\n`);
      chmodSync(tmp, mode);
      renameSync(tmp, path);
    } finally {
      try {
        rmSync(tmp);
      } catch {}
    }
    this.dropCatalogCache();
    return true;
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
    for (const [provider, label] of PI_MODEL_ROUTES)
      for (const model of inputs.pi?.[provider] ?? []) {
        const id = `${provider}/${model.id}`;
        out[id] = this.routePolicy(
          provider,
          model.id,
          model.name,
          label,
          patternEffort(id) ?? "high",
          model.context_window,
        );
      }
    for (const [name, provider] of inputs.providerEntries)
      for (const model of provider.models) {
        const id = `${name}/${model.id}`;
        if (Object.hasOwn(out, id)) continue;
        out[id] = this.routePolicy(
          name,
          model.id,
          model.label || model.id,
          name,
          model.effort ?? "high",
          model.context_window ?? null,
        );
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
    const model = this.CHAT_MODEL;
    if (!Object.hasOwn(policies, model))
      options.unshift({
        id: model,
        label: model,
        provider: "Custom",
        effort: effort(model, undefined),
      });
    inputs.options = options;
    inputs.ids = new Set(options.map((option) => option.id));
    return { options, ids: inputs.ids };
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
      for (const [provider] of PI_MODEL_ROUTES)
        for (const entry of inputs.pi?.[provider] ?? [])
          if (entry.reasoning_levels)
            levels.set(`${provider}/${entry.id}`, entry.reasoning_levels);
      inputs.reasoningLevels = levels;
    }
    const levels = inputs.reasoningLevels.get(this.canonicalModelId(model));
    return levels ? [...levels] : null;
  }

  defaultChatModel(): string {
    const want = this.customDefaultModel() || this.CHAT_MODEL;
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

  setDeletedAgentHistoryDays(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 36500
    )
      throw valueError(
        "deleted agents' history must be kept for between 1 and 36500 days",
      );
    this.writePrivateJson(this.paths.DELETED_AGENT_HISTORY_FILE, {
      days: value,
    });
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

  setMaximumContextWindow(value: unknown): number {
    const checked = this.validateMaximumContextWindow(value);
    this.writePrivateJson(this.paths.MAXIMUM_CONTEXT_WINDOW_FILE, {
      maximum_context_window: checked,
    });
    return checked;
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

  setDefaultEfforts(value: unknown): Record<string, string> {
    const resolved = this.validateDefaultEfforts(value);
    const sorted = Object.fromEntries(
      Object.keys(resolved)
        .sort()
        .map((model) => [model, resolved[model]]),
    );
    this.writePrivateJson(this.paths.DEFAULT_EFFORTS_FILE, sorted, false);
    this.dropCatalogCache();
    return this.defaultEfforts();
  }

  modelContextWindow(modelId: string): number | null {
    return this.modelPolicy(modelId).context_window;
  }

  contextBarWindow(modelId: string): number | null {
    const capacity = this.modelContextWindow(modelId);
    return capacity === null
      ? null
      : Math.min(capacity, this.maximumContextWindow());
  }

  providerOf(modelId: string): string {
    const slash = this.canonicalModelId(modelId).indexOf("/");
    return slash < 0 ? "" : this.canonicalModelId(modelId).slice(0, slash);
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
    let authed: Set<string>;
    try {
      authed = new Set(this.authenticatedProviderSource());
    } catch {
      return new Set();
    }
    for (const provider of this.configuredCustomProviders())
      authed.add(provider);
    return authed;
  }

  authedChatModels(): ModelOption[] {
    const authed = this.authedModelProviders();
    return this.chatModels().filter((option) =>
      authed.has(this.providerOf(option.id)),
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

  private defaultLadder(authed: Set<string>): Ladder {
    const anthro: [string, Thinking][] = [
      ["anthropic/claude-haiku-5-5", "high"],
      ["anthropic/claude-sonnet-5-5", "medium"],
      ["anthropic/claude-opus-5-5", "medium"],
      ["anthropic/claude-opus-5-5", "high"],
      ["anthropic/claude-fable-5-1", "medium"],
    ];
    const codex: [string, Thinking][] = [
      ["openai-codex/gpt-5.6-luna", "xhigh"],
      ["openai-codex/gpt-6-luna", "max"],
      ["openai-codex/gpt-6.1-sol", "medium"],
      ["openai-codex/gpt-6.1-sol", "xhigh"],
      ["openai-codex/gpt-6-astra", "medium"],
    ];
    const mixed: [string, Thinking][] = [
      ["openai-codex/gpt-5.6-luna", "xhigh"],
      ["openai-codex/gpt-6.1-sol", "low"],
      ["openai-codex/gpt-6.1-sol", "high"],
      ["anthropic/claude-opus-5-5", "high"],
      ["anthropic/claude-fable-5-1", "medium"],
    ];
    let entries: [string, Thinking][];
    if (authed.has("anthropic") && authed.has("openai-codex")) entries = mixed;
    else if (authed.has("anthropic")) entries = anthro;
    else if (authed.has("openai-codex")) entries = codex;
    else {
      let catalog: string[];
      try {
        catalog = this.chatModels()
          .filter((option) => authed.has(this.providerOf(option.id)))
          .map((option) => option.id);
      } catch {
        catalog = [];
      }
      const best = catalog[0] ?? this.CHAT_MODEL;
      entries = [
        [best, "low"],
        [best, "medium"],
        [best, "high"],
        [best, "max"],
        [best, "xhigh"],
      ];
    }
    return Object.fromEntries(
      entries.map(([model, reasoning], index) => [
        index + 1,
        { model, reasoning },
      ]),
    );
  }

  /** Listed models, or null before the server first lists Pi's models. */
  private catalogModelIds(): Set<string> | null {
    if (this.catalogInputs().pi === null) return null;
    return this.catalogOptions().ids;
  }

  private readEffortLevelsDoc(): Dict {
    const data = this.settingsJson(this.paths.EFFORT_LEVELS_FILE);
    return isObject(data) ? data : {};
  }

  effortLevels(): Record<number, { model: string; reasoning: string }> {
    return Object.fromEntries(
      Object.entries(this.resolvedEffortLevels()).map(([level, entry]) => [
        level,
        { ...entry },
      ]),
    );
  }

  private resolvedEffortLevels(): Ladder {
    const raw = this.settingsJson(this.paths.EFFORT_LEVELS_FILE);
    const catalog = this.catalogInputs();
    let authed: Set<string>;
    try {
      authed = this.authedModelProviders();
    } catch {
      authed = new Set();
    }
    const providers = [...authed].sort().join("\0");
    const cached = this.effortLevelsCache;
    if (
      cached &&
      cached.document === raw &&
      cached.catalog === catalog &&
      cached.providers === providers
    )
      return cached.levels;
    const defaults = this.defaultLadder(authed);
    const document = isObject(raw) ? raw : {};
    const rawLevels = isObject(document.levels) ? document.levels : {};
    const resolved: Ladder = {};
    for (let level = EFFORT_MIN_LEVEL; level <= EFFORT_MAX_LEVEL; level += 1) {
      const defaultEntry = defaults[level]!;
      let model = defaultEntry.model;
      let reasoning = defaultEntry.reasoning;
      const entry = rawLevels[String(level)];
      if (isObject(entry)) {
        let candidate = entry.model;
        if (typeof candidate === "string")
          candidate = this.canonicalModelId(candidate);
        // Invariant: A stored id Pi no longer lists stays as stored: its turns
        // fail with unlistedModelSentence rather than quietly running another
        // model.
        if (typeof candidate === "string" && validModelScopeKey(candidate))
          model = candidate;
        try {
          reasoning = parseThinking(entry.reasoning ?? reasoning);
        } catch {
          reasoning = defaultEntry.reasoning;
        }
      }
      resolved[level] = { model, reasoning };
    }
    this.effortLevelsCache = {
      document: raw,
      catalog,
      providers,
      levels: resolved,
    };
    return resolved;
  }

  defaultEffortLevel(): number {
    const value = this.readEffortLevelsDoc().default_level;
    return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 5
      ? value
      : DEFAULT_EFFORT_LEVEL;
  }

  resolveEffortLevel(level: unknown): [string, string] {
    if (
      typeof level !== "number" ||
      !Number.isInteger(level) ||
      level < 1 ||
      level > 5
    ) {
      throw valueError(
        `effort level must be 1-5, got ${this.pythonRepr(level)}`,
      );
    }
    const resolved = this.resolvedEffortLevels()[level]!;
    return [resolved.model, resolved.reasoning];
  }

  private pythonRepr(value: unknown): string {
    if (typeof value === "string") return `'${value}'`;
    if (value === undefined || value === null) return "None";
    if (value === true) return "True";
    if (value === false) return "False";
    return String(value);
  }

  private thinkingOrNone(value: unknown): Thinking | null {
    if (typeof value !== "string") return null;
    try {
      return parseThinking(value);
    } catch {
      return null;
    }
  }

  private firstLadderLevel(
    levels: Record<number, { model: string; reasoning: string }>,
    match: (entry: { model: string; reasoning: string }) => boolean,
  ): number | null {
    for (let level = EFFORT_MIN_LEVEL; level <= EFFORT_MAX_LEVEL; level += 1)
      if (match(levels[level]!)) return level;
    return null;
  }

  ladderHome(
    model: unknown,
    reasoning: unknown = null,
  ): [number, string, string] | null {
    if (typeof model !== "string") return null;
    const canonical = this.canonicalModelId(model);
    const level = this.nearestEffortLevel(canonical, reasoning);
    const [resolvedModel, resolvedReasoning] = this.resolveEffortLevel(level);
    return resolvedModel === canonical
      ? [level, resolvedModel, resolvedReasoning]
      : null;
  }

  nearestEffortLevel(model: unknown = null, reasoning: unknown = null): number {
    const levels = this.effortLevels();
    const want = this.thinkingOrNone(reasoning);
    if (typeof model === "string") {
      const canonical = this.canonicalModelId(model);
      if (want !== null) {
        const match = this.firstLadderLevel(
          levels,
          (entry) => entry.model === canonical && entry.reasoning === want,
        );
        if (match !== null) return match;
      }
      const exact = this.firstLadderLevel(
        levels,
        (entry) => entry.model === canonical,
      );
      if (exact !== null) return exact;
      if (want !== null) {
        const provider = this.providerOf(canonical);
        const match = this.firstLadderLevel(
          levels,
          (entry) =>
            this.providerOf(entry.model) === provider &&
            entry.reasoning === want,
        );
        if (match !== null) return match;
      }
    } else if (want !== null) {
      const match = this.firstLadderLevel(
        levels,
        (entry) => entry.reasoning === want,
      );
      if (match !== null) return match;
    }
    return this.defaultEffortLevel();
  }

  validateEffortLevels(value: unknown): Dict {
    if (!isObject(value))
      throw valueError(
        "effort levels must map levels 1-5 to {model, reasoning}",
      );
    if (!isObject(value.levels))
      throw valueError("effort levels require a 'levels' map for levels 1-5");
    const ids = this.catalogModelIds();
    const stored = this.effortLevels();
    const levels: Record<string, { model: string; reasoning: string }> = {};
    for (let level = EFFORT_MIN_LEVEL; level <= EFFORT_MAX_LEVEL; level += 1) {
      const entry = value.levels[String(level)];
      if (!isObject(entry))
        throw valueError(`effort level ${level} needs {model, reasoning}`);
      const model =
        typeof entry.model === "string"
          ? this.canonicalModelId(entry.model)
          : entry.model;
      if (
        typeof model !== "string" ||
        !validModelScopeKey(model) ||
        (ids !== null && !ids.has(model) && stored[level]!.model !== model)
      )
        throw valueError(
          `unsupported model for effort level ${level}: ${this.pythonRepr(model)}`,
        );
      let reasoning: Thinking;
      try {
        reasoning = parseThinking(entry.reasoning);
      } catch {
        throw valueError(
          `unsupported reasoning for effort level ${level}: ${this.pythonRepr(entry.reasoning)}`,
        );
      }
      levels[String(level)] = { model, reasoning };
    }
    const defaultLevel =
      value.default_level === undefined
        ? DEFAULT_EFFORT_LEVEL
        : value.default_level;
    if (
      typeof defaultLevel !== "number" ||
      !Number.isInteger(defaultLevel) ||
      defaultLevel < 1 ||
      defaultLevel > 5
    )
      throw valueError("default_level must be 1-5");
    return {
      version: EFFORT_LEVELS_VERSION,
      default_level: defaultLevel,
      levels,
    };
  }

  setEffortLevels(value: unknown): Dict {
    const resolved = this.validateEffortLevels(value);
    this.writePrivateJson(
      this.paths.EFFORT_LEVELS_FILE,
      this.sortKeysRecursive(resolved),
      false,
    );
    return resolved;
  }

  private sortKeysRecursive(value: unknown): unknown {
    if (Array.isArray(value))
      return value.map((entry) => this.sortKeysRecursive(entry));
    if (!isObject(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, this.sortKeysRecursive(value[key])]),
    );
  }

  availableModelsSnapshot(): Dict {
    let authed: Set<string>;
    try {
      authed = this.authedModelProviders();
    } catch {
      authed = new Set();
    }
    let catalog: ModelOption[];
    try {
      catalog = this.chatModels();
    } catch {
      catalog = [];
    }
    const providers = Object.create(null) as Record<
      string,
      { authed: boolean; models: string[] }
    >;
    for (const option of catalog) {
      const provider = this.providerOf(option.id);
      if (!Object.hasOwn(providers, provider))
        providers[provider] = { authed: authed.has(provider), models: [] };
      providers[provider]!.models.push(option.id);
    }
    return { version: AVAILABLE_MODELS_VERSION, providers };
  }

  writeAvailableModels(): Dict {
    const snapshot = this.availableModelsSnapshot();
    this.writePrivateJson(this.paths.AVAILABLE_MODELS_FILE, snapshot, true);
    return snapshot;
  }

  private readTurnMarks(): Record<string, { model: string; reason: string }> {
    let value: unknown;
    try {
      value = JSON.parse(
        readFileSync(this.paths.AVAILABLE_MODELS_FILE, "utf8"),
      );
    } catch {
      return {};
    }
    if (!isObject(value) || !isObject(value.turn_marks)) return {};
    const out: Record<string, { model: string; reason: string }> = {};
    for (const [level, mark] of Object.entries(value.turn_marks)) {
      if (!/^[1-5]$/u.test(level) || !isObject(mark)) continue;
      if (typeof mark.model === "string" && typeof mark.reason === "string")
        out[level] = {
          model: this.canonicalModelId(mark.model),
          reason: mark.reason,
        };
    }
    return out;
  }

  private writeTurnMarks(
    marks: Record<string, { model: string; reason: string }>,
  ): void {
    this.writePrivateJson(
      this.paths.AVAILABLE_MODELS_FILE,
      { ...this.availableModelsSnapshot(), turn_marks: marks },
      true,
    );
  }

  noteLevelTurnFailure(level: unknown, reason: unknown): void {
    if (
      typeof level !== "number" ||
      !Number.isInteger(level) ||
      level < 1 ||
      level > 5 ||
      typeof reason !== "string" ||
      !reason
    )
      return;
    const marks = this.readTurnMarks();
    marks[String(level)] = {
      model: this.effortLevels()[level]!.model,
      reason: Array.from(reason).slice(0, 300).join(""),
    };
    this.writeTurnMarks(marks);
  }

  noteLevelTurnSuccess(level: unknown): void {
    if (
      typeof level !== "number" ||
      !Number.isInteger(level) ||
      level < 1 ||
      level > 5
    )
      return;
    const marks = this.readTurnMarks();
    if (Object.hasOwn(marks, String(level))) {
      delete marks[String(level)];
      this.writeTurnMarks(marks);
    }
  }

  effortLevelReachability(): Record<
    number,
    { reachable: boolean; model: string; reasoning: string; reason: string }
  > {
    let authed: Set<string>;
    try {
      authed = this.authedModelProviders();
    } catch {
      authed = new Set();
    }
    const ids = this.catalogModelIds();
    const marks = this.readTurnMarks();
    const out: Record<
      number,
      { reachable: boolean; model: string; reasoning: string; reason: string }
    > = {};
    for (const [levelKey, entry] of Object.entries(this.effortLevels())) {
      const level = Number(levelKey);
      const model = entry.model;
      let reachable: boolean;
      let reason: string;
      if (ids !== null && !ids.has(model)) {
        reason = `level ${level} model ${model} is not in Pi's model list`;
        reachable = false;
      } else if (!authed.has(this.providerOf(model))) {
        reason = `level ${level} model ${model} needs provider '${this.providerOf(model)}', which is not logged in`;
        reachable = false;
      } else if (marks[String(level)]?.model === model) {
        reason = `level ${level} model ${model} failed on the last turn: ${marks[String(level)]!.reason}`;
        reachable = false;
      } else {
        reason = "";
        reachable = true;
      }
      out[level] = { reachable, model, reasoning: entry.reasoning, reason };
    }
    return out;
  }

  private writePrivateJson(path: string, value: unknown, sort = true): void {
    // Invariant: Any write through this Config applies to its next read. No
    // cached read uses available-models.json (the catalog's output), so writing
    // it keeps the catalog: the server writes it right after listening.
    if (path !== this.paths.AVAILABLE_MODELS_FILE) this.dropCatalogCache();
    this.ensureDir(dirname(path));
    const tmp = join(
      dirname(path),
      `.${path.slice(dirname(path).length + 1)}.${process.pid}.tmp`,
    );
    try {
      const text = pythonJson(value, sort);
      writeFileSync(tmp, text);
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } finally {
      try {
        rmSync(tmp);
      } catch {}
    }
  }
}

/** Construct settings against an explicit environment and state root. */
export function createConfig(options: ConfigOptions = {}): Config {
  return new Config(options);
}

let processConfig: Config | undefined;
function currentConfig(value?: Config): Config {
  return value ?? (processConfig ??= createConfig());
}

export function credentialRevision(config?: Config): number {
  return currentConfig(config).credentialRevision();
}
export function noteCredentialsUpdated(config?: Config): void {
  currentConfig(config).noteCredentialsUpdated();
}
export function agentTempLeaf(key: string, config?: Config): string {
  return currentConfig(config).agentTempLeaf(key);
}
export function ensureDir(path: string, config?: Config): string {
  return currentConfig(config).ensureDir(path);
}
export function canonicalModelId(model: string, config?: Config): string {
  return currentConfig(config).canonicalModelId(model);
}
export function modelPolicy(model: string, config?: Config): ModelPolicy {
  return currentConfig(config).modelPolicy(model);
}
export function trustedModelPolicy(model: string, config?: Config): string {
  return currentConfig(config).trustedModelPolicy(model);
}
export function defaultEfforts(config?: Config): Record<string, string> {
  return currentConfig(config).defaultEfforts();
}
export function suggestedEffort(model: string, config?: Config): Thinking {
  return currentConfig(config).suggestedEffort(model);
}
export function defaultEffort(model: string, config?: Config): Thinking {
  return currentConfig(config).defaultEffort(model);
}
export function customModelProviders(
  config?: Config,
): Record<string, ProviderSpec> {
  return currentConfig(config).customModelProviders();
}
export function upsertCustomProvider(
  name: string,
  spec: Dict,
  config?: Config,
): boolean {
  return currentConfig(config).upsertCustomProvider(name, spec);
}
export function customDefaultModel(config?: Config): string {
  return currentConfig(config).customDefaultModel();
}
export function chatModels(config?: Config): ModelOption[] {
  return currentConfig(config).chatModels();
}
export function defaultChatModel(config?: Config): string {
  return currentConfig(config).defaultChatModel();
}
export function maximumContextWindow(config?: Config): number {
  return currentConfig(config).maximumContextWindow();
}
export function validateMaximumContextWindow(
  value: unknown,
  config?: Config,
): number {
  return currentConfig(config).validateMaximumContextWindow(value);
}
export function setMaximumContextWindow(
  value: unknown,
  config?: Config,
): number {
  return currentConfig(config).setMaximumContextWindow(value);
}
export function validateDefaultEfforts(
  value: unknown,
  config?: Config,
): Record<string, string> {
  return currentConfig(config).validateDefaultEfforts(value);
}
export function setDefaultEfforts(
  value: unknown,
  config?: Config,
): Record<string, string> {
  return currentConfig(config).setDefaultEfforts(value);
}
export function modelContextWindow(
  modelId: string,
  config?: Config,
): number | null {
  return currentConfig(config).modelContextWindow(modelId);
}
export function contextBarWindow(
  modelId: string,
  config?: Config,
): number | null {
  return currentConfig(config).contextBarWindow(modelId);
}
export function providerOf(modelId: string, config?: Config): string {
  return currentConfig(config).providerOf(modelId);
}
export function configuredCustomProviders(config?: Config): Set<string> {
  return currentConfig(config).configuredCustomProviders();
}
export function authedModelProviders(config?: Config): Set<string> {
  return currentConfig(config).authedModelProviders();
}
export function authedChatModels(config?: Config): ModelOption[] {
  return currentConfig(config).authedChatModels();
}
export function chatModel(model?: string | null, config?: Config): ModelOption {
  return currentConfig(config).chatModel(model);
}
export function chatSettings(
  model?: string | null,
  config?: Config,
): [string, string] {
  return currentConfig(config).chatSettings(model);
}
export function effortLevels(
  config?: Config,
): Record<number, { model: string; reasoning: string }> {
  return currentConfig(config).effortLevels();
}
export function defaultEffortLevel(config?: Config): number {
  return currentConfig(config).defaultEffortLevel();
}
export function resolveEffortLevel(
  level: unknown,
  config?: Config,
): [string, string] {
  return currentConfig(config).resolveEffortLevel(level);
}
export function ladderHome(
  model: unknown,
  reasoning?: unknown,
  config?: Config,
): [number, string, string] | null {
  return currentConfig(config).ladderHome(model, reasoning);
}
export function nearestEffortLevel(
  model?: unknown,
  reasoning?: unknown,
  config?: Config,
): number {
  return currentConfig(config).nearestEffortLevel(model, reasoning);
}
export function validateEffortLevels(value: unknown, config?: Config): Dict {
  return currentConfig(config).validateEffortLevels(value);
}
export function setEffortLevels(value: unknown, config?: Config): Dict {
  return currentConfig(config).setEffortLevels(value);
}
export function availableModelsSnapshot(config?: Config): Dict {
  return currentConfig(config).availableModelsSnapshot();
}
export function writeAvailableModels(config?: Config): Dict {
  return currentConfig(config).writeAvailableModels();
}
export function noteLevelTurnFailure(
  level: unknown,
  reason: unknown,
  config?: Config,
): void {
  currentConfig(config).noteLevelTurnFailure(level, reason);
}
export function noteLevelTurnSuccess(level: unknown, config?: Config): void {
  currentConfig(config).noteLevelTurnSuccess(level);
}
export function effortLevelReachability(
  config?: Config,
): Record<
  number,
  { reachable: boolean; model: string; reasoning: string; reason: string }
> {
  return currentConfig(config).effortLevelReachability();
}
