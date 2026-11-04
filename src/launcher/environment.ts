/** Server-safe subprocess environments shared by Settings and the launcher. */
import { isolatedSubprocessEnvironment } from "../local_roots";

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
