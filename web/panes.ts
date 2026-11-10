// Owns pane visibility, selection, bounded caches and desktop/mobile layout.
// Conversation actions keep their module owners. Unavailable panes hide their
// rail and close on refresh; discovery leaves Chat usable. Embedded apps
// never schedule discovery, including reads settling after parking.
import { currentUiOwnerId, DRAFT, embedded, state } from "./state.js";
import { phoneListEntry } from "./phone-nav.js";
import {
  DELETE_ICON,
  SHARE_ICON,
  TAKE_CONTROL_ICON,
  UP_ICON,
  NEW_ICON,
  MORE_ICON,
  PANE_ICON,
  MESSAGE_ICON,
  PANE_COMPRESS_ICON,
  PANE_EXPAND_ICON,
} from "./icons.js";
import { installPaneChrome } from "./panes/chrome.js";
import { recordPaneOpen } from "./panes/frecency.js";
import { scrollPane } from "./panes/navigation.js";
import {
  createPanePowerbar,
  paneFullscreenControl,
  retainPanePowerbar,
} from "./panes/powerbar.js";
import { $, inputEl } from "./dom.js";
import { pendingCommentCount } from "./comments.js";
import {
  handleCommentShortcut,
  selectionCommentOwner,
} from "./artifacts/selection-comments.js";
import {
  ArtifactPaneAutoOpenPolicy,
  type ArtifactAutoOpenObservation,
} from "./panes/autoopen.js";
import { storedPanesWidth, ensurePanesGrip } from "./resize.js";
import { DesktopDock } from "./dock/desktop.js";
import type { WindowCommand } from "./dock/commands.js";
import { guardLeaveComments } from "./comments.js";
import { mobileSidebarOpen, restoreAgentFocus } from "./sidebar.js";
import {
  paneFocusIndicatorId,
  paneIsActionable,
  paneVisibilityAfterUserAction,
} from "./panes/focus.js";
import { backgroundWork } from "./background-work.js";
import { conversationUiState } from "./conversation-ui-state/store.js";
import type { PaneVisibility } from "./conversation-ui-state/schema.js";
import {
  capturePaneViewState,
  PaneViewStateLifecycle,
  validPaneViewStateDef,
} from "./panes/view-state.js";
import { PaneInstanceCache, validPaneCacheDef } from "./panes/cache.js";
import { FileTabs } from "./panes/file-tabs.js";
import type { PaneContext, PaneDef, PaneNavigation } from "./types.js";
export { setPaneLoading } from "./panes/loading.js";

for (const [id, icon] of [
  ["trash-btn", DELETE_ICON],
  ["takeover-btn", TAKE_CONTROL_ICON],
  ["share-link-btn", SHARE_ICON],
  ["up-top", UP_ICON],
  ["new-top", NEW_ICON],
  ["pane-fab", MORE_ICON],
])
  $("#" + id)!.insertAdjacentHTML("afterbegin", icon);

const registry: PaneDef[] = [];
const open = new Set<string>();
const bodies = new Map<string, HTMLElement>();
const cachedPaneScroll = new WeakMap<HTMLElement, number>();
let mobileActive: string | null = null;
let railHash = "";
let fullId: string | null = null;
const focusOrigins = new Map<string, HTMLElement>();
const ARTIFACTS_PANE_ID = "report";
const artifactAutoOpen = new ArtifactPaneAutoOpenPolicy(true);
window.addEventListener("recurse:tree-authoritative", () => {
  artifactAutoOpen.retainAgents(new Set(Object.keys(state.nodes)));
});
// The same policy opens Files for a file a settled turn published.
const FILES_PANE_ID = "files";
const filesAutoOpen = new ArtifactPaneAutoOpenPolicy();
let artifactsAttention = false;
let announcementTimer = 0;
const paneOwners = new Map<string, string>();
const paneAgents = new Map<string, string>();
const paneViewState = new PaneViewStateLifecycle();
const paneInstances = new PaneInstanceCache();
const fileTabs = new FileTabs(open, (id, ownerId) =>
  paneInstances.retains(id, ownerId),
);
const paneDefinitions = (): PaneDef[] => [
  ...registry,
  ...fileTabs.definitions(),
];
let paneParking: HTMLElement | null = null;
let paneVisitAgentId: string | null = null;
let paneVisitOwnerId: string | null = null;
let paneRenderedAgentId: string | null = null;
let paneVisitVisibility: PaneVisibility = { kind: "default" };

const panesEl = $("#panes")!,
  railEl = $("#pane-rail")!,
  topbarEl = $("#topbar")!;
const fabEl = $("#pane-fab")!,
  menuEl = $("#pane-menu")!,
  backdropEl = $("#pane-backdrop")!;
// Optional across bundle generations; absence cannot abort core rendering.
const announcerEl = $("#pane-announcer");

installPaneChrome(panesEl);
panesEl.addEventListener("keydown", (event) => {
  const pane = paneForTarget(event.target);
  if (pane) handleCommentShortcut(event, pane);
});
panesEl.addEventListener("comments-submitting", (event) => {
  const pane = paneForTarget(event.target);
  const id = pane?.dataset.pane;
  // Invariant: Comments are persisted; remember the close without discarding
  // another pane's staged draft.
  if (id && closePane(id, true, true, true) && fileTabs.has(id))
    desktopDock.showChat();
});

const mq = matchMedia("(max-width: 700px)");
const isMobile = (): boolean => mq.matches;
const desktopDock = new DesktopDock(panesEl, {
  refresh: () => {
    layout();
    syncPanes();
  },
  known: (id, parameters) =>
    (parameters === undefined && registry.some((pane) => pane.id === id)) ||
    fileTabs.restore(id, parameters),
  prepare: (ids) => fileTabs.prepare(ids),
  restore: (ids) => {
    const extra = [...open].filter((id) => !ids.includes(id));
    if (extra.length && (selectionCommentOwner() || pendingCommentCount()))
      return false;
    for (const id of extra) closePane(id);
    for (const id of ids) {
      open.add(id);
      desktopDock.opening(id, true);
    }
    layout();
    return true;
  },
  closed: (id, restoreFocus = true) => closePane(id, true, restoreFocus),
  element: (id) => bodies.get(id)?.closest<HTMLElement>(".pane-col") ?? null,
  action: (id) => {
    const body = bodies.get(id);
    return body && !body.closest(".pane-col.fullscreen")
      ? paneFullscreenControl(body)
      : null;
  },
  focus: (id) => {
    focusPaneContent(id);
  },
  fullscreen: toggleFull,
  leaveFullscreen: () => {
    if (fullId) {
      fullId = null;
      syncFull();
    }
  },
  error: () => {
    if (announcerEl)
      announcerEl.textContent = "Windows could not load. Reload to try again.";
  },
});

