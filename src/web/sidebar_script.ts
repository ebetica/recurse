// The operator's sidebar script routes (operator-only under /api/sidebar/):
// read the script in use with its saved versions for Settings › Sidebar and
// the sidebar, and undo or reset it. Agents change it with recurse_settings.
// GETs privately revalidate the complete script/default/history snapshot.
import { readFile } from "node:fs/promises";
import {
  DEFAULT_SCRIPT,
  SidebarScriptError,
  type SidebarScript,
} from "../sidebar_script";
import { conditionalJson } from "./caching";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Router } from "./router";

export function registerSidebarScriptRoutes(
  router: Router,
  script: SidebarScript,
): void {
  const state = async () => ({
    script: await script.script(),
    default: await readFile(DEFAULT_SCRIPT, "utf8"),
    history: await script.history(),
  });

  router.get("/api/sidebar/script", async (ex) =>
    conditionalJson(ex.request, await state()),
  );

  router.post("/api/sidebar/script", async (ex) => {
    const { action } = await jsonDictBody(ex);
    try {
      if (action === "undo") await script.undo("operator");
      else if (action === "reset") await script.set(null, "operator");
      else throw new HttpError(422, 'action must be "undo" or "reset"');
    } catch (error) {
      if (error instanceof SidebarScriptError)
        throw new HttpError(409, error.message);
      throw error;
    }
    return jsonResponse(await state());
  });
}
