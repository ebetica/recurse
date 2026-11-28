// Focused conversation reads: fetching one agent's view into the cache,
// painting it from cache or network, and warming neighbours. Settled reads
// catch up committed input before painting idle. Reads update chrome before
// reconciling and rendering the thread.
import { backendFor } from "../backends/backend.js";
import { conversationId } from "../backends/conversation-id/index.js";
import { backgroundWork, focusedPathReady } from "../background-work.js";
import {
  applyFreshness,
  noteConversationSwitch,
  updateChrome,
} from "./chrome.js";
import {
  type ConversationFetchPurpose,
  shouldCacheConversationResponse,
} from "./cache/index.js";
import {
  focusedRead,
  noteRefreshApplied,
  noteRefreshFailed,
  phaseFor,
} from "./freshness.js";
import { inputEl } from "../dom.js";
import {
  notePaneConversationRendered,
  notePaneConversationRequested,
  syncPanes,
} from "../panes.js";
import {
  configurePendingMessageRefresh,
  optPending,
} from "../pending-queue/index.js";
import {
  type FocusedSubscription,
  subscribeFocusedEvents,
} from "../focused-events.js";
import { recordUiTiming } from "../interaction-timing.js";
import { markMainThreadEvent } from "../main-thread-timing.js";
import { phoneListEntry } from "../phone-nav.js";
import {
  applyFocusedEventPage,
  catchUpRowThread,
  isDeletingConversation,
  refreshRowThread,
} from "../row-thread-state.js";
import { rowThreads } from "../row-thread-state/index.js";
import {
  COLD_FOCUSED,
  coldStage,
  conversationRequestDispatched,
} from "../show-timing.js";
import { DRAFT, embedded, embeddedFrameHidden, state } from "../state.js";
import { convHash, renderThread } from "./thread.js";
import { keepRepliedSafety } from "../safety-view.js";
import { type Conversation } from "../types.js";
import { type ViewPage } from "../row-thread-state/view-blocks.js";

configurePendingMessageRefresh(refreshConv);

let fallbackPoll: () => Promise<void>;
let notePollActivity: () => void;

export function configureFocusedPoll(
  poll: typeof fallbackPoll,
  activity: typeof notePollActivity,
): void {
  fallbackPoll = poll;
  notePollActivity = activity;
}

export let pollGeneration = 0;
export function advancePollGeneration(): number {
  return ++pollGeneration;
}

// Focused SSE owns rows; polls keep chrome and provide a fallback.
let focusedEventsId: string | null = null;
let focusedEventsSub: FocusedSubscription | null = null;
let focusedEventsHealthy = false;
const ACTIVE_STREAM_STALL_MS = 12_000;
let focusedEventsActivity = 0;
let focusedEventsRun: {
  run: string;
  source: string;
  settlingAt?: number;
} | null = null;
let focusedEventsGone: string | null = null;
let wakePaint: { id: string; at: number } | null = null;

export function noteWakePaint(id: string): void {
  wakePaint = { id, at: performance.now() };
}

function finishWakePaint(id: string, requestedAt: number): void {
  const timing = wakePaint;
  if (!timing || timing.id !== id || requestedAt < timing.at) return;
  wakePaint = null;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!document.hidden && state.selectedId === id)
        recordUiTiming("wake:painted", performance.now() - timing.at, id);
    }),
  );
}

// The stream replaces the focused row poll while subscribed: tail deltas
// arrive as snapshot/rows frames (resyncing with Last-Event-ID on
// reconnect), so the poll loop skips its own /view tail read for this id.
function focusedEventsLive(id: string): boolean {
  const running =
    state.currentConv?.id === id && state.currentConv.status === "running";
  const now = performance.now();
  const settlingAt = focusedEventsRun?.settlingAt;
  if (
    focusedEventsId === id &&
    focusedEventsHealthy &&
    (now - focusedEventsActivity >
      (running ? ACTIVE_STREAM_STALL_MS : 130_000) ||
      (settlingAt !== undefined && now - settlingAt >= ACTIVE_STREAM_STALL_MS))
  ) {
    closeFocusedEvents();
    retargetFocusedEvents(id);
  }
  return (
    focusedEventsId === id && focusedEventsSub !== null && focusedEventsHealthy
  );
}

/** Let a stream that acknowledged this run settle its rows. */
function deferFocusedSettle(id: string, run: string, source: string): boolean {
  if (!focusedEventsLive(id)) return false;
  const active = focusedEventsRun;
  if (!active || active.run !== run || active.source !== source) return false;
  active.settlingAt ??= performance.now();
  return true;
}

function focusedRowsSettling(id: string): boolean {
  return focusedEventsId === id && focusedEventsRun?.settlingAt !== undefined;
}

export function closeFocusedEvents(): void {
  focusedEventsSub?.close();
  focusedEventsSub = null;
  focusedEventsId = null;
  focusedEventsHealthy = false;
  focusedEventsActivity = 0;
  focusedEventsRun = null;
}

