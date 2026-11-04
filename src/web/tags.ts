// Sidebar tag changes. The operator's sidebar route changes any tag on up to
// MAX_TAG_IDS conversations and is operator-only (request_auth.ts); agents use
// the per-conversation route through tools/subagent.ts, which refuses the
// operator's tags (archived, snoozed, pinned).
import {
  parseTagChange,
  TagRefused,
  type TagChange,
} from "../agents/conversation_tags";
import { requireLocalAgent } from "./backends";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Handler, type Router } from "./router";

export const MAX_TAG_IDS = 500;

export interface TagRoutesDeps {
  requireActionReady(): void;
  /** Apply the change to each id; returns the ids not found. */
  changeTags(
    cids: readonly string[],
    change: TagChange,
    by: string,
    now: number,
  ): Promise<string[]>;
  /** Title of a live local agent, for the agent route's caller check. */
  title(cid: string): string | undefined;
  now(): number;
}

export function registerTagRoutes(router: Router, deps: TagRoutesDeps) {
  const change = async (
    cids: string[],
    set: unknown,
    clear: unknown,
    agent?: string,
  ) => {
    deps.requireActionReady();
    const now = deps.now();
    try {
      const parsed = parseTagChange(set, clear, agent === undefined, now);
      return await deps.changeTags(cids, parsed, agent ?? "operator", now);
    } catch (error) {
      if (error instanceof TagRefused) throw new HttpError(422, error.message);
      throw error;
    }
  };

  const sidebarTags: Handler = async (ex) => {
    const { ids, set, clear } = await jsonDictBody(ex);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > MAX_TAG_IDS ||
      ids.some((id) => typeof id !== "string")
    )
      throw new HttpError(422, `ids must list 1-${MAX_TAG_IDS} conversations`);
    const missing = await change(ids as string[], set, clear);
    return jsonResponse({ missing });
  };
  router.post("/api/sidebar/tags", sidebarTags);

  router.post("/api/conversations/{cid}/tags", async (ex) => {
    const agent = requireLocalAgent(ex, deps);
    const cid = ex.params.cid!;
    const { add = [], remove = [] } = await jsonDictBody(ex);
    if (!Array.isArray(add) || !Array.isArray(remove))
      throw new HttpError(422, "add and remove must be lists of tag names");
    const set = Object.fromEntries(add.map((name) => [name, null]));
    const missing = await change([cid], set, remove, agent);
    if (missing.length) throw new HttpError(404, "conversation not found");
    return jsonResponse({ id: cid });
  });
  return sidebarTags;
}
