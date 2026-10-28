// Registers optional panes and owns visibility, selection, bounded body caches
// and desktop/mobile layout. Conversation actions retain their module owners.
// Phone content/header share a scroller. Unregistered/unavailable panes hide
// their rail; unavailable open panes close on refresh.
import { currentUiOwnerId, DRAFT, embedded, state } from "./state.js";
import {
  DELETE_ICON,
  TAKE_CONTROL_ICON,
  UP_ICON,
  NEW_ICON,
  MORE_ICON,
  PANE_ICON,
  PANE_COMPRESS_ICON,
  PANE_EXPAND_ICON,
} from "./icons.js";
import { installPaneChrome } from "./panes/chrome.js";
import { createPanePowerbar, retainPanePowerbar } from "./panes/powerbar.js";
import { $, inputEl } from "./dom.js";
import { pendingCommentCount } from "./comments.js";
import {
  ArtifactPaneAutoOpenPolicy,
  type ArtifactAutoOpenObservation,
} from "./panes/autoopen.js";
import { storedPanesWidth, ensurePanesGrip } from "./resize.js";
import { guardLeaveComments } from "./comments.js";
import { mobileSidebarOpen, restoreAgentFocus } from "./sidebar.js";
import {
  cyclePane,
  paneFocusIndicatorId,
  paneIsActionable,
  paneVisibilityAfterUserAction,
  resolvePaneActivation,
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
import type { PaneContext, PaneDef } from "./types.js";
export { setPaneLoading } from "./panes/loading.js";

for (const [id, icon] of [
  ["trash-btn", DELETE_ICON],
  ["takeover-btn", TAKE_CONTROL_ICON],
  ["up-btn", UP_ICON],
  ["up-top", UP_ICON],
  ["new-top", NEW_ICON],
  ["pane-fab", MORE_ICON],
])
  $("#" + id)!.insertAdjacentHTML("afterbegin", icon);

const registry: PaneDef[] = [];
const open = new Set<string>();
const bodies = new Map<string, HTMLElement>();
const cachedPhoneScroll = new WeakMap<HTMLElement, number>();
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
let paneVisitAgentId: string | null = null;
let paneVisitOwnerId: string | null = null;
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

const mq = matchMedia("(max-width: 700px)");
const isMobile = (): boolean => mq.matches;

// A conversation switch restores only that conversation's explicit visibility
// choice. A first visit starts from the product default instead of inheriting a
// pane from the previous conversation; Artifacts may still auto-open by policy.
export function beginPaneVisit(
  agentId: string,
  ownerId = currentUiOwnerId(),
): void {
  artifactAutoOpen.beginVisit(agentId);
  filesAutoOpen.beginVisit(agentId);
  for (const def of registry) def.visit?.(agentId);
  clearArtifactAnnouncement();
  if (artifactsAttention) {
    artifactsAttention = false;
    railHash = "";
  }
  if (paneVisitAgentId === agentId && paneVisitOwnerId === ownerId) return;

  const held =
    document.activeElement instanceof HTMLElement &&
    !!document.activeElement.closest(".pane-col");
  const outgoingOwnerId = paneVisitOwnerId;
  for (const id of [...open]) closePane(id);
  if (outgoingOwnerId) conversationUiState.flush(outgoingOwnerId);
  if (held) restoreAgentFocus();

  paneVisitAgentId = agentId;
  paneVisitOwnerId = ownerId;
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
  // Invariant: Priority promotion checks owner and agent together. Unlike
  // restoration, it may read unavailable panes; a wrong priority only warms
  // cache and cannot restore the wrong owner's selection.
  const restoring =
    paneVisitVisibility.kind === "open" &&
    paneVisitVisibility.id === paneId &&
    paneVisitAgentId === agentId &&
    paneVisitOwnerId === currentUiOwnerId();
  if (open.has(paneId) || restoring) {
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
  const prior = conversationUiState.pane(ownerId);
  paneVisitVisibility = paneVisibilityAfterUserAction(
    prior,
    id,
    opening,
    preserveLastId,
  );
  conversationUiState.setPane(ownerId, paneVisitVisibility);
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
    definition = registry.find((p) => p.id === id);
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

function forgetPaneState(id: string): void {
  const body = bodies.get(id),
    ownerId = paneOwners.get(id),
    agentId = paneAgents.get(id);
  const definition = registry.find((p) => p.id === id);
  bodies.delete(id);
  paneOwners.delete(id);
  paneAgents.delete(id);
  if (body)
    try {
      definition?.leave?.(body);
    } catch {}
  if (!body || !ownerId || !agentId || !definition?.cache) return;
  if (isMobile())
    cachedPhoneScroll.set(body, body.parentElement?.scrollTop ?? 0);
  const context = buildCtxFor(agentId);
  const scope = paneCacheScope(id, ownerId, context, definition);
  if (scope) paneInstances.put(scope, body, context, definition.cache);
  else
    try {
      definition.cache.dispose?.(body, context);
    } catch {}
}

// A plugin mutation can discard only its detached rendered instances. Active
// bodies refresh normally and will be cached from their new state when closed.
export function invalidatePaneCache(id: string, instanceKey?: string): void {
  paneInstances.invalidate(id, instanceKey);
}

function availableFor(ctx: PaneContext): PaneDef[] {
  return registry.filter((p) => {
    try {
      return p.available ? !!p.available(ctx) : true;
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
  if (!registry.some((p) => p.id === id)) return false;
  const focusHeading = options.focusHeading !== false;
  const entrySel =
    options.focusTarget === "body" ? ".pane-body" : ".pane-title";
  const userInitiated = options.userInitiated !== false;
  // Invariant: Replacing a comment-capable pane is a leave action just like
  // closing it. Do not clear its attention/visit state until the operator
  // accepts the existing shared comment guard.
  if (
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
  focusOrigins.clear();
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
  // Invariant: At most one panel is open; opening another replaces it. Layout
  // owns removal/reattachment of desktop columns and mobile grips.
  open.clear();
  if (isMobile()) {
    for (const paneId of [...bodies.keys()]) forgetPaneState(paneId);
    panesEl.innerHTML = "";
    mobileActive = id;
  }
  open.add(id);
  if (userInitiated) noteUserPaneAction(id, true, options.preserveLastId);
  layout();
  syncPanes();
  if (focusHeading)
    requestAnimationFrame(() => {
      const col = panesEl.querySelector<HTMLElement>(
        `.pane-col[data-pane="${CSS.escape(id)}"]`,
      );
      const target = col?.querySelector<HTMLElement>(entrySel);
      (target?.inert
        ? col?.querySelector<HTMLElement>(".pane-title")
        : target
      )?.focus({ preventScroll: true });
    });
  return true;
}
function closePane(
  id: string,
  userInitiated = false,
  restoreFocus = userInitiated,
): boolean {
  if (!open.has(id) || (userInitiated && !guardLeaveComments())) return false;
  capturePaneState(id);
  if (userInitiated) noteUserPaneAction(id, false);
  const origin = focusOrigins.get(id);
  open.delete(id);
  forgetPaneState(id);
  focusOrigins.delete(id);
  if (mobileActive === id) mobileActive = null;
  if (fullId === id) fullId = null;
  layout();
  renderRail(availableFor(buildCtx()));
  if (restoreFocus)
    requestAnimationFrame(() => {
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
  return true;
}
function togglePane(id: string): void {
  open.has(id)
    ? closePane(id, true, true)
    : openPane(id, { userInitiated: true });
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
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col")) {
    const on = col.dataset.pane === fullId;
    const modal = on || (mobile && col.dataset.pane === mobileActive);
    col.classList.toggle("fullscreen", on);
    col.setAttribute("role", modal ? "dialog" : "region");
    if (modal) col.setAttribute("aria-modal", "true");
    else col.removeAttribute("aria-modal");
    const fs = col.querySelector<HTMLElement>(".pane-head .fs");
    if (fs) {
      fs.innerHTML = on ? PANE_COMPRESS_ICON : PANE_EXPAND_ICON;
      fs.title = on ? "Exit fullscreen" : "Fullscreen";
      fs.setAttribute("aria-label", on ? "Exit fullscreen" : "Open fullscreen");
      fs.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
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
  const modal = activeId
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
    // full-screen dialog before it can reach covered chrome, then keep the
    // focus trap.
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
    panesEl
      .querySelector<HTMLElement>(
        `.pane-col[data-pane="${CSS.escape(id)}"] .fs`,
      )
      ?.focus();
    return true;
  }
  if (menuEl.classList.contains("on")) {
    closeMenu();
    fabEl.focus();
    return true;
  }
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const focusedCol = activeElement?.closest<HTMLElement>(".pane-col");
  const id = (isMobile() ? mobileActive : focusedCol?.dataset.pane) || null;
  if (!id || !open.has(id)) return false;
  const before = open.has(id);
  closePane(id, true);
  return before && !open.has(id);
}
// Only fullscreen/mobile/menu panes are modal; desktop columns preserve tree
// navigation, with Pane mode/native editor keys only while focus is inside.
export function paneKeyboardLayerOpen(): boolean {
  return (
    !!fullId || menuEl.classList.contains("on") || (isMobile() && open.size > 0)
  );
}

function activePaneId(fallback = false): string | null {
  if (fullId && open.has(fullId)) return fullId;
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const focused = active?.closest<HTMLElement>(".pane-col")?.dataset.pane;
  if (focused && open.has(focused)) return focused;
  if (mobileActive && open.has(mobileActive)) return mobileActive;
  return fallback ? [...open][0] || null : null;
}

// Pane keyboard actions are available when a pane is open or can be opened.
export function paneActionable(): boolean {
  // Invariant: Runs on every keydown; short-circuit on an open pane before the
  // availableFor() scan, whose predicates are side-effectful (TTL-guarded)
  // fetches.
  return (
    open.size > 0 ||
    paneIsActionable(
      [...open],
      availableFor(buildCtx()).map((p) => p.id),
    )
  );
}

// The `o` key toggles pane visibility from either the conversation or pane
// focus context. Opening moves focus into the labelled, scrollable pane body;
// closing moves it to the agent tree so focus never remains on removed content.
export function togglePaneFromKeyboard(): boolean {
  const availableIds = availableFor(buildCtx()).map((p) => p.id);
  const preferredId =
    paneVisitVisibility.kind === "default"
      ? undefined
      : paneVisitVisibility.lastId;
  const decision = resolvePaneActivation([...open], availableIds, preferredId);
  if (!decision) return false;
  if (decision.kind === "open")
    return openPane(decision.id, {
      userInitiated: true,
      focusHeading: true,
      focusTarget: "body",
      preserveLastId: !!preferredId && preferredId !== decision.id,
    });
  return closeFocusedPaneFromKeyboard(decision.id);
}

// Focus an open pane without reopening it or changing fullscreen/visibility.
export function focusPaneFromKeyboard(): boolean {
  const id = activePaneId(true);
  if (!id) return togglePaneFromKeyboard();
  const body = panesEl.querySelector<HTMLElement>(
    `.pane-col[data-pane="${CSS.escape(id)}"] .pane-body`,
  );
  body?.focus({ preventScroll: true });
  return document.activeElement === body;
}

export function closeFocusedPaneFromKeyboard(
  preferredId?: string,
  restoreVisibleOrigin = false,
): boolean {
  const id = preferredId || activePaneId(true);
  if (!id) return false;
  const closed = closePane(id, true, restoreVisibleOrigin);
  if (closed && !restoreVisibleOrigin) restoreAgentFocus();
  return closed;
}

// Tracks pane focus rings through focusin, clearing them on tree/composer
// focus.
function syncPaneFocusIndicator(): void {
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const columnId =
    active?.closest<HTMLElement>(".pane-col")?.dataset.pane ?? null;
  const focusedId = paneFocusIndicatorId(columnId, [...open]);
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col"))
    col.classList.toggle("kb-focused", col.dataset.pane === focusedId);
}
document.addEventListener("focusin", syncPaneFocusIndicator);

// Pane mode j/k: switch to the next/previous pane available for this agent and
// focus it (its content stays scrollable via the mouse/trackpad/native arrows).
export function switchPane(delta: -1 | 1): boolean {
  const availableIds = availableFor(buildCtx()).map((p) => p.id);
  const current = activePaneId(true);
  const nextId = cyclePane(availableIds, current, delta);
  if (!nextId || nextId === current) return false;
  return openPane(nextId, {
    userInitiated: true,
    focusHeading: true,
    focusTarget: "body",
  });
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
  const p = registry.find((x) => x.id === id);
  if (!p) return undefined;
  const ownerId = paneVisitOwnerId || currentUiOwnerId();
  const col = document.createElement("div");
  col.className = "pane-col";
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
  col.append(retainPanePowerbar(body, head), body);
  panesEl.appendChild(col);
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
  ensurePanesGrip();
  if (fullId && !open.has(fullId)) fullId = null;
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col")) {
    const pid = col.dataset.pane;
    if (!pid || !open.has(pid)) {
      if (pid) forgetPaneState(pid);
      col.remove();
    }
  }
  for (const p of registry) if (open.has(p.id)) ensureColumn(p.id, ctx);

  const mobile = isMobile();
  panesEl.classList.toggle("on", open.size > 0);
  const w = mobile ? null : storedPanesWidth();
  if (w != null) {
    panesEl.style.flex = "none";
    panesEl.style.width = w + "px";
  } else {
    panesEl.style.flex = mobile ? "" : String(open.size);
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
  if (mobile)
    for (const body of bodies.values()) {
      const top = cachedPhoneScroll.get(body);
      if (top === undefined) continue;
      body.parentElement!.scrollTop = top;
      cachedPhoneScroll.delete(body);
    }
}

// ---- rail + mobile menu ---------------------------------------------------
function paneBadge(pane: PaneDef, ctx: PaneContext): string {
  try {
    const value = pane.badge?.(ctx);
    return value === null || value === undefined || value === ""
      ? ""
      : String(value).slice(0, 6);
  } catch {
    return "";
  }
}

function renderRail(avail: PaneDef[], ctx = buildCtx()): void {
  const mobile = isMobile();
  // Invariant: Reparent shared controls, retaining their owners and handlers.
  const actions = [$("#trash-btn")!, $("#takeover-btn")!];
  const actionHost = mobile ? menuEl : railEl;
  if (actions[0].parentElement !== actionHost) {
    actionHost.prepend(...actions);
    for (const action of actions) {
      if (mobile) action.setAttribute("role", "menuitem");
      else action.removeAttribute("role");
    }
  }
  const badges = new Map(avail.map((p) => [p.id, paneBadge(p, ctx)]));
  const hash =
    avail.map((p) => `${p.id}:${badges.get(p.id) || ""}`).join(",") +
    "|" +
    [...open].join(",") +
    "|" +
    (artifactsAttention ? "a" : "") +
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
  const mobileAttention =
    artifactsAttention && avail.some((p) => p.id === ARTIFACTS_PANE_ID);
  fabEl.classList.toggle("attention", mobileAttention);
  fabEl.title = mobileAttention
    ? "More actions — Artifacts available"
    : "More actions";
  fabEl.setAttribute(
    "aria-label",
    mobileAttention ? "More actions — Artifacts available" : "More actions",
  );

  const railPanels = $("#pane-rail-panels")!;
  railPanels.innerHTML = "";
  for (const p of avail) {
    const b = document.createElement("button");
    const attention = artifactsAttention && p.id === ARTIFACTS_PANE_ID;
    b.className =
      "rail-btn" +
      (open.has(p.id) ? " active" : "") +
      (attention ? " attention" : "");
    b.dataset.pane = p.id;
    const badge = badges.get(p.id) || "";
    const baseLabel = p.title || p.id;
    const counted = badge ? `${baseLabel} (${badge})` : baseLabel;
    const label = attention ? `${counted} available` : counted;
    b.title = label;
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
    const attention = artifactsAttention && p.id === ARTIFACTS_PANE_ID;
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
    b.onclick = () => openPane(p.id);
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
  layout();
  syncPanes();
});
addEventListener("panes-relayout", () => layout());

// ---- the per-poll sync (called from the conversation refresh) -------------
let syncFailureAnnounced = false;

function restorePanePreference(availableIds: ReadonlySet<string>): boolean {
  if (
    paneVisitAgentId !== state.selectedId ||
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
  const avail = availableFor(ctx);
  const availIds = new Set(avail.map((p) => p.id));
  for (const id of [...open])
    if (!availIds.has(id)) {
      // Invariant: If the pane being auto-closed currently holds keyboard
      // focus, hand focus back to the canonical tree/menu target so a Pane-mode
      // user is never dropped onto <body>.
      const held =
        document.activeElement instanceof HTMLElement &&
        !!document.activeElement.closest(
          `.pane-col[data-pane="${CSS.escape(id)}"]`,
        );
      closePane(id);
      if (held) restoreAgentFocus();
    }

  // Invariant: Explicit state wins over per-visit defaults and asynchronous
  // Artifact discovery. openPane() re-enters sync with the pane present, so
  // return after a successful restore rather than refreshing the same body
  // twice.
  if (restorePanePreference(availIds)) return;

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
    otherPaneOpen: [...open].some((id) => id !== ARTIFACTS_PANE_ID),
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
    otherPaneOpen: [...open].some((id) => id !== FILES_PANE_ID),
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
    const p = registry.find((x) => x.id === id);
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
  for (const id of open) capturePaneState(id);
  conversationUiState.flush();
});

beginPaneVisit(state.selectedId);
