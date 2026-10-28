// Opening a conversation snaps its keyboard cursor; j/k only move that cursor.
// Keyed forest rows preserve DOM/scroll; tree_projection owns reveal policy.
// Rename/swipe gestures freeze repaint until completion.
import { startDraft } from "./composer.js";
import { sharedTrees, reloadChangedTreeLink } from "./shared-trees.js";
import { copyText } from "./tool_details.js";
import { remoteSectionHeader } from "./backends/discovery.js";
import { treeFor, treeOf } from "./backends/tree.js";
import {
  backendFor,
  backends,
  parseConversationId,
} from "./backends/backend.js";
import { html, render, nothing, type TemplateResult } from "lit";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
  currentUiOwnerId,
  state,
  visibleAgent,
  DRAFT,
  LAST_AGENT_KEY,
  embedded,
} from "./state.js";
import { $, listEl, titleEl, inputEl } from "./dom.js";
import {
  MESSAGE_ICON,
  NEW_ICON,
  SAFETY_OFF_ICON,
  TAKEN_OVER_ICON,
} from "./icons.js";
import { relTime, kidsBadge } from "./util.js";
import { isTakenOver } from "./active-agents.js";
import { attachHoldTip } from "./hold-tip.js";
import {
  presentAgentState,
  queuedDescription,
  queuedLabel,
} from "./agent-status.js";
import {
  abandonBackgroundWarming,
  refreshConv,
  showCached,
} from "./conversation/fetch.js";
import {
  noteConversationSwitch,
  renderEmptyAgentList,
} from "./conversation/chrome.js";
import { poll } from "./conversation/poll.js";
import { beginShowingConversation } from "./show-timing.js";
import { beginPaneVisit, syncPanes } from "./panes.js";
import { openArtifactLink } from "./artifacts/pane.js";
import { guardLeaveComments } from "./comments.js";
import {
  agentLinkUrl,
  treeLinkUrl,
  historyDisposition,
  readHistoryView,
  readAgentLink,
  type HistoryView,
} from "./deep-link.js";
import { requestUiStatus } from "./ui-events.js";
import { preloadSkills } from "./skills.js";
import {
  promoteComposerOwner,
  snapshotComposerOwner,
  switchComposerOwner,
} from "./composer/view-state.js";
import { conversationUiState } from "./conversation-ui-state/store.js";
import { TitleActionOrder } from "./title-actions.js";
import { focusFirst, installFocusTrap } from "./focus_trap.js";
import {
  ancestorIds,
  descendantIds,
  removalNeighbourIds,
  resolveConfirmedRemovalSelection,
  snapshotRemovalSelection,
  type RemovalSelectionSnapshot,
} from "./selection.js";
import {
  applySelectedRowReveal,
  nearestRowScrollTop,
  projectAgentForest,
  requestSelectedRowReveal,
  resolveHAction,
  resolveLAction,
  type TreeRelationship,
} from "./tree_projection.js";
import { canDrop, isValidDropTarget, reparentValidity } from "./reparent.js";
import type { TreeNode } from "./types.js";

interface TreeEntry {
  n?: TreeNode;
  draftRow?: boolean;
  depth: number;
  relationship?: TreeRelationship;
  hasChildren?: boolean;
  collapsed?: boolean;
}

let deleteArmed = false;
let disarmTimer = 0;
// Saved/deep-link selection keeps Delete until the first tree proves absence.
let treeSnapshotKnown = false;
// Marks correction rather than reader navigation for historyDisposition.
let correctingHistory = false;
let selectedRowReveal = requestSelectedRowReveal("");

const INDENT = 10;
const MAX_VISUAL_DEPTH = 6;
// Top-level folds default closed; selected lineage and h/l override.
const DEFAULT_FOLD_DEPTH = 0;
const RELATIONSHIP_DESCRIPTION: Record<TreeRelationship, string> = {
  current: "Current conversation",
  ancestor: "Top-level agent",
  parent: "Parent conversation",
  sibling: "Sibling agent",
  child: "Child agent",
};

// Live row dragging highlights imperatively and freezes repaint.
let dragSourceId: string | null = null;
let dragActive = false;

export const isArmed = (): boolean => deleteArmed;

// Frozen ranks prevent jumping; hourly resorts put newly born agents first.
let sortRank: Record<string, number> = {};
let sortRankAt = 0;
const RESORT_MS = 3600000;

function stableOrder(list: TreeNode[]): TreeNode[] {
  const now = Date.now();
  if (now - sortRankAt > RESORT_MS) {
    sortRank = {};
    const nodes = Object.values(state.nodes);
    nodes
      .sort(
        (a, b) =>
          (b.operator_message_at ?? b.updated) -
          (a.operator_message_at ?? a.updated),
      )
      .forEach((n, i) => {
        sortRank[n.id] = i;
      });
    if (nodes.length) sortRankAt = now;
  } else {
    // Invariant: New agents rank above frozen rows immediately, newest first.
    // Existing order stays untouched until the periodic resort.
    const fresh = list
      .filter((n) => !(n.id in sortRank))
      .sort((a, b) => a.updated - b.updated);
    if (fresh.length) {
      let top = Math.min(0, ...Object.values(sortRank));
      fresh.forEach((n) => {
        sortRank[n.id] = --top;
      });
    }
  }
  return list
    .slice()
    .sort((a, b) => (sortRank[a.id] ?? 0) - (sortRank[b.id] ?? 0));
}

// Parent edges drive indentation and collapse, but roots are still peers in
// one stable activity order. A draft sits after the selected row when possible.
function visibleTree(): TreeEntry[] {
  const out: TreeEntry[] = projectAgentForest(
    stableOrder(Object.values(state.nodes)).sort((a, b) => {
      const labels = backends().map((backend) => backend.label);
      return (
        labels.indexOf(parseConversationId(a.id).label) -
        labels.indexOf(parseConversationId(b.id).label)
      );
    }),
    state.selectedId,
    {
      collapsed: collapsedAnchor ? new Set([collapsedAnchor]) : undefined,
      autoCollapseDepth: DEFAULT_FOLD_DEPTH,
    },
  ).map((e) => ({
    n: e.node,
    depth: e.depth,
    relationship: e.relationship,
    hasChildren: e.hasChildren,
    collapsed: e.collapsed,
  }));
  if (state.draft) {
    const current = out.findIndex((e) => e.n?.id === state.selectedId);
    out.splice(current >= 0 ? current + 1 : 0, 0, {
      draftRow: true,
      depth: current >= 0 ? out[current].depth + 1 : 0,
    });
  }
  return out;
}

export function visibleRows(): TreeNode[] {
  return visibleTree().flatMap((e) => (e.n ? [e.n] : []));
}

function anchorId(): string {
  if (state.draft) return state.draft.parent || "";
  return state.selectedId && state.nodes[state.selectedId]
    ? state.selectedId
    : "";
}

