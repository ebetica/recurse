// Owns pane visibility, selection, bounded caches and desktop/mobile layout.
// Desktop restores the saved window grid independently of pane data. Built-in
// panes can close once unavailable; file tabs keep their own loading and errors.
// Embedded apps never schedule discovery, including reads settling after parking.
import { currentUiOwnerId, DRAFT, embedded, state } from "./state.js";
import { isTextEditorTarget } from "../src/keyboard_target.js";
import { phoneListEntry, openLinkedPhonePane } from "./phone-nav.js";
import {
  DELETE_ICON,
  SHARE_ICON,
  TAKE_CONTROL_ICON,
  UP_ICON,
  NEW_ICON,
  MORE_ICON,
  PANE_ICON,
  MESSAGE_ICON,
} from "./icons.js";
import {
  ArtifactPaneAutoOpenPolicy,
  capturePaneViewState,
  createPaneMenu,
  createPanePowerbar,
  FileTabs,
  installPaneChrome,
  PaneInstanceCache,
  paneFullscreenControl,
  PaneViewStateLifecycle,
  recordPaneOpen,
  retainPanePowerbar,
  scrollPane,
  updateFullscreenControl,
  validPaneCacheDef,
  validPaneViewStateDef,
  type ArtifactAutoOpenObservation,
} from "./panes/index.js";
import { visibleFocusable } from "./focus_trap.js";
import { $, inputEl, scrollEl } from "./dom.js";
import { guardLeaveComments, pendingCommentCount } from "./comments.js";
import { selectionCommentOwner } from "./comments/selection-draft/index.js";
import { storedPanesWidth, ensurePanesGrip } from "./resize.js";
import { DesktopDock } from "./dock/desktop.js";
import type { WindowCommand } from "./dock/commands.js";
import { restoreAgentFocus } from "./sidebar/focus.js";
import { backgroundWork } from "./background-work.js";
import { conversationUiState } from "./conversation-ui-state/store.js";
import type { PaneVisibility } from "./conversation-ui-state/schema.js";
import type { PaneContext, PaneDef, PaneNavigation } from "./types.js";
export { setPaneLoading } from "./panes/index.js";

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
let paneConversationRead: "pending" | "requested" | "settled" = "pending";
let paneReadAttempt = 0;
let paneOpenAfterDispatch: (() => void) | null = null;
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
panesEl.addEventListener("comments-submitting", (event) => {
  const pane = paneForTarget(event.target);
  const id = pane?.dataset.pane;
  // Invariant: Submitting Artifact comments never changes pane visibility or
  // the saved window layout, including while delivery is still pending.
  if (id === ARTIFACTS_PANE_ID) return;
  // Invariant: Other persisted comments retain their existing close behaviour
  // without discarding another pane's staged draft.
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
// pane from the previous conversation. Artifacts require an explicit choice.
export function beginPaneVisit(
  agentId: string,
  ownerId = currentUiOwnerId(),
): void {
  artifactAutoOpen.beginVisit(agentId);
  filesAutoOpen.beginVisit(agentId);
  if (agentId === state.selectedId)
    for (const def of paneDefinitions()) def.visit?.(agentId);
  clearArtifactAnnouncement();
  if (artifactsAttention) {
    artifactsAttention = false;
    railHash = "";
  }
  if (paneVisitAgentId === agentId && paneVisitOwnerId === ownerId) {
    if (!desktopDock.chatOpen()) desktopDock.showChat();
    return;
  }

  const held = !!paneForTarget(document.activeElement);
  const outgoingOwnerId = paneVisitOwnerId;
  desktopDock.beginVisit(ownerId);
  for (const id of Array.from(open)) closePane(id);
  if (outgoingOwnerId) conversationUiState.flush(outgoingOwnerId);
  if (held) restoreAgentFocus();

  paneVisitAgentId = agentId;
  paneVisitOwnerId = ownerId;
  paneRenderedAgentId = null;
  paneConversationRead = "pending";
  paneReadAttempt++;
  paneOpenAfterDispatch = null;
  paneVisitVisibility = conversationUiState.pane(ownerId);
  if (paneVisitVisibility.kind !== "default") {
    artifactAutoOpen.noteUserPaneChoice(agentId);
    filesAutoOpen.noteUserPaneChoice(agentId);
  }
}

/** Paint the saved grid until the tree confirms the selection or reports failure. */
export function previewDesktopPanes(id: string | null): void {
  if (embedded || isMobile() || state.selectedId) return;
  if (id && desktopDock.hasSavedLayout(id)) beginPaneVisit(id, id);
  else if (paneVisitAgentId) beginPaneVisit("");
  layout();
  desktopDock.restoreLayout();
}

function desktopPaneContentReady(agentId: string): boolean {
  return (
    embedded ||
    !agentId ||
    agentId === DRAFT ||
    paneConversationRead === "settled" ||
    (paneConversationRead === "requested" && paneRenderedAgentId === agentId)
  );
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
  if (
    (open.has(paneId) &&
      paneVisitAgentId === agentId &&
      (isMobile() || desktopPaneContentReady(agentId))) ||
    (restoring && paneRenderedAgentId === agentId)
  ) {
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
    const priorLast = prior.kind === "default" ? undefined : prior.lastId;
    paneVisitVisibility = opening
      ? {
          kind: "open",
          id,
          lastId: preserveLastId && priorLast ? priorLast : id,
        }
      : { kind: "closed", lastId: priorLast || id };
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

function artifactAutoOpenGuards(): Pick<
  ArtifactAutoOpenObservation,
  "typing" | "modalOpen" | "unsentComments" | "mobileKeyboardOpen" | "mobile"
> {
  const active = document.activeElement;
  const textEntry = isTextEditorTarget(active);
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
  return (
    !!id &&
    openLinkedPhonePane(
      id,
      mobileActive,
      () => openPane(id, options),
      (key) => fileTabs.descriptor(key),
    )
  );
}

/** Show a different file in this tab without moving or opening a window. */
export function replaceFileTab(
  body: HTMLElement,
  key: string,
  initial: unknown,
): HTMLElement | null {
  const id = body.dataset.pane;
  const column = body.closest<HTMLElement>(".pane-col");
  if (!id || !column || bodies.get(id) !== body) return null;
  const focused = column.contains(document.activeElement);
  const next = fileTabs.replace(id, key, initial, () => forgetPaneState(id));
  if (!next) return null;
  column.replaceChildren();
  const replacement = ensureColumn(id, buildCtx(), column);
  noteUserPaneAction(id, true);
  desktopDock.fileChanged(id, next.pane.title || id, next.descriptor);
  layout();
  if (focused) focusPaneContent(id);
  return replacement ?? null;
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
    if (fileTabs.has(p.id) && !open.has(p.id)) return false;
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
  if (!state.selectedId && paneVisitAgentId) return false;
  if (id === "chat") {
    if (isMobile() && !guardLeaveComments()) return false;
    if (isMobile())
      for (const paneId of Array.from(open)) closePane(paneId, true);
    desktopDock.showChat(true);
    scrollEl.tabIndex = -1;
    desktopDock.focusControl("chat", scrollEl);
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
    for (const paneId of Array.from(bodies.keys())) forgetPaneState(paneId);
    panesEl.innerHTML = "";
    mobileActive = id;
  }
  const entry = options.focusEntry && !isMobile() && !open.has(id);
  open.add(id);
  if (userInitiated) {
    noteUserPaneAction(id, true, options.preserveLastId);
    if (!isMobile() && !fileTabs.has(id)) recordPaneOpen(id);
  }
  layout(userInitiated ? id : undefined);
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
  if (!open.has(id)) return false;
  if (userInitiated) {
    const pane = paneDefinitions().find((pane) => pane.id === id);
    const body = bodies.get(id);
    if (
      pane?.guardClose
        ? body && !pane.guardClose(body, preserveComments)
        : !preserveComments && !guardLeaveComments()
    )
      return false;
  }
  capturePaneState(id);
  if (userInitiated) noteUserPaneAction(id, false);
  const origin = focusOrigins.get(id);
  open.delete(id);
  forgetPaneState(id);
  fileTabs.closed(id);
  desktopDock.remove(id);
  focusOrigins.delete(id);
  if (mobileActive === id) mobileActive = null;
  if (fullId === id) fullId = null;
  layout();
  if (paneVisitAgentId === state.selectedId)
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

/** Restore phone files; distinguish missing panes from guard refusals. */
export function restorePhonePane(id: string, file?: unknown): boolean | null {
  if (file && !fileTabs.has(id) && !fileTabs.restore(id, { file })) return null;
  if (!paneDefinitions().some((pane) => pane.id === id)) return null;
  return open.has(id) || openPane(id);
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
  placeNew(mobile);
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col")) {
    const on = col.dataset.pane === fullId;
    const modal = mobile && (on || col.dataset.pane === mobileActive);
    col.classList.toggle("fullscreen", on);
    col.setAttribute("role", modal ? "dialog" : "region");
    if (modal) col.setAttribute("aria-modal", "true");
    else col.removeAttribute("aria-modal");
    const body = bodies.get(col.dataset.pane || "");
    const fs = body ? paneFullscreenControl(body) : null;
    if (fs) updateFullscreenControl(fs, on);
  }
  desktopDock.refreshActions();
}

addEventListener("keydown", (event: KeyboardEvent) => {
  if (phoneListEntry()) return;
  if (paneMenu.isOpen()) {
    paneMenu.handleKey(event);
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
    const items = visibleFocusable(modal);
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
  if (paneMenu.isOpen()) {
    paneMenu.close();
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
  return paneMenu.isOpen() || (isMobile() && open.size > 0);
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
  return !embedded || open.size > 0 || availableFor(buildCtx()).length > 0;
}

const CHAT_PANE: PaneDef = { id: "chat", title: "Chat", icon: MESSAGE_ICON };
const paneOpen = (id: string): boolean =>
  id !== "chat"
    ? open.has(id)
    : isMobile()
      ? !mobileActive
      : desktopDock.chatOpen();

/** Offered panes in rail order; the finder also offers Chat, last. */
export function offeredPanes({ includeChat = false } = {}) {
  const panes = availableFor(buildCtx()).filter((p) => !fileTabs.has(p.id));
  return (includeChat ? [...panes, CHAT_PANE] : panes).map((pane) => ({
    id: pane.id,
    title: pane.title || pane.id,
    icon: pane.icon || PANE_ICON,
    open: paneOpen(pane.id),
    finder: pane.finder,
  }));
}

/** Open the pane at a one-based rail position; desktop Chat is first. */
export function openPaneByIndex(index: number): boolean {
  const panes = offeredPanes();
  const pane = (isMobile() ? panes : [CHAT_PANE, ...panes])[index - 1];
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
  if (!target) {
    if (isMobile() || !open.has(id)) return false;
    desktopDock.focusControl(id, () => bodies.get(id) ?? null);
    return true;
  }
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
  if (restoreVisibleOrigin) return closePane(id, true, true, preserveComments);
  return desktopDock.closeTab(id, (fallback) => {
    const closed = closePane(id, true, false, preserveComments);
    if (closed && fallback) restoreAgentFocus();
    return closed;
  });
}

// Tracks pane focus rings through focusin, clearing them on tree/composer
// focus.
function syncPaneFocusIndicator(): void {
  const focused = focusedPaneId();
  const focusedId = focused && open.has(focused) ? focused : null;
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col"))
    col.classList.toggle("kb-focused", col.dataset.pane === focusedId);
}
document.addEventListener("focusin", syncPaneFocusIndicator);

/** Run desktop window commands without loading the dock on phones. */
export function runWindowCommand(command: WindowCommand): boolean {
  return desktopDock.command(command);
}

export function toggleFocusedPaneFullscreen(): boolean {
  if (!state.selectedId && paneVisitAgentId) return false;
  const id = activePaneId(true);
  if (!id) return false;
  toggleFull(id);
  return true;
}

// ---- column layout --------------------------------------------------------
function ensureColumn(
  id: string,
  ctx: PaneContext,
  column?: HTMLElement,
): HTMLElement | undefined {
  const existing = bodies.get(id);
  if (existing) return existing;
  const p = paneDefinitions().find((x) => x.id === id);
  if (!p) return undefined;
  const ownerId = paneVisitOwnerId || currentUiOwnerId();
  const col = column ?? document.createElement("div");
  if (!column) {
    col.className = fileTabs.has(id) ? "pane-col file-tab" : "pane-col";
    col.dataset.pane = id;
    col.dataset.theme = "pane";
  }
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
  if (!column) panesEl.appendChild(col);
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
      p.render?.(body, ctx);
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

function layout(explicitPane?: string): void {
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
  const mobile = isMobile();
  const visitMatches = paneVisitAgentId === ctx.agentId;
  if (visitMatches) {
    if (mobile || desktopPaneContentReady(ctx.agentId)) {
      for (const p of paneDefinitions())
        if (open.has(p.id)) ensureColumn(p.id, ctx);
    } else if (explicitPane && paneConversationRead !== "pending") {
      // Explicit links initialize their target immediately after the focused
      // read dispatches, without unlocking the other saved panes.
      ensureColumn(explicitPane, ctx);
    }
  }

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
      !ctx.agentId && !visitMatches,
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
    backdropEl.classList.toggle("on", overlay || paneMenu.isOpen());
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

// Spec: Desktop starts the rail with New, above Share link; phones and
// fullscreen Chat (which covers the rail) keep New in the Chat header.
function placeNew(mobile = isMobile()): void {
  const newTop = $("#new-top")!;
  if (mobile || fullId === "chat") {
    if (newTop.parentElement !== fabEl.parentElement) fabEl.before(newTop);
  } else if (railEl.firstElementChild !== newTop) railEl.prepend(newTop);
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
  // Spec: Delete sits last, apart from routine actions: after a line in
  // the phone More menu, at the foot of the desktop rail.
  if (actions[0].parentElement !== (mobile ? menuEl : railEl)) {
    if (mobile) {
      $("#pane-menu-divider")!.before(actions[2], actions[1]);
      $("#pane-menu-divider")!.after(actions[0]);
    } else {
      railEl.prepend(actions[2], actions[1]);
      railEl.append(actions[0]);
    }
    for (const action of actions) {
      if (mobile) action.setAttribute("role", "menuitem");
      else action.removeAttribute("role");
    }
  }
  placeNew(mobile);
  const badges = new Map(avail.map((p) => [p.id, paneBadge(p, ctx)]));
  const attentive = avail.filter(paneAttention);
  const hash =
    avail.map((p) => `${p.id}:${badges.get(p.id) || ""}`).join(",") +
    "|" +
    [...open].join(",") +
    "|" +
    attentive.map((p) => p.id).join(",") +
    "|" +
    (mobile ? "m" : paneOpen("chat") ? "d" : "dc") +
    "|" +
    state.selectedId;
  if (hash === railHash) return;
  railHash = hash;
  const any = avail.length > 0;
  railEl.classList.toggle(
    "on",
    !mobile &&
      (any ||
        !$("#new-top")!.hidden ||
        (!!state.selectedId && state.selectedId !== DRAFT)),
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
  const focusedPane =
    railPanels.querySelector<HTMLButtonElement>(".rail-btn:focus")?.dataset
      .pane;
  railPanels.innerHTML = "";
  for (const [index, p] of (mobile ? avail : [CHAT_PANE, ...avail]).entries()) {
    const b = document.createElement("button");
    const attention = attentive.includes(p);
    b.className =
      "rail-btn" +
      (paneOpen(p.id) ? " active" : "") +
      (attention ? " attention" : "");
    b.dataset.pane = p.id;
    const badge = badges.get(p.id) || "";
    const baseLabel = p.title || p.id;
    const counted = badge ? `${baseLabel} (${badge})` : baseLabel;
    const label = attention ? `${counted} available` : counted;
    b.title = index < 9 ? `${baseLabel} (g${index + 1})` : label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-expanded", paneOpen(p.id) ? "true" : "false");
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
    if (p.id === focusedPane) b.focus({ preventScroll: true });
  }

  paneMenu.renderItems(avail, badges, attentive, open, (id) =>
    openPane(id, { focusEntry: true }),
  );
}

const paneMenu = createPaneMenu({
  fab: fabEl,
  menu: menuEl,
  backdrop: backdropEl,
  overlayOpen: () => isMobile() && !!mobileActive && open.size > 0,
  onBackdrop: () => {
    if (isMobile() && mobileActive) closePane(mobileActive, true, true);
  },
});

addEventListener("popstate", () => {
  if (phoneListEntry()) paneMenu.close();
});

mq.addEventListener("change", () => {
  paneMenu.close();
  railHash = "";
  if (isMobile()) {
    desktopDock.sync(false, []);
    if (paneVisitAgentId !== state.selectedId) beginPaneVisit(state.selectedId);
    const commentPane =
      selectionCommentOwner()?.closest<HTMLElement>(".pane-col")?.dataset.pane;
    mobileActive =
      commentPane && open.has(commentPane) ? commentPane : activePaneId(true);
    for (const id of Array.from(open)) if (id !== mobileActive) closePane(id);
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

// Login recovery can restore the link before the poll dispatches its read.
export function deferPaneOpenUntilRead(open: () => void): boolean {
  const defer = !isMobile() && !embedded && paneConversationRead === "pending";
  paneOpenAfterDispatch = defer ? open : null;
  return defer;
}

/** Window contents follow the focused read; the saved grid can paint earlier. */
export function notePaneConversationRequested(
  agentId: string,
): ((failed: boolean) => void) | undefined {
  if (paneVisitAgentId !== agentId || paneConversationRead === "settled")
    return;
  paneConversationRead = "requested";
  const attempt = ++paneReadAttempt;
  const afterDispatch = paneOpenAfterDispatch;
  if (afterDispatch)
    queueMicrotask(() => {
      if (paneOpenAfterDispatch !== afterDispatch) return;
      paneOpenAfterDispatch = null;
      afterDispatch();
    });
  return (failed) => {
    if (paneReadAttempt !== attempt) return;
    paneConversationRead = "settled";
    if (failed && !isMobile()) syncPanes();
  };
}

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
  const mobile = isMobile();
  let ownLayout = !mobile && desktopDock.restoreLayout();
  if (paneVisitAgentId !== ctx.agentId) return;
  desktopDock.finishPreview();
  if (!mobile && !desktopPaneContentReady(ctx.agentId)) return;
  const rendered =
    paneRenderedAgentId === ctx.agentId &&
    paneVisitOwnerId === currentUiOwnerId();
  if (!mobile && [...open].some((id) => !bodies.has(id))) layout();
  const discovering = new Set<string>();
  const avail = availableFor(ctx, discovering);
  const availIds = new Set(avail.map((p) => p.id));
  for (const id of Array.from(open))
    if (
      !availIds.has(id) &&
      (mobile || (!fileTabs.has(id) && rendered && !discovering.has(id)))
    ) {
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
  if (!ownLayout && !mobile && rendered)
    ownLayout = desktopDock.restoreLayout(availIds);
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
