#!/usr/bin/env bun
// ./recurse prepares setup; src/local.ts supervises HEAD or execs once/prebuilt
// under the data lock. User Bun runs tools. Agent worktrees leave target
// checkouts untouched. Isolation checks precede credentials/state; src/launcher
// owns lifecycle/config.
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { ARTIFACT_PATHS } from "./build_stamp";
import {
  RootError,
  preparePiAgentDir,
  resolveRoots,
  validateIsolatedEnvironment,
  validateIsolatedPath,
  validateLaunchEnvironment,
  type Roots,
} from "./local_roots";
import { buildCurrentGeneration } from "./launcher/build";
import {
  HERE,
  exists,
  isDirectory,
  prepareCodeSource,
  repoUrl,
} from "./launcher/git";
import { acquireSupervisorLock, LOCK_FD_ENV } from "./launcher/lock";
import { Supervisor } from "./launcher/supervisor";
import { execReplacing, logError, say } from "./launcher/system";
import { versionLine } from "./release";
import { pyResolve } from "./workdir_git";

export { HERE };
export const BUN_MIN_VERSION = "1.4.0";

export const PREBUILT_ARTIFACTS = [
  "web/index.html",
  "web/icons.ts",
  "web/dist/app.js",
  "web/dist/app.css",
  "web/dist/katex.css",
  "src/extensions/core/safety/index.ts",
  "src/extensions/core/environment/managed_tools.ts",
  "src/extensions/extra/fff/fff_worker_thread.ts",
  "src/extensions/extra/mcp/mcp.ts",
  "src/extensions/extra/rtk/rtk.ts",

  "src/auth/anthropic_oauth.ts",
  ...ARTIFACT_PATHS,
] as const;

export const USAGE =
  "usage: src/local.ts [-h] [--version] [--once] [--prebuilt] [repo]";
export const HELP = `${USAGE}

Run Recurse locally. See the header of src/local.ts.

positional arguments:
  repo                  git repo the agents develop: a URL or a local
                        directory (default: the recurse repo)

options:
  -h, --help            show this help message and exit
  --version             print the Recurse release and, in a Git checkout,
                        its commit, for example "recurse 0.1.0 (abc1234)"
  --once, --no-supervise
                        single process, no source supervisor
  --prebuilt            serve installed artifacts without installs or
                        builds (a missing target clone is made once);
                        implies --once

commands of ./recurse (run before any setup):
  update                update this checkout in place on the channel it
                        was installed with (install.sh --update); a
                        running supervisor rebuilds and restarts into it
  update --check        print the channel and the installed and available
                        versions; changes nothing

Bun ${BUN_MIN_VERSION} or newer runs the launcher and the server.
`;

/**
 * Minimal .env loader: `KEY=VALUE` lines, `#` comments, optional surrounding
 * quotes. Never overrides a variable already set in the real environment.
 */