let collapsedAnchor: string | null = null;
function anchorHasChildren(anchor: string): boolean {
  return (
    !!anchor &&
    Object.values(state.nodes).some((node) => node.parent === anchor)
  );
}

const TAKEN_OVER_TAG = html`<span
  class="takeover-tag"
  aria-hidden="true"
  title="Taken over by the operator"
  >${unsafeHTML(TAKEN_OVER_ICON)}</span
>`;
const SAFETY_OFF_TAG = html`<span
  class="safety-off-tag"
  role="img"
  title="DANGEROUSLY SKIPPING PERMISSIONS — per-action safety review off"
  aria-label="Dangerously skipping permissions: per-action safety review off"
  >${unsafeHTML(SAFETY_OFF_ICON)}</span
>`;
const treeAnnouncer = $<HTMLElement>("#tree-announcer")!;
function announceNode(n: TreeNode, action: string): void {
  const takenOver = isTakenOver(n);
  const status = presentAgentState(
    n.status,
    n.restart_parked,
    takenOver,
  ).description;
  const details = [
    action,
    n.title,
    status,
    n.queued ? queuedDescription(n.queued) : "",
  ].filter(Boolean);
  // Invariant: Reset first so moving away and back to the same row is announced
  // again.
  treeAnnouncer.textContent = "";
  treeAnnouncer.textContent = details.join(". ");
}

// Speak a one-off drag-move outcome into the same live region.
function announceMove(text: string): void {
  treeAnnouncer.textContent = "";
  treeAnnouncer.textContent = text;
}

// Agent ids key real rows; one fixed sentinel keys the draft row.
const rowKey = (e: TreeEntry): string => (e.draftRow ? "__draft__" : e.n!.id);

// One row: the not-yet-created draft placeholder, or a real agent node.
function rowT(
  e: TreeEntry,
  open?: (event: Event, id: string) => void,
): TemplateResult {
  const visualDepth = Math.min(e.depth, MAX_VISUAL_DEPTH);
  const indentPx = 8 + visualDepth * INDENT;
  const pad = styleMap(
    e.depth ? { paddingInlineStart: `min(${indentPx}px, 18vw)` } : {},
  );
  if (e.draftRow) {
    return html`<div
      class="agent cursor draft-row"
      style=${pad}
      role="treeitem"
      aria-label="New agent draft"
      @click=${() => {
        closeMobileSidebar();
        inputEl.focus();
      }}
    >
      <div class="row1">
        <span
          class="agent-state draft"
          role="img"
          aria-label="Draft agent"
          title="Draft agent"
          ><span class="state-mark" aria-hidden="true"></span
        ></span>
        <span class="title">New agent</span>
      </div>
    </div>`;
  }
  const n = e.n!;
  const takenOver = isTakenOver(n);
  const agentState = presentAgentState(
    n.status,
    n.restart_parked,
    takenOver,
    state.pendingStops[n.id] === true,
  );
  // Invariant: Idle take-over already owns the yellow status ring. Other states
  // keep their activity marker and get this independent tag instead.
  const showTakeoverTag = takenOver && agentState.key !== "taken-over";
  const cls =
    "agent" +
    (n.id === state.selectedId ? " selected" : "") +
    (!open && n.id === state.cursorId ? " cursor" : "") +
    (!open && deleteArmed && n.id === state.cursorId ? " armed" : "");
  const onClick = () => {
    if (touchActionHandled) {
      touchActionHandled = false;
      return;
    }
    if (n.id !== state.selectedId && !guardLeaveComments()) return;
    state.cursorId = n.id;
    selectAgent(n.id);
    closeMobileSidebar();
  };
  const onDbl = () => {
    if (n.id !== state.selectedId && !guardLeaveComments()) return;
    selectAgent(n.id);
  };
  // Invariant: data-id lets inline rename, swipe, and drag find this row. The
  // title is an interpolated text child (never innerHTML), so lit escapes it.
  const hasChildren = e.hasChildren ?? anchorHasChildren(n.id);
  const tag = unsafeStatic(open ? "button" : "div");
  return staticHtml`<${tag}
    class=${cls}
    type=${open ? "button" : nothing}
    style=${pad}
    data-id=${n.id}
    data-agent-id=${open ? n.id : nothing}
    role=${open ? nothing : "treeitem"}
    draggable=${open || parseConversationId(n.id).label ? nothing : "true"}
    aria-selected=${open ? nothing : n.id === state.cursorId ? "true" : "false"}
    aria-current=${n.id === state.selectedId ? "page" : nothing}
    aria-level=${open ? nothing : e.depth + 1}
    aria-expanded=${!open && hasChildren ? String(!e.collapsed) : nothing}
    aria-description=${
      e.relationship ? RELATIONSHIP_DESCRIPTION[e.relationship] : nothing
    }
    tabindex=${open || n.id === state.cursorId ? 0 : -1}
    @click=${open ? (event: Event) => open(event, n.id) : onClick}
    @dblclick=${open ? nothing : onDbl}
  >
    <div class="row1">
      <span
        class="agent-state ${agentState.key}"
        role="img"
        aria-label=${agentState.description}
        title=${agentState.description}
      >
        <span class="state-mark" aria-hidden="true"></span>
      </span>
      ${n.safety_off ? SAFETY_OFF_TAG : nothing}
      <span class="title">${n.title}</span>
      ${
        n.model
          ? html`<span class="agent-model" title=${n.model}
              >${n.model.split("/").at(-1)}</span
            >`
          : nothing
      }
      ${
        n.children
          ? html`<span
              class="badge accent kids"
              title=${`${n.children} subagent${n.children > 1 ? "s" : ""}`}
              >${unsafeHTML(kidsBadge(n.children))}</span
            >`
          : nothing
      }
      ${showTakeoverTag ? TAKEN_OVER_TAG : nothing}
      ${
        n.queued
          ? html`<span
              class="badge warn queue-badge"
              role="img"
              aria-label=${queuedDescription(n.queued)}
              title=${queuedDescription(n.queued)}
            >
              <span aria-hidden="true">${queuedLabel(n.queued)}</span>
              ${unsafeHTML(MESSAGE_ICON)}
            </span>`
          : nothing
      }
      <span class="time" title="Last activity ${relTime(n.updated)}"
        >${relTime(n.updated)}</span
      >
    </div>
  </${tag}>`;
}

/** Sidebar rows reused by the active-agent dialog, without tree gestures. */
export function activeAgentRowT(
  node: TreeNode,
  depth: number,
  open: (event: Event, id: string) => void,
): TemplateResult {
  return rowT({ n: node, depth }, open);
}

