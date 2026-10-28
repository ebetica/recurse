// Load patched Pi search on the Worker, without TUI or Harness imports.
// Notifications cannot throw: fallback finders must return/destroy on errors.
// Auxiliary roots avoid watches/eager caches and parent reuse; refresh on
// search and expire when idle. Native work stays off the server thread.
import { getEnvironmentData } from "node:worker_threads";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type FffDefinition = ToolDefinition<
  ToolDefinition["parameters"],
  JsonValue
>;
export type FffResult = Awaited<ReturnType<FffDefinition["execute"]>>;
export type FffToolInfo = Pick<
  FffDefinition,
  "name" | "label" | "description" | "parameters"
>;
export type FffFlags = Record<string, string | boolean>;
type Lifecycle = (event: unknown, context: ExtensionContext) => unknown;
export const FFF_IMPORT_COUNT = "recurse-fff-import-count";

type FffModule = { default: (api: ExtensionAPI) => void };
let fffModule: Promise<FffModule> | undefined;
// Shared Int32Array counter for this thread's imports.
const importCount = getEnvironmentData(FFF_IMPORT_COUNT) as
  | Int32Array
  | undefined;

/** pi-fff's module, imported once per thread; a failed import is retried. */
export function importFff(): Promise<FffModule> {
  if (fffModule) return fffModule;
  if (importCount) Atomics.add(importCount, 0, 1);
  const loading = import(
    import.meta.resolve("@ff-labs/pi-fff/src/index.ts")
  ) as Promise<FffModule>;
  fffModule = loading;
  loading.catch(() => {
    if (fffModule === loading) fffModule = undefined;
  });
  return loading;
}

export async function loadFffTools(cwd: string, flags: FffFlags = {}) {
  const { default: fff } = await importFff();
  const tools = new Map<string, FffDefinition>();
  const lifecycle = new Map<string, Lifecycle>();
  let active: string[] = [];
  const context = {
    cwd,
    ui: {
      notify(message: string) {
        console.warn(message);
      },
    },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  fff({
    getFlag: (name: string) =>
      flags[name] ?? (name === "fff-mode" ? "override" : undefined),
    registerFlag() {},
    registerCommand() {},
    registerTool: (tool: FffDefinition) => {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    on: (name: string, handler: Lifecycle) => {
      lifecycle.set(name, handler);
    },
  } as unknown as ExtensionAPI);
  // Invariant: Register without eager native indexing.
  lifecycle.get("before_agent_start")?.({}, context);
  return {
    definitions: active.map((name) => tools.get(name)!),
    async close() {
      await lifecycle.get("session_shutdown")?.({}, context);
    },
  };
}
