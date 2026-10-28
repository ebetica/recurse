// Held /view row threads: per-conversation holder maps, Clear/epoch staleness
// guards, and the tail/older fetch plus fold into the presented thread.
import { backendFor } from "./backends/backend.js";
import { scrollEl } from "./dom.js";
import { state } from "./state.js";
import {
  clearedPageStale,
  foldRowThread,
  pruneCaches,
  readSerialApplies,
  rowThreadHasActiveTurn,
  rowsToTurns,
  type ClearedMarker,
  type RowThread,
} from "./row-thread-state/row-thread.js";
import type { ViewPage } from "./row-thread-state/view-blocks.js";
import { pruneOptimistic } from "./pending-queue.js";
import { cancelRevealTimer } from "./conversation/disclosure.js";
import { fillViewport } from "./conversation/navigation.js";
import { paint } from "./conversation/thread.js";
import { noteRowsRead, noteTurns } from "./files.js";
import type { Conversation, Turn } from "./types.js";

export let loaded: Turn[] = [];
export let renderedConvId: string | null = null;
export let renderedLogGeneration = 0;
export let topCursor = 0;
// Held rows own loaded turns once /view succeeds; polls retain chrome only.
export const rowThreads = new Map<string, RowThread>();
export const rowReadStatus = new Map<string, string>();
export const rowThreadOlder = new Map<string, boolean>();
const liveTails = new Map<string, { owner: string; turn: string }>();
// Never-reused read serials fence in-flight pages across drops and eviction.
const rowThreadEpoch = new Map<string, number>();
let rowThreadDropSerial = 0;

export function rowThreadContextKey(id: string): string {
  return JSON.stringify([
    rowThreads.get(id)?.instanceId,
    rowThreadEpoch.get(id),
  ]);
}
// Clear tombstones require a new session, not a rebuilt view instance.
const rowThreadCleared = new Map<string, ClearedMarker>();
const MAX_ROW_THREADS = 100;

// True when the page carries nothing newer than a confirmed Clear: the drop
// already emptied this thread, so applying the page would resurrect history.
// Resolve rule lives in row-thread.clearedPageStale (unit-tested there).
function isClearedStale(id: string, page: ViewPage | null): boolean {
  const cleared = rowThreadCleared.get(id);
  if (!clearedPageStale(cleared, page)) {
    if (cleared && page?.status === "ready") rowThreadCleared.delete(id);
    return false;
  }
  return true;
}

// Deleting sessions are retired: skip unavailable history reads and streams.
// Consult open state, cache and tree because any source may learn first.
export function isDeletingConversation(id: string): boolean {
  if (state.currentConv?.id === id && state.currentConv.status === "deleting")
    return true;
  if (state.convCache.peek(id)?.status === "deleting") return true;
  return state.nodes[id]?.status === "deleting";
}

// Working-set bound across every per-conversation row map: thread-less
// entries (a drop serial with no held thread) count too, so a drop with no
// held thread cannot leak past eviction. Bound itself is row-thread
// pruneCaches (unit-tested there); this names the held maps.
function pruneRowCaches(except?: string): void {
  pruneCaches(
    [
      rowThreads,
      rowThreadOlder,
      rowReadStatus,
      rowThreadEpoch,
      rowThreadCleared,
      liveTails,
    ],
    MAX_ROW_THREADS,
    except,
  );
}

// One SSE delta folded through the same thread-level rules as the row poll:
// stale pages keep held rows, instance changes rebuild, and only a changed
// thread repaints the open conversation.
export function applyFocusedEventPage(id: string, page: ViewPage): void {
  if (isDeletingConversation(id)) return;
  if (isClearedStale(id, page)) return;
  if (page?.status === "stale") return;
  if (id !== state.selectedId) return;
  const priorStatus = rowReadStatus.get(id);
  const status = page?.status === "ready" ? "ready" : "unavailable";
  rowReadStatus.set(id, status);
  if (!page) return;
  const fold = foldRowThread(rowThreads.get(id), page);
  if (!fold.state) return;
  rememberRowThread(id, fold.state, fold.reset, page.older === true);
  const conv = state.currentConv;
  if (
    conv?.id === id &&
    (fold.changed || priorStatus !== status) &&
    reconcileRows(conv)
  )
    paint(conv);
}

function rememberRowThread(
  id: string,
  thread: RowThread,
  reset: boolean,
  older: boolean,
): void {
  rowThreads.set(id, thread);
  noteRowsRead(id);
  if (reset) rowThreadOlder.set(id, older);
  pruneRowCaches(id);
}