export function renderSidebar(): void {
  // Invariant: Repainting during imperative rename/swipe would destroy input or
  // overwrite live gesture classes. Freeze until the interaction completes.
  if (renaming || (swipe && swipe.active) || dragActive) return;
  if (
    !state.nodes[state.cursorId] &&
    state.nodes[state.selectedId] &&
    ![...pendingDeletes.values()].some(
      (op) => !op.confirmed && op.removedIds.includes(state.cursorId),
    )
  ) {
    state.cursorId = state.selectedId;
    window.dispatchEvent(new Event("recurse:selection-change"));
    disarmDelete();
  }
  const sharedLabel = $("#shared-tree-status")!;
  sharedLabel.hidden = sharedTrees === null;
  const rootCount = Object.values(state.nodes).filter(
    (node) => !node.parent,
  ).length;
  sharedLabel.textContent = rootCount
    ? `${rootCount} shared conversation${rootCount === 1 ? "" : "s"}`
    : "Shared conversations are unavailable.";
  const entries = visibleTree();
  const rows = entries.flatMap((e) => (e.n ? [e.n] : []));
  // Invariant: A vanished cursor cannot retain an armed delete.
  if (deleteArmed && !rows.find((n) => n.id === state.cursorId)) {
    deleteArmed = false;
    clearTimeout(disarmTimer);
    titleEl.classList.remove("armed");
  }
  // Invariant: One section per backend, in backends() order; the home's rows
  // sit directly in the list, each remote's below its divider and header.
  render(
    html`${repeat(
      backends().filter(
        (backend) =>
          sharedTrees === null ||
          entries.some(
            (entry) =>
              entry.n &&
              parseConversationId(entry.n.id).label === backend.label,
          ),
      ),
      (backend) => backend.label,
      (backend) => {
        const { label } = backend;
        const sectionRows = repeat(
          entries.filter((e) =>
            e.draftRow
              ? (state.draft?.backendLabel ?? "") === label
              : parseConversationId(e.n!.id).label === label,
          ),
          rowKey,
          (entry) => rowT(entry),
        );
        if (!label) return sectionRows;
        const connected = treeOf(backend).status === "connected";
        return html`<section
          class="backend-section"
          data-backend=${label}
          role="group"
          aria-label=${label}
        >
          <hr />
          <div class="backend-section-header">
            ${remoteSectionHeader(backend)}
            <button
              class="icon-btn lg backend-new-agent"
              aria-label=${`New agent on ${label}`}
              title=${connected
                ? `New agent on ${label}`
                : `${label} is offline`}
              ?disabled=${!connected}
              ?hidden=${sharedTrees !== null}
              @click=${() => startDraft({ parent: null, backendLabel: label })}
            >
              ${unsafeHTML(NEW_ICON)}
            </button>
          </div>
          ${sectionRows}
        </section>`;
      },
    )}`,
    listEl,
  );

  // Invariant: Opening gets one centring pass after keyed row creation. Polls
  // never recenter or override scrolling; DOM focus remains untouched.
  selectedRowReveal = applySelectedRowReveal(
    selectedRowReveal,
    rows.map((n) => n.id),
    listEl,
    (id) =>
      listEl.querySelector<HTMLElement>(`.agent[data-id="${CSS.escape(id)}"]`),
  );
}

window.addEventListener("recurse:stop-pending", () => renderSidebar());

export function selectAgent(
  id: string,
  refetch = true,
  preserveAttachments = false,
  skipComposerSnapshot = false,
): void {
  if (id !== state.selectedId) disarmDelete();
  if (id !== state.cursorId || id !== state.selectedId)
    window.dispatchEvent(new Event("recurse:selection-change"));
  const treeFocused = listEl.contains(document.activeElement);
  const outgoing = state.selectedId;
  const outgoingUiOwner = currentUiOwnerId();
  // Invariant: The field still belongs to the outgoing owner here. Snapshot
  // before any selectedId/draft mutation so even a cold async navigation cannot
  // retarget it.
  if (!skipComposerSnapshot) snapshotComposerOwner(outgoingUiOwner);
  // Invariant: Staged files switch through the same owner lifecycle as text.
  // Saved owners stay cached; an unreachable draft is disposed by dropPrevious
  // below, while draft promotion transfers both views to the newly created
  // conversation.
  state.draft = null;
  collapsedAnchor = null;
  state.selectedId = id;
  state.cursorId = id;
  if (outgoing === DRAFT && preserveAttachments) promoteComposerOwner(id);
  else switchComposerOwner(id, outgoing === DRAFT);
  if (state.nodes[id]) announceNode(state.nodes[id], "Opened conversation");
  selectedRowReveal = requestSelectedRowReveal(id);
  state.openConvHash = "";
  // Invariant: Retarget panels at selection before any cold/failed fetch.
  // Withhold mismatched currentConv; render panels only after their thread data
  // so prior-agent controls and late responses never act on a new selection.
  beginPaneVisit(id);
  // Invariant: Navigation aborts departed warming/probes to free focused reads.
  // Re-selecting the same conversation keeps still-relevant work.
  if (id !== outgoing) abandonBackgroundWarming();
  // Invariant: Only a navigation that will read this conversation is an
  // interaction worth timing. Reclaiming a deleted selection passes
  // refetch=false, and recording it would put a switch nobody asked for into
  // the reported numbers.
  if (id !== DRAFT && refetch) beginShowingConversation(id);
  // Invariant: Never inherit the previously-open agent's Stop eligibility
  // across a cache miss: stop actions always target the open conversation,
  // never stale chrome.
  const cached = state.convCache.peek(id);
  state.selectedRunning =
    Boolean(cached?.active_run) || cached?.status === "running";
  if (!cached) state.currentConv = null;
  if (id !== DRAFT && !embedded) {
    try {
      localStorage.setItem(LAST_AGENT_KEY, id);
    } catch {}
  }
  // Invariant: Warm cached threads stay interactive while reconciling. Cold
  // switches stand down old chrome; owner-preserving draft promotion is already
  // this conversation and must never dim or become inert.
  if (id !== DRAFT)
    noteConversationSwitch(id, showCached(id) || preserveAttachments);
  preloadSkills();
  // Invariant: Start the focused read BEFORE rendering the panels. It holds the
  // background queue for its whole flight, so a closed panel's availability
  // probe is queued behind it instead of taking a connection ahead of it.
  if (refetch) refreshConv();
  syncPanes();
  renderSidebar();
  if (treeFocused) focusAgentTree();
  syncHistoryToSelection();
  refreshUpBtn();
}

// Climbs the live routing parent via goUp; browser Back remains a separate
// return-to-previous-view action, regardless of navigation depth.
export function currentParent(): string | null {
  if (state.draft) return state.draft.parent;
  if (!state.selectedId || state.selectedId === DRAFT) return null;
  return (
    state.nodes[state.selectedId]?.parent ||
    pendingDeleteParent(state.selectedId) ||
    null
  );
}
export function goUp(): boolean {
  const target = currentParent();
  if (!target) return false;
  if (!guardLeaveComments()) return false;
  closeMobileSidebar();
  selectAgent(target);
  return true;
}

