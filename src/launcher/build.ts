// Stage frontend builds; two renames publish only a successful current build.
// Failures/source changes keep the last good UI; restart restores killed-swap
// backups. Publish one stamp after RTK/frontend succeed for equal HEAD/dirty.
// Like package.json build:assets, app.css includes theme and powerbar rules.
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { copyFrontendAssets } from "./frontend_assets";
import * as buildStamp from "../build_stamp";
import type { SourceState } from "../build_stamp";
import { isolatedSubprocessEnvironment } from "../local_roots";
import { managedDependencyRoot } from "../local_dependencies";
import { detail, logError, run, say, type RunResult } from "./system";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The subprocess environment without the data-directory lock descriptor. */
export function subprocessEnv(inheritDataLock = false): Record<string, string> {
  const env = isolatedSubprocessEnvironment(process.env);
  if (!inheritDataLock) delete env.RECURSE_DATA_DIR_LOCK_FD;
  return env;
}

/** Environment for checkout entrypoints (ensure-rtk.sh, src/local.ts). */
export function entrypointEnv(inheritDataLock = false): Record<string, string> {
  const env = subprocessEnv(inheritDataLock);
  if (!("RECURSE_ISOLATED_ROOT" in env)) delete env.RECURSE_CODE_HOME;
  return env;
}

/** The Bun a checkout runs on: the Bun running this launcher. */
export async function checkoutBun(_codeDir: string): Promise<string> {
  return process.execPath;
}

/** Recover the previous frontend when a kill orphaned its backup name. */
export async function restoreDistBackup(
  webDir: string,
  dist: string,
): Promise<void> {
  if (await exists(dist)) return;
  let names: string[];
  try {
    names = await readdir(webDir);
  } catch {
    return;
  }
  const backups: [number, string][] = [];
  for (const name of names) {
    if (!name.startsWith(".recurse-dist-backup-")) continue;
    try {
      const info = await stat(join(webDir, name), { bigint: true });
      backups.push([Number(info.mtimeNs), join(webDir, name)]);
    } catch {}
  }
  backups.sort((left, right) => right[0] - left[0]);
  if (backups[0]) await rename(backups[0][1], dist).catch(() => {});
}

/** Atomically replace the live frontend, rolling back on interruption. */
export async function publishStagedFrontend(
  staging: string,
  dist: string,
  backup: string,
): Promise<void> {
  if (await exists(backup)) await rm(backup, { recursive: true, force: true });
  if (await exists(dist)) await rename(dist, backup);
  try {
    await rename(staging, dist);
  } catch (error) {
    if ((await exists(backup)) && !(await exists(dist)))
      await rename(backup, dist);
    throw error;
  }
  await rm(backup, { recursive: true, force: true }).catch(() => {});
}

export interface BuildDeps {
  readonly run: typeof run;
  readonly bun: (codeDir: string) => Promise<string>;
}

const BUILD_DEPS: BuildDeps = { run, bun: checkoutBun };

class CommandFailed extends Error {
  override name = "CalledProcessError";
  constructor(readonly result: RunResult) {
    super(`command failed with return code ${result.returncode}`);
  }
}

async function check(
  deps: BuildDeps,
  argv: string[],
  cwd: string,
): Promise<void> {
  const result = await deps.run(argv, {
    cwd,
    env: subprocessEnv(),
    timeoutSeconds: 300,
  });
  if (result.returncode !== 0) throw new CommandFailed(result);
}

/**
 * Build into staging, then publish only a complete, current frontend.
 * `beforePublish` validates that sources did not change during the build.
 */