export function retargetFocusedEvents(id: string | null): void {
  if (focusedEventsGone !== null && focusedEventsGone !== id)
    focusedEventsGone = null;
  if (
    !id ||
    id === DRAFT ||
    document.hidden ||
    embeddedFrameHidden() ||
    phoneListEntry()
  ) {
    if (focusedEventsSub) closeFocusedEvents();
    return;
  }
  // Invariant: No stream for a deleting conversation: there is no history to
  // feed it, only the retired session behind the Deleting notice.
  if (isDeletingConversation(id)) {
    if (focusedEventsId === id) closeFocusedEvents();
    return;
  }
  if (focusedEventsId === id || focusedEventsGone === id) return;
  closeFocusedEvents();
  const held = rowThreads.get(id);
  // Invariant: The stream resumes from rows a /view read already holds; with
  // none it would resend that read's window as a snapshot.
  if (!held) return;
  const lastEventId = `${held.instanceId}:${held.revision}`;
  const sub = subscribeFocusedEvents(
    id,
    {
      onPage: (kind, page, at) => {
        focusedEventsHealthy = true;
        markMainThreadEvent("stream-batch");
        if (applyFocusedEventPage(id, page, kind === "snapshot")) {
          const source = page.run_state_clock?.[0];
          const run = page.active_run;
          if (!source || !run) focusedEventsRun = null;
          else if (
            focusedEventsRun?.source !== source ||
            focusedEventsRun.run !== run
          )
            focusedEventsRun = { run, source };
          applyFrameRunState(id, page, at);
          finishWakePaint(id, at);
        }
      },
      onTerminal: (status) => {
        focusedEventsHealthy = false;
        focusedEventsRun = null;
        if (status === "gone") {
          focusedEventsGone = id;
          closeFocusedEvents();
        }
        // Invariant: Any other terminal frame (unavailable) leaves the
        // subscription open: the server ended that attempt, and the transport
        // reconnects on its own retry loop with the latest id.
        void fallbackPoll();
      },
      onActivity: () => {
        focusedEventsActivity = performance.now();
        focusedEventsHealthy = true;
      },
      onTransportError: () => {
        focusedEventsHealthy = false;
        focusedEventsRun = null;
        catchUpRowThread(id);
        void fallbackPoll();
      },
    },
    { lastEventId, viewing: !embedded },
  );
  if (sub) {
    focusedEventsSub = sub;
    focusedEventsId = id;
  }
}

// Cleared by refreshConv when its focused read lands on the parked
// id: a successful read supersedes the parked terminal marker.
function clearFocusedEventsGone(id: string): void {
  if (focusedEventsGone === id) focusedEventsGone = null;
}

// Caches views without rendering; only focused reads get full windows.
const fetchGeneration: Record<string, number> = {};
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
    const switchHeaders: Record<string, string> = switchTiming
      ? {
          "x-recurse-trace": switchTiming.traceId,
          "x-recurse-client-dispatch-ms":
            switchTiming.clickToDispatchMs.toFixed(3),
        }
      : {};
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
            { headers: switchHeaders },
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
    const clock = r.headers.get("x-recurse-run-state-clock");
    const separator = clock?.lastIndexOf(":") ?? -1;
    if (clock && separator > 0) {
      const at = Number(clock.slice(separator + 1));
      if (Number.isFinite(at))
        conv.run_state_clock = [clock.slice(0, separator), at];
    }
    const backend = backendFor(id);
    if (backend.label)
      conv = {
        ...conv,
        id: conversationId(backend.label, conv.id),
        parent: conv.parent ? conversationId(backend.label, conv.parent) : null,
        // Spec: A backend older than the taken_over rename sends `pinned`;
        // drop this one release after the rename.
        taken_over: conv.taken_over ?? conv.pinned,
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
      conv.taken_over = state.pendingTakeovers[id];
    }
    state.convCache.set(id, conv, purpose !== "prefetch");
    return { status: 200, conv };
  } catch {
    return { status: 0, conv: null };
  }
}

function renderConv(conv: Conversation): void {
  updateChrome(conv);
  renderThread(conv);
}

export function showSelectedConversation(
  id: string,
  preserveAttachments: boolean,
): void {
  noteConversationSwitch(id, showCached(id) || preserveAttachments);
  // Invariant: The newly opened agent owns the one SSE subscription; the
  // previously open one closes here so only the focused conversation streams.
  retargetFocusedEvents(id);
}

// Paints a cached thread immediately and seeds its reconciliation hash.
// Returns false on first visit.
function showCached(id: string): boolean {
  const conv = state.convCache.view(id);
  if (!conv) return false;
  state.currentConv = conv;
  state.openConvHash = convHash(conv);
  renderConv(conv);
  notePaneConversationRendered(id);
  return true;
}

// Only reads that apply run state can supersede a stream or Stop lookup.
const convReadAt = new Map<string, number>();
let latestRunRead: { id: string; started: number } | null = null;

function newerRunState(
  current: Conversation,
  incoming: Conversation,
  requestedAt: number,
): boolean {
  const latest = current.run_state_clock;
  const read = incoming.run_state_clock;
  return (
    (latestRunRead?.id === current.id && latestRunRead.started > requestedAt) ||
    (!!latest && !!read && latest[0] === read[0] && latest[1] > read[1])
  );
}

