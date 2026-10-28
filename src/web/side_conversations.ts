// Create read-only Durable forks at the parent's current point, off-tree.
// Commit before replying; an optional question is the first operator message.
// Keep at most MAX_SIDES, deleting oldest even if running; refuse during clear.
// Promotion to a subagent only starts its durable job (202) or says why not.
import { jsonDictBody } from "./login";
import { agentMarked } from "./request_auth";
import { HttpError, jsonResponse, type Router } from "./router";

type Rec = Record<string, unknown>;

export const MAX_SIDES = 20;
export const SIDE_QUESTION_MAX_CHARS = 20_000;

export interface SideRoutesDeps {
  requireActionReady(): void;
  load(cid: string): Rec | null;
  all(): Rec[];
  owns(conv: Rec): boolean;
  /** A clear is pending: its rotation would retire a new fork. */
  clearing(cid: string): boolean;
  create(parent: string): Promise<Rec>;
  /** Open the side conversation, which forks its parent. */
  fork(cid: string): Promise<void>;
  reap(cid: string): Promise<unknown>;
  deliver(cid: string, content: string): Promise<string | null>;
  /** Start promoting an idle side conversation; null, or why it cannot. */
  promote(cid: string): Promise<string | null>;
  log(event: string, fields: Rec): void;
}

export function registerSideRoutes(router: Router, deps: SideRoutesDeps) {
  router.post("/api/conversations/{cid}/side", async (ex) => {
    const body = await jsonDictBody(ex);
    deps.requireActionReady();
    const parent = ex.params.cid!;
    const conv = deps.load(parent);
    if (conv === null) throw new HttpError(404);
    if (
      !deps.owns(conv) ||
      typeof conv.side_of === "string" ||
      conv.reap_deferred ||
      deps.clearing(parent)
    )
      throw new HttpError(
        409,
        "this conversation cannot have side conversations",
      );
    const question = body.question ?? "";
    if (typeof question !== "string")
      throw new HttpError(422, "question must be text");
    if ([...question].length > SIDE_QUESTION_MAX_CHARS)
      throw new HttpError(413, "question too long");
    let side: Rec;
    try {
      side = await deps.create(parent);
    } catch (error) {
      throw new HttpError(
        422,
        error instanceof Error ? error.message : "refused",
      );
    }
    const cid = String(side.id);
    try {
      await deps.fork(cid);
    } catch (error) {
      void deps.reap(cid).catch(() => undefined);
      throw new HttpError(
        409,
        error instanceof Error ? error.message : "the fork failed",
      );
    }
    const sides = deps
      .all()
      .filter((row) => row.side_of === parent && !row.reap_deferred)
      .sort((a, b) => Number(a.created ?? 0) - Number(b.created ?? 0));
    for (const old of sides.slice(0, Math.max(0, sides.length - MAX_SIDES)))
      if (old.id !== cid)
        void deps.reap(String(old.id)).catch((error: unknown) =>
          deps.log("side_conversation_cap_reap_failed", {
            cid: old.id,
            error: String(error),
          }),
        );
    const text = question.trim();
    const message = text ? await deps.deliver(cid, text) : null;
    return jsonResponse({ id: cid, message_id: message }, 201);
  });

  router.post("/api/conversations/{cid}/promote", async (ex) => {
    // Invariant: Only the operator grants a side conversation full tools.
    if (agentMarked(ex))
      throw new HttpError(
        403,
        "only the operator can promote a side conversation",
      );
    await jsonDictBody(ex);
    deps.requireActionReady();
    const cid = ex.params.cid!;
    const conv = deps.load(cid);
    if (conv === null) throw new HttpError(404);
    const parent = conv.side_of;
    if (
      typeof parent !== "string" ||
      conv.reap_deferred ||
      deps.load(parent)?.reap_deferred ||
      deps.clearing(parent)
    )
      throw new HttpError(409, "this conversation cannot be promoted");
    const refused = await deps.promote(cid);
    if (refused !== null) throw new HttpError(409, refused);
    return jsonResponse({ id: cid, promoting: true }, 202);
  });
}