// A conversation switch restores only that conversation's explicit visibility
// choice. A first visit starts from the product default instead of inheriting a
// pane from the previous conversation; Artifacts may still auto-open by policy.
export function beginPaneVisit(
  agentId: string,
  ownerId = currentUiOwnerId(),
): void {
  artifactAutoOpen.beginVisit(agentId);
  filesAutoOpen.beginVisit(agentId);
  for (const def of paneDefinitions()) def.visit?.(agentId);
  clearArtifactAnnouncement();
  if (artifactsAttention) {
    artifactsAttention = false;
    railHash = "";
  }
  if (paneVisitAgentId === agentId && paneVisitOwnerId === ownerId) return;

  const held = !!paneForTarget(document.activeElement);
  const outgoingOwnerId = paneVisitOwnerId;
  desktopDock.beginVisit(ownerId);
  for (const id of [...open]) closePane(id);
  if (outgoingOwnerId) conversationUiState.flush(outgoingOwnerId);
  if (held) restoreAgentFocus();

  paneVisitAgentId = agentId;
  paneVisitOwnerId = ownerId;
  paneRenderedAgentId = null;
  paneVisitVisibility = conversationUiState.pane(ownerId);
  if (paneVisitVisibility.kind !== "default") {
    artifactAutoOpen.noteUserPaneChoice(agentId);
    filesAutoOpen.noteUserPaneChoice(agentId);
  }
}

// Open/remembered-visible panes read immediately; closed probes queue behind
// focus. Probes record real errors without auto-opening; cancellation stays
// silent. Record invalidation before queueing, because capped queues can drop
// probes.
export function fetchPaneData(
  paneId: string,
  agentId: string,
  run: (signal?: AbortSignal) => Promise<unknown> | void,
): void {
  if (embedded) return;
  // Invariant: Priority promotion checks owner and agent together. Unlike
  // restoration, it may read unavailable panes; a wrong priority only warms
  // cache and cannot restore the wrong owner's selection.
  const restoring =
    paneVisitVisibility.kind === "open" &&
    paneVisitVisibility.id === paneId &&
    paneVisitAgentId === agentId &&
    paneVisitOwnerId === currentUiOwnerId();
  if (open.has(paneId) || (restoring && paneRenderedAgentId === agentId)) {
    void run();
    return;
  }
  backgroundWork.enqueue(`pane:${paneId}:${agentId}`, (signal) =>
    Promise.resolve(run(signal)),
  );
}

function noteUserPaneAction(
  id: string,
  opening: boolean,
  preserveLastId = false,
): void {
  const ownerId = paneVisitOwnerId || currentUiOwnerId();
  desktopDock.userAction();
  if (!fileTabs.has(id)) {
    const prior = conversationUiState.pane(ownerId);
    paneVisitVisibility = paneVisibilityAfterUserAction(
      prior,
      id,
      opening,
      preserveLastId,
    );
    conversationUiState.setPane(ownerId, paneVisitVisibility);
  }
  if (id === ARTIFACTS_PANE_ID && opening)
    artifactAutoOpen.noteArtifactsOpened(state.selectedId);
  else artifactAutoOpen.noteUserPaneChoice(state.selectedId);
  if (id === FILES_PANE_ID && opening)
    filesAutoOpen.noteArtifactsOpened(state.selectedId);
  else filesAutoOpen.noteUserPaneChoice(state.selectedId);
  clearArtifactAnnouncement();
  if (artifactsAttention) {
    artifactsAttention = false;
    railHash = "";
  }
}

function isTextEntry(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable ||
    !!element.closest('[contenteditable="true"], [role="textbox"]')
  );
}

function artifactAutoOpenGuards(): Pick<
  ArtifactAutoOpenObservation,
  "typing" | "modalOpen" | "unsentComments" | "mobileKeyboardOpen" | "mobile"
> {
  const active = document.activeElement;
  const textEntry = isTextEntry(active);
  const mobile = isMobile();
  // Invariant: Avoid viewport layout flush on desktop or focused input;
  // neither needs a visual keyboard check.
  const visualKeyboard =
    mobile &&
    !textEntry &&
    !!window.visualViewport &&
    window.innerHeight - window.visualViewport.height > 120;
  return {
    typing: textEntry || !!inputEl.value,
    modalOpen:
      Array.from(document.getElementsByTagName("dialog")).some(
        (dialog) => dialog.open,
      ) ||
      ["settings-overlay", "prompt-overlay", "pane-menu"].some((id) =>
        document.getElementById(id)?.classList.contains("on"),
      ) ||
      !!document.getElementById("sidebar")?.classList.contains("open"),
    unsentComments: pendingCommentCount() > 0,
    mobileKeyboardOpen: mobile && (textEntry || visualKeyboard),
    mobile,
  };
}

function clearArtifactAnnouncement(): void {
  clearTimeout(announcementTimer);
  announcementTimer = 0;
  if (announcerEl) announcerEl.textContent = "";
}

function announceArtifacts(
  kind: "opened" | "available",
  title = "Artifacts",
): void {
  clearArtifactAnnouncement();
  const agentId = state.selectedId;
  announcementTimer = setTimeout(() => {
    announcementTimer = 0;
    if (state.selectedId !== agentId) return;
    if (announcerEl)
      announcerEl.textContent =
        kind === "opened" ? `${title} opened.` : `${title} available.`;
  }, 0) as unknown as number;
}

