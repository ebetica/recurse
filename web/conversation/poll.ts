// Poll loop and live subscription: the tree + focused-conversation reads that
// keep the UI a dumb view of server state, the focused SSE subscription that
// replaces the row poll while open, boot-restore selection, and pending
// mute/title application. This module drives; thread/fetch/chrome render.
import { homeBackend } from "../backends/backend.js";
import { sharedTrees, sharedTreeNodes } from "../shared-trees.js";
import {
  refreshRemoteTrees,
  remoteBootPending,
} from "../backends/discovery.js";
import {
  treeCanConfirmAbsence,
  treeOf,
  type TreeRead,
} from "../backends/tree.js";
import { refreshAgentMentionCache } from "../agent-finder/ui.js";
import { markMainThreadEvent } from "../main-thread-timing.js";
import { recordUiTiming } from "../interaction-timing.js";
import { focusedPathReady } from "../background-work.js";
import { completeChromeFromTree, renderEmptyAgentList } from "./chrome.js";
import { conversationUiState } from "../conversation-ui-state/store.js";
import { readAgentLink, resolveBootSelection } from "../deep-link.js";
import { openArtifactLink } from "../artifacts/pane.js";
import {
  applyFrameRunState,
  prefetchInFlight,
  prefetchedAt,
  refreshConv,
  startRelatedPrefetch,
} from "./fetch.js";
import {
  type FocusedSubscription,
  subscribeFocusedEvents,
} from "../focused-events.js";
import { prefetchPlan } from "../related-prefetch.js";
import {
  applyFocusedEventPage,
  catchUpRowThread,
  isDeletingConversation,
  rowThreads,
} from "../row-thread-state.js";
import {
  type RemovalSelectionSnapshot,
  descendantIds,
  isDeletingTreeNode,
  missingSubtreeRoot,
  resolveRemovalSelection,
  snapshotRemovalSelection,
} from "../selection.js";
import { COLD_TREE, coldStage } from "../show-timing.js";
import {
  applyPendingDeleteMasks,
  applyPendingReparentMasks,
  asHistoryCorrection,
  canonicalizeAgentUrl,
  hasPendingDeleteSelection,
  renderSidebar,
  refreshUpBtn,
  reportAgentUnavailable,
  selectAgent,
  visibleRows,
} from "../sidebar.js";
import { preloadSkills } from "../skills.js";
import {
  DRAFT,
  embedded,
  embeddedFrameHidden,
  LAST_AGENT_KEY,
  state,
  visibleAgent,
} from "../state.js";
import { reconcilePendingManualTitle } from "../title-actions.js";
import {
  requestArtifactsRefresh,
  requestUiRefresh,
  treeMutationNeedsUiRefresh,
} from "../ui-events.js";

// Focused SSE owns rows; polls keep chrome and provide a fallback.
let focusedEventsId: string | null = null;
let focusedEventsSub: FocusedSubscription | null = null;
let focusedEventsGone: string | null = null;
let wakePaint: { id: string; at: number } | null = null;

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
export function focusedEventsLive(id: string): boolean {
  return focusedEventsId === id && focusedEventsSub !== null;
}

function closeFocusedEvents(): void {
  focusedEventsSub?.close();
  focusedEventsSub = null;
  focusedEventsId = null;
}