// Confirmed Clear drops exactly this thread, including unavailable retries.
// Failures, queued actions, other conversations and transient outages keep
// rows.
export function dropRowThread(id: string): void {
  const held = rowThreads.get(id);
  // Invariant: Refresh recency first so the union prune treats this id as
  // newest; the serial itself comes from the never-reused process counter.
  rowThreadEpoch.delete(id);
  rowThreadCleared.delete(id);
  if (held) {
    // Invariant: A tombstone keeps reconcileRows on the (empty) row path
    // instead of falling back to the turns poll, which still serves pre-Clear
    // turns until the boundary applies the Clear server-side.
    rowThreads.set(id, {
      instanceId: held.instanceId,
      revision: held.revision,
      rows: [],
    });
    rowThreadOlder.set(id, false);
    rowThreadCleared.set(id, {
      instanceId: held.instanceId,
      revision: held.revision,
      sessionKey: held.sessionKey,
    });
  } else {
    rowThreads.delete(id);
    rowThreadOlder.delete(id);
  }
  rowReadStatus.delete(id);
  cancelRevealTimer(id);
  rowThreadEpoch.set(id, ++rowThreadDropSerial);
  // Invariant: A thread-less drop still adds an epoch key: prune here, not just
  // on the next remember, so drops alone cannot grow the maps past the cap.
  pruneRowCaches(id);
  if (renderedConvId === id) {
    loaded = [];
    rowThreadInst = null;
  }
}

// Single /view tail read outside the poll loop: covers a failed stream
// attempt while the transport backs off and resyncs. Guards mirror the
// SSE path — only the still-open conversation repaints.
export function catchUpRowThread(id: string): void {
  if (isDeletingConversation(id)) return;
  void (async () => {
    try {
      if (!(await refreshRowThread(id))) return;
      const conv = state.currentConv;
      if (conv?.id === id && id === state.selectedId && reconcileRows(conv))
        paint(conv);
    } catch {}
  })();
}

let rowThreadInst: string | null = null;
export let loadingOlder = false;

// Extends rows when unsubscribed, after a failed stream, or when a metadata
// read settles a run. The same page feeds settled tools. Unavailable/stale
// pages retain rows; instance
// changes rebuild instead of blanking the thread.
export async function refreshRowThread(id: string): Promise<boolean> {
  const held = rowThreads.get(id);
  // Invariant: Per-request identity (row-thread.readSerialApplies, unit-tested
  // there): apply only on exact serial match. A drop stores a fresh
  // never-reused serial; a missing entry never matches.
  const epoch = rowThreadEpoch.get(id);
  const read = async (): Promise<ViewPage | null> => {
    const query = held
      ? `since=${held.revision}&instance=${encodeURIComponent(held.instanceId)}&limit=100`
      : "limit=100";
    try {
      const response = await backendFor(id).api(
        `/api/conversations/${id}/view?${query}`,
      );
      if (!response.ok) return null;
      return (await response.json()) as ViewPage;
    } catch {
      return null;
    }
  };
  const page = await read();
  // Invariant: A confirmed Clear dropped this thread while the read was in
  // flight: the response describes pre-Clear history and must not repopulate
  // it.
  if (!readSerialApplies(epoch, rowThreadEpoch.get(id))) return false;
  if (isClearedStale(id, page)) return false;
  if (page?.status === "stale") return false;
  const priorStatus = rowReadStatus.get(id);
  const status = page?.status === "ready" ? "ready" : "unavailable";
  rowReadStatus.set(id, status);
  if (!page) return priorStatus !== status;
  if (held && rowThreads.get(id)?.instanceId !== held.instanceId) return false;
  const fold = foldRowThread(rowThreads.get(id), page);
  const thread = fold.state;
  if (!thread) return priorStatus !== status;
  rememberRowThread(id, thread, fold.reset, page.older === true);
  return fold.changed || priorStatus !== status;
}