export async function buildFrontend(
  codeDir: string,
  options: {
    force?: boolean;
    beforePublish?: () => Promise<boolean>;
    deps?: BuildDeps;
  } = {},
): Promise<boolean> {
  const deps = options.deps ?? BUILD_DEPS;
  const webDir = join(codeDir, "web");
  try {
    if (!(await stat(webDir)).isDirectory()) return true;
  } catch {
    return true;
  }
  const dist = join(webDir, "dist");
  await restoreDistBackup(webDir, dist);
  if (!options.force && buildStamp.matches(codeDir)) return true;
  const bun = await deps.bun(codeDir);
  say(
    `[supervisor] building frontend (${options.force ? "rebuild" : "initial"})…`,
  );
  let staging: string | null = null;
  const backup = join(webDir, `.recurse-dist-backup-${process.pid}`);
  try {
    staging = await mkdtemp(join(webDir, ".recurse-dist-"));
    await check(
      deps,
      (await managedDependencyRoot(codeDir)) === null
        ? [bun, "install", "--frozen-lockfile"]
        : [bun, join(codeDir, "src/launcher/dependencies.ts")],
      codeDir,
    );
    await check(
      deps,
      [
        bun,
        "build",
        "web/app.ts",
        "--splitting",
        "--outdir",
        staging,
        "--target=browser",
        "--minify",
        "--define",
        'process.env.NODE_ENV="production"',
      ],
      codeDir,
    );
    await copyFrontendAssets(codeDir, staging);
    if (options.beforePublish && !(await options.beforePublish())) {
      say(
        "[supervisor] sources changed during frontend build; " +
          "discarding staged output",
      );
      return false;
    }
    await publishStagedFrontend(staging, dist, backup);
    staging = null;
    say("[supervisor] frontend build complete");
    return true;
  } catch (error) {
    logError("supervisor_frontend_build_failed", error);
    const text =
      error instanceof CommandFailed
        ? detail(error.result)
        : (error instanceof Error ? error.message : String(error)).slice(-400);
    say(`[supervisor] frontend build failed (${text}); keeping existing dist`);
    return false;
  } finally {
    if (staging !== null)
      await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GenerationDeps {
  readonly run: typeof run;
  readonly buildFrontend: typeof buildFrontend;
  readonly matches: (root: string) => boolean;
  readonly sourceState: (root: string) => SourceState | null;
  readonly writeStamp: (root: string, expected: SourceState) => boolean;
}

export const GENERATION_DEPS: GenerationDeps = {
  run,
  buildFrontend,
  matches: (root) => buildStamp.matches(root),
  sourceState: (root) => buildStamp.sourceState(root),
  writeStamp: (root, expected) => buildStamp.write(root, expected),
};

function sameState(left: SourceState | null, right: SourceState): boolean {
  return left !== null && left[0] === right[0] && left[1] === right[1];
}

/** Build every checkout-owned artifact and publish one generation stamp. */
export async function buildCurrentGeneration(
  codeDir: string,
  options: { managedReady?: boolean; deps?: GenerationDeps } = {},
): Promise<boolean> {
  const deps = options.deps ?? GENERATION_DEPS;
  if (deps.matches(codeDir)) return true;
  const generation = deps.sourceState(codeDir);
  if (generation === null) {
    say("[supervisor] cannot identify the checkout generation");
    return false;
  }
  if (!options.managedReady) {
    say("[supervisor] checking RTK…");
    let result: RunResult;
    try {
      result = await deps.run(
        [Bun.which("bash") ?? "/bin/bash", "./scripts/ensure-rtk.sh"],
        {
          cwd: codeDir,
          env: entrypointEnv(),
          timeoutSeconds: 900,
        },
      );
    } catch (error) {
      logError("supervisor_managed_build_failed", error);
      return false;
    }
    if (result.returncode !== 0) {
      say(`[supervisor] RTK check failed: ${detail(result)}`);
      return false;
    }
  }
  if (
    !(await deps.buildFrontend(codeDir, {
      force: true,
      beforePublish: async () =>
        sameState(deps.sourceState(codeDir), generation),
    }))
  )
    return false;
  if (!deps.writeStamp(codeDir, generation)) {
    say("[supervisor] could not publish the build stamp");
    return false;
  }
  return true;
}
