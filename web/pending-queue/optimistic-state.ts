// Just-sent entries awaiting a committed row, keyed by conversation. Row
// rebuilds pass their committed window in; rendering and repaint stay outside.
import {
  pruneOptimisticEntries,
  removeOptimisticMessageById,
  type OptimisticEntry,
} from "./pending-message.js";
import type { Conversation, MessageEntry, Turn } from "../types.js";

const optimisticPending: Record<string, OptimisticEntry[]> = {};
let optSeq = 0;
const OPT_TTL_MS = 30000;

export function optPending(cid: string): OptimisticEntry[] {
  return optimisticPending[cid] || [];
}

export function discardOptimisticPending(cid: string, id: string): void {
  const kept = removeOptimisticMessageById(optPending(cid), id);
  if (kept.length) optimisticPending[cid] = kept;
  else delete optimisticPending[cid];
}

export function recordOptimisticPending(
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
}

// Committed inputs in oldest-first order for optimistic reconciliation.
function committedUserEntries(turns: readonly Turn[]): MessageEntry[] {
  const out: MessageEntry[] = [];
  for (const turn of turns) {
    for (const segment of turn.segments) out.push(...segment.user);
  }
  return out;
}

// Keep echoed sends by identity and retire them once their committed row
// arrives. The matching and TTL rules live in pending-message.ts.
export function pruneOptimistic(
  conv: Conversation,
  turns: readonly Turn[],
): void {
  const list = optimisticPending[conv.id];
  if (!list || !list.length) return;
  const kept = pruneOptimisticEntries(
    list,
    [...(conv.pending || [])],
    committedUserEntries(turns),
    Date.now(),
    OPT_TTL_MS,
  );
  if (kept.length) optimisticPending[conv.id] = kept;
  else delete optimisticPending[conv.id];
}
