// Focused conversation reads: fetching one agent's view into the cache,
// painting it from cache or network, and warming neighbours. Settled reads
// catch up committed input before painting idle. thread.ts owns rendering;
// chrome.ts settles freshness. This module never paints chrome itself.
import { backendFor, conversationId } from "../backends/backend.js";
import { backgroundWork, focusedPathReady } from "../background-work.js";
import {
  applyFreshness,
  freshness,
  noteRefreshApplied,
  noteRefreshFailed,
  setStopReadAuthoritative,
} from "./chrome.js";
import {
  type ConversationFetchPurpose,
  shouldCacheConversationResponse,
} from "./cache.js";
import { phaseFor } from "./freshness.js";
import { inputEl } from "../dom.js";
import { syncPanes } from "../panes.js";
import {
  clearFocusedEventsGone,
  focusedEventsLive,
  retargetFocusedEvents,
} from "./poll.js";
import {
  isDeletingConversation,
  refreshRowThread,
} from "../row-thread-state.js";
import {
  COLD_FOCUSED,
  coldStage,
  conversationRequestDispatched,
} from "../show-timing.js";
import { DRAFT, embeddedFrameHidden, state } from "../state.js";
import { pollGeneration } from "./poll.js";
import { convHash, renderConv } from "./thread.js";
import { type Conversation } from "../types.js";
import { type ViewPage } from "../row-thread-state/view-blocks.js";

// Caches views without rendering; only focused reads get full windows.
export const fetchGeneration: Record<string, number> = {};
const stopFetchGeneration: Record<string, number> = {};
async function fetchConvView(
  id: string,
  core = false,
  pollToken: number | null = null,
  purpose: ConversationFetchPurpose = "focused",
  signal?: AbortSignal,
): Promise<{ status: number; conv: Conversation | null }> {
  // Invariant: A click-owned Stop read also advances the per-agent fence so
  // every focused poll launched before the click becomes stale. Its own attempt
  // ordering fence, rather than later ordinary reads, owns whether the Stop
  // response may apply; a newer Stop lookup supersedes an older one.
  const requestGeneration = (fetchGeneration[id] || 0) + 1;
  fetchGeneration[id] = requestGeneration;
  const stopGeneration =
    purpose === "stop" ? (stopFetchGeneration[id] || 0) + 1 : null;
  if (stopGeneration !== null) stopFetchGeneration[id] = stopGeneration;
  try {
    // Invariant: Background warmth stays on the cheap default read: no
    // 40-message window and no shell-registry scan for an agent nobody is
    // looking at. It produces the same preview shape the cache already holds
    // for inactive agents.
    const switchTiming =
      purpose === "focused" ? conversationRequestDispatched(id) : null;
    const focusedQuery = new URLSearchParams({ focused: "1" });
    if (purpose === "stop") focusedQuery.set("purpose", "stop");
    if (switchTiming) {
      focusedQuery.set("switch_trace", switchTiming.traceId);
      focusedQuery.set(
        "client_dispatch_ms",
        switchTiming.clickToDispatchMs.toFixed(3),
      );
    }
    const r =
      purpose === "prefetch"
        ? /* Invariant: Warm reads must not pin connections indefinitely. */
          await backendFor(id).api(
            "/api/conversations/" + id,
            { signal },
            { availability: "optional", timeoutMs: 10_000 },
          )
        : await backendFor(id).api(
            `/api/conversations/${id}?${focusedQuery}`,
            {},
            { availability: core ? "core" : "optional" },
          );
    if (pollToken !== null && pollToken !== pollGeneration)
      return { status: 0, conv: null };
    if (r.status === 404) {
      // Invariant: Keep the last good view: a transient storage miss must not
      // make a later switch back to this agent show the previously-open agent's
      // thread. The next open-agent refresh retries while retaining the cached
      // view.
      return { status: 404, conv: null };
    }
    if (!r.ok) return { status: r.status, conv: null };
    let conv = (await r.json()) as Conversation;
    const backend = backendFor(id);
    if (backend.label)
      conv = {
        ...conv,
        id: conversationId(backend.label, conv.id),
        parent: conv.parent ? conversationId(backend.label, conv.parent) : null,
      };
    if (
      (pollToken !== null && pollToken !== pollGeneration) ||
      (purpose === "stop"
        ? stopFetchGeneration[id] !== stopGeneration
        : fetchGeneration[id] !== requestGeneration)
    )
      return { status: 0, conv: null };
    // Invariant: Navigation can move while a request is in flight. Discard its
    // response before it can mutate any cache or derived UI state: a focused
    // read that lost the selection, or a prefetch whose agent has since been
    // opened.
    if (
      !shouldCacheConversationResponse(conv.id, id, state.selectedId, purpose)
    )
      return { status: 0, conv: null };
    if (id in state.pendingTakeovers) {
      conv.muted = state.pendingTakeovers[id];
      conv.pinned = state.pendingTakeovers[id];
    }
    state.convCache.set(id, conv, purpose !== "prefetch");
    return { status: 200, conv };
  } catch {
    return { status: 0, conv: null };
  }
}