// Prepends one bounded older page without changing newer state. Empty
// readable-top pages end paging; empty pages claiming older rows stop the
// gesture without looping until a poll reanchors.
export async function loadOlderRows(
  conv: Conversation,
  fill: boolean,
): Promise<void> {
  const held = rowThreads.get(conv.id);
  const anchor = held?.rows[0]?.id;
  if (!held || !anchor) return;
  loadingOlder = true;
  const refill = fill;
  const generation = renderedLogGeneration;
  // Invariant: Same confirmed-Clear invalidation as the tail read: a drop while
  // this page was in flight must not prepend pre-Clear history into the
  // tombstone.
  const epoch = rowThreadEpoch.get(conv.id);
  try {
    const r = await backendFor(conv.id).api(
      `/api/conversations/${conv.id}/view?before=${encodeURIComponent(anchor)}&limit=100`,
    );
    if (!r.ok) return;
    const page = (await r.json()) as ViewPage;
    if (conv.id !== renderedConvId || generation !== renderedLogGeneration)
      return;
    if (!readSerialApplies(epoch, rowThreadEpoch.get(conv.id))) return;
    if (isClearedStale(conv.id, page)) return;
    if (rowThreads.get(conv.id)?.instanceId !== held.instanceId) return;
    const fold = foldRowThread(rowThreads.get(conv.id), page, "older");
    if (!fold.state) return;
    rowThreads.set(conv.id, fold.state);
    if (fold.changed && typeof page.older === "boolean")
      rowThreadOlder.set(conv.id, page.older);
    if (!reconcileRows(conv)) return;
    if (fold.reset) {
      // Invariant: A clear/shrink replaced the thread mid-gesture: repaint the
      // new thread instead of steadying scroll against a dropped anchor.
      // (Compaction no longer resets: its marker prepends like any row.)
      paint(state.currentConv?.id === conv.id ? state.currentConv : conv);
      return;
    }
    const prevHeight = scrollEl.scrollHeight;
    const prevTop = scrollEl.scrollTop;
    paint(state.currentConv?.id === conv.id ? state.currentConv : conv);
    scrollEl.scrollTop = prevTop + scrollEl.scrollHeight - prevHeight;
  } catch {
  } finally {
    loadingOlder = false;
    if (refill) fillViewport();
  }
}

// Folds held rows into loaded, returning false before /view ever answers.
// Selection/generation or new-instance resets replace the thread. Stable
// row-derived turn ids preserve keyed DOM on repeat polls.
function reconcileRows(conv: Conversation): boolean {
  const thread = rowThreads.get(conv.id);
  if (!thread) return false;
  const sameView =
    renderedConvId === conv.id && rowThreadInst === thread.instanceId;
  if (!sameView) {
    renderedConvId = conv.id;
    renderedLogGeneration += 1;
    rowThreadInst = thread.instanceId;
  }
  loaded = rowsToTurns(thread.rows, rowThreadOlder.get(conv.id) !== false);
  conv.retry_notice = thread.retryNotice ?? null;
  markRowsOpen(conv, thread.rows);
  noteTurns(conv.id, loaded);
  // Invariant: Rows page by id: top is "no older rows", not byte offset 0.
  topCursor = rowThreadOlder.get(conv.id) === false ? 0 : 1;
  pruneOptimistic(conv);
  return true;
}

function markRowsOpen(conv: Conversation, rows: RowThread["rows"]): void {
  const last = loaded[loaded.length - 1];
  const owner = JSON.stringify([conv.id, rowThreadInst, conv.active_run]);
  if (conv.status !== "running" && conv.status !== "interrupting") {
    liveTails.delete(conv.id);
    return;
  }
  // Invariant: Admission never reopens a settled tail; once observed live,
  // the same run stays open between provider rows until its status settles.
  if (rowThreadHasActiveTurn(conv.status, rows) && last && !last.system)
    liveTails.set(conv.id, { owner, turn: last.turn_id });
  const liveTail = liveTails.get(conv.id);
  if (
    last &&
    !last.system &&
    liveTail?.owner === owner &&
    liveTail.turn === last.turn_id
  ) {
    last.open = true;
    last.status = "open";
  }
}

// Fold the server's trailing turns into `loaded`, resetting when the shown
// agent changed or the thread was replaced rather than extended.
export function reconcile(conv: Conversation): void {
  if (reconcileRows(conv)) return;
  if (renderedConvId !== conv.id) {
    loaded = [];
    renderedConvId = conv.id;
    rowThreadInst = null;
  }
}

// Clear the presented thread (empty list, draft): the next conversation forces
// a full rebuild instead of reusing another agent's rows.
export function resetThreadView(): void {
  renderedConvId = null;
  renderedLogGeneration = 0;
  rowThreadInst = null;
  loaded = [];
  topCursor = 0;
}