export function registerPane(def: PaneDef): void {
  if (!def || !def.id || registry.some((p) => p.id === def.id)) return;
  if (paneVisitAgentId !== null) def.visit?.(paneVisitAgentId);
  // Invariant: Invalid or colliding plugin state must not block the pane itself
  // or let one pane read/write another pane's bounded namespace.
  const viewState = def.viewState;
  if (
    viewState &&
    (!validPaneViewStateDef(viewState) ||
      registry.some((p) => p.viewState?.key === viewState.key) ||
      registry.some(
        (p) =>
          p.viewState?.storageSlot === viewState.storageSlot &&
          (p.viewState.retention || "session") ===
            (viewState.retention || "session"),
      ))
  )
    def = { ...def, viewState: undefined };
  if (def.cache && !validPaneCacheDef(def.cache))
    def = { ...def, cache: undefined };
  registry.push(def);
  railHash = "";
  syncPanes();
}

export function openFileTab(
  source: string,
  key: string,
  initial: unknown,
  options: OpenPaneOptions = {},
): boolean {
  const id = fileTabs.create(source, key, initial, currentUiOwnerId());
  return !!id && openPane(id, options);
}

function buildCtxFor(id: string): PaneContext {
  // Invariant: Selection changes before a cold conversation fetch completes.
  // Never hand an old agent's conversation to panels already being retargeted
  // to the new id; the next cache/fetch repaint supplies the matching record.
  const conv = state.currentConv?.id === id ? state.currentConv : null;
  return {
    agentId: id,
    node: state.nodes[id] || null,
    conv,
    nodes: state.nodes,
  };
}

function buildCtx(): PaneContext {
  return buildCtxFor(state.selectedId);
}

function capturePaneState(id: string): void {
  const body = bodies.get(id),
    definition = paneDefinitions().find((p) => p.id === id);
  const ownerId = paneOwners.get(id),
    agentId = paneAgents.get(id);
  if (!body || !definition || !ownerId || !agentId) return;
  capturePaneViewState(
    conversationUiState,
    ownerId,
    definition.viewState,
    body,
    buildCtxFor(agentId),
  );
}

function paneCacheScope(
  id: string,
  ownerId: string,
  context: PaneContext,
  definition: PaneDef,
) {
  if (!definition.cache) return null;
  try {
    const instanceKey = definition.cache.key(context);
    return typeof instanceKey === "string" &&
      instanceKey.length > 0 &&
      instanceKey.length <= 256
      ? { paneId: id, ownerId, instanceKey }
      : null;
  } catch {
    return null;
  }
}

function parkPaneBody(body: HTMLElement): void {
  if (!("moveBefore" in Element.prototype)) return;
  if (!paneParking) {
    const host = document.createElement("div");
    host.hidden = true;
    paneParking = document.createElement("div");
    host.attachShadow({ mode: "closed" }).append(paneParking);
    document.body.append(host);
  }
  try {
    (
      paneParking as HTMLElement & {
        moveBefore(node: Node, child: Node | null): void;
      }
    ).moveBefore(body, null);
    body.dataset.paneParked = "true";
  } catch {}
}

function forgetPaneState(id: string): void {
  const body = bodies.get(id),
    ownerId = paneOwners.get(id),
    agentId = paneAgents.get(id);
  const definition = paneDefinitions().find((p) => p.id === id);
  bodies.delete(id);
  paneOwners.delete(id);
  paneAgents.delete(id);
  if (body)
    try {
      definition?.leave?.(body);
    } catch {}
  if (!body || !ownerId || !agentId || !definition?.cache) return;
  delete body.dataset.paneFocusWhenReady;
  cachedPaneScroll.set(
    body,
    isMobile() ? (body.parentElement?.scrollTop ?? 0) : body.scrollTop,
  );
  const context = buildCtxFor(agentId);
  const scope = paneCacheScope(id, ownerId, context, definition);
  if (scope) {
    if (definition.cache.keepConnected) parkPaneBody(body);
    paneInstances.put(scope, body, context, definition.cache);
  } else
    try {
      definition.cache.dispose?.(body, context);
    } catch {}
}

// A plugin mutation can discard only its detached rendered instances. Active
// bodies refresh normally and will be cached from their new state when closed.
export function invalidatePaneCache(id: string, instanceKey?: string): void {
  paneInstances.invalidate(id, instanceKey);
}

function availableFor(ctx: PaneContext, discovering?: Set<string>): PaneDef[] {
  return paneDefinitions().filter((p) => {
    if (
      fileTabs.has(p.id) &&
      (!fileTabs.needed(p.id) ||
        (!open.has(p.id) &&
          (isMobile() || paneRenderedAgentId !== ctx.agentId)))
    )
      return false;
    try {
      const available = p.available ? p.available(ctx) : true;
      if (available === undefined) discovering?.add(p.id);
      return !!available;
    } catch {
      return false;
    }
  });
}

interface OpenPaneOptions {
  focusHeading?: boolean;
  userInitiated?: boolean;
  // Temporary p fallback preserves the remembered pane until explicit choice.
  preserveLastId?: boolean;
  // Keyboard opens focus the body; mobile modal opens focus the heading.
  focusTarget?: "heading" | "body";
  focusEntry?: boolean; // Desktop: new opens focus [data-pane-entry].
}