// One history entry per opened view supports sharing, Back and Forward. Default
// Back leaves the app; goUp remains the explicit parent climb.
function currentHistoryView(): HistoryView {
  if (state.draft || state.selectedId === DRAFT)
    return { agent: currentParent() || "", draft: true };
  return { agent: state.selectedId, draft: false };
}

export function syncHistoryToSelection(): void {
  const next = currentHistoryView();
  const entry = readHistoryView(history.state, location.hash);
  const base =
    history.state && typeof history.state === "object" ? history.state : {};
  const stamped = { ...base, recurseView: next };
  const url = agentLinkUrl(location.href, next.agent, correctingHistory);
  try {
    // Invariant: A frame's entries would join the parent page's Back stack.
    if (
      !embedded &&
      historyDisposition(entry, next, correctingHistory) === "push"
    )
      history.pushState(stamped, "", url);
    else history.replaceState(stamped, "", url);
  } catch {}
}

// Corrects the current history entry without creating an unchosen Back step.
// Used by boot restore, history replay, deletion and login recovery.
export function asHistoryCorrection<T>(select: () => T): T {
  correctingHistory = true;
  try {
    return select();
  } finally {
    correctingHistory = false;
  }
}

// Make the address bar name the current view without navigating.
export function canonicalizeAgentUrl(): void {
  asHistoryCorrection(syncHistoryToSelection);
}

// Unopenable history entries remain addressable across transient tree misses.
// Only rejected cold-load links strip: there is no prior entry worth
// preserving.
function keepEntryAddressing(view: HistoryView): void {
  const base =
    history.state && typeof history.state === "object" ? history.state : {};
  try {
    history.replaceState(
      { ...base, recurseView: view },
      "",
      agentLinkUrl(location.href, view.agent),
    );
  } catch {}
}

export function reportAgentUnavailable(): void {
  // Invariant: Deliberately one message for unknown, malformed, deleted, and
  // no-longer- visible ids: the reader learns the link cannot be opened, and
  // nothing distinguishes an agent that never existed from one that is not
  // theirs.
  requestUiStatus("That agent link is not available");
}

// URL traversals can be undone for unsent work; app push/replace fire no event.
let lastHandledEntry = "";
const LINK_WAIT_MS = 5000;
/** Open embedded link {id} once a tree read lists it, or fail after 5 s. */
function openWhenListed(id: string, traversed: boolean): void {
  const hash = location.hash;
  const finish = () => {
    removeEventListener("recurse:tree-authoritative", listed);
    clearTimeout(bound);
    if (location.hash === hash) openHistoryEntry(traversed, true);
  };
  const listed = () => visibleAgent(id) && finish();
  const bound = setTimeout(finish, LINK_WAIT_MS);
  addEventListener("recurse:tree-authoritative", listed);
  void poll();
}
function openHistoryEntry(traversed: boolean, listed = false): void {
  if (reloadChangedTreeLink()) return;
  // Invariant: Before the first tree read nothing can be resolved, and boot
  // restore will consume whatever the URL says. Leave both the selection and
  // the URL alone rather than reporting an agent unavailable that was simply
  // not read yet.
  const fallback = visibleRows()[0]?.id;
  if (!fallback) return;
  const entry = readHistoryView(history.state, location.hash);
  if (!readAgentLink(location.hash).present)
    entry.agent = state.selectedId || fallback;
  const known = visibleAgent(entry.agent);
  if (embedded && !known && !listed && readAgentLink(location.hash).present)
    return openWhenListed(entry.agent, traversed);
  const target = known ? entry.agent : fallback;
  // Invariant: Deduplicate navigation by full input and unchanged outgoing
  // view. Popstate/hashchange describe one traversal; later same-URL navigation
  // still counts, while refusals and unavailable notices happen only once.
  const current = currentHistoryView();
  const handled = [
    location.href,
    entry.agent,
    entry.draft,
    current.agent,
    current.draft,
  ].join("\u0000");
  if (handled === lastHandledEntry) return;
  lastHandledEntry = handled;
  // Invariant: Draft-ness distinguishes real moves even when agent ids match.
  // Leaving a draft for its parent differs from revisiting that draft's entry.
  if (target === current.agent && entry.draft === current.draft) {
    if (known) canonicalizeAgentUrl();
    else {
      keepEntryAddressing(entry);
      reportAgentUnavailable();
    }
    openArtifactLink();
    return;
  }
  // Invariant: Unsent comments undo refused navigation, never push
  // replacements. Repeated Back must not grow history or discard the original
  // entry.
  if (!guardLeaveComments()) {
    if (traversed) history.go(1);
    else history.back();
    return;
  }
  closeMobileSidebar();
  asHistoryCorrection(() => selectAgent(target));
  if (known) openArtifactLink();
  if (!known) {
    keepEntryAddressing(entry);
    reportAgentUnavailable();
  }
}
window.addEventListener("popstate", () => openHistoryEntry(true));
window.addEventListener("hashchange", () => openHistoryEntry(false));

export function treeAscendOrCollapse(): void {
  const anchor = anchorId();
  const action = resolveHAction(
    state.cursorId,
    anchor,
    anchorHasChildren(anchor),
    collapsedAnchor === anchor,
  );
  if (action === "collapse") {
    collapsedAnchor = anchor;
    renderSidebar();
    if (state.nodes[anchor])
      announceNode(state.nodes[anchor], "Collapsed subagents");
    return;
  }
  const up = currentParent();
  if (up && guardLeaveComments()) selectAgent(up);
}

export function treeExpandIfCollapsed(): boolean {
  const anchor = anchorId();
  if (
    resolveLAction(state.cursorId, anchor, collapsedAnchor === anchor) !==
    "expand"
  )
    return false;
  collapsedAnchor = null;
  renderSidebar();
  if (state.nodes[anchor])
    announceNode(state.nodes[anchor], "Expanded subagents");
  return true;
}

export function focusAgentTree(): boolean {
  renderSidebar();
  const row = listEl.querySelector<HTMLElement>(
    `.agent[data-id="${CSS.escape(state.cursorId)}"]`,
  );
  row?.focus();
  return !!row && document.activeElement === row;
}

export function restoreAgentFocus(): boolean {
  if (focusAgentTree()) return true;
  if (!matchMedia("(max-width: 700px)").matches) return false;
  const menu = document.getElementById("menu-btn");
  menu?.focus();
  return document.activeElement === menu;
}

