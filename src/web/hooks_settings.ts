// Settings → Hooks (operator only; writes run under the storage lease): global
// hook files and the "Run hooks" switch. Also the hooks tool's read-only list
// of the files that run for one live agent; agents manage their own files.
import type { Config } from "../config";
import { HookSettingsError, type Hooks } from "../extensions/extra/hooks";
import { requireOperator } from "./backend_keys";
import { jsonDictBody } from "./request";
import { HttpError, jsonResponse, type Router } from "./router";

const PRIVATE = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

export function registerHooksRoutes(
  router: Router,
  deps: {
    hooks: Hooks;
    config: Config;
    liveIds(): readonly string[];
    mutate<T>(work: () => Promise<T>): Promise<T>;
  },
): void {
  const path = "/api/settings/hooks";
  const state = async () =>
    jsonResponse(
      { enabled: deps.config.runHooks(), files: await deps.hooks.list() },
      200,
      PRIVATE,
    );
  const change = async (work: () => Promise<unknown>) => {
    try {
      await deps.mutate(work);
    } catch (error) {
      if (error instanceof HookSettingsError)
        throw new HttpError(400, error.message);
      throw error;
    }
    return state();
  };
  router.get(path, async (ex) => {
    requireOperator(ex);
    return state();
  });
  router.post(`${path}/file`, async (ex) => {
    requireOperator(ex);
    const { name, source } = await jsonDictBody(ex);
    return change(() => deps.hooks.save(name, source));
  });
  router.post(`${path}/delete`, async (ex) => {
    requireOperator(ex);
    const { name } = await jsonDictBody(ex);
    return change(() => deps.hooks.remove(name));
  });
  router.get("/api/hooks-tool/list", async (ex) => {
    const agent = ex.url.searchParams.get("agent") ?? "";
    if (!deps.liveIds().includes(agent))
      throw new HttpError(404, "No such agent.");
    return jsonResponse(
      {
        enabled: deps.config.runHooks(),
        files: await deps.hooks.listFor(agent),
      },
      200,
      PRIVATE,
    );
  });
  router.post(`${path}/enabled`, async (ex) => {
    requireOperator(ex);
    const { enabled } = await jsonDictBody(ex);
    if (typeof enabled !== "boolean")
      throw new HttpError(400, "Choose whether hooks run.");
    return change(() => deps.config.setRunHooks(enabled));
  });
}
