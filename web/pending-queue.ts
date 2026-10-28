// The optimistic/pending queue: just-sent messages render as faded bubbles at
// once, stay pinned while the server echoes them, and retire once their
// committed row arrives (the pure decision lives in pending-message.ts).
import { backendFor } from "./backends/backend.js";
import { html, nothing, type TemplateResult } from "lit";
import { state } from "./state.js";
import {
  RETRY_QUEUED_MESSAGE_LABEL,
  canRemovePendingMessage,
  isFailedPending,
  pendingMessageDismissButton,
  pendingMessageRemoveButton,
  pruneOptimisticEntries,
  removeOptimisticMessageById,
  sendFailureCopy,
  type OptimisticEntry,
} from "./pending-queue/pending-message.js";
import { activityMessageT, userBubble } from "./thread-render.js";
import { loaded, rowThreads } from "./row-thread-state.js";
import { paint } from "./conversation/thread.js";
import { refreshConv } from "./conversation/fetch.js";
import type { Conversation, Message, MessageEntry } from "./types.js";

export function pendingBubble(conv: Conversation, m: Message): TemplateResult {
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
    refreshConv();
  };
  const retry = async () => {
    const r = await backendFor(conv.id).api(
      `/api/conversations/${conv.id}/messages/${m.id}/retry`,
      { method: "POST" },
    );
    state.openConvHash = "";
    refreshConv();
    return r.ok;
  };
  const btn = canRemovePendingMessage(m)
    ? pendingMessageRemoveButton(cancel)
    : nothing;
  const bubble = html`<div class="bubble">${userBubble(m.content)}</div>`;
  const failed = isFailedPending(m);
  // Invariant: Failed sends retain Retry under the same id and Dismiss, never
  // auto-resend. The cancellation × belongs only to queued rows.
  const detail = sendFailureCopy(
    typeof m.error === "string" && m.error.trim() ? m.error.trim() : null,
  );
  const full =
    typeof m.error_detail === "string" && m.error_detail.trim()
      ? m.error_detail.trim()
      : detail;
  const retryBtn = html`<button
    class="btn sm pending-retry"
    type="button"
    title=${RETRY_QUEUED_MESSAGE_LABEL}
    aria-label=${RETRY_QUEUED_MESSAGE_LABEL}
    @click=${retry}
  >
    Retry
  </button>`;
  const failure = html`<div class="pending-failure" role="alert">
    <span class="pending-failure-text" title=${full}>${detail}</span>
    ${retryBtn}${canRemovePendingMessage(m)
      ? pendingMessageDismissButton(cancel)
      : nothing}
  </div>`;
  const activity =
    Boolean(m.from) ||
    ["agent", "platform"].includes(m.origin ?? m.source ?? "");
  if (failed && !activity)
    return html`<div class="msg user pending failed">${bubble}${failure}</div>`;
  if (!activity)
    return html`<div class="msg user pending">${btn}${bubble}</div>`;

  return html`<div class="msg pending agent">
    ${activityMessageT(
      conv,
      { ...m, kind: "user", offset: 0 },
      false,
      false,
      btn,
    )}
    ${failed ? failure : nothing}
  </div>`;
}

type OptMsg = OptimisticEntry;
const optimisticPending: Record<string, OptMsg[]> = {};
let optSeq = 0;
const OPT_TTL_MS = 30000;

export function optPending(cid: string): OptMsg[] {
  return optimisticPending[cid] || [];
}

function discardOptimisticPending(cid: string, id: string): void {
  const kept = removeOptimisticMessageById(optPending(cid), id);
  if (kept.length) optimisticPending[cid] = kept;
  else delete optimisticPending[cid];
}

// A faded queued bubble for a not-yet-echoed send. Current servers return the
// durable inbox id with the enqueue response, so this can use pendingBubble's
// remove control immediately; the id-less fallback supports an older server
// during a rolling frontend/backend replacement.
export function optimisticBubble(
  conv: Conversation,
  o: OptMsg,
): TemplateResult {
  return o.id
    ? pendingBubble(conv, { role: "user", content: o.content, id: o.id })
    : html`<div class="msg user pending">
        <div class="bubble">${userBubble(o.content)}</div>
      </div>`;
}

// A delivered bubble for an accepted send awaiting its committed row.
export function acceptedBubble(o: OptMsg): TemplateResult {
  return html`<div class="msg user">
    <div class="bubble">${userBubble(o.content)}</div>
  </div>`;
}

// Show a just-sent message on the open agent's thread immediately. Repaints in
// place (not via renderConv) and clears openConvHash so the next reconciling
// fetch re-renders and prunes it against the server view.
export function addOptimisticPending(
  cid: string,
  content: string,
  sinceOffset: number,
  id?: string,
): void {
  const list = optimisticPending[cid] || (optimisticPending[cid] = []);
  // Invariant: Where the thread ended when this was sent: only a line stored
  // after that byte can be this send, so an identical earlier message keeps its
  // own bubble.
  const now = Date.now();
  list.push({
    content,
    id,
    ts: now,
    lastTrace: now,
    sinceOffset,
    seq: ++optSeq,
    echoed: false,
    confirmed: false,
  });
  if (state.currentConv && state.currentConv.id === cid) {
    state.openConvHash = "";
    paint(state.currentConv);
  }
}

// Committed inputs in oldest-first order for optimistic reconciliation.
function committedUserEntries(): MessageEntry[] {
  const out: MessageEntry[] = [];
  for (const turn of loaded) {
    for (const segment of turn.segments) out.push(...segment.user);
  }
  return out;
}

export function newestCommittedOffset(cid: string): number {
  return (rowThreads.get(cid)?.rows ?? []).reduce(
    (newest, row) => (row.live ? newest : Math.max(newest, row.offset ?? 0)),
    0,
  );
}

// Reconcile just-sent entries against the rebuilt window: pin by identity
// while the server echoes them, retire by content identity once their
// committed row arrives. The pure decision lives in pending-message.ts so the
// rebuild-during-pending-steer behavior is unit-testable without a DOM.
export function pruneOptimistic(conv: Conversation): void {
  const list = optimisticPending[conv.id];
  if (!list || !list.length) return;
  const kept = pruneOptimisticEntries(
    list,
    [...(conv.pending || [])],
    committedUserEntries(),
    Date.now(),
    OPT_TTL_MS,
  );
  if (kept.length) optimisticPending[conv.id] = kept;
  else delete optimisticPending[conv.id];
}
