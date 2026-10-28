// Durable tool environment: paths, safety roots and Settings, not Pi processes.
// Preparation is async. Preserve agent PATH; RECURSE_BUN names internal Bun.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";
import { piAgentDir, piRuntimeEnvironment } from "../local_roots";
import type { Roots } from "../local_roots";
import { resolvedDirectory } from "./extensions";

export interface LaunchEnvInputs {
  config: Config;
  /** workdir_git.git_env(): a fresh scrubbed copy of the process env. */
  gitEnv: () => Record<string, string>;
  roots: Roots;
  preparePiAgentDir: (roots: Roots) => Promise<void>;
  checkoutRoot: string;
}

export interface BuildEnvOptions {
  cid?: string | null;
  safetyOff?: boolean;
  model?: string | null;
  maximumContextWindow?: number | null;
  agentTmpdir?: string | null;
  localTmpdir?: string | null;
  workspaceRoot?: string | null;
  worktreesRoot?: string | null;
  turnContextKey?: string | null;
  runId?: string | null;
  workdir?: string | null;
}

const TMP_NAMES = [
  "RECURSE_AGENT_TMPDIR",
  "RECURSE_AGENT_ENV_FILE",
  "RECURSE_AGENT_WORKDIR_FILE",
  "TMPDIR",
  "TMP",
  "TEMP",
];
const TURN_NAMES = [
  "RECURSE_RUN_ID",
  "RECURSE_WORKDIR",
  "RECURSE_ATTACHMENT_HELPER",
  "RECURSE_COLLECTION_DIR",
  "RECURSE_BUN",
  "RECURSE_PYTHON",
];

/** The Pi tool environment, including detached-shell subprocesses. */
export async function buildEnv(
  inputs: LaunchEnvInputs,
  o: BuildEnvOptions = {},
): Promise<Record<string, string>> {
  const { config } = inputs;
  const paths = config.paths;
  const env = inputs.gitEnv();
  Object.assign(env, piRuntimeEnvironment(inputs.roots));
  env.CHAT_DATA_DIR = paths.DATA_DIR;
  env.RECURSE_SAFETY_DIR = paths.DATA_DIR;
  env.RECURSE_SRC = inputs.checkoutRoot;
  // Invariant: RECURSE_BUN identifies the server runtime for internal helpers;
  // keep the operator's PATH unchanged so agents use their own Bun.
  const bun = process.execPath;
  delete env.RECURSE_TOOL_CAPTURE_DIR;
  delete env.RECURSE_TOOL_CAPTURE_FD;
  delete env.RECURSE_TOOL_CAPTURE_KEY_FD;
  delete env.RECURSE_GLOBAL_AGENTS_FD;
  delete env.RECURSE_GLOBAL_AGENTS_PATH;
  for (const name of TMP_NAMES) delete env[name];
  if (o.agentTmpdir != null) {
    env.RECURSE_AGENT_TMPDIR = o.agentTmpdir;
    for (const name of ["TMPDIR", "TMP", "TEMP"])
      env[name] = o.localTmpdir ?? o.agentTmpdir;
    env.RECURSE_AGENT_ENV_FILE = join(o.agentTmpdir, "env.sh");
    env.RECURSE_AGENT_WORKDIR_FILE = join(o.agentTmpdir, "workdir.json");
  }
  // Invariant: Fail safe: only an explicit per-conversation choice disables
  // review.
  delete env.PI_SAFETY_OFF;
  if (o.safetyOff) env.PI_SAFETY_OFF = "1";
  delete env.RECURSE_MODEL_POLICY;
  if (o.model != null)
    env.RECURSE_MODEL_POLICY = config.trustedModelPolicy(o.model);
  for (const [name, root] of [
    ["RECURSE_WORKSPACE_ROOT", o.workspaceRoot],
    ["RECURSE_WORKTREES_ROOT", o.worktreesRoot],
  ] as const) {
    delete env[name];
    const resolved = await resolvedDirectory(root);
    if (resolved !== null) env[name] = resolved;
  }
  env.PI_BG_SHELL_STATE_DIR = paths.PI_BG_SHELL_STATE_DIR;
  env.RECURSE_MAX_CONTEXT_WINDOW = String(
    o.maximumContextWindow == null
      ? config.maximumContextWindow()
      : config.validateMaximumContextWindow(o.maximumContextWindow),
  );
  env.RECURSE_INTERRUPT_SOCKET = paths.INTERRUPT_SOCKET;
  env.PI_OFFLINE = "1";
  env.PI_FFF_MULTIGREP = "1";
  delete env.RTK_DISABLED;
  delete env.PI_AUTH_JSON;
  delete env.OPENROUTER_API_KEY;
  const agentDir = await piAgentDir(inputs.roots, inputs.preparePiAgentDir);
  await mkdir(agentDir, { recursive: true });
  env.PI_CODING_AGENT_DIR = agentDir;
  // Invariant: Settings-owned credentials stay in Durable's model layer, not
  // tool env.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.RECURSE_CHANGES_TOKEN;
  delete env.RECURSE_TURN_CONTEXT_KEY;
  if (o.turnContextKey) env.RECURSE_TURN_CONTEXT_KEY = o.turnContextKey;
  for (const name of TURN_NAMES) delete env[name];
  env.RECURSE_BUN = bun;
  if (o.runId != null) env.RECURSE_RUN_ID = o.runId;
  if (o.workdir != null) env.RECURSE_WORKDIR = o.workdir;
  if (o.agentTmpdir != null)
    env.RECURSE_COLLECTION_DIR = join(o.agentTmpdir, "uploads");
  if (o.cid) env.RECURSE_AGENT_ID = o.cid;
  return env;
}