export function retargetFocusedEvents(id: string | null): void {
  if (focusedEventsGone !== null && focusedEventsGone !== id)
    focusedEventsGone = null;
  if (!id || id === DRAFT || embeddedFrameHidden()) {
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
  const lastEventId = held ? `${held.instanceId}:${held.revision}` : null;
  const sub = subscribeFocusedEvents(
    id,
    {
      onPage: (_kind, page, at) => {
        markMainThreadEvent("stream-batch");
        applyFocusedEventPage(id, page);
        applyFrameRunState(id, page, at);
        if (page.status === "ready") finishWakePaint(id, at);
      },
      onTerminal: (status) => {
        if (status === "gone") {
          focusedEventsGone = id;
          closeFocusedEvents();
        }
        // Invariant: Any other terminal frame (unavailable) leaves the
        // subscription open: the server ended that attempt, and the transport
        // reconnects on its own retry loop with the latest id.
        void poll();
      },
      onTransportError: () => {
        // Invariant: One-shot catch-up while the stream re-establishes: the
        // recurring row poll is gone, but a failed attempt still gets a single
        // /view tail read so errors keep the polling fallback V4 promised.
        catchUpRowThread(id);
        void poll();
      },
    },
    { lastEventId },
  );
  if (sub) {
    focusedEventsSub = sub;
    focusedEventsId = id;
  }
}

// ---------------------------------------------------------------- poll loop
const treeHashes = new Map<string, string>();
let missingPolls = 0;
// Inactive state is reclaimed only after two successful missing snapshots.
const missingUiOwners = new Set<string>();
let missingSelection: {
  selectedId: string;
  snapshot: RemovalSelectionSnapshot;
  retainedNodes: Record<string, import("../types.js").TreeNode>;
} | null = null;
let polling = false;
let initialPollSettled = false;
let pollStartedAt = 0;
export let pollGeneration = 0;
let wakePollPending = false;
const pollUiFailures = new Set<string>();
let resolveInitialAuthoritativeRead: (() => void) | null = null;
const initialAuthoritativeRead = new Promise<void>((resolve) => {
  resolveInitialAuthoritativeRead = resolve;
});

// Startup generation monitoring waits for whichever poll generation first
// completes the open conversation read. A focus/pageshow wake may supersede the
// original poll; awaiting that original call alone would then resolve too
// early.
export function waitForInitialAuthoritativeRead(): Promise<void> {
  return initialAuthoritativeRead;
}
// A wedged mobile/background fetch stops blocking fresh polls after this bound.
const POLL_WEDGE_MS = 12000;
// Overlay any optimistic rename onto the freshly-fetched tree: keep showing the
// name we just set until the server's own title matches it, then drop the
// override. A vanished agent drops its override too. (state.pendingTitles is
// seeded by the rename control in sidebar.js.)
export function applyPendingTakeovers(): void {
  for (const [id, took] of Object.entries(state.pendingTakeovers)) {
    const n = state.nodes[id];
    if (!n) {
      delete state.pendingTakeovers[id];
      continue;
    }
    if (n.muted === took && (n.pinned ?? false) === took)
      delete state.pendingTakeovers[id];
    else {
      n.muted = took;
      n.pinned = took;
    }
  }
}

export function applyPendingStops(): void {
  for (const id of Object.keys(state.pendingStops)) {
    const status = state.nodes[id]?.status;
    if (status !== "running" && status !== "interrupting")
      delete state.pendingStops[id];
  }
}

export function applyPendingTitles(): void {
  for (const [id, pending] of Object.entries(state.pendingTitles)) {
    const n = state.nodes[id];
    if (!n) {
      delete state.pendingTitles[id];
      continue;
    }
    // Invariant: A poll started before this manual action may still carry the
    // older R spinner/result. Keep the optimistic manual action authoritative
    // through this reconciliation pass, including a same-text ABA.
    if (reconcilePendingManualTitle(n, pending)) delete state.pendingTitles[id];
  }
}

// Boot restores deep links before memory, without overriding navigation.
let lastAgentRestored = false;
let homeTreeKnown = false;
function rememberedAgent(): string | null {
  try {
    return localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}
function clearSelectionForEmptyList(): void {
  retargetFocusedEvents(null);
  state.selectedId = "";
  state.cursorId = "";
  state.currentConv = null;
  state.openConvHash = "";
  try {
    localStorage.removeItem(LAST_AGENT_KEY);
  } catch {}
  renderEmptyAgentList();
  canonicalizeAgentUrl();
}
function restoreBootSelection(): void {
  if (lastAgentRestored) return;
  if (
    remoteBootPending(
      readAgentLink(location.hash).id ||
        (sharedTrees === null
          ? rememberedAgent()
          : sharedTrees.find(
              (id) => visibleAgent(id) || remoteBootPending(id),
            ) || null),
    )
  )
    return;
  lastAgentRestored = true;
  if (state.draft || state.selectedId) {
    // Invariant: A navigation restored from a deep link or cache can precede
    // the first tree read. Paint its saved-action affordance without waiting
    // for another poll; the authoritative snapshot will hide it if the row is
    // gone.
    refreshUpBtn();
    canonicalizeAgentUrl();
    openArtifactLink();
    return;
  }
  const fallback =
    sharedTrees?.find(visibleAgent) ||
    Object.values(state.nodes)[0]?.id ||
    null;
  const boot = resolveBootSelection(
    readAgentLink(location.hash),
    sharedTrees === null ? rememberedAgent() : null,
    visibleAgent,
    fallback,
  );
  if (boot.select)
    asHistoryCorrection(() => selectAgent(boot.select!, !embedded));
  else if (!fallback) clearSelectionForEmptyList();
  else preloadSkills();
  // Invariant: Whatever happened, the address bar now names the view on screen:
  // a rejected link is stripped rather than left pointing at something nobody
  // can open.
  canonicalizeAgentUrl();
  if (boot.unavailable) reportAgentUnavailable();
  else openArtifactLink();
}

// Waits for the tree only if boot restore could select another conversation.
// Avoids spending a focused read or briefly painting main before restoration.
export function bootRestorePending(): boolean {
  if (lastAgentRestored) return false;
  return !state.draft && !state.selectedId;
}

// Browser-only chrome cannot undo a successful tree/thread commit. Recurring
// work retries; boot restore retains the tree. Report only the first fault,
// then allow generation recovery after authoritative reads.
function runPollUi(label: string, action: () => void): boolean {
  try {
    action();
    pollUiFailures.delete(label);
    return true;
  } catch {
    if (!pollUiFailures.has(label)) {
      pollUiFailures.add(label);
      console.warn(
        `${label} could not update; the conversation remains available.`,
      );
    }
    return false;
  }
}

const labelOf = (id: string): string =>
  id.includes("/") ? id.slice(0, id.indexOf("/")) : "";

// Apply a backend tree to sidebar/finder/caches/chrome (home label: "").
// Null means status-only change; return whether applied. The loader discards
// superseded reads so stale snapshots never resurrect renamed/deleted agents.
function commitTree(label: string, read: TreeRead | null): boolean {
  if (!read) {
    if (label && homeTreeKnown) {
      runPollUi("Agent tree", renderSidebar);
      runPollUi("Agent search", () => refreshAgentMentionCache(label));
    }
    return false;
  }
  // Invariant: An unchanged remote snapshot has nothing to fold in, unless
  // it is counting the selected conversation's absence (one-snapshot grace).
  if (label && !read.changed && labelOf(state.selectedId) !== label)
    return true;
  const wire = sharedTreeNodes(read.nodes);
  let treeReadSucceeded = false;
  try {
    if (!label) {
      coldStage(COLD_TREE);
      state.sides = wire.filter((node) => node.side_of);
    }
    // Invariant: Side conversations live only in the Side pane; the embedded
    // frame showing one keeps them as ordinary rows so it can open it.
    // Remote side conversations stay on their own backend's page.
    const fetched =
      embedded && !label ? wire : wire.filter((node) => !node.side_of);
    // Invariant: Explicit deletes mask stale in-flight tree responses until
    // the server has acknowledged the removal in a later snapshot. A
    // server-reported deleting row is also hidden, including its descendants.
    const selectedId = state.selectedId;
    const ownsSelection = labelOf(selectedId) === label;
    const selectedIsDeleting =
      selectedId !== DRAFT && isDeletingTreeNode(fetched, selectedId);
    const masked = applyPendingDeleteMasks(fetched, label);
    const arr = label ? masked : applyPendingReparentMasks(masked);
    const nextNodes = {
      ...Object.fromEntries(
        Object.entries(state.nodes).filter(([id]) => labelOf(id) !== label),
      ),
      ...Object.fromEntries(arr.map((n): [string, typeof n] => [n.id, n])),
    };
    // Invariant: The home tree is read before remote snapshots reconcile, so
    // a remote never drives boot restore or selection against an empty home.
    if (label && !homeTreeKnown) {
      state.nodes = nextNodes;
      refreshAgentMentionCache(label, arr);
      return true;
    }
    // Invariant: Only the selected backend's tree can establish absence;
    // a remote creation must outlive snapshots started before it completed.
    const selMissing =
      !!selectedId &&
      selectedId !== DRAFT &&
      ownsSelection &&
      !nextNodes[selectedId] &&
      treeCanConfirmAbsence(selectedId);
    const explicitDeletePending =
      selMissing && hasPendingDeleteSelection(selectedId);

    if (missingSelection && missingSelection.selectedId !== selectedId) {
      missingSelection = null;
      missingPolls = 0;
    }
    if (explicitDeletePending) {
      // Invariant: The explicit delete owns this missing selection until its
      // request settles; do not apply the unrelated disappearance
      // grace/fallback.
      missingSelection = null;
      missingPolls = 0;
    } else if (selMissing) {
      if (!missingSelection && state.nodes[selectedId]) {
        const survivorIds = new Set(Object.keys(nextNodes));
        const root = missingSubtreeRoot(state.nodes, selectedId, survivorIds);
        const removedIds = descendantIds(state.nodes, root);
        const snapshot = snapshotRemovalSelection(
          visibleRows().map((n) => n.id),
          removedIds,
          selectedId,
        );
        if (snapshot) {
          const retainedNodes = Object.fromEntries(
            removedIds.map((id) => [id, state.nodes[id]]),
          );
          missingSelection = { selectedId, snapshot, retainedNodes };
        }
      }
      if (selectedIsDeleting) {
        // Invariant: A deleting status is authoritative, unlike a transient
        // storage miss: remove the open branch now and resolve its
        // replacement below.
        missingPolls = 2;
      } else {
        missingPolls++;
        if (missingPolls < 2 && missingSelection) {
          // Invariant: Keep the old branch for the one-snapshot grace period.
          // This avoids a transient storage miss flashing main/the parent
          // before confirmation.
          Object.assign(nextNodes, missingSelection.retainedNodes);
        }
      }
    } else if (ownsSelection) {
      missingPolls = 0;
      missingSelection = null;
    }

    const previousNodes = state.nodes;
    const nextIds = new Set(Object.keys(nextNodes));
    for (const id of [...missingUiOwners]) {
      if (labelOf(id) !== label) continue;
      if (!nextIds.has(id)) conversationUiState.remove(id);
      missingUiOwners.delete(id);
    }
    for (const id of Object.keys(previousNodes))
      if (id !== selectedId && !nextIds.has(id)) missingUiOwners.add(id);
    state.nodes = nextNodes;
    runPollUi("Agent actions", () => refreshUpBtn(true));
    // Invariant: Listeners reclaim state for ids absent from the home tree,
    // so only home reads are authoritative for them.
    if (!label) {
      homeTreeKnown = true;
      window.dispatchEvent(new Event("recurse:tree-authoritative"));
    }
    for (const [id, node] of Object.entries(nextNodes)) {
      if (treeMutationNeedsUiRefresh(previousNodes[id], node))
        requestUiRefresh(id);
      else if (
        previousNodes[id] &&
        previousNodes[id].artifacts_revision !== node.artifacts_revision
      )
        requestArtifactsRefresh(id);
    }
    // Invariant: Deleted inactive conversations have no future selection
    // boundary at which to replace their stale browser preview.
    for (const id of [...state.convCache.keys()])
      if (!nextNodes[id] && id !== selectedId) state.convCache.delete(id);
    for (const id of Object.keys(prefetchedAt))
      if (!nextNodes[id]) delete prefetchedAt[id];
    for (const id of prefetchPlan(
      previousNodes,
      nextNodes,
      selectedId,
      prefetchInFlight,
      prefetchedAt,
      Date.now(),
    ))
      startRelatedPrefetch(id);
    applyPendingTitles();
    applyPendingTakeovers();
    applyPendingStops();
    treeReadSucceeded = true;

    // Invariant: Finish the chrome of a thread the focused read painted
    // before this tree arrived. Browser-only chrome like everything else in
    // this section, so a stale shell cannot turn a successful tree read into
    // a failed one.
    runPollUi("Conversation chrome", completeChromeFromTree);
    // Invariant: Paint the authoritative tree before boot restore, pane
    // discovery, skill cache work, or finder indexing. Those are useful
    // enhancements, but none may strand a phone with an empty tree after
    // /api/tree already succeeded.
    const beforeRestoreHash =
      JSON.stringify(arr) + state.selectedId + state.cursorId;
    if (
      beforeRestoreHash !== treeHashes.get(label) &&
      runPollUi("Agent tree", renderSidebar)
    )
      treeHashes.set(label, beforeRestoreHash);
    // Invariant: Publish search atomically from only the successful wire ids.
    // Deleted ids vanish immediately despite navigation's one-miss grace;
    // pending titles overlay only ids the server returned.
    runPollUi("Agent search", () =>
      refreshAgentMentionCache(
        label,
        arr.map((node) => state.nodes[node.id] || node),
      ),
    );
    const bootWasPending = bootRestorePending();
    runPollUi("Opening conversation", restoreBootSelection);
    // Invariant: A poll skips its focused read while boot restore is pending;
    // a remote snapshot that completes the restore reads the conversation.
    if (label && bootWasPending && !bootRestorePending()) void refreshConv();
    runPollUi("Skills", preloadSkills);
    if (selMissing && missingPolls >= 2) {
      const removedUiOwners = Object.keys(
        missingSelection?.retainedNodes || {},
      );
      const target = missingSelection
        ? resolveRemovalSelection(
            missingSelection.snapshot,
            new Set(Object.keys(state.nodes)),
          )
        : Object.keys(state.nodes)[0] || null;
      missingPolls = 0;
      missingSelection = null;
      // Invariant: Reclaiming a deleted selection is a correction, not a step
      // the reader took: the address bar follows, but Back must not return to
      // the link of an agent that no longer exists.
      const moved =
        !!target &&
        runPollUi("Conversation selection", () =>
          asHistoryCorrection(() => selectAgent(target, false)),
        );
      if (!target && !Object.keys(state.nodes).length)
        runPollUi("Empty agent list", clearSelectionForEmptyList);
      if (moved || !target)
        for (const id of removedUiOwners) conversationUiState.remove(id);
    }
    const h = JSON.stringify(arr) + state.selectedId + state.cursorId;
    if (h !== treeHashes.get(label) && runPollUi("Agent tree", renderSidebar))
      treeHashes.set(label, h);
  } catch {}
  return treeReadSucceeded;
}

// Starts every backend's tree read independently of the focused read, so a
// slow remote or focused read never holds back the home's tree.
function readTrees(force: boolean): Promise<boolean> {
  refreshRemoteTrees(commitTree, force);
  return treeOf(homeBackend).refresh((read) => commitTree("", read), force);
}

export function poll(): Promise<void> {
  return runPoll(false);
}

async function runPoll(force: boolean): Promise<void> {
  if (initialPollSettled && embeddedFrameHidden()) return;
  if (!force && polling && performance.now() - pollStartedAt < POLL_WEDGE_MS) {
    void readTrees(false);
    return;
  }
  polling = true;
  pollStartedAt = performance.now();
  const generation = ++pollGeneration;
  // Invariant: Focused and tree reads race; warming waits for focused
  // completion. Catch at creation: navigation can leave the promise unawaited,
  // and render faults must not become unhandled rejections.
  const earlyRead = bootRestorePending()
    ? null
    : refreshConv(generation).catch(() => false);
  // Invariant: A poll dispatches its focused read before its tree reads.
  const homeTree = readTrees(force);
  const readFor = state.selectedId;
  let treeReadSucceeded = false;
  let conversationReadSucceeded = false;
  try {
    treeReadSucceeded = await homeTree;
    // Invariant: Reclaiming a deleted selection navigates from inside the tree
    // read, so the parallel read is for the conversation that just went away.
    // Read the one the reader was moved to instead of leaving it unpainted
    // until the next poll.
    conversationReadSucceeded = await (earlyRead && state.selectedId === readFor
      ? earlyRead
      : refreshConv(generation));
    if (
      generation === pollGeneration &&
      treeReadSucceeded &&
      conversationReadSucceeded
    ) {
      resolveInitialAuthoritativeRead?.();
      resolveInitialAuthoritativeRead = null;
    }
  } catch {
  } finally {
    // Invariant: A tree failure must not leave the parallel read unobserved:
    // awaiting it keeps `polling` honest about what is still in flight.
    await earlyRead;
    // Invariant: A poll that got as far as settling has had its chance at the
    // focused read (a draft view never issues one), so cache warming may begin
    // either way.
    focusedPathReady();
    if (generation === pollGeneration) {
      polling = false;
      initialPollSettled = true;
    }
  }
}

// Foreground/pageshow forces a fresh poll past the in-flight guard because
// backgrounding can freeze fetches and pause timers indefinitely.
export function wake(): void {
  if (document.hidden || embeddedFrameHidden() || wakePollPending) return;
  wakePollPending = true;
  wakePaint = { id: state.selectedId, at: performance.now() };
  // Invariant: An open stream may have silently died while the phone slept.
  // Reconnect from the held cursor now, without waiting for EOF or backoff.
  closeFocusedEvents();
  retargetFocusedEvents(state.selectedId);
  void runPoll(true).finally(() => {
    wakePollPending = false;
  });
}
window.addEventListener("recurse:backends-change", () => {
  refreshRemoteTrees(commitTree);
  if (!homeTreeKnown) return;
  renderSidebar();
  refreshAgentMentionCache("");
  if (bootRestorePending()) {
    restoreBootSelection();
    void refreshConv();
  }
});
window.addEventListener("recurse:embedded-visibility", () => {
  if (embeddedFrameHidden()) closeFocusedEvents();
  else wake();
});
document.addEventListener("visibilitychange", wake);
window.addEventListener("focus", wake);
window.addEventListener("pageshow", wake);

// Cleared by refreshConv in fetch.ts when its focused read lands on the parked
// id: a successful read supersedes the parked terminal marker.
export function clearFocusedEventsGone(id: string): void {
  if (focusedEventsGone === id) focusedEventsGone = null;
}