function usableFocusOrigin(
  element: HTMLElement | null | undefined,
): element is HTMLElement {
  if (
    !element?.isConnected ||
    element === document.body ||
    element === document.documentElement
  )
    return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

export function openPane(id: string, options: OpenPaneOptions = {}): boolean {
  if (id === "chat") {
    if (isMobile() && !guardLeaveComments()) return false;
    if (isMobile()) for (const paneId of [...open]) closePane(paneId, true);
    desktopDock.showChat(true);
    const thread = $("#scroll");
    if (thread) {
      thread.tabIndex = -1;
      desktopDock.focusControl("chat", thread);
    }
    if (!isMobile()) recordPaneOpen(id);
    return true;
  }
  if (
    !paneDefinitions().some((p) => p.id === id) ||
    (fileTabs.has(id) && !fileTabs.canOpen(id))
  )
    return false;
  const focusHeading = options.focusHeading !== false;
  const userInitiated = options.userInitiated !== false;
  // Invariant: Replacing a comment-capable pane is a leave action just like
  // closing it. Do not clear its attention/visit state until the operator
  // accepts the existing shared comment guard.
  if (
    isMobile() &&
    userInitiated &&
    [...open].some((openId) => openId !== id) &&
    !guardLeaveComments()
  ) {
    const current = [...open][0];
    if (isMobile() && current)
      requestAnimationFrame(() =>
        panesEl
          .querySelector<HTMLElement>(
            `.pane-col[data-pane="${CSS.escape(current)}"] .pane-title`,
          )
          ?.focus(),
      );
    return false;
  }
  for (const openId of open) if (openId !== id) capturePaneState(openId);
  const active = document.activeElement;
  if (isMobile()) focusOrigins.clear();
  // Invariant: A keyboard menu choice is hidden immediately before openPane
  // runs. Restore to the persistent Panels button rather than that
  // now-invisible menu item.
  const origin =
    active instanceof HTMLElement
      ? menuEl.contains(active)
        ? fabEl
        : active
      : null;
  if (usableFocusOrigin(origin)) focusOrigins.set(id, origin);
  // Invariant: Phones replace their one overlay; desktop opens a tab without
  // discarding other windows. Automatic opens never take DOM focus.
  desktopDock.opening(id, !focusHeading);
  if (isMobile()) {
    open.clear();
    for (const paneId of [...bodies.keys()]) forgetPaneState(paneId);
    panesEl.innerHTML = "";
    mobileActive = id;
  }
  const entry = options.focusEntry && !isMobile() && !open.has(id);
  open.add(id);
  if (userInitiated) {
    noteUserPaneAction(id, true, options.preserveLastId);
    if (!isMobile() && !fileTabs.has(id)) recordPaneOpen(id);
  }
  layout();
  syncPanes();
  if (focusHeading) {
    desktopDock.show(id);
    focusPaneContent(id, options.focusTarget !== "body", entry);
  }
  return true;
}
function closePane(
  id: string,
  userInitiated = false,
  restoreFocus = userInitiated,
  preserveComments = false,
): boolean {
  if (
    !open.has(id) ||
    (userInitiated &&
      !preserveComments &&
      !(fileTabs.has(id)
        ? fileTabs.guardClose(id, bodies.get(id))
        : guardLeaveComments()))
  )
    return false;
  capturePaneState(id);
  if (userInitiated) noteUserPaneAction(id, false);
  const origin = focusOrigins.get(id);
  open.delete(id);
  forgetPaneState(id);
  desktopDock.remove(id);
  focusOrigins.delete(id);
  if (mobileActive === id) mobileActive = null;
  if (fullId === id) fullId = null;
  layout();
  renderRail(availableFor(buildCtx()));
  if (restoreFocus) {
    const prior = document.activeElement;
    requestAnimationFrame(() => {
      if (document.activeElement !== prior) return;
      const fallback = isMobile()
        ? fabEl
        : railEl.querySelector<HTMLElement>(
            `.rail-btn[data-pane="${CSS.escape(id)}"]`,
          );
      // Invariant: The opener can remain connected while a breakpoint moves it
      // offscreen; body is likewise connected but is not a meaningful restored
      // target.
      const target = usableFocusOrigin(origin) ? origin : fallback;
      target?.focus();
    });
  }
  return true;
}
/** Close pane `id` as the operator, leaving focus to the caller. */
export function closeOpenPane(id: string): boolean {
  return closePane(id, true, false);
}

/** Whether pane `id` is offered for the open agent. */
export function paneAvailable(id: string): boolean {
  return availableFor(buildCtx()).some((p) => p.id === id);
}

function togglePane(id: string): void {
  if (isMobile() && open.has(id)) closePane(id, true, true);
  else openPane(id, { userInitiated: true, focusEntry: true });
}

// ---- temporary fullscreen -------------------------------------------------
// A panel can expand to cover the whole viewport; toggling fullscreen or
// closing the panel drops back to the normal column layout.
function toggleFull(id: string): void {
  fullId = fullId === id ? null : id;
  syncFull();
}
function syncFull(): void {
  const mobile = isMobile();
  const chat = document.getElementById("main");
  chat?.classList.toggle("fullscreen", fullId === "chat");
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col")) {
    const on = col.dataset.pane === fullId;
    const modal = mobile && (on || col.dataset.pane === mobileActive);
    col.classList.toggle("fullscreen", on);
    col.setAttribute("role", modal ? "dialog" : "region");
    if (modal) col.setAttribute("aria-modal", "true");
    else col.removeAttribute("aria-modal");
    const body = bodies.get(col.dataset.pane || "");
    const fs = body ? paneFullscreenControl(body) : null;
    if (fs) {
      fs.innerHTML = on ? PANE_COMPRESS_ICON : PANE_EXPAND_ICON;
      fs.title = on ? "Exit fullscreen" : "Fullscreen";
      fs.setAttribute("aria-label", on ? "Exit fullscreen" : "Open fullscreen");
      fs.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  desktopDock.refreshActions();
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (element) =>
      !element.hidden && getComputedStyle(element).display !== "none",
  );
}
addEventListener("keydown", (event: KeyboardEvent) => {
  if (mobileSidebarOpen()) return;
  if (menuEl.classList.contains("on")) {
    const items = focusables(menuEl);
    if (
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
      items.length
    ) {
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (index + 1 + items.length) % items.length
              : (index - 1 + items.length) % items.length;
      event.preventDefault();
      items[next].focus();
      return;
    }
    if (event.key === "Tab") {
      if (!items.length) {
        event.preventDefault();
        fabEl.focus();
        return;
      }
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && (index < 0 || index === items.length - 1)) {
        event.preventDefault();
        items[0].focus();
      }
    }
    return;
  }
  const activeId = fullId || (isMobile() ? mobileActive : null);
  const modal =
    activeId === "chat"
      ? document.getElementById("main")
      : activeId
        ? panesEl.querySelector<HTMLElement>(
            `.pane-col[data-pane="${CSS.escape(activeId)}"]`,
          )
        : null;
  if (event.key === "Tab" && modal) {
    const items = focusables(modal);
    if (!items.length) {
      event.preventDefault();
      modal.querySelector<HTMLElement>(".pane-title")?.focus();
      return;
    }
    const first = items[0],
      last = items[items.length - 1];
    const index = items.indexOf(document.activeElement as HTMLElement);
    // Invariant: Heading focus is scheduled after a programmatic mobile open.
    // Pull an earlier Tab (or focus restored unexpectedly outside) into the
    // visible fullscreen pane before it can reach covered chrome, then keep
    // focus within that pane.
    if (!modal.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && index <= 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && index === items.length - 1) {
      event.preventDefault();
      first.focus();
    }
  }
});