export async function loadDotenv(path: string): Promise<void> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return;
  }
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    const key = line.slice(0, at).trim();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^"+|"+$/g, "")
      .replace(/^'+|'+$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** An exit with a message, as Python's sys.exit("..."). */
export class LauncherExit extends Error {
  override name = "SystemExit";
  constructor(
    readonly code: number,
    message = "",
  ) {
    super(message);
  }
}

function expandUser(path: string): string {
  const home = process.env.HOME;
  if (!home || !(path === "~" || path.startsWith("~/"))) return path;
  return home + path.slice(1);
}

// Resolve local directory repo arguments; pass URL-shaped values unchanged.
// Missing paths fail rather than silently falling back.
export async function resolveRepoArg(arg: string): Promise<string> {
  const path = expandUser(arg);
  if (await isDirectory(path)) return realpath(path);
  if (arg.includes(":")) return arg;
  if (await exists(path))
    throw new LauncherExit(1, `error: ${arg} is not a directory`);
  throw new LauncherExit(1, `error: ${arg}: no such file or directory`);
}

/**
 * Default local state: inside a local target (so agent worktrees sit under
 * the target's own CLAUDE.md/AGENTS.md), else under this checkout.
 */
export async function defaultDataDir(
  repo: string | null,
  here: string = HERE,
): Promise<string> {
  if (!repo) return join(here, ".recurse-data");
  const trimmed = repo.replace(/\/+$/, "");
  let base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (base.endsWith(".git")) base = base.slice(0, -4);
  const name = base.replace(/[^\p{L}\p{N}_.-]+/gu, "-") || "repo";
  const root = (await isDirectory(repo)) ? await pyResolve(repo) : here;
  return join(root, `.recurse-data-${name}`);
}

/** Select local state, enforcing an opt-in isolated-launch declaration. */
export async function configureDataDir(repo: string | null): Promise<string> {
  const declared = process.env.RECURSE_ISOLATED_DATA_DIR;
  if (declared === undefined) {
    process.env.CHAT_DATA_DIR ??= await defaultDataDir(repo);
  } else {
    if (!declared.trim())
      throw new Error("RECURSE_ISOLATED_DATA_DIR must not be empty");
    if (!isAbsolute(declared))
      throw new Error("RECURSE_ISOLATED_DATA_DIR must be an absolute path");
    const ambient = process.env.CHAT_DATA_DIR;
    if (
      ambient !== undefined &&
      (await pyResolve(ambient)) !== (await pyResolve(declared))
    )
      throw new Error(
        "CHAT_DATA_DIR conflicts with RECURSE_ISOLATED_DATA_DIR; " +
          "refusing to start an isolated supervisor against inherited state",
      );
    process.env.CHAT_DATA_DIR = declared;
  }
  const dataDir = resolve(process.env.CHAT_DATA_DIR!);
  process.env.CHAT_DATA_DIR = dataDir;
  return dataDir;
}

function listen(host: string, port: number): Promise<number | null> {
  // Spec: SO_REUSEADDR treats TIME_WAIT as free but live listeners as taken.
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(null));
    server.listen({ host, port, exclusive: true }, () => {
      const address = server.address();
      const chosen =
        typeof address === "object" && address !== null ? address.port : null;
      server.close(() => done(chosen));
    });
  });
}

/** `port` if it is free on `host`, else a random free port. */
export async function resolvePort(host: string, port: number): Promise<number> {
  for (const candidate of [port, 0]) {
    const chosen = await listen(host, candidate);
    if (chosen === null) continue;
    if (candidate === 0 && port !== 0)
      say(`port ${port} is in use → using random free port ${chosen}`);
    return chosen;
  }
  return port;
}

/** Resolve the requested port once and carry it across supervisor re-exec. */
export async function resolveListenPort(host: string): Promise<number> {
  const raw = process.env.PORT ?? "8787";
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw new Error(`invalid PORT: ${raw}`);
  const requested = Number(raw);
  // Invariant: Never probe pinned ports with temporary listeners; let the real
  // server bind/report failure.
  const port =
    process.env.PORT !== undefined && requested !== 0
      ? requested
      : await resolvePort(host, requested);
  process.env.PORT = String(port);
  return port;
}

/** Fail closed on missing image artifacts; never repair them at startup. */
export async function validatePrebuiltArtifacts(
  here: string = HERE,
): Promise<void> {
  if (!process.env.RECURSE_HOME?.trim())
    throw new RootError("--prebuilt requires explicit RECURSE_HOME");
  for (const relative of PREBUILT_ARTIFACTS) {
    const path = join(here, relative);
    let file = false;
    try {
      file = (await stat(path)).isFile();
    } catch {
      file = false;
    }
    if (!file) throw new RootError(`missing prebuilt artifact: ${path}`);
  }
}

/** Resolve and prepare the persistent roots, then publish RECURSE_HOME. */
export async function prepareLocalEnvironment(
  prepare: () => Promise<Roots> = async () => {
    const roots = resolveRoots();
    await preparePiAgentDir(roots);
    return roots;
  },
): Promise<Roots> {
  const roots = await prepare();
  delete process.env.RECURSE_CODE_HOME;
  process.env.RECURSE_HOME = roots.state;
  return roots;
}

