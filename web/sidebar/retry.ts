// Every sidebar script run goes through runRetryingTimeout: the sandbox's
// budget is wall-clock time, so a busy device or server can time out a quick
// script. The browser's script worker and the server's dry run both use it.
import type { ScriptResult } from "./sandbox.js";

export const RETRY_MS = 500;

/** Run; if it timed out and is still wanted, run once more after RETRY_MS. */
export async function runRetryingTimeout(
  run: () => Promise<ScriptResult>,
  wanted: () => boolean = () => true,
): Promise<ScriptResult> {
  const result = await run();
  if (!("timeout" in result) || !wanted()) return result;
  await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  return wanted() ? run() : result;
}