// The centralized keymap calls this for Escape outside focused pane content
// (for example, from the panel menu). Focused panes dispatch their own close
// command; this fallback still peels fullscreen before another local layer.
export function closePaneKeyboardLayer(): boolean {
  if (fullId) {
    const id = fullId;
    fullId = null;
    syncFull();
    const body = bodies.get(id);
    if (body) paneFullscreenControl(body).focus();
    return true;
  }
  if (menuEl.classList.contains("on")) {
    closeMenu();
    fabEl.focus();
    return true;
  }
  const id = (isMobile() ? mobileActive : focusedPaneId()) || null;
  if (!id || !open.has(id)) return false;
  const before = open.has(id);
  closePane(id, true, true, true);
  return before && !open.has(id);
}
// Only phone overlays and menus are modal. Desktop fullscreen is a layout;
// Pane mode/native editor keys depend on focus, not the layout's size.
export function paneKeyboardLayerOpen(): boolean {
  return menuEl.classList.contains("on") || (isMobile() && open.size > 0);
}

export const hasFullscreenPane = () => !!fullId;

/** Resolve the pane owning content or a native window control. */
export function paneForTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const column = target.closest<HTMLElement>(".pane-col");
  if (column) return column;
  const id =
    target.closest<HTMLElement>("[data-dock-panel]")?.dataset.dockPanel;
  return id
    ? (bodies.get(id)?.closest<HTMLElement>(".pane-col") ?? null)
    : null;
}

function focusedPaneId(): string | undefined {
  return paneForTarget(document.activeElement)?.dataset.pane;
}

function activePaneId(fallback = false): string | null {
  if (fullId && open.has(fullId)) return fullId;
  const focused = focusedPaneId();
  if (focused && open.has(focused)) return focused;
  if (mobileActive && open.has(mobileActive)) return mobileActive;
  return fallback ? [...open][0] || null : null;
}

// Chat is always offered outside embedded views, including a new draft.
export function paneActionable(): boolean {
  return (
    !embedded ||
    open.size > 0 ||
    paneIsActionable(
      [...open],
      availableFor(buildCtx()).map((p) => p.id),
    )
  );
}

/** Offered panes in rail order; the finder can also offer Chat. */
export function offeredPanes({ includeChat = false } = {}) {
  const panes = availableFor(buildCtx())
    .filter((pane) => !fileTabs.has(pane.id))
    .map((pane) => ({
      id: pane.id,
      title: pane.title || pane.id,
      icon: pane.icon || PANE_ICON,
      open: open.has(pane.id),
      finder: pane.finder,
    }));
  return includeChat
    ? [
        ...panes,
        {
          id: "chat",
          title: "Chat",
          icon: MESSAGE_ICON,
          open: isMobile() ? !mobileActive : desktopDock.chatOpen(),
          finder: undefined,
        },
      ]
    : panes;
}

/** Open the offered pane at a one-based rail position. */
export function openPaneByIndex(index: number): boolean {
  const pane = offeredPanes()[index - 1];
  return !!pane && openPane(pane.id, { focusTarget: "body" });
}

/** Handle focused-pane items, falling back to content scrolling. */
export function navigateFocusedPane(command: PaneNavigation): void {
  const id = activePaneId();
  const body = id ? bodies.get(id) : null;
  if (
    !body ||
    paneDefinitions()
      .find((pane) => pane.id === id)
      ?.navigate?.(body, command)
  )
    return;
  scrollPane(body, command);
}

/** Scroll or move the item cursor to an edge of the focused pane. */
export function scrollFocusedPane(edge: "top" | "bottom"): void {
  navigateFocusedPane(edge);
}

function focusPaneContent(id: string, heading = false, entry = false): boolean {
  const column = panesEl.querySelector<HTMLElement>(
    `.pane-col[data-pane="${CSS.escape(id)}"]`,
  );
  const body = column?.querySelector<HTMLElement>(".pane-body");
  const input = entry && body?.querySelector<HTMLElement>("[data-pane-entry]");
  const title = column?.querySelector<HTMLElement>(".pane-title");
  const target = input || (heading || body?.inert ? title : body);
  if (!target) return false;
  if (body?.inert && !heading) body.dataset.paneFocusWhenReady = "true";
  desktopDock.focusControl(id, target);
  return true;
}

/** Reveal a pane and focus its native control once its window is visible. */
export function focusPaneControl(id: string, target: HTMLElement): void {
  desktopDock.focusControl(id, target);
}

export function closeFocusedPaneFromKeyboard(
  preferredId?: string,
  restoreVisibleOrigin = false,
  preserveComments = false,
): boolean {
  const id = preferredId || activePaneId(true);
  if (!id) return false;
  const closed = closePane(id, true, restoreVisibleOrigin, preserveComments);
  if (closed && !restoreVisibleOrigin) restoreAgentFocus();
  return closed;
}

// Tracks pane focus rings through focusin, clearing them on tree/composer
// focus.
function syncPaneFocusIndicator(): void {
  const focusedId = paneFocusIndicatorId(focusedPaneId() ?? null, [...open]);
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col"))
    col.classList.toggle("kb-focused", col.dataset.pane === focusedId);
}
document.addEventListener("focusin", syncPaneFocusIndicator);

/** Run desktop window commands without loading the dock on phones. */
export function runWindowCommand(command: WindowCommand): boolean {
  return desktopDock.command(command);
}

export function toggleFocusedPaneFullscreen(): boolean {
  const id = activePaneId(true);
  if (!id) return false;
  toggleFull(id);
  return true;
}