// Paints a cached thread immediately and seeds its reconciliation hash. Panels
// sync only after selectAgent starts the focused read, never before the
// thread's data. Returns false on first visit.
export function showCached(id: string): boolean {
  const conv = state.convCache.view(id);
  if (!conv) return false;
  state.currentConv = conv;
  state.openConvHash = convHash(conv);
  renderConv(conv);
  return true;
}

// When each conversation's latest applied read landed (performance.now()).
const convReadAt = new Map<string, number>();

// An events frame's run state belongs to the same snapshot as its rows. Take
// it when the frame was requested (`at`) after the latest applied read landed,
// so a slow read never leaves settled rows beside a stale running status.
export function applyFrameRunState(id: string, page: ViewPage, at: number) {
  const conv = state.currentConv;
  if (conv?.id !== id || typeof page.turn_status !== "string") return;
  if (at <= (convReadAt.get(id) ?? Infinity)) return;
  const run = page.active_run ?? null;
  if (conv.status === page.turn_status && (conv.active_run ?? null) === run)
    return;
  conv.status = page.turn_status as Conversation["status"];
  conv.active_run = run;
  state.openConvHash = convHash(conv);
  renderConv(conv);
}

export async function refreshConv(
  generation: number | null = null,
  purpose: ConversationFetchPurpose = "focused",
): Promise<boolean> {
  if (state.selectedId === DRAFT || !state.selectedId) return false;
  inputEl.placeholder = "Message this agent…";
  const id = state.selectedId;
  const wasRunning =
    state.currentConv?.id === id &&
    ["running", "interrupting"].includes(state.currentConv.status);
  const rowsFromEvents = focusedEventsLive(id);
  let settledRowsChanged = false;
  // Invariant: Nothing best-effort may hold one of the browser's few per-origin
  // connections while the read the reader is waiting on is in flight.
  const release = backgroundWork.hold();
  // Invariant: Served snapshots supply settled tool data without a second read.
  // During a run, only absent subscriptions use the /view fallback. A settled
  // read also catches up below; deleting sessions have no history to read.
  const blocksPromise =
    purpose === "focused" && !rowsFromEvents && !isDeletingConversation(id)
      ? refreshRowThread(id)
      : Promise.resolve(false);
  const { status, conv } = await fetchConvView(
    id,
    true,
    generation,
    purpose,
    undefined,
  )
    .then(async (result) => {
      // Invariant: A settled read must reconcile the admitted send's real row
      // before painting idle; otherwise its optimistic echo looks queued.
      if (
        wasRunning &&
        rowsFromEvents &&
        !embeddedFrameHidden() &&
        result.conv?.status === "idle" &&
        !result.conv.active_run &&
        id === state.selectedId &&
        (generation === null || generation === pollGeneration) &&
        !isDeletingConversation(id)
      )
        settledRowsChanged = await refreshRowThread(id);
      return result;
    })
    .finally(() => {
      release();
      focusedPathReady();
    });
  if (
    (generation !== null && generation !== pollGeneration) ||
    id !== state.selectedId
  )
    return false;
  // Invariant: A read 404 never navigates; two tree misses confirm absence.
  // Keep the chosen thread. Failed cached reads end refreshing; cold switches
  // keep loading until the correct thread exists.
  if (status === 404 || !conv) {
    noteRefreshFailed(id);
    applyFreshness();
    return false;
  }
  coldStage(COLD_FOCUSED);
  state.currentConv = conv;
  convReadAt.set(id, performance.now());
  setStopReadAuthoritative(id);
  // Invariant: A successful read proves the conversation exists: lift any
  // terminal park and make sure the focused subscription is live (a no-op while
  // it is).
  clearFocusedEventsGone(id);
  if (purpose === "focused") retargetFocusedEvents(id);
  const blocksChanged = (await blocksPromise) || settledRowsChanged;
  const hash = convHash(conv);
  // Invariant: A switch with nothing cached has never painted this thread, so
  // it renders even in the (unreachable-by-construction) case of a matching
  // hash.
  if (
    hash !== state.openConvHash ||
    blocksChanged ||
    phaseFor(freshness, id) === "loading"
  ) {
    state.openConvHash = hash;
    renderConv(conv);
  }
  noteRefreshApplied(id);
  applyFreshness();
  syncPanes();
  return true;
}

// Warms changed neighbours behind focus through a bounded, abortable queue.
export const prefetchInFlight = new Set<string>();
export const prefetchedAt: Record<string, number> = {};
export function startRelatedPrefetch(id: string): void {
  // Invariant: Mark in flight only when queued work starts; dropped tasks
  // otherwise stay stuck forever. Waiting work is deduplicated by queue key.
  backgroundWork.enqueue("warm-conversation:" + id, (signal) => {
    prefetchInFlight.add(id);
    return fetchConvView(id, false, null, "prefetch", signal).finally(() => {
      prefetchInFlight.delete(id);
      // Invariant: An aborted warm read fetched nothing, so it must not start a
      // cooldown that would skip this neighbour on the next poll.
      if (!signal.aborted) prefetchedAt[id] = Date.now();
    });
  });
}

// Aborts warming/probes for the departed conversation. Abandoned neighbour
// reads wait for a changed stamp; opening one reconciles its stale cache
// through a focused read instead of spending recurring warm-read capacity.
export function abandonBackgroundWarming(): void {
  backgroundWork.abandonAll();
  prefetchInFlight.clear();
}