/** Refuse an older Bun, naming the minimum and executable that was found. */
export function bunGate(
  version: string | undefined = process.versions.bun,
  executable: string = process.execPath,
): void {
  const minimum = BUN_MIN_VERSION.split(".").map(Number);
  const actual = (version ?? "").split(".").map(Number);
  const supported = minimum.every(
    (part, index) => (actual[index] ?? 0) === part,
  )
    ? actual.length >= minimum.length
    : (actual[0] ?? 0) > (minimum[0] ?? 0) ||
      ((actual[0] ?? 0) === (minimum[0] ?? 0) &&
        (actual[1] ?? 0) > (minimum[1] ?? 0)) ||
      ((actual[0] ?? 0) === (minimum[0] ?? 0) &&
        (actual[1] ?? 0) === (minimum[1] ?? 0) &&
        (actual[2] ?? 0) >= (minimum[2] ?? 0));
  if (supported) return;
  throw new RootError(
    `Recurse needs Bun ${BUN_MIN_VERSION} or newer, but ${executable} ` +
      `reports ${version || "no version"}; install Bun from ` +
      "https://bun.sh/",
  );
}

export interface MainDeps {
  validateLaunchEnvironment: typeof validateLaunchEnvironment;
  validateIsolatedEnvironment: typeof validateIsolatedEnvironment;
  validatePrebuiltArtifacts: () => Promise<void>;
  prepareLocalEnvironment: () => Promise<Roots>;
  resolveListenPort: (host: string) => Promise<number>;
  prepareCodeSource: (dataDir: string) => Promise<[string, boolean]>;
  buildCurrentGeneration: (
    codeDir: string,
    options: { managedReady: boolean },
  ) => Promise<boolean>;
  supervise: (host: string, port: number, dataDir: string) => Promise<void>;
  execve: typeof execReplacing;
  bunVersion: string | undefined;
}

/** SIGUSR1's diagnostic line; the supervisor replaces it once it runs. */
let stateLine = (): string => `[launcher] state pid=${process.pid} starting`;

export function mainDeps(): MainDeps {
  return {
    validateLaunchEnvironment,
    validateIsolatedEnvironment,
    validatePrebuiltArtifacts: () => validatePrebuiltArtifacts(),
    prepareLocalEnvironment: () => prepareLocalEnvironment(),
    resolveListenPort,
    prepareCodeSource: (dataDir) => prepareCodeSource(dataDir),
    buildCurrentGeneration: (codeDir, options) =>
      buildCurrentGeneration(codeDir, options),
    async supervise(host, port, dataDir) {
      const supervisor = new Supervisor(host, port, dataDir);
      stateLine = () =>
        `[supervisor] state pid=${process.pid} child=${supervisor.child?.pid ?? "none"} ` +
        `head=${supervisor.watchedSha?.slice(0, 7) ?? "unknown"} ` +
        `pending=${supervisor.pendingReexecSha?.slice(0, 7) ?? "none"}`;
      await supervisor.start();
      await supervisor.run();
    },
    execve: execReplacing,
    bunVersion: process.versions.bun,
  };
}

/** Serve in this process: exec the server, keeping pid and lock descriptor. */
export async function serveOnce(
  host: string,
  port: number,
  prebuilt: boolean,
  deps: MainDeps,
): Promise<void> {
  // Invariant: Setup owns cloning; prebuilt fresh state still needs a clone.
  await deps.prepareCodeSource(process.env.CHAT_DATA_DIR!);
  if (!prebuilt) {
    const managedReady = process.env.RECURSE_MANAGED_BUILD_READY === "1";
    delete process.env.RECURSE_MANAGED_BUILD_READY;
    if (!(await deps.buildCurrentGeneration(HERE, { managedReady })))
      throw new Error("the current source generation could not be built");
  }
  say(`recurse → http://${host}:${port}`);
  say("  state directory configured");
  say("  agents' repository configured");
  if (!process.env.GITHUB_TOKEN && !(await isDirectory(repoUrl())))
    say(
      "  GITHUB_TOKEN unset → setup can only clone public remotes; " +
        "private ones fail fast (rerun setup with a token)",
    );
  process.chdir(HERE);
  const bun = process.execPath;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const lock = Number(env[LOCK_FD_ENV]);
  await deps.execve(
    bun,
    [bun, "src/server.ts", "--host", host, "--port", String(port)],
    env,
    Number.isInteger(lock) && lock > 2 ? [lock] : [],
  );
}