// ---- column layout --------------------------------------------------------
function ensureColumn(id: string, ctx: PaneContext): HTMLElement | undefined {
  const existing = bodies.get(id);
  if (existing) return existing;
  const p = paneDefinitions().find((x) => x.id === id);
  if (!p) return undefined;
  const ownerId = paneVisitOwnerId || currentUiOwnerId();
  const col = document.createElement("div");
  col.className = fileTabs.has(id) ? "pane-col file-tab" : "pane-col";
  col.dataset.pane = id;
  const head = createPanePowerbar(
    id,
    p.title || id,
    () => toggleFull(id),
    () => closePane(id, true, true),
  );
  col.setAttribute("aria-labelledby", `pane-title-${id}`);
  const scope = paneCacheScope(id, ownerId, ctx, p);
  const cached =
    scope && p.cache ? paneInstances.take(scope, ctx, p.cache) : null;
  const body = cached || document.createElement("div");
  if (!cached) {
    body.className = "pane-body";
    body.tabIndex = -1;
  }
  body.dataset.pane = id;
  col.append(retainPanePowerbar(body, head));
  panesEl.appendChild(col);
  if (body.dataset.paneParked === "true") {
    try {
      const move = (
        col as { moveBefore?: (node: Node, child: Node | null) => void }
      ).moveBefore;
      if (move) move.call(col, body, null);
      else col.appendChild(body);
    } catch {
      col.appendChild(body);
    }
    delete body.dataset.paneParked;
  } else col.appendChild(body);
  bodies.set(id, body);
  paneOwners.set(id, ownerId);
  paneAgents.set(id, ctx.agentId);
  if (!cached) {
    try {
      p.render && p.render(body, ctx);
    } catch {}
    paneViewState.restoreOnce(
      conversationUiState,
      ownerId,
      p.viewState,
      body,
      ctx,
    );
  }
  return body;
}

function layout(): void {
  const ctx = buildCtx();
  if (isMobile() || embedded) {
    if (fullId === "chat") {
      fullId = null;
      syncFull();
    }
    desktopDock.sync(false, []);
  }
  ensurePanesGrip();
  if (fullId && fullId !== "chat" && !open.has(fullId)) fullId = null;
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col")) {
    const pid = col.dataset.pane;
    if (!pid || !open.has(pid)) {
      if (pid) forgetPaneState(pid);
      col.remove();
    }
  }
  for (const p of paneDefinitions())
    if (open.has(p.id)) ensureColumn(p.id, ctx);

  const mobile = isMobile();
  const docked =
    !mobile &&
    !embedded &&
    desktopDock.sync(
      true,
      paneDefinitions()
        .filter((pane) => open.has(pane.id))
        .map((pane) => ({
          id: pane.id,
          title: pane.title || pane.id,
          icon: pane.icon || PANE_ICON,
          file: fileTabs.descriptor(pane.id),
        })),
    );
  panesEl.classList.toggle("on", docked || open.size > 0);
  const w = mobile || docked ? null : storedPanesWidth();
  if (w != null) {
    panesEl.style.flex = "none";
    panesEl.style.width = w + "px";
  } else {
    panesEl.style.flex = mobile ? "" : docked ? "1" : String(open.size);
    panesEl.style.width = "";
  }

  if (mobile) {
    if (mobileActive && !open.has(mobileActive)) mobileActive = null;
    if (!mobileActive && open.size) mobileActive = [...open][0];
    for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col"))
      col.classList.toggle("mobile-active", col.dataset.pane === mobileActive);
    const overlay = open.size > 0 && !!mobileActive;
    panesEl.classList.toggle("overlay", overlay);
    backdropEl.classList.toggle(
      "on",
      overlay || menuEl.classList.contains("on"),
    );
  } else {
    panesEl.classList.remove("overlay");
    backdropEl.classList.remove("on");
    for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col"))
      col.classList.remove("mobile-active");
  }
  topbarEl.classList.toggle(
    "pane-overlay",
    panesEl.classList.contains("overlay"),
  );
  syncFull();
  for (const body of bodies.values()) {
    const top = cachedPaneScroll.get(body);
    if (top === undefined) continue;
    (mobile ? body.parentElement! : body).scrollTop = top;
    cachedPaneScroll.delete(body);
  }
}

// ---- rail + mobile menu ---------------------------------------------------
function paneBadge(pane: PaneDef, ctx: PaneContext): string {
  try {
    const value = pane.badge?.(ctx);
    if (Number(/^(\d+)\+?$/.exec(String(value))?.[1]) > 999) return "999+";
    return value === null || value === undefined || value === ""
      ? ""
      : String(value).slice(0, 6);
  } catch {
    return "";
  }
}

function paneAttention(pane: PaneDef): boolean {
  if (pane.id === ARTIFACTS_PANE_ID) return artifactsAttention;
  try {
    return !!pane.attention?.();
  } catch {
    return false;
  }
}

