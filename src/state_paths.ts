// Resolve instance storage from explicit environment and working directory.
// Isolated state must agree with the inherited root. Scratch stays outside the
// data root by default, with socket-safe leaves for the short local path.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { valueError } from "./config_files";
import { pyStrip } from "./utils/python-whitespace";

export const AGENT_TEMP_KEY_RE = /^\p{Nd}{8}-[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/u;
export const AGENT_DRAFT_KEY_RE = /^draft-\p{Nd}{8}-[a-f0-9]{32}$/u;

export const RECURSE_REPO_URL = "https://github.com/ebetica/recurse.git";

export type Environment = Readonly<Record<string, string | undefined>>;

export interface StatePaths {
  DATA_DIR: string;
  RECURSE_SERVICE_TOKEN_FILE: string | null;
  RECURSE_SERVICE_PRINCIPALS_FILE: string | null;
  RECURSE_TAILSCALE_LOGIN: string | null;
  REPO_DIR: string;
  ARTIFACTS_DIR: string;
  WORKTREES: string;
  SERVICE_BINDINGS_DIR: string;
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
  CONV_DIR: string;
  EXTERNAL_KEY_DIR: string;
  MSG_DIR: string;
  TOOL_DETAILS_DIR: string;
  SPAWN_OUTCOME_DIR: string;
  INTERRUPT_SOCKET: string;
  TITLE_LOCK_DIR: string;
  MUTE_LOCK_DIR: string;
  AGENT_TEMP_USES_SHORT_DEFAULT: boolean;
  AGENT_TEMP_ROOT: string;
  AGENT_TEMP_INSTANCE_DIR: string;
  AGENT_FILES_DIR: string;
  AGENT_TEMP_PATH_MAX_BYTES: number;
  AGENT_RUNTIME_ROOT: string;
  AGENT_RUNTIME_INSTANCE_DIR: string;
  AGENT_TEMP_DRAFT_TTL: number;
  TRASH_DIR: string;
  AGENT_HISTORY_DIR: string;
  AGENT_HISTORY_EXPIRY_LIMIT: number;
  AGENT_TEMP_TRASH_NAME: string;
  AGENT_TEMP_TRASH_DIR: string;
  AGENT_RUNTIME_TRASH_DIR: string;
  AGENT_STORE_TRASH_DIR: string;
  TRASH_SWEEP_LIMIT: number;
  DELETED_DIR: string;
  DELETED_RETENTION_DAYS: number;
  DELETED_EXPIRY_LIMIT: number;
  TURN_PROMPT_DIR: string;
  HTTP_REQUEST_DECOMPRESSION_ENABLED: boolean;
  HTTP_RESPONSE_COMPRESSION_ENABLED: boolean;
  PI_BG_SHELL_STATE_DIR: string;
  PI_BG_SHELL_ENABLED: boolean;
}

function pythonInt(env: Environment, name: string, fallback: string): number {
  const raw = env[name] ?? fallback;
  const stripped = pyStrip(raw);
  if (!/^[+-]?\d+$/u.test(stripped))
    throw valueError(`invalid literal for int(): ${raw}`);
  const value = Number(stripped);
  if (!Number.isSafeInteger(value))
    throw valueError(`invalid literal for int(): ${raw}`);
  return value;
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
  const value = pyStrip(env[name] ?? "").toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

export function statePaths(
  env: Environment,
  cwd: string,
  explicitToolsDir?: string | null,
): StatePaths {
  const declared = env.RECURSE_ISOLATED_DATA_DIR;
  let dataDir: string;
  if (declared === undefined) {
    const configured = env.CHAT_DATA_DIR;
    dataDir = pythonResolvePath(configured || ".recurse-data", cwd);
  } else {
    if (!pyStrip(declared))
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
  return {
    DATA_DIR: dataDir,
    RECURSE_SERVICE_TOKEN_FILE: tokenPath,
    RECURSE_SERVICE_PRINCIPALS_FILE: principalsPath,
    RECURSE_TAILSCALE_LOGIN: env.RECURSE_TAILSCALE_LOGIN?.trim() || null,
    REPO_DIR: path("repo"),
    ARTIFACTS_DIR: path("artifact_repos"),
    WORKTREES: path("worktrees"),
    SERVICE_BINDINGS_DIR: path("service_bindings"),
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
    CONV_DIR: path("conversations"),
    EXTERNAL_KEY_DIR: path("external_keys"),
    MSG_DIR: path("messages"),
    TOOL_DETAILS_DIR: path("tool_artifacts"),
    SPAWN_OUTCOME_DIR: path("spawn_outcomes"),
    INTERRUPT_SOCKET: `/tmp/recurse-interrupt-${createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}.sock`,
    TITLE_LOCK_DIR: path("title_locks"),
    MUTE_LOCK_DIR: path("mute_locks"),
    AGENT_TEMP_USES_SHORT_DEFAULT: shortDefault,
    AGENT_TEMP_ROOT: tempRoot,
    AGENT_TEMP_INSTANCE_DIR: tempInstance,
    AGENT_FILES_DIR: path("agent_files"),
    AGENT_TEMP_PATH_MAX_BYTES: 65,
    AGENT_RUNTIME_ROOT: runtimeRoot,
    AGENT_RUNTIME_INSTANCE_DIR: runtimeInstance,
    AGENT_TEMP_DRAFT_TTL: agentDraftTtl,
    TRASH_DIR: path("trash"),
    AGENT_HISTORY_DIR: path("history"),
    AGENT_HISTORY_EXPIRY_LIMIT: 4,
    AGENT_TEMP_TRASH_NAME: ".trash",
    AGENT_TEMP_TRASH_DIR: pythonPathJoin(tempInstance, ".trash"),
    AGENT_RUNTIME_TRASH_DIR: pythonPathJoin(runtimeInstance, ".trash"),
    AGENT_STORE_TRASH_DIR: path("agents/.trash"),
    TRASH_SWEEP_LIMIT: trashSweepLimit,
    DELETED_DIR: path("deleted"),
    DELETED_RETENTION_DAYS: deletedRetentionDays,
    DELETED_EXPIRY_LIMIT: deletedExpiryLimit,
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
  };
}

export function agentTempLeaf(paths: StatePaths, key: string): string {
  const instance = paths.AGENT_TEMP_INSTANCE_DIR;
  if (
    !paths.AGENT_TEMP_USES_SHORT_DEFAULT ||
    Buffer.byteLength(pythonPathJoin(instance, key)) <=
      paths.AGENT_TEMP_PATH_MAX_BYTES
  )
    return key;
  const dash = key.indexOf("-");
  const day = dash < 0 ? "" : key.slice(0, dash);
  if (dash < 0 || !/^\p{N}{8}$/u.test(day)) return key;
  const leaf = `${day}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  if (
    Buffer.byteLength(join(instance, leaf)) > paths.AGENT_TEMP_PATH_MAX_BYTES
  ) {
    throw valueError(
      "default agent temp scope exceeds socket-safe path budget",
    );
  }
  return leaf;
}