// Server-side sample clocks order run-state reads without assuming a shared
// client/server clock.
function applyFrameRunState(id: string, page: ViewPage, at: number) {
  const conv = state.currentConv;
  if (conv?.id !== id || typeof page.turn_status !== "string") return;
  const clock = page.run_state_clock;
  const latest = conv.run_state_clock;
  if (clock && latest) {
    if (clock[0] !== latest[0] || clock[1] <= latest[1]) return;
    conv.run_state_clock = clock;
  } else if (at <= (convReadAt.get(id) ?? Infinity)) return;
  const run = page.active_run ?? null;
  const start = page.active_run_start ?? null;
  if (
    conv.status === page.turn_status &&
    (conv.active_run ?? null) === run &&
    (conv.active_run_start ?? null) === start &&
    JSON.stringify(conv.running_hooks) === JSON.stringify(page.running_hooks)
  )
    return;
  conv.status = page.turn_status as Conversation["status"];
  conv.active_run = run;
  conv.active_run_start = start;
  conv.running_hooks = page.running_hooks;
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
  const requestedAt = performance.now();
  const rowsFromEvents = focusedEventsLive(id);
  const directRowRead =
    purpose === "focused" &&
    !isDeletingConversation(id) &&
    (!rowsFromEvents || (generation === null && focusedRowsSettling(id)));
  let settledRowsChanged = false;
  // Invariant: Nothing best-effort may hold one of the browser's few per-origin
  // connections while the read the reader is waiting on is in flight.
  const release = backgroundWork.hold();
  // Invariant: Served snapshots supply settled tool data without a second read.
  // During a run, only absent subscriptions use the /view fallback. A settled
  // read also catches up below; deleting sessions have no history to read.
  const blocksPromise = directRowRead
    ? refreshRowThread(id)
    : Promise.resolve(false);
  const view = fetchConvView(id, true, generation, purpose, undefined);
  const settlePaneRead = notePaneConversationRequested(id);
  const { status, conv } = await view
    .then(async (result) => {
      const current = state.currentConv;
      const next = result.conv;
      if (
        current?.id === id &&
        (current.status === "running" || current.status === "interrupting") &&
        rowsFromEvents &&
        !directRowRead &&
        !embeddedFrameHidden() &&
        next?.status === "idle" &&
        !next.active_run &&
        id === state.selectedId &&
        (generation === null || generation === pollGeneration) &&
        !isDeletingConversation(id) &&
        !newerRunState(current, next, requestedAt)
      ) {
        // Invariant: Paint idle promptly, but reconcile unresolved optimistic
        // inputs first so an accepted send cannot reappear as queued.
        const latest = current.run_state_clock;
        const read = next.run_state_clock;
        const deferRows =
          purpose === "focused" &&
          generation !== null &&
          optPending(id).length === 0 &&
          !!current.active_run &&
          !!latest &&
          !!read &&
          latest[0] === read[0] &&
          latest[1] < read[1] &&
          deferFocusedSettle(id, current.active_run, read[0]);
        if (!deferRows) settledRowsChanged = await refreshRowThread(id);
      }
      return result;
    })
    .finally(() => {
      release();
      focusedPathReady();
    });
  const stillSelected = () =>
    (generation === null || generation === pollGeneration) &&
    id === state.selectedId;
  if (stillSelected()) settlePaneRead?.(!conv);
  const blocksChanged = (await blocksPromise) || settledRowsChanged;
  if (!stillSelected()) return false;
  // Invariant: A read 404 never navigates; two tree misses confirm absence.
  // Keep the chosen thread. Failed cached reads end refreshing; cold switches
  // keep loading until the correct thread exists.
  if (status === 404 || !conv) {
    noteRefreshFailed(id);
    applyFreshness();
    return false;
  }
  coldStage(COLD_FOCUSED);
  const current = state.currentConv;
  if (current?.id === id && newerRunState(current, conv, requestedAt)) {
    conv.status = current.status;
    conv.active_run = current.active_run;
    conv.active_run_start = current.active_run_start;
    conv.running_hooks = current.running_hooks;
    conv.run_state_clock = current.run_state_clock;
  } else {
    latestRunRead = { id, started: requestedAt };
    convReadAt.set(id, performance.now());
  }
  keepRepliedSafety(
    id,
    requestedAt,
    current?.id === id ? current : undefined,
    conv,
  );
  state.currentConv = conv;
  focusedRead.stopReadAuthoritativeId = id;
  // Invariant: A successful read proves the conversation exists: lift any
  // terminal park and make sure the focused subscription is live (a no-op while
  // it is).
  clearFocusedEventsGone(id);
  if (purpose === "focused") retargetFocusedEvents(id);
  const hash = convHash(conv);
  // Invariant: A switch with nothing cached has never painted this thread, so
  // it renders even in the (unreachable-by-construction) case of a matching
  // hash.
  if (
    hash !== state.openConvHash ||
    blocksChanged ||
    phaseFor(focusedRead.freshness, id) === "loading"
  ) {
    state.openConvHash = hash;
    renderConv(conv);
    notePaneConversationRendered(id);
    notePollActivity();
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