function renderRail(avail: PaneDef[], ctx = buildCtx()): void {
  avail = avail.filter((pane) => !fileTabs.has(pane.id));
  const mobile = isMobile();
  // Invariant: Reparent shared controls, retaining their owners and handlers.
  const actions = [
    $("#trash-btn")!,
    $("#takeover-btn")!,
    $("#share-link-btn")!,
  ];
  // Spec: Phones keep Delete in More; desktop places it beside Settings.
  const foot = $("#agent-list-foot")!;
  if (actions[0].parentElement !== (mobile ? menuEl : foot)) {
    if (mobile) {
      $("#pane-menu-divider")!.before(actions[0], actions[1]);
      $("#pane-menu-divider")!.after(actions[2]);
    } else {
      foot.append(actions[0]);
      railEl.prepend(actions[1], actions[2]);
    }
    for (const action of actions) {
      if (mobile) action.setAttribute("role", "menuitem");
      else action.removeAttribute("role");
    }
  }
  const badges = new Map(avail.map((p) => [p.id, paneBadge(p, ctx)]));
  const attentive = avail.filter(paneAttention);
  const hash =
    avail.map((p) => `${p.id}:${badges.get(p.id) || ""}`).join(",") +
    "|" +
    [...open].join(",") +
    "|" +
    attentive.map((p) => p.id).join(",") +
    "|" +
    (mobile ? "m" : "d") +
    "|" +
    state.selectedId;
  if (hash === railHash) return;
  railHash = hash;
  const any = avail.length > 0;
  railEl.classList.toggle(
    "on",
    !mobile && (any || (!!state.selectedId && state.selectedId !== DRAFT)),
  );
  fabEl.classList.toggle("on", mobile);
  fabEl.classList.toggle("attention", attentive.length > 0);
  // Spec: Pane counts appear in the menu, not on More.
  const fabLabel =
    "More actions" +
    (attentive.length
      ? ` — ${attentive.map((p) => p.title || p.id).join(", ")} available`
      : "");
  fabEl.title = fabLabel;
  fabEl.setAttribute("aria-label", fabLabel);

  const railPanels = $("#pane-rail-panels")!;
  railPanels.innerHTML = "";
  for (const [index, p] of avail.entries()) {
    const b = document.createElement("button");
    const attention = attentive.includes(p);
    b.className =
      "rail-btn" +
      (open.has(p.id) ? " active" : "") +
      (attention ? " attention" : "");
    b.dataset.pane = p.id;
    const badge = badges.get(p.id) || "";
    const baseLabel = p.title || p.id;
    const counted = badge ? `${baseLabel} (${badge})` : baseLabel;
    const label = attention ? `${counted} available` : counted;
    b.title = index < 9 ? `${baseLabel} (g${index + 1})` : label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-expanded", open.has(p.id) ? "true" : "false");
    b.innerHTML = p.icon || `<span>${(p.title || "?").slice(0, 1)}</span>`;
    if (badge) {
      const count = document.createElement("span");
      count.className = "badge rail-count";
      count.textContent = badge;
      count.setAttribute("aria-hidden", "true");
      b.appendChild(count);
    }
    b.onclick = () => togglePane(p.id);
    railPanels.appendChild(b);
  }

  const panelItems = $("#pane-menu-panels")!;
  panelItems.innerHTML = "";
  for (const p of avail) {
    const b = document.createElement("button");
    const attention = attentive.includes(p);
    b.className =
      "menu-item pane-menu-item" +
      (open.has(p.id) ? " active" : "") +
      (attention ? " attention" : "");
    b.dataset.pane = p.id;
    b.setAttribute("role", "menuitem");
    const badge = badges.get(p.id) || "";
    const label = badge ? `${p.title || p.id} (${badge})` : p.title || p.id;
    if (attention) b.setAttribute("aria-label", `${label} available`);
    b.innerHTML = p.icon || PANE_ICON;
    b.querySelector("svg")?.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    b.appendChild(text);
    b.onclick = () => openPane(p.id, { focusEntry: true });
    panelItems.appendChild(b);
  }
}

menuEl.addEventListener(
  "click",
  (event) => {
    const item = (event.target as Element | null)?.closest<HTMLButtonElement>(
      ".pane-menu-item",
    );
    if (!item || item.disabled) return;
    // Invariant: Delete's first tap is an inline confirmation, not an action.
    if (item.id === "trash-btn" && !item.classList.contains("armed")) return;
    closeMenu();
    fabEl.focus({ preventScroll: true });
  },
  true,
);

function openMenu(focusFirst = false): void {
  menuEl.classList.add("on");
  menuEl.scrollTop = 0;
  backdropEl.classList.add("on");
  fabEl.setAttribute("aria-expanded", "true");
  if (focusFirst) requestAnimationFrame(() => focusables(menuEl)[0]?.focus());
}
function closeMenu(): void {
  menuEl.classList.remove("on");
  fabEl.setAttribute("aria-expanded", "false");
  clearHot();
  if (!(isMobile() && mobileActive && open.size))
    backdropEl.classList.remove("on");
}

addEventListener("popstate", () => {
  if (phoneListEntry()) closeMenu();
});