export function moveCursor(id: string): void {
  if (id !== state.cursorId)
    window.dispatchEvent(new Event("recurse:selection-change"));
  const treeFocused = listEl.contains(document.activeElement);
  state.cursorId = id;
  if (state.nodes[id]) announceNode(state.nodes[id], "Agent cursor");
  renderSidebar();
  // Invariant: Minimal explicit scroll keeps the cursor visible without
  // stealing Normal-mode focus; tree-held focus suppresses competing browser
  // scrolling.
  revealCursorRowNearest(id);
  if (treeFocused)
    listEl
      .querySelector<HTMLElement>(`.agent[data-id="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true });
}

// Bring the cursor row into view within the sidebar list only — never the page
// or composer — and only when it's off-screen.
function revealCursorRowNearest(id: string): void {
  const row = listEl.querySelector<HTMLElement>(
    `.agent[data-id="${CSS.escape(id)}"]`,
  );
  if (!row) return;
  const listRect = listEl.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const nextScrollTop = nearestRowScrollTop(
    listRect.top,
    listEl.clientHeight,
    listEl.scrollTop,
    rowRect.top,
    rowRect.height,
  );
  if (nextScrollTop !== listEl.scrollTop) listEl.scrollTop = nextScrollTop;
}

// Arms then confirms modifier-X deletion of the painted cursor target. Any
// other key/click or timeout disarms, preventing stray destructive chords.
export function armDelete(timeoutMs = 3000): void {
  if (!state.nodes[state.cursorId]) return;
  deleteArmed = true;
  const target = state.nodes[state.cursorId];
  if (target)
    announceNode(
      target,
      "Delete armed; press the delete shortcut again to confirm",
    );
  const onOpen = state.cursorId === state.selectedId;
  titleEl.classList.toggle("armed", onOpen);
  trashBtn.classList.toggle("armed", onOpen);
  trashBtn.querySelector(".action-label")!.textContent = onOpen
    ? "Confirm delete agent and descendants"
    : "Delete";
  if (onOpen) trashHold.pin();
  renderSidebar();
  clearTimeout(disarmTimer);
  if (timeoutMs > 0)
    disarmTimer = setTimeout(disarmDelete, timeoutMs) as unknown as number;
}
export function disarmDelete(): void {
  if (!deleteArmed) return;
  deleteArmed = false;
  clearTimeout(disarmTimer);
  titleEl.classList.remove("armed");
  trashBtn.classList.remove("armed");
  trashBtn.querySelector(".action-label")!.textContent = "Delete";
  trashHold.hide();
  renderSidebar();
}
document.addEventListener(
  "click",
  (e) => {
    // Invariant: Capture runs before Delete's arm/confirm handler.
    // Exempt its button or the confirming tap would be disarmed first.
    if ((e.target as HTMLElement | null)?.closest?.("#trash-btn")) return;
    disarmDelete();
  },
  true,
);

export function killSelected(): void {
  killAgent(state.cursorId);
}

interface PendingDelete {
  removedIds: string[];
  removedNodes: Record<string, TreeNode>;
  selection: RemovalSelectionSnapshot | null;
  parentIds: string[];
  neighbourIds: string[];
  treeFocused: boolean;
  confirmed: boolean;
}

// Delete tombstones persist until a post-success tree omits the root.
const pendingDeletes = new Map<string, PendingDelete>();
// Accepted deletes hide until omitted or parked, never masking later failures.
const deletionTombstones = new Set<string>();
function pendingDeleteParent(id: string): string | null {
  for (const op of pendingDeletes.values()) {
    if (op.confirmed || op.selection?.selectedId !== id) continue;
    for (const parent of op.parentIds) if (state.nodes[parent]) return parent;
    return visibleRows()[0]?.id || null;
  }
  return null;
}
function withoutPendingDeletes(
  nodes: TreeNode[],
  authoritative: string | null = null,
): TreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Invariant: Only authoritative tree omissions release completed tombstones,
  // and only for rows of the backend whose tree this is. Parked failures become
  // visible; synthetic refusal rollback cannot release omitted masks for
  // overlapping operations.
  if (authoritative !== null) {
    for (const id of deletionTombstones) {
      if (parseConversationId(id).label !== authoritative) continue;
      const node = byId.get(id);
      if (!node || node.status !== "deleting") deletionTombstones.delete(id);
    }
  }
  const blocked = new Set(deletionTombstones);
  for (const node of nodes) {
    if (node.status === "deleting") blocked.add(node.id);
  }
  for (const op of pendingDeletes.values())
    for (const id of op.removedIds) blocked.add(id);
  const hasBlockedAncestor = (node: TreeNode): boolean => {
    const seen = new Set<string>();
    let parent = node.parent;
    while (parent && !seen.has(parent)) {
      if (blocked.has(parent)) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parent || null;
    }
    return false;
  };
  return nodes.filter((n) => !blocked.has(n.id) && !hasBlockedAncestor(n));
}
/** Masks one backend's tree read (home: ""), releasing only its own rows. */
export function applyPendingDeleteMasks(
  nodes: TreeNode[],
  label = "",
): TreeNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  for (const [root, op] of pendingDeletes) {
    if (
      op.confirmed &&
      parseConversationId(root).label === label &&
      op.removedIds.every((id) => !ids.has(id))
    )
      pendingDeletes.delete(root);
  }
  return withoutPendingDeletes(nodes, label);
}

// An explicit delete may leave selectedId pointing at its optimistic tombstone
// until the server confirms success. Tree reconciliation must not treat that
// deliberate gap as an unrelated disappearance and steal focus to a sibling.
export function hasPendingDeleteSelection(id: string): boolean {
  return [...pendingDeletes.values()].some(
    (op) => !op.confirmed && op.selection?.selectedId === id,
  );
}

// Keyboard and swipe deletion share the same confirmation and navigation path.
// A refused deletion carries the server's own diagnostic: prefer it, fall
// back to the bare status, and keep the line bounded for the status banner.
export function deleteFailureMessage(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail !== "string" || !detail) return `HTTP ${status}`;
  return detail.length > 240 ? detail.slice(0, 239) + "…" : detail;
}

class DeleteRefused extends Error {}

export function killAgent(dying: string | null | undefined): void {
  if (!dying || !state.nodes[dying]) return;
  trashHold.hide();
  const before = { ...state.nodes };
  const removedIds = descendantIds(before, dying);
  const removedNodes = Object.fromEntries(
    removedIds.map((id) => [id, before[id]]),
  );
  const selection = snapshotRemovalSelection(
    visibleRows().map((n) => n.id),
    removedIds,
    state.selectedId,
  );
  const op: PendingDelete = {
    removedIds,
    removedNodes,
    selection,
    parentIds: selection ? ancestorIds(before, selection.selectedId) : [],
    neighbourIds: selection
      ? removalNeighbourIds(before, selection.order, selection.selectedId)
      : [],
    treeFocused: listEl.contains(document.activeElement),
    confirmed: false,
  };
  pendingDeletes.set(dying, op);

  // Invariant: Hide the branch optimistically, but leave selectedId untouched.
  // Navigation happens only after the server confirms the delete below, so a
  // slow teardown cannot replace the conversation the operator is still
  // reading.
  for (const id of removedIds) delete state.nodes[id];
  renderSidebar();

  treeFor(dying)?.invalidate();
  backendFor(dying)
    .api(
      "/api/conversations/" + dying,
      { method: "DELETE" },
      { timeoutMs: 30_000 },
    )
    .then(async (r) => {
      // Invariant: Accepted 200/202 deletes settle selection against surviving
      // rows. Reclaim removed UI owners after navigation; refusal never changes
      // selection.
      const settleRemovalSelection = (): void => {
        // Invariant: Navigate first: switching composer owners snapshots the
        // outgoing UI state, so reclaim deleted owners after the switch rather
        // than writing one back.
        try {
          const target = resolveConfirmedRemovalSelection(
            selection?.selectedId ?? null,
            op.neighbourIds,
            state.selectedId,
            new Set(Object.keys(state.nodes)),
          );
          if (target) {
            selectAgent(target);
          } else if (
            selection?.selectedId === state.selectedId &&
            !Object.keys(state.nodes).length
          ) {
            state.selectedId = "";
            state.cursorId = "";
            state.currentConv = null;
            state.openConvHash = "";
            try {
              localStorage.removeItem(LAST_AGENT_KEY);
            } catch {}
            renderEmptyAgentList();
            renderSidebar();
            syncHistoryToSelection();
            refreshUpBtn();
          }
          renderSidebar();
          if (op.treeFocused) focusAgentTree();
        } finally {
          for (const id of removedIds) conversationUiState.remove(id);
        }
      };
      if (r.status === 202) {
        // Invariant: Accepted async deletion stays hidden until omission/parked
        // failure. Mark confirmed before UI work so a paint error cannot undo
        // server acceptance.
        for (const id of removedIds) deletionTombstones.add(id);
        op.confirmed = true;
        settleRemovalSelection();
        pendingDeletes.delete(dying);
        const title = op.removedNodes[dying]?.title || "agent";
        announceMove(`Deleting ${title}: the backend is removing it`);
        renderSidebar();
        return;
      }
      if (!r.ok) {
        // Invariant: The server refuses some deletions (a missing row, an auth
        // or transport error). Surface its reason instead of silently restoring
        // the row.
        const body = await r.json().catch(() => null);
        throw new DeleteRefused(deleteFailureMessage(r.status, body));
      }
      op.confirmed = true;
      settleRemovalSelection();
    })
    .catch((error: unknown) => {
      // Invariant: A server-confirmed delete is final even if a best-effort UI
      // update throws.
      if (op.confirmed) return;
      // Invariant: Restoring the row is not enough: name the refusal where the
      // operator can see it, with the server's own diagnostic for
      // inspectability.
      const reason = error instanceof DeleteRefused ? error.message : "";
      const title = op.removedNodes[dying]?.title || "agent";
      announceMove(`Deleting ${title} failed${reason ? ": " + reason : ""}`);
      requestUiStatus("Delete failed");
      // Invariant: Restore only this operation's nodes, then reapply any
      // overlapping/newer tombstones. A failed request never changes the
      // current selection.
      pendingDeletes.delete(dying);
      state.nodes = Object.fromEntries(
        withoutPendingDeletes(
          Object.values({ ...state.nodes, ...op.removedNodes }),
        ).map((n) => [n.id, n]),
      );
      if (!state.nodes[state.cursorId] && state.nodes[state.selectedId])
        state.cursorId = state.selectedId;
      renderSidebar();
    })
    .finally(() => poll());
}

interface PendingReparent {
  to: string;
}
const pendingReparents = new Map<string, PendingReparent>();

// Masks moving parents until reflected or source/target disappears. Apply-time
// rejection must release the mask, never pin a row beneath a dead id.
export function applyPendingReparentMasks(nodes: TreeNode[]): TreeNode[] {
  for (const [source, op] of pendingReparents) {
    const node = nodes.find((n) => n.id === source);
    if (!node) {
      pendingReparents.delete(source);
      continue;
    }
    if (node.parent === op.to) {
      pendingReparents.delete(source);
      continue;
    }
    if (!nodes.some((n) => n.id === op.to)) {
      pendingReparents.delete(source);
      continue;
    }
    node.parent = op.to;
  }
  return nodes;
}

export function reparentAgent(source: string, target: string): void {
  // Invariant: Agents never move between backends or within a remote.
  if (parseConversationId(source).label || parseConversationId(target).label)
    return;
  const node = state.nodes[source];
  if (!node || !canDrop(state.nodes, source, target)) return;
  if (node.parent === target) return;
  const from = node.parent;
  const targetTitle = state.nodes[target]?.title || target;
  const op: PendingReparent = { to: target };
  pendingReparents.set(source, op);
  node.parent = target;
  selectAgent(source);
  announceMove(`Moved ${node.title} under ${targetTitle}`);
  backendFor(source)
    .jpost(`/api/conversations/${source}/reparent`, {
      parent: target ? parseConversationId(target).cid : target,
    })
    .then((r) => {
      if (!r.ok) throw new Error(`reparent failed (${r.status})`);
    })
    .catch(() => {
      pendingReparents.delete(source);
      if (state.nodes[source]) state.nodes[source].parent = from;
      announceMove(`Move of ${node.title} was rejected`);
      renderSidebar();
    })
    .finally(() => poll());
}

const shareBtn = $<HTMLButtonElement>("#share-link-btn")!;
let shareNoticeTimer = 0;
shareBtn.onclick = async () => {
  let node = state.nodes[state.selectedId];
  if (!node) return;
  const seen = new Set<string>();
  while (node.parent && state.nodes[node.parent] && !seen.has(node.id)) {
    seen.add(node.id);
    node = state.nodes[node.parent];
  }
  const copied = await copyText(treeLinkUrl(location.href, [node.id]));
  const notice = $("#share-link-status")!;
  notice.textContent = copied ? "Link copied" : "Could not copy link";
  notice.hidden = false;
  clearTimeout(shareNoticeTimer);
  shareNoticeTimer = window.setTimeout(() => {
    notice.hidden = true;
  }, 1800);
};

// ---------------- up-to-parent button (visible twin of the phone back button)
const upBtn = $("#up-btn")!;
upBtn.onclick = goUp;
const upTop = $("#up-top")!;
upTop.onclick = goUp;

// Touch Delete arms/confirms only the painted open agent and its subtree.
const trashBtn = $<HTMLButtonElement>("#trash-btn")!;
// Arm flag owns confirmation; holds reveal only, with no redundant menu tip.
const trashHold = attachHoldTip(trashBtn, document, {
  text: () =>
    trashBtn.closest("#pane-menu")
      ? null
      : trashBtn.classList.contains("on")
        ? isArmed()
          ? "Tap again to delete this agent and all its descendants"
          : "Delete this agent and all its descendants"
        : null,
  enabled: () => trashBtn.classList.contains("on"),
  onHoldEnd: () => {
    // Invariant: A held peek cannot leave the next tap armed for deletion.
    disarmDelete();
    trashHold.show();
  },
});
trashBtn.onclick = () => {
  if (trashHold.takeHoldConsumed()) return;
  if (isArmed() && state.cursorId === state.selectedId) {
    disarmDelete();
    killAgent(state.selectedId);
  } else {
    disarmDelete();
    state.cursorId = state.selectedId;
    armDelete();
  }
};

export function refreshUpBtn(authoritativeTree = false): void {
  if (authoritativeTree) treeSnapshotKnown = true;
  const hasParent = currentParent() !== null;
  upBtn.classList.toggle("on", hasParent);
  upTop.classList.toggle("on", hasParent);
  const selectedSaved = !!state.selectedId && state.selectedId !== DRAFT;
  const cachedSelection = selectedSaved
    ? state.convCache.peek(state.selectedId)
    : undefined;
  const savedAgent =
    selectedSaved &&
    (visibleAgent(state.selectedId) ||
      // Invariant: Before the first tree response, a selected deep link or
      // cached conversation is enough to show the affordance. Once a response
      // lands, only its own rows keep it visible.
      (!treeSnapshotKnown &&
        (cachedSelection !== undefined || state.selectedId !== "")));

  shareBtn.hidden = !savedAgent;
  trashBtn.classList.toggle("on", savedAgent);
  trashHold.sync();
}

// ---------------- mobile: off-canvas sidebar
const sidebar = $("#sidebar")!,
  backdrop = $("#backdrop")!;
const menuBtn = $<HTMLButtonElement>("#menu-btn")!;
const mobileMedia = window.matchMedia("(max-width: 700px)");
function syncMobileSidebarAccess(): void {
  if (!window.matchMedia("(max-width: 700px)").matches) {
    sidebar.inert = false;
    sidebar.removeAttribute("aria-hidden");
    sidebar.classList.remove("open");
    backdrop.classList.remove("on");
    menuBtn.setAttribute(
      "aria-expanded",
      String(!sidebar.classList.contains("desktop-hidden")),
    );
    return;
  }
  const open = sidebar.classList.contains("open");
  sidebar.inert = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
}
function restoreSidebarFocus(): void {
  if (window.matchMedia("(max-width: 700px)").matches) menuBtn.focus();
}
// Instant close commits before mobile input focus can freeze a transition.
// Normal backdrop closes retain animation; keyboard resize must not leave the
// sidebar half-open.
export function mobileSidebarOpen(): boolean {
  return sidebar.classList.contains("open");
}
export function closeMobileSidebar(instant?: boolean, restore = false): void {
  const wasOpen = mobileSidebarOpen();
  const focusInside = wasOpen && sidebar.contains(document.activeElement);
  if (instant) sidebar.style.transition = "none";
  sidebar.classList.remove("open");
  backdrop.classList.remove("on");
  menuBtn.setAttribute("aria-expanded", "false");
  syncMobileSidebarAccess();
  if (instant) {
    void sidebar.offsetWidth;
    sidebar.style.transition = "";
  }
  if (wasOpen && (focusInside || restore)) restoreSidebarFocus();
}
function openMobileSidebar(): void {
  sidebar.classList.add("open");
  backdrop.classList.add("on");
  menuBtn.setAttribute("aria-expanded", "true");
  syncMobileSidebarAccess();
  focusFirst(sidebar);
}
menuBtn.onclick = () => {
  if (!mobileMedia.matches) {
    const hidden = sidebar.classList.toggle("desktop-hidden");
    menuBtn.setAttribute("aria-expanded", String(!hidden));
    return;
  }
  mobileSidebarOpen() ? closeMobileSidebar() : openMobileSidebar();
};

installFocusTrap(sidebar, mobileSidebarOpen);
mobileMedia.addEventListener("change", syncMobileSidebarAccess);
window.addEventListener("resize", syncMobileSidebarAccess, { passive: true });
window.visualViewport?.addEventListener("resize", syncMobileSidebarAccess, {
  passive: true,
});

syncMobileSidebarAccess();
backdrop.onclick = () => closeMobileSidebar(true, true);

// Optimistic F2/touch rename survives polls, waiting for running settle.
let renaming: string | null = null;
let finishRename: ((commit: boolean) => void) | null = null;
const titleActions = new TitleActionOrder();

export function isRenaming(): boolean {
  return renaming !== null;
}
export function cancelRename(): boolean {
  if (!finishRename) return false;
  finishRename(false);
  return true;
}
export function commitRename(): boolean {
  if (!finishRename) return false;
  finishRename(true);
  return true;
}

export function startRename(id: string): void {
  if (renaming) return;
  const n = id && id !== DRAFT ? state.nodes[id] : null;
  if (!n) return;
  const row = listEl.querySelector(`.agent[data-id="${CSS.escape(id)}"]`);
  const titleSpan = row && row.querySelector<HTMLElement>(".title");
  if (!titleSpan) return;
  renaming = id;
  const orig = n.title || "";
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = orig;
  input.spellcheck = false;
  input.setAttribute("aria-label", `Rename ${orig}`);
  titleSpan.style.display = "none";
  titleSpan.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    renaming = null;
    finishRename = null;
    // Invariant: Keyed rows do not rebuild swapped input/title nodes. Undo the
    // imperative edit DOM before repainting the new title.
    input.remove();
    titleSpan.style.display = "";
    const val = input.value.trim();
    if (commit && val && val !== orig) {
      const action = titleActions.begin(id);
      state.pendingTitles[id] = {
        title: val,
        acknowledged: false,
        waitForSettle: false,
      };
      if (state.nodes[id]) {
        state.nodes[id].title = val;
      }
      backendFor(id)
        .jpost(`/api/conversations/${id}/rename`, {
          title: val,
          title_order: action.order,
        })
        .then(async (r) => {
          if (!r.ok) throw new Error("rename failed");
          // Invariant: Reconcile to the normalized stored title, not raw input.
          // Whitespace/length normalization can otherwise pin a stale overlay
          // forever; a newer rename always wins.
          const { title, superseded, pending } = (await r.json()) as {
            title: string;
            superseded?: boolean;
            pending?: boolean;
          };
          const optimistic = state.pendingTitles[id];
          if (!titleActions.isCurrent(id, action) || optimistic?.title !== val)
            return;
          if (superseded) {
            delete state.pendingTitles[id];
          } else if (pending) {
            state.pendingTitles[id] = {
              title,
              acknowledged: true,
              waitForSettle: true,
            };
          } else {
            // Invariant: The backend applied an idle rename before replying.
            // Keep the acknowledged overlay through the next causal tree
            // reconciliation so the open conversation's older cached title
            // cannot flash back.
            state.pendingTitles[id] = {
              title,
              acknowledged: true,
              waitForSettle: false,
            };
          }
          if (state.nodes[id]) state.nodes[id].title = title;
        })
        .catch(() => {
          if (
            titleActions.isCurrent(id, action) &&
            state.pendingTitles[id]?.title === val
          )
            delete state.pendingTitles[id];
          poll();
        });
    }
    renderSidebar();
  };
  finishRename = finish;
  input.addEventListener("blur", () => finish(true));
  // Invariant: a click/press in the field must not bubble to the row (which
  // would open it)
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

const rowOf = (e: Event): HTMLElement | null =>
  (e.target as HTMLElement | null)?.closest<HTMLElement>(".agent") || null;
let touchActionHandled = false;
let longPressTimer = 0;
// Hold renames; left swipe deletes; native scrolling retains pan-y ownership.
const SWIPE_START = 12;
const DISMISS_MIN = 90;
interface Swipe {
  row: HTMLElement;
  id: string | undefined;
  x0: number;
  y0: number;
  dx: number;
  active: boolean;
  armed: boolean;
}
let swipe: Swipe | null = null;

function resetRow(row: HTMLElement | null, animate: boolean): void {
  if (!row) return;
  row.classList.remove("swiping", "dismiss-armed");
  if (animate)
    row.style.transition =
      "transform var(--motion-move) ease, opacity var(--motion-move) ease";
  else row.style.transition = "";
  row.style.transform = "";
  row.style.opacity = "";
}

listEl.addEventListener(
  "touchstart",
  (e: TouchEvent) => {
    if (renaming || e.touches.length > 1) return;
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      ".agent",
    );
    if (!row) return;
    const id = row.dataset.id;
    const t = e.touches[0];
    swipe = {
      row,
      id,
      x0: t.clientX,
      y0: t.clientY,
      dx: 0,
      active: false,
      armed: false,
    };
    touchActionHandled = false;
    clearTimeout(longPressTimer);
    // Invariant: long-press → rename in place. The row's own tap-open is
    // swallowed afterwards. A draft row has no real agent to rename, so skip
    // it.
    if (id && id !== DRAFT)
      longPressTimer = setTimeout(() => {
        if (!swipe || swipe.active) return;
        touchActionHandled = true;
        swipe = null;
        startRename(id);
      }, 450) as unknown as number;
  },
  { passive: true },
);

listEl.addEventListener(
  "touchmove",
  (e: TouchEvent) => {
    if (!swipe) return;
    const t = e.touches[0];
    const dx = t.clientX - swipe.x0,
      dy = t.clientY - swipe.y0;
    if (!swipe.active) {
      // Invariant: First real movement kills the long-press. Commit to a
      // horizontal swipe only when the travel is clearly sideways; a vertical
      // drag hands off to scrolling.
      if (Math.abs(dy) > SWIPE_START && Math.abs(dy) >= Math.abs(dx)) {
        clearTimeout(longPressTimer);
        swipe = null;
        return;
      }
      if (Math.abs(dx) > SWIPE_START && Math.abs(dx) > Math.abs(dy)) {
        clearTimeout(longPressTimer);
        if (!swipe.id || swipe.id === DRAFT) {
          swipe = null;
          return;
        }
        swipe.active = true;
        swipe.row.style.transition = "";
        swipe.row.classList.add("swiping");
      } else return;
    }
    e.preventDefault();
    swipe.dx = Math.min(0, dx);
    swipe.row.style.transform = `translateX(${swipe.dx}px)`;
    swipe.row.style.opacity = String(Math.max(0.35, 1 + swipe.dx / 260));
    const armed = -swipe.dx >= DISMISS_MIN;
    if (armed !== swipe.armed) {
      swipe.armed = armed;
      swipe.row.classList.toggle("dismiss-armed", armed);
    }
  },
  { passive: false },
);

function endSwipe(): void {
  clearTimeout(longPressTimer);
  if (!swipe) return;
  const s = swipe;
  swipe = null;
  if (!s.active) return;
  if (s.armed) {
    // Invariant: Slide the row out, then delete optimistically (the teardown
    // runs on the backend). touchActionHandled keeps the follow-up tap from
    // opening it.
    touchActionHandled = true;
    const w = s.row.offsetWidth || 320;
    s.row.classList.remove("dismiss-armed");
    s.row.style.transition =
      "transform var(--motion-fast) ease, opacity var(--motion-fast) ease";
    s.row.style.transform = `translateX(-${w}px)`;
    s.row.style.opacity = "0";
    setTimeout(() => killAgent(s.id), 150);
  } else {
    resetRow(s.row, true);
  }
}
listEl.addEventListener("touchend", endSwipe);
listEl.addEventListener("touchcancel", () => {
  clearTimeout(longPressTimer);
  if (swipe && swipe.active) resetRow(swipe.row, true);
  swipe = null;
});

// ---------------- pointer drag to re-parent (desktop mouse). A row is dragged
// onto another agent to move it there. Delegated on the persistent list so it
// survives every keyed re-render; highlights are imperative and re-render is
// frozen (dragActive) for the brief gesture, then repainted on drop/end.
function clearDropHighlight(): void {
  for (const el of listEl.querySelectorAll(".agent.drop-ok, .agent.drop-bad"))
    el.classList.remove("drop-ok", "drop-bad");
}
function endDrag(): void {
  clearDropHighlight();
  if (dragSourceId) {
    listEl
      .querySelector(`.agent[data-id="${CSS.escape(dragSourceId)}"]`)
      ?.classList.remove("drag-source");
  }
  dragSourceId = null;
  if (dragActive) {
    dragActive = false;
    renderSidebar();
  }
}

listEl.addEventListener("dragstart", (e: DragEvent) => {
  const row = rowOf(e);
  const id = row?.dataset.id;
  // Invariant: A draft is not a saved agent and cannot be moved.
  if (!id || id === DRAFT || !state.nodes[id]) {
    e.preventDefault();
    return;
  }
  dragSourceId = id;
  dragActive = true;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", id);
    } catch {}
  }
  row!.classList.add("drag-source");
});

listEl.addEventListener("dragover", (e: DragEvent) => {
  if (!dragSourceId) return;
  const id = rowOf(e)?.dataset.id;
  if (id && isValidDropTarget(state.nodes, dragSourceId, id)) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }
});

listEl.addEventListener("dragenter", (e: DragEvent) => {
  if (!dragSourceId) return;
  const row = rowOf(e);
  const id = row?.dataset.id;
  clearDropHighlight();
  if (!row || !id || id === dragSourceId) return;
  const reason = reparentValidity(state.nodes, dragSourceId, id);
  if (reason === "ok") row.classList.add("drop-ok");
  else if (reason !== "noop") row.classList.add("drop-bad");
});

listEl.addEventListener("drop", (e: DragEvent) => {
  e.preventDefault();
  const source = dragSourceId;
  const target = rowOf(e)?.dataset.id;
  endDrag();
  if (source && target) reparentAgent(source, target);
});

listEl.addEventListener("dragend", endDrag);