export interface Args {
  repo: string | null;
  once: boolean;
  prebuilt: boolean;
}

/** argparse's grammar: flags anywhere, at most one positional. */
export function parseArgs(argv: readonly string[]): Args | "help" | "version" {
  const args: Args = { repo: null, once: false, prebuilt: false };
  let positional = false;
  for (const arg of argv) {
    if (!positional && (arg === "-h" || arg === "--help")) return "help";
    if (!positional && arg === "--version") return "version";
    if (!positional && (arg === "--once" || arg === "--no-supervise"))
      args.once = true;
    else if (!positional && arg === "--prebuilt") args.prebuilt = true;
    else if (!positional && arg === "--") positional = true;
    else if (!positional && arg.startsWith("-") && arg !== "-")
      throw new LauncherExit(
        2,
        `${USAGE}\nlocal.ts: error: unrecognized arguments: ${arg}`,
      );
    else if (args.repo === null) args.repo = arg;
    else
      throw new LauncherExit(
        2,
        `${USAGE}\nlocal.ts: error: unrecognized arguments: ${arg}`,
      );
  }
  return args;
}

function failWith(error: unknown): never {
  throw new LauncherExit(
    2,
    `[recurse] error: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Launch: validate, pick state, take the lock, then serve or supervise. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: MainDeps = mainDeps(),
): Promise<void> {
  const args = parseArgs(argv);
  if (args === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (args === "version") {
    process.stdout.write(await versionLine());
    return;
  }
  try {
    bunGate(deps.bunVersion);
    // Invariant: Validate isolation before dotenv and again after it can add
    // escaped paths or credentials.
    deps.validateLaunchEnvironment(process.env);
    const envFile = process.env.RECURSE_ENV_FILE;
    if (envFile || !process.env.RECURSE_ISOLATED_ROOT)
      await loadDotenv(envFile || join(HERE, ".env"));
    deps.validateIsolatedEnvironment(process.env);
    if (args.prebuilt) await deps.validatePrebuiltArtifacts();
    await deps.prepareLocalEnvironment();
  } catch (error) {
    failWith(error);
  }
  let repo: string | null = null;
  if (args.repo !== null) {
    try {
      validateIsolatedPath(args.repo, "CHAT_REPO_URL");
      repo = await resolveRepoArg(args.repo);
      // Spec: CLI repo arguments override env/.env.
      process.env.CHAT_REPO_URL = repo;
      deps.validateIsolatedEnvironment(process.env);
    } catch (error) {
      if (error instanceof RootError) failWith(error);
      throw error;
    }
  }
  let dataDir: string;
  try {
    dataDir = await configureDataDir(repo);
    deps.validateIsolatedEnvironment(process.env);
  } catch (error) {
    logError("supervisor_data_dir_refused", error);
    throw new LauncherExit(2);
  }
  const host = process.env.HOST ?? "127.0.0.1";
  const port = await deps.resolveListenPort(host);
  let lock;
  try {
    lock = await acquireSupervisorLock(dataDir);
  } catch (error) {
    logError("supervisor_lock_refused", error);
    throw new LauncherExit(2);
  }
  try {
    if (args.once || args.prebuilt)
      await serveOnce(host, port, args.prebuilt, deps);
    else await deps.supervise(host, port, dataDir);
  } finally {
    lock.close();
  }
}

if (import.meta.main) {
  process.on("SIGUSR1", () => say(stateLine()));
  try {
    await main();
  } catch (error) {
    if (error instanceof LauncherExit) {
      if (error.message) process.stderr.write(`${error.message}\n`);
      process.exit(error.code);
    }
    logError("supervisor_failed", error);
    process.stderr.write(
      `[recurse] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}
