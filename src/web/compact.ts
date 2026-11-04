// Shared compaction admission for operator and v1 routes; history is retained.
import { pyTruthy } from "../agents/runtime/turn_prep";
import type { ConversationsRoutesDeps } from "./conversations";
import { HttpError } from "./router";

export async function compactConversation(
  deps: Pick<ConversationsRoutesDeps, "store" | "durable" | "compaction">,
  cid: string,
): Promise<unknown> {
  const conv = deps.store.load(cid);
  if (!pyTruthy(conv)) throw new HttpError(404, "conversation not found");
  const result = deps.durable?.owns(conv)
    ? await deps.durable.compact(cid)
    : await deps.compaction.requestCompact(cid);
  if (result == null) throw new HttpError(404, "conversation not found");
  return result;
}
