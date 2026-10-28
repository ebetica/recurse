import { RESTART_PARKED_STATUS } from "../../agent-status.js";
import type { Conversation } from "../../types.js";

export function conversationStatusCopy(
  conv: Pick<Conversation, "status" | "restart_parked">,
): string {
  if (conv.status === "interrupted" && conv.restart_parked) {
    return RESTART_PARKED_STATUS;
  }
  if (conv.status === "interrupted") {
    return "interrupted — context kept";
  }
  if (conv.status === "error") {
    return "last turn errored";
  }
  return "";
}
