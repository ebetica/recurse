// Retry and removal own the queued message request and optimistic echo.
import { backendFor } from "../backends/index.js";
import { state } from "../state.js";
import type { Conversation, Message } from "../types.js";
import { discardOptimisticPending } from "./optimistic-state.js";

let refreshPending: () => Promise<boolean>;
export function configurePendingMessageRefresh(
  refresh: typeof refreshPending,
): void {
  refreshPending = refresh;
}

export function pendingMessageActions(conv: Conversation, m: Message) {
  const cancel = async (e: Event) => {
    const el = (e.currentTarget as HTMLElement).closest<HTMLElement>(".msg");
    if (el) el.style.display = "none";
    const r = await backendFor(conv.id).api(
      `/api/conversations/${conv.id}/messages/${m.id}`,
      {
        method: "DELETE",
      },
    );
    if (r.ok && m.id) discardOptimisticPending(conv.id, m.id);
    if (el && !r.ok) el.style.display = "";
    state.openConvHash = "";
    refreshPending();
  };
  const retry = async () => {
    const r = await backendFor(conv.id).api(
      `/api/conversations/${conv.id}/messages/${m.id}/retry`,
      { method: "POST" },
    );
    state.openConvHash = "";
    refreshPending();
    return r.ok;
  };
  return { cancel, retry };
}
