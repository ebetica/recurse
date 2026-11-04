// Runs a sidebar script in QuickJS: a fresh engine per run with no host APIs,
// at most RUN_MS of work and 16 MB of memory. The browser's script worker and
// the server's dry run both use it; callers check the sections it returns.
import { EvalFlags, QuickJS } from "quickjs-wasi";

export const RUN_MS = 50;
export const MAX_SCRIPT_BYTES = 16 * 1024;
const MEMORY = 16 * 1024 * 1024;
const MAX_ERROR = 300;

export type ScriptResult =
  | { sections: unknown }
  | { error: string; line: number | null };

/** Run `script`'s default export on `rows`; the error names its line. */
export async function runSidebarScript(
  wasm: WebAssembly.Module,
  script: string,
  rows: unknown[],
  now: number,
): Promise<ScriptResult> {
  let deadline = Infinity;
  const vm = await QuickJS.create({
    wasm,
    memoryLimit: MEMORY,
    interruptHandler: () => performance.now() > deadline,
  });
  try {
    deadline = performance.now() + RUN_MS;
    const loading = vm.evalCode(script, "sidebar.js", EvalFlags.TYPE_MODULE);
    vm.executePendingJobs();
    const loaded = await vm.resolvePromise(loading);
    loading.dispose();
    if ("error" in loaded) throw loaded.error.consume((e) => vm.dump(e));
    const sidebar = loaded.value.consume((exports) =>
      exports.getProp("default"),
    );
    if (vm.typeof(sidebar) !== "function")
      return { error: "The script must export a default function", line: null };
    deadline = performance.now() + RUN_MS;
    const input = vm.hostToHandle(rows);
    const output = vm.callFunction(
      sidebar,
      vm.undefined,
      input,
      vm.newNumber(now),
    );
    return { sections: output.consume((value) => vm.dump(value)) };
  } catch (error) {
    const { name, message, stack } = (error ?? {}) as Error;
    const line = /sidebar\.js:(\d+)/.exec(String(stack))?.[1];
    if (message === "interrupted")
      return { error: `The script ran longer than ${RUN_MS} ms`, line: null };
    const text = `${name || "Error"}: ${message || String(error)}`;
    return {
      error: text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR)}…` : text,
      line: line ? Number(line) : null,
    };
  } finally {
    vm.dispose();
  }
}