// Phone FAB press/slide/release picks a panel; plain taps toggle the menu.
let hotItem: HTMLElement | null = null;
function clearHot(): void {
  if (hotItem) {
    hotItem.classList.remove("hot");
    hotItem = null;
  }
}
function setHot(el: HTMLElement | null): void {
  if (el === hotItem) return;
  clearHot();
  if (el) {
    el.classList.add("hot");
    hotItem = el;
  }
}
function inRect(x: number, y: number, el: HTMLElement | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function menuItemAt(x: number, y: number): HTMLElement | null {
  for (const el of menuEl.querySelectorAll<HTMLButtonElement>(
    ".pane-menu-item:not(:disabled)",
  ))
    if (inRect(x, y, el)) return el;
  return null;
}

let fabActive = false,
  fabWasOpen = false;
fabEl.addEventListener("pointerdown", (e: PointerEvent) => {
  fabActive = true;
  fabWasOpen = menuEl.classList.contains("on");
  try {
    fabEl.setPointerCapture(e.pointerId);
  } catch {}
  openMenu();
  e.preventDefault();
});
fabEl.addEventListener("pointermove", (e: PointerEvent) => {
  if (fabActive) setHot(menuItemAt(e.clientX, e.clientY));
});
const fabFinish = (commit: boolean) => (e: PointerEvent) => {
  if (!fabActive) return;
  fabActive = false;
  try {
    fabEl.releasePointerCapture(e.pointerId);
  } catch {}
  const item = menuItemAt(e.clientX, e.clientY);
  const overBtn = inRect(e.clientX, e.clientY, fabEl);
  clearHot();
  // Spec: Slide-release activates one item via pointer confirmation.
  if (commit && item) {
    item.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 1,
        clientX: e.clientX,
        clientY: e.clientY,
      }),
    );
  } else if (overBtn) {
    if (fabWasOpen) closeMenu();
  } else closeMenu();
};
fabEl.addEventListener("pointerup", fabFinish(true));
fabEl.addEventListener("pointercancel", fabFinish(false));
fabEl.addEventListener("click", (e: MouseEvent) => {
  // Spec: Detail-0 keyboard clicks toggle; pointer gestures already handled
  // their own generated clicks and must not activate twice.
  if (e.detail === 0) {
    menuEl.classList.contains("on") ? closeMenu() : openMenu(true);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
});
fabEl.addEventListener("contextmenu", (e) => e.preventDefault());
backdropEl.onclick = () => {
  closeMenu();
  if (isMobile() && mobileActive) closePane(mobileActive, true, true);
};
mq.addEventListener("change", () => {
  closeMenu();
  railHash = "";
  if (isMobile()) {
    desktopDock.sync(false, []);
    const commentPane =
      selectionCommentOwner()?.closest<HTMLElement>(".pane-col")?.dataset.pane;
    mobileActive =
      commentPane && open.has(commentPane) ? commentPane : activePaneId(true);
    for (const id of [...open]) if (id !== mobileActive) closePane(id);
  }
  layout();
  syncPanes();
  const editingComment =
    document.activeElement instanceof Element &&
    !!document.activeElement.closest(".report-comment-popover");
  if (
    isMobile() &&
    mobileActive &&
    !panesEl.contains(document.activeElement) &&
    !editingComment
  ) {
    const id = mobileActive;
    requestAnimationFrame(() =>
      panesEl
        .querySelector<HTMLElement>(
          `.pane-col[data-pane="${CSS.escape(id)}"] .pane-title`,
        )
        ?.focus({ preventScroll: true }),
    );
  }
});
addEventListener("panes-relayout", () => layout());

// ---- the per-poll sync (called from the conversation refresh) -------------
let syncFailureAnnounced = false;

export function notePaneConversationRendered(agentId: string): void {
  if (paneVisitAgentId === agentId) paneRenderedAgentId = agentId;
}

function restorePanePreference(availableIds: ReadonlySet<string>): boolean {
  if (
    paneVisitAgentId !== state.selectedId ||
    paneRenderedAgentId !== state.selectedId ||
    paneVisitOwnerId !== currentUiOwnerId() ||
    paneVisitVisibility.kind !== "open" ||
    open.size > 0 ||
    !availableIds.has(paneVisitVisibility.id)
  )
    return false;
  return openPane(paneVisitVisibility.id, {
    // Invariant: A restored desktop column must not steal conversation/tree
    // focus. On a phone it covers the conversation as a modal, so focus enters
    // its heading.
    focusHeading: isMobile(),
    userInitiated: false,
  });
}

function syncPanesNow(): void {
  const ctx = buildCtx();
  const rendered =
    paneVisitAgentId === ctx.agentId &&
    paneRenderedAgentId === ctx.agentId &&
    paneVisitOwnerId === currentUiOwnerId();
  if (!isMobile() && rendered) desktopDock.prepareLayout();
  const discovering = new Set<string>();
  const avail = availableFor(ctx, discovering);
  const availIds = new Set(avail.map((p) => p.id));
  for (const id of [...open])
    if (!availIds.has(id)) {
      // Invariant: If the pane being auto-closed currently holds keyboard
      // focus, hand focus back to the canonical tree/menu target so a Pane-mode
      // user is never dropped onto <body>.
      const held = paneForTarget(document.activeElement)?.dataset.pane === id;
      closePane(id);
      if (held) restoreAgentFocus();
    }

  // Invariant: Explicit state wins over per-visit defaults and asynchronous
  // Artifact discovery. openPane() re-enters sync with the pane present, so
  // return after a successful restore rather than refreshing the same body
  // twice.
  const ownLayout =
    !isMobile() && rendered && desktopDock.restoreLayout(availIds, discovering);
  if (!ownLayout && restorePanePreference(availIds)) return;

  const artifacts = registry.find((p) => p.id === ARTIFACTS_PANE_ID);
  let generation: string | null | undefined;
  try {
    generation = artifacts?.autoOpenGeneration?.(ctx);
  } catch {
    generation = undefined;
  }
  const autoDecision = artifactAutoOpen.observe({
    agentId: ctx.agentId,
    generation,
    artifactsPaneOpen: open.has(ARTIFACTS_PANE_ID),
    otherPaneOpen:
      isMobile() && [...open].some((id) => id !== ARTIFACTS_PANE_ID),
    ...artifactAutoOpenGuards(),
  });
  if (artifactsAttention !== autoDecision.badged) {
    artifactsAttention = autoDecision.badged;
    railHash = "";
  }
  if (autoDecision.announcement) announceArtifacts(autoDecision.announcement);
  if (autoDecision.open && availIds.has(ARTIFACTS_PANE_ID)) {
    openPane(ARTIFACTS_PANE_ID, {
      // Invariant: A desktop side column can preserve conversation focus. The
      // full-screen phone surface is an ARIA modal, so focus must enter its
      // heading.
      focusHeading: isMobile() ? true : autoDecision.focusHeading,
      userInitiated: false,
    });
    return;
  }

  const files = registry.find((p) => p.id === FILES_PANE_ID);
  let fileGeneration: string | null | undefined;
  try {
    fileGeneration = files?.autoOpenGeneration?.(ctx);
  } catch {
    fileGeneration = undefined;
  }
  const filesDecision = filesAutoOpen.observe({
    agentId: ctx.agentId,
    generation: fileGeneration,
    artifactsPaneOpen: open.has(FILES_PANE_ID),
    otherPaneOpen: isMobile() && [...open].some((id) => id !== FILES_PANE_ID),
    ...artifactAutoOpenGuards(),
  });
  if (filesDecision.open && files && availIds.has(FILES_PANE_ID)) {
    files.autoOpened?.(ctx);
    announceArtifacts("opened", "Files");
    openPane(FILES_PANE_ID, { focusHeading: false, userInitiated: false });
    return;
  }

  renderRail(avail);
  for (const id of open) {
    const p = paneDefinitions().find((x) => x.id === id);
    const body = bodies.get(id);
    if (p && body && p.refresh) {
      try {
        p.refresh(body, ctx);
      } catch {}
    }
  }
}

// Optional pane failures cannot block successful tree/thread rendering. Keep
// failures local, announce once, retry on ordinary sync, and allow generation
// recovery to replace stale shells.
export function syncPanes(): void {
  if (embedded) return;
  try {
    syncPanesNow();
    if (syncFailureAnnounced) {
      syncFailureAnnounced = false;
      if (announcerEl) announcerEl.textContent = "Panels available again.";
    }
  } catch {
    if (syncFailureAnnounced) return;
    syncFailureAnnounced = true;
    console.warn(
      "Panels could not update; the conversation remains available.",
    );
    if (announcerEl)
      announcerEl.textContent =
        "Panels could not update. The conversation remains available.";
  }
}

addEventListener("pagehide", () => {
  desktopDock.saveLayout();
  for (const id of open) capturePaneState(id);
  conversationUiState.flush();
});

beginPaneVisit(state.selectedId);
if (!embedded && !isMobile()) layout();
