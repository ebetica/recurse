// Sends ordered tag mutations to each owning backend in batches.
// Dialogs collect input; tag-state keeps changes until a newer tree read.
import { backendFor, treeOf } from "../backends/index.js";
import { parseConversationId } from "../backends/conversation-id/index.js";
import { refreshSidebarTags } from "./action-handlers.js";
import { SIDEBAR_CHANGE } from "./events.js";
import { requestUiStatus } from "../ui-events.js";
import { state } from "../state.js";
import type { Action } from "../../src/sidebar_script/index.js";
import { askConfirm, askSnooze, askTag } from "./dialogs.js";
import { drop, pending, type Change } from "./tag-state.js";

const changed = () => window.dispatchEvent(new Event(SIDEBAR_CHANGE));

/** Batch size of POST /api/sidebar/tags (the route's MAX_TAG_IDS). */
const MAX_IDS = 500;

/** Ask, confirm if needed, then apply `action` to `ids`. */
export async function runAction(
  action: Action,
  ids: string[],
  anchor: DOMRect,
  confirm = false,
): Promise<void> {
  if (action.ask === "tag") {
    const name = await askTag(anchor, ids, action.clearAsked === true);
    if (!name) return;
    action = {
      ...action,
      set: action.clearAsked ? action.set : [...action.set, name],
      clear: action.clearAsked ? [...action.clear, name] : action.clear,
    };
  }
  let until = action.until;
  if (until === "ask") until = await askSnooze(anchor);
  if (until === undefined && action.until === "ask") return;
  if (confirm && !(await askConfirm(action.label, ids.length, anchor))) return;
  const now = Date.now() / 1000;
  const set = Object.fromEntries(
    action.set.map((name) => [name, typeof until === "number" ? until : null]),
  );
  const changes = new Map<string, Change>();
  for (const id of ids) {
    // Invariant: A shown archive outranks the last reply, whatever the clocks.
    const at = Math.max(now, (state.nodes[id]?.replied_at ?? 0) + 1);
    const change = { set, clear: action.clear, at };
    changes.set(id, change);
    pending.set(id, [...(pending.get(id) ?? []), change]);
  }
  changed();
  // Invariant: Requests reach the server in the order the operator acted, so
  // a later action is never overwritten by an earlier one still being sent.
  const turn = sending.then(() => send(action, ids, set, changes));
  sending = turn.catch(() => {});
  await turn;
}

let sending: Promise<void> = Promise.resolve();

async function send(
  action: Action,
  ids: string[],
  set: Record<string, number | null>,
  changes: Map<string, Change>,
): Promise<void> {
  let failed = 0;
  const groups = Map.groupBy(ids, (id) => backendFor(id));
  for (const [backend, targets] of groups) {
    for (let i = 0; i < targets.length; i += MAX_IDS) {
      const batch = targets.slice(i, i + MAX_IDS);
      const response = await backend
        .jpost(backend.label ? "/api/v1/agents/tags" : "/api/sidebar/tags", {
          ids: batch.map((id) => parseConversationId(id).cid),
          set,
          clear: action.clear,
        })
        .catch(() => null);
      const body = response?.ok
        ? ((await response.json().catch(() => null)) as {
            missing?: string[];
          } | null)
        : null;
      const missing = new Set(body?.missing ?? []);
      const readsBefore = treeOf(backend).readsStarted;
      for (const id of batch) {
        const change = changes.get(id)!;
        if (body && !missing.has(parseConversationId(id).cid))
          change.readsBefore = readsBefore;
        else {
          drop(id, change);
          if (!missing.has(parseConversationId(id).cid)) failed++;
        }
      }
    }
  }
  if (failed)
    requestUiStatus(
      failed === ids.length
        ? `${action.label} failed; try again`
        : `${action.label} failed for ${failed} of ${ids.length}; try again`,
    );
  changed();
  void refreshSidebarTags();
}
