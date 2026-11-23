// Entry point: pulls the feature modules together, executes the pure
// centralized keymap's effects, and boots the poll loop.
// Auth/generation reload defers while browser-only work cannot survive.
// Capture dispatch precedes local input handlers; unclaimed keys stay native.
import { startMainThreadTiming } from "./main-thread-timing.js";
import { installPhonePaneHistory, phoneListEntry } from "./phone-nav.js";
import * as threadState from "./row-thread-state.js";
import { rowThreads } from "./row-thread-state/index.js";
import { startBackendDiscovery } from "./backends/discovery/index.js";
import { backends } from "./backends/backend.js";
import { treeOf } from "./backends/tree.js";
import { keepSubagentsOpen } from "./sidebar/agent-folds.js";
import {
  state,
  chordLabel,
  embedded,
  embeddedFrameHidden,
  primaryPointerIsCoarse,
} from "./state.js";
import { startInteractionTiming } from "./interaction-timing.js";
import {
  configureAgentFocus,
  focusAgentTree,
  restoreAgentFocus,
} from "./sidebar/focus.js";
import { configureSidebarActions } from "./sidebar/index.js";
import { configureArtifactRendering } from "./artifacts/artifact-state.js";
import { commentOutbox } from "./artifacts/index.js";
import { renderContent } from "./artifacts/content-view.js";
import { configureDisclosure } from "./conversation/disclosure.js";
import * as threadRender from "./thread-render.js";
import { configureRowPaint } from "./thread-render/index.js";
import { configureBoxCommentOffer } from "./comments/box/index.js";

configureAgentFocus(renderSidebar);
configureArtifactRendering(renderContent);
configureBoxCommentOffer(offerBoxComment);
configureRowPaint({ paint, anchoredPaint });
configureThreadTemplates(threadRender, commentOutbox);
configureDisclosure(threadState, threadState.loadOlder);
threadState.configureRowFileUpdates(files);
configureOperatorSendScroll(prepareOperatorSendScroll);
configureSidePane(poll);
configureSidebarActions({
  refreshTree: poll,
  startDraft: startNewAgent,
  renderActiveAgentRow: activeAgentRowT,
  openAgent: selectAgent,
});
$("#panes")!.addEventListener("keydown", (event) => {
  const pane = paneForTarget(event.target);
  if (pane) handleCommentShortcut(event, pane);
});
startInteractionTiming(() => state.selectedId);
startMainThreadTiming(
  () => ({
    conversation_id: state.selectedId,
    held_rows: rowThreads.get(state.selectedId)?.rows.length || 0,
    rendered_rows: document.querySelectorAll("#messages [data-row-id]").length,
    remote_count: backends().length - 1,
    remote_statuses: backends()
      .slice(1, 17)
      .map((backend) => treeOf(backend).status),
    composer_focused: document.activeElement?.id === "input",
    embedded,
  }),
  embeddedFrameHidden,
);
startBackendDiscovery();
import { dismissEffortMenu, openEffortMenu } from "./models.js";
import { openContextViewer } from "./context-viewer.js";
import { closePowerbarOverflow } from "./panes/powerbar.js";
import type { PaneNavigation, TreeNode } from "./types.js";
import type { WindowCommand } from "./dock/commands.js";
import { $, inputEl, scrollEl } from "./dom.js";
import { scrollThreadForReader } from "./thread-scroll/index.js";
import {
  isNativeActivationKey,
  isTextEditorTarget,
} from "../src/keyboard_target.js";
import {
  insertTextAtSelection,
  isDialogTarget,
  shouldTypeToCompose,
} from "./type_to_compose.js";
import {
  classifyKeyTarget,
  visibleCommentControl,
} from "./keyboard_context.js";
import { installKeyboardModeController } from "./modal-mode.js";
import {
  SHORTCUT_GROUPS,
  G_BINDINGS,
  WINDOW_BINDINGS,
  adjacentCursor,
  formatShortcutKey,
  initialKeymapState,
  keymapModeLabel,
  reduceKeymap,
  shouldLeaveEmptyComposer,
  type KeyCommand,
  type KeyContext,
  type KeymapState,
  type KeyTarget,
} from "./keymap.js";
import {
  activeAgentRowT,
  renderSidebar,
  visibleRows,
  moveCursor,
  selectAgent,
  treeAscendOrCollapse,
  treeExpandIfCollapsed,
  armDelete,
  disarmDelete,
  killSelected,
  refreshUpBtn,
  startRename,
  cancelRename,
  commitRename,
  isRenaming,
} from "./sidebar.js";
import {
  agentSurfaceOpen,
  closeAgentSurface,
  closeShellSurface,
  shellSurfaceOpen,
} from "./conversation/shell-surface.js";
import {
  anchoredPaint,
  configureThreadTemplates,
  paint,
  prepareOperatorSendScroll,
  toggleLatestTurnEye,
} from "./conversation/thread.js";
import {
  poll,
  startPolling,
  waitForInitialAuthoritativeRead,
} from "./polling/index.js";
import { requestStop, stopPublicationPending } from "./conversation/stop.js";
import {
  closeSafetyConfirmation,
  configureOperatorSendScroll,
  requestTakeoverToggle,
  safetyConfirmationOpen,
  scrollToLatest,
  type TakeoverToggleResult,
} from "./conversation/index.js";
import {
  send,
  hasUnsentComposerWork,
  preserveUnsentForLogin,
  startNewAgent,
} from "./composer.js";
import { focusComposerAtEnd } from "./composer/index.js";
import { startConnectionMonitoring } from "./connection.js";
installPhonePaneHistory(
  () => closeFocusedPaneFromKeyboard(undefined, true, true),
  restorePhonePane,
);
import { guardLeaveComments, pendingCommentCount } from "./comments.js";
import { closeSettings, settingsOpen } from "./settings.js";
import { closePrompt, promptOpen } from "./prompt.js";
import {
  closePaneKeyboardLayer,
  paneKeyboardLayerOpen,
  hasFullscreenPane,
  paneActionable,
  paneForTarget,
  openPaneByIndex,
  scrollFocusedPane,
  runWindowCommand,
  closeFocusedPaneFromKeyboard,
  navigateFocusedPane,
  toggleFocusedPaneFullscreen,
  restorePhonePane,
} from "./panes.js";
import {
  closeSkillAutocomplete,
  skillAutocompleteOpen,
  skillAutocompleteOwnsKey,
} from "./skills.js";
import { composerAutocompleteOwnsKey } from "./composer/autocomplete.js";
import {
  closeDrawingFromKeyboard,
  drawingEditorOpen,
  drawingEditorOwnsKey,
} from "./image-preview/editor.js";
import {
  thumbnailFallback,
  threadImageLoaded,
} from "./image-preview/inline.js";
import { showExternalImage } from "./image-preview/references.js";
import {
  agentFinderOpen,
  closeAgentFinder,
  configureAgentFinderNavigation,
  openAgentFinderNavigate,
} from "./agent-finder/ui.js";
import {
  openPaneFinder,
  closePaneFinder,
  paneFinderOpen,
} from "./pane-finder.js";
import "./resize.js";
import {
  artifactVersionMenuOpen,
  closeArtifactVersionMenuKeyboardLayer,
} from "./artifacts/pane.js";
import { openPullRequestFinder } from "./diff.js";
import { configureSidePane, relaySideKey } from "./side-pane.js";
import * as files from "./files.js";
import { explorerSearchOwnsKey } from "./explorer/index.js";
import {
  closeSelectionCommentFromKeyboard,
  handleCommentShortcut,
  hasStagedCommentsIn,
  offerBoxComment,
} from "./artifacts/selection-comments.js";
import { handleDownloadClick } from "./download.js";
import { UI_STATUS_EVENT } from "./ui-events.js";
import "./selection-comments.js";
import "./comments/touch-selection-edge.js";
import "./tips/pane.js";

document.addEventListener("click", handleDownloadClick, true);
document.addEventListener("click", showExternalImage);
document.addEventListener("error", thumbnailFallback, true);
document.addEventListener("load", threadImageLoaded, true);

// Wrapped-shell bounds keep mobile overlays below safe-area/keyboard changes.
const topbarEl = $("#topbar");
function syncMobileShellHeight(): void {
  if (!topbarEl || !window.matchMedia("(max-width: 700px)").matches) {
    document.documentElement.style.removeProperty("--mobile-shell-height");
    return;
  }
  const value = `${Math.ceil(topbarEl.getBoundingClientRect().height)}px`;
  if (
    document.documentElement.style.getPropertyValue("--mobile-shell-height") !==
    value
  )
    document.documentElement.style.setProperty("--mobile-shell-height", value);
}
if (topbarEl) {
  const resizeObserver = new ResizeObserver(syncMobileShellHeight);
  // Invariant: Safe-area insets change only padding; watch the border box.
  resizeObserver.observe(topbarEl, { box: "border-box" });
  syncMobileShellHeight();
}

// Invariant: Android Chrome can cover the bottom of 100dvh (keyboard open,
// URL bar shown) while the visual viewport reports what is visible, so phone
// shells end at the visual viewport's bottom. Pinch zoom keeps the layout.
function syncVisibleHeight(): void {
  const viewport = window.visualViewport;
  const root = document.documentElement.style;
  const bottom =
    viewport &&
    Math.abs(viewport.scale - 1) < 0.01 &&
    window.matchMedia("(max-width: 700px)").matches
      ? viewport.offsetTop + viewport.height
      : Infinity;
  if (bottom >= window.innerHeight - 1) root.removeProperty("--visible-height");
  else root.setProperty("--visible-height", `${bottom}px`);
}
window.visualViewport?.addEventListener("resize", syncVisibleHeight);
window.visualViewport?.addEventListener("scroll", syncVisibleHeight);
syncVisibleHeight();

configureAgentFinderNavigation((id: string) => {
  if (!state.nodes[id]) return false;
  if (id !== state.selectedId && !guardLeaveComments()) return false;
  selectAgent(id);
  focusAgentTree();
  return true;
});

let keyState: KeymapState = initialKeymapState();
let keyTimer = 0;
// Detached optional chrome keeps mixed-generation shells able to boot polling.
const modeEl = $("#key-mode") ?? document.createElement("span");
const topActionsEl = $("#top-actions") ?? document.createElement("div");
const windowKeysEl = document.createElement("div");
windowKeysEl.id = "window-key-hints";
windowKeysEl.setAttribute("role", "note");
windowKeysEl.setAttribute("aria-label", "Window shortcuts");
windowKeysEl.hidden = true;
document.body.append(windowKeysEl);

function paintKeyState(): void {
  const label = keymapModeLabel(keyState);
  modeEl.textContent = label;
  modeEl.style.display = keyState.mode === "dialog" ? "none" : "";
  // Spec: Thread shortcuts and typing are the resting modes: their badge is
  // only announced; other modes (a focused pane, a prefix) show themselves.
  modeEl.classList.toggle(
    "sr-only",
    keyState.mode === "normal" || keyState.mode === "insert",
  );
  modeEl.classList.toggle(
    "pending",
    ["t-prefix", "g-prefix", "w-prefix"].includes(keyState.mode),
  );
  modeEl.classList.toggle(
    "danger",
    keyState.mode === "delete-pending" || keyState.mode === "interrupt-pending",
  );
  document.body.classList.toggle(
    "interrupt-pending",
    keyState.mode === "interrupt-pending",
  );
  topActionsEl.classList.toggle("prefix-on", keyState.mode === "t-prefix");
  $("#pane-rail")?.classList.toggle("prefix-on", keyState.mode === "t-prefix");
  topActionsEl.setAttribute("aria-label", "Agent actions");
  const bindings =
    keyState.mode === "g-prefix"
      ? G_BINDINGS
      : keyState.mode === "w-prefix"
        ? WINDOW_BINDINGS
        : [];
  windowKeysEl.hidden = !bindings.length;
  windowKeysEl.replaceChildren(
    ...bindings.map(({ keys, description }) => {
      const item = document.createElement("div");
      const key = document.createElement("kbd");
      key.textContent = keys[0] || "";
      const text = document.createElement("span");
      text.textContent = description;
      item.append(key, text);
      return item;
    }),
  );
}

function setKeyState(next: KeymapState): void {
  const wasDelete = keyState.mode === "delete-pending";
  keyState = next;
  if (wasDelete && next.mode !== "delete-pending") disarmDelete();
  clearTimeout(keyTimer);
  if (next.deadline !== null) {
    const anchor = next.anchorId;
    const mode = next.mode;
    keyTimer = setTimeout(
      () => {
        if (keyState.mode === mode && keyState.anchorId === anchor)
          setKeyState(initialKeymapState());
      },
      Math.max(0, next.deadline - Date.now()),
    ) as unknown as number;
  }
  paintKeyState();
}

installKeyboardModeController((mode) => setKeyState(initialKeymapState(mode)));

function flashKeyStatus(text: string): void {
  modeEl.textContent = text;
  modeEl.style.display = "";
  modeEl.classList.remove("sr-only");
  setTimeout(() => paintKeyState(), 900);
}
window.addEventListener(UI_STATUS_EVENT, (event) => {
  const message = (event as CustomEvent<{ message?: unknown }>).detail?.message;
  if (typeof message === "string" && message) flashKeyStatus(message);
});

function flashCancelled(): void {
  flashKeyStatus("Cancelled");
}

function localLayerOpen(): boolean {
  return (
    isRenaming() ||
    safetyConfirmationOpen() ||
    settingsOpen() ||
    promptOpen() ||
    artifactVersionMenuOpen() ||
    paneKeyboardLayerOpen() ||
    skillAutocompleteOpen() ||
    agentFinderOpen() ||
    paneFinderOpen() ||
    drawingEditorOpen() ||
    shellSurfaceOpen() ||
    agentSurfaceOpen()
  );
}

function closeLocalLayer(): void {
  const activeBefore = document.activeElement;
  let closed =
    closeSafetyConfirmation() ||
    closeDrawingFromKeyboard() ||
    files.closeImageFromKeyboard() ||
    closeArtifactVersionMenuKeyboardLayer() ||
    cancelRename() ||
    closeSettings() ||
    closePrompt() ||
    closePaneKeyboardLayer() ||
    closeShellSurface() ||
    closeAgentSurface();
  if (!closed && paneFinderOpen()) closed = closePaneFinder();
  if (!closed && agentFinderOpen()) closed = closeAgentFinder();
  if (!closed && skillAutocompleteOpen()) closeSkillAutocomplete();
  // Invariant: Preserve focus restored by a closer; blur only if the same local
  // editor still owns focus after cancellation.
  const activeAfter = document.activeElement;
  if (activeAfter instanceof HTMLElement && activeAfter === activeBefore)
    activeAfter.blur();
}

function keyTarget(target: EventTarget | null): KeyTarget {
  const element = target as HTMLElement | null;
  const textEditor =
    isTextEditorTarget(target) || isTextEditorTarget(document.activeElement);
  const insidePane = !!paneForTarget(target);
  return classifyKeyTarget({
    composer: element === inputEl,
    rename: !!element?.closest?.(".rename-input"),
    finder: !!element?.closest?.("[data-agent-finder], [data-pane-finder]"),
    insidePane,
    textEditor,
    // Invariant: Phone overlays change ARIA, not the pane keyboard contract;
    // desktop fullscreen is only a layout. Pane editors retain native input.
    // The pane menu remains a local dialog because it is outside #panes.
    modalLayer:
      safetyConfirmationOpen() ||
      settingsOpen() ||
      promptOpen() ||
      artifactVersionMenuOpen() ||
      drawingEditorOpen() ||
      (paneKeyboardLayerOpen() &&
        !insidePane &&
        !element?.closest?.("#scroll, #sidebar")) ||
      (!insidePane &&
        isDialogTarget(target) &&
        !element?.closest?.("dialog.image-popout")),
  });
}

function hasTextSelection(target: EventTarget | null): boolean {
  const control = target as HTMLInputElement | HTMLTextAreaElement | null;
  if (
    control &&
    (control.tagName === "INPUT" || control.tagName === "TEXTAREA")
  )
    return control.selectionStart !== control.selectionEnd;
  const selection =
    target instanceof HTMLIFrameElement && target.matches("iframe.side-frame")
      ? target.contentDocument?.getSelection()
      : getSelection();
  return !!selection && !selection.isCollapsed;
}

function keyContext(
  event: KeyboardEvent,
  target = keyTarget(event.target),
): KeyContext {
  return {
    now: Date.now(),
    desktop: !primaryPointerIsCoarse(),
    target,
    selectedId: state.selectedId,
    interruptible: state.selectedRunning && !localLayerOpen(),
    deletable: !!state.nodes[state.cursorId],
    paneAvailable: paneActionable(),
    chatFullscreen: document
      .getElementById("main")
      ?.classList.contains("fullscreen"),
    textSelected: hasTextSelection(event.target),
    insideDialog: isDialogTarget(event.target),
    commentAvailable:
      event.key === "c" &&
      !isTextEditorTarget(event.target) &&
      !isTextEditorTarget(document.activeElement) &&
      target !== "composer" &&
      target !== "rename" &&
      !!visibleCommentControl(),
  };
}

function navigate(command: "next" | "previous"): void {
  const rows = visibleRows() as TreeNode[];
  const next = adjacentCursor(
    rows.map((row) => row.id),
    state.cursorId,
    command === "next" ? 1 : -1,
  );
  if (next) moveCursor(next);
}

function openCursor(): void {
  if (treeExpandIfCollapsed()) return;
  if (!state.nodes[state.cursorId]) return;
  if (state.cursorId !== state.selectedId && !guardLeaveComments()) return;
  keepSubagentsOpen(state.cursorId);
  selectAgent(state.cursorId);
}

async function toggleCursorTakeover(): Promise<void> {
  const result: TakeoverToggleResult = await requestTakeoverToggle(
    state.selectedId,
  );
  if (result.ok) {
    flashKeyStatus(
      result.takenOver ? "Taken over by the operator" : "Take-over released",
    );
    return;
  }
  const messages: Record<
    Extract<TakeoverToggleResult, { ok: false }>["reason"],
    string
  > = {
    missing: "No agent selected to take over",
    busy: "A take-over change is already in progress",
    failed: "Take-over change failed",
  };
  flashKeyStatus(messages[result.reason]);
}

function execute(command: KeyCommand | null): void {
  if (command?.startsWith("window-")) {
    if (!runWindowCommand(command.slice(7) as WindowCommand))
      setKeyState(initialKeymapState());
    return;
  }
  if (
    state.selectedId.includes("/") &&
    command &&
    ["choose-effort", "take-over"].includes(command)
  )
    return;
  switch (command) {
    case "parent":
      treeAscendOrCollapse();
      break;
    case "toggle-agents": {
      const sidebar = $("#sidebar");
      const focusInside = sidebar?.contains(document.activeElement);
      $<HTMLButtonElement>("#menu-btn")?.click();
      if (focusInside && sidebar?.classList.contains("desktop-hidden"))
        execute("focus-thread");
      break;
    }
    case "next":
      navigate("next");
      break;
    case "previous":
      navigate("previous");
      break;
    case "open":
      openCursor();
      break;
    case "comment": {
      const control = visibleCommentControl();
      if (control instanceof HTMLTextAreaElement) control.focus();
      else control?.click();
      break;
    }
    case "compose":
      if (hasFullscreenPane() || paneKeyboardLayerOpen())
        closePaneKeyboardLayer();
      if (!focusComposerAtEnd()) setKeyState(initialKeymapState());
      break;
    case "find-agent":
      openAgentFinderNavigate();
      break;
    case "new-agent":
      $<HTMLButtonElement>("#new-top")?.click();
      break;
    case "arm-delete":
      armDelete(0);
      break;
    case "delete":
      killSelected();
      break;
    case "rename":
      startRename(state.selectedId);
      break;
    case "find-pull-request":
      openPullRequestFinder();
      break;
    case "open-pane-finder":
      openPaneFinder();
      break;
    case "pane-1":
    case "pane-2":
    case "pane-3":
    case "pane-4":
    case "pane-5":
    case "pane-6":
    case "pane-7":
    case "pane-8":
    case "pane-9":
      openPaneByIndex(Number(command.slice(5)));
      break;
    case "scroll-pane-top":
      scrollFocusedPane("top");
      break;
    case "scroll-pane-bottom":
      scrollFocusedPane("bottom");
      break;
    case "focus-thread": {
      const focus = () => {
        scrollEl.tabIndex = -1;
        scrollEl.focus({ preventScroll: true });
      };
      const show = new CustomEvent("recurse:show-chat", {
        cancelable: true,
        detail: focus,
      });
      dispatchEvent(show);
      if (!show.defaultPrevented) focus();
      break;
    }
    case "focus-agents":
      restoreAgentFocus();
      break;
    case "pane-next":
    case "pane-previous":
    case "pane-half-down":
    case "pane-half-up":
    case "pane-open":
    case "pane-back":
    case "pane-previous-section":
    case "pane-next-section":
    case "pane-filter":
    case "pane-copy":
      navigateFocusedPane(command.slice(5) as PaneNavigation);
      break;
    case "pane-fullscreen":
      toggleFocusedPaneFullscreen();
      break;
    case "close-pane":
      closeFocusedPaneFromKeyboard();
      break;
    case "interrupt":
      void requestStop();
      break;
    case "commit-rename":
      commitRename();
      break;
    case "take-over":
      void toggleCursorTakeover();
      break;
    case "choose-effort":
      openEffortMenu();
      break;
    case "view-context":
      void openContextViewer();
      break;
    case "toggle-latest-turn":
      toggleLatestTurnEye();
      break;
    case "scroll-chat-down":
    case "scroll-chat-up":
      if (scrollEl.checkVisibility({ visibilityProperty: true }))
        scrollThreadForReader(
          scrollEl.scrollTop +
            scrollEl.clientHeight *
              (command === "scroll-chat-down" ? 0.5 : -0.5),
        );
      break;
    case "scroll-bottom":
      scrollToLatest();
      break;
    case "cancel-local":
      closeLocalLayer();
      break;
    case "invalid-chord":
      flashCancelled();
      break;
    case "unavailable-stop":
      flashKeyStatus("Nothing to stop");
      break;
  }
}

function dispatchKey(event: KeyboardEvent, target?: KeyTarget): boolean {
  const result = reduceKeymap(
    keyState,
    {
      key: event.key,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.isComposing,
      keyCode: event.keyCode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
    },
    keyContext(event, target),
  );
  if (result.handled) {
    event.preventDefault();
    event.stopPropagation();
    if (result.command !== "comment" && result.command !== "cancel-local")
      files.closeImageFromKeyboard();
  }
  setKeyState(result.state);
  execute(result.command);
  return result.handled;
}

document.addEventListener("recurse:side-key", (event: Event) => {
  const frame = event.target;
  const key = (event as CustomEvent<KeyboardEvent>).detail;
  if (
    !(frame instanceof HTMLIFrameElement) ||
    !frame.matches("#panes iframe.side-frame") ||
    frame !== document.activeElement ||
    keyTarget(frame) !== "pane" ||
    !key ||
    typeof key.key !== "string"
  )
    return;
  // Invariant: Side Escape cancels window commands without ever arming agent
  // shortcuts, including when a pending chord has expired. Keep native Escape.
  if (key.key === "Escape") {
    setKeyState(initialKeymapState("pane"));
    execute("window-cancel");
    return;
  }
  const forwarded = new KeyboardEvent("keydown", key);
  frame.dispatchEvent(forwarded);
  if (forwarded.defaultPrevented) event.preventDefault();
});

window.addEventListener("message", (event: MessageEvent) => {
  // Invariant: Opaque origins cannot authenticate Artifacts; only the
  // focused mounted frame may relay keys through the keymap dispatcher.
  const key: unknown = event.data?.recurseArtifactKey;
  if (
    typeof key !== "string" ||
    ![
      "j",
      "k",
      "d",
      "u",
      "l",
      "Enter",
      "[",
      "]",
      "/",
      "y",
      "z",
      "o",
      "p",
      "Escape",
      "h",
      "H",
      "P",
      "G",
      "g",
      "w",
      ...WINDOW_BINDINGS.flatMap(({ keys }) => keys),
      "q",
      "i",
      ..."123456789",
    ].includes(key)
  )
    return;
  const frame = document.activeElement;
  if (
    !(frame instanceof HTMLIFrameElement) ||
    !frame.matches("#panes iframe.artifact-embed") ||
    keyTarget(frame) !== "pane" ||
    event.source !== frame.contentWindow
  )
    return;
  dispatchKey(new KeyboardEvent("keydown", { key, cancelable: true }), "pane");
});

document.addEventListener(
  "keydown",
  (event: KeyboardEvent) => {
    if (
      event.target instanceof Element &&
      (event.target.closest("dialog.mermaid-viewer[open]") ||
        (event.target.closest(".status-bar-thinking-summary") &&
          /^(?:ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(event.key)))
    )
      return;
    // Invariant: Embedded editors and local controls keep native keys. Reader
    // shortcuts belong to the mounted Side pane, never the embedded agent tree.
    if (embedded && keyTarget(event.target) !== "composer") {
      const target = keyTarget(event.target);
      const element = event.target as HTMLElement | null;
      if (
        !localLayerOpen() &&
        target === "chrome" &&
        !element?.closest?.("#model-menu") &&
        !element
          ?.closest?.(".model-box")
          ?.querySelector('[aria-expanded="true"]') &&
        !isNativeActivationKey(event.key, event.target)
      )
        relaySideKey(event);
      return;
    }
    // Invariant: The drawing editor owns its keys; idle Escape still closes.
    if (drawingEditorOwnsKey(event)) return;
    if (
      event.key === "Escape" &&
      event.target instanceof Element &&
      event.target.closest("dialog.image-popout[open]")
    ) {
      event.preventDefault();
      event.stopPropagation();
      files.handleImageEscape();
      return;
    }
    if (
      event.key === "Escape" &&
      (!isTextEditorTarget(event.target) ||
        (event.target instanceof Element &&
          !!event.target.closest(".report-comment-popover"))) &&
      closeSelectionCommentFromKeyboard()
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape" && closePowerbarOverflow(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const mobileDrawerEscape =
      event.key === "Escape" &&
      phoneListEntry() &&
      window.matchMedia("(max-width: 700px)").matches;
    if (mobileDrawerEscape && isRenaming()) {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
      return;
    }
    const higherLayerOpen =
      safetyConfirmationOpen() ||
      settingsOpen() ||
      promptOpen() ||
      artifactVersionMenuOpen() ||
      drawingEditorOpen() ||
      shellSurfaceOpen() ||
      agentSurfaceOpen() ||
      skillAutocompleteOpen() ||
      agentFinderOpen() ||
      paneFinderOpen();
    if (mobileDrawerEscape && !higherLayerOpen) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Invariant: Nonempty search clears before pane navigation.
    if (!higherLayerOpen && explorerSearchOwnsKey(event)) return;
    const focusedPane = paneForTarget(event.target);
    if (
      event.key === "Escape" &&
      !higherLayerOpen &&
      focusedPane &&
      hasStagedCommentsIn(focusedPane) &&
      closeFocusedPaneFromKeyboard(focusedPane.dataset.pane, true, true)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Invariant: Touch layouts skip the desktop navigation reducer, but a
    // hardware Escape key must still dismiss an ARIA-modal surface and restore
    // visible focus.
    if (primaryPointerIsCoarse() && event.key === "Escape") {
      const eventElement = event.target as HTMLElement | null;
      const paneColumn = paneForTarget(event.target);
      const paneMenu = eventElement?.closest?.("#pane-menu");
      const closed = drawingEditorOpen()
        ? closeDrawingFromKeyboard()
        : /* Invariant: Inner menu owns Escape. */
          artifactVersionMenuOpen()
          ? closeArtifactVersionMenuKeyboardLayer()
          : paneColumn
            ? closeFocusedPaneFromKeyboard(undefined, true, true)
            : paneMenu
              ? closePaneKeyboardLayer()
              : false;
      if (closed) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    // A touch-opened effort menu leaves keyboard focus in the draft.
    if (
      event.key === "Escape" &&
      event.target === inputEl &&
      !event.defaultPrevented &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      dismissEffortMenu()
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    let target = keyTarget(event.target);
    const eventElement = event.target as HTMLElement | null;
    // Invariant: Only the open effort picker owns its list keys and Escape. A
    // hidden picker never changes tree navigation.
    if (eventElement?.closest?.("#model-menu")) return;
    // Invariant: An open Settings model box owns its list keys, Escape
    // included; a closed one leaves Escape to close Settings.
    if (
      eventElement
        ?.closest?.(".model-box")
        ?.querySelector?.('[aria-expanded="true"]')
    )
      return;
    const paneElement = paneForTarget(event.target);
    // Invariant: Focused pane content keeps Pane shortcuts even when
    // fullscreen. A nested menu retains its dialog keys; Escape from ordinary
    // pane editors returns focus to agents without changing pane layout.
    if (paneElement && target !== "dialog" && event.key === "Escape")
      target = "pane";
    else if (
      paneElement &&
      target === "dialog" &&
      event.key !== "Escape" &&
      !artifactVersionMenuOpen() &&
      !isTextEditorTarget(event.target)
    )
      target = "pane";

    // Invariant: A composer picker is the top Insert layer. Its target listener
    // owns movement, completion, and Escape before the modal reducer may leave
    // Insert or send the draft.
    if (
      target === "composer" &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      composerAutocompleteOwnsKey(event.key, event.shiftKey)
    )
      return;

    // Invariant: Empty composer arrows leave Insert and traverse in one press.
    // Non-empty drafts keep ordinary caret movement and are never disturbed.
    if (
      target === "composer" &&
      !embedded &&
      shouldLeaveEmptyComposer(
        {
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
        },
        !inputEl.value,
      )
    ) {
      inputEl.blur();
      setKeyState(initialKeymapState());
      dispatchKey(event, "chrome");
      return;
    }

    // Invariant: Native activation and image arrows keep their local actions.
    if (
      isNativeActivationKey(event.key, event.target) ||
      (eventElement?.closest("dialog.image-popout") &&
        ["ArrowLeft", "ArrowRight"].includes(event.key))
    ) {
      cancelKeyPrefix();
      return;
    }
    if (dispatchKey(event, target)) return;

    // Invariant: Insert's send/newline behavior stays native on touch. IME
    // Enter only commits composition; it never sends a draft.
    if (target === "composer") {
      // Invariant: The target-level skills listener runs after this capture
      // listener. Leave its navigation/completion keys untouched instead of
      // sending too early.
      if (skillAutocompleteOwnsKey(event.key, event.shiftKey)) return;
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !primaryPointerIsCoarse() &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        send();
      }
      return;
    }
    // Invariant: Editors and dialogs never fall into type-to-compose.
    if (target !== "chrome") return;

    // Invariant: Ordinary printable keys may retain #307's desktop
    // type-to-focus behavior. Reserved Normal keys were already consumed above,
    // so they can never leak a leading t/d/navigation character into a draft.
    const composerAvailable =
      !inputEl.disabled &&
      !inputEl.readOnly &&
      inputEl.isConnected &&
      !inputEl.closest("[hidden], [inert]") &&
      inputEl.getClientRects().length > 0;
    if (
      shouldTypeToCompose(event, {
        desktop: !primaryPointerIsCoarse(),
        composerFocused: false,
        paneFocused: !!paneForTarget(event.target),
        composerAvailable,
        textEditorFocused:
          isTextEditorTarget(event.target) ||
          isTextEditorTarget(document.activeElement),
        textSelected: hasTextSelection(event.target),
        dialogOpen: localLayerOpen() || isDialogTarget(event.target),
      })
    ) {
      const next = insertTextAtSelection(
        inputEl.value,
        inputEl.selectionStart,
        inputEl.selectionEnd,
        event.key,
      );
      if (!focusComposerAtEnd()) return;
      event.preventDefault();
      inputEl.value = next.value;
      inputEl.setSelectionRange(next.caret, next.caret);
      inputEl.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: event.key,
        }),
      );
      setKeyState(initialKeymapState("insert"));
    }
  },
  true,
);

document.addEventListener("focusin", (event: FocusEvent) => {
  const target = keyTarget(event.target);
  const focusedPane = paneForTarget(event.target);
  if (target === "composer") setKeyState(initialKeymapState("insert"));
  else if (target === "rename") setKeyState(initialKeymapState("rename"));
  else if (target === "finder") setKeyState(initialKeymapState("finder"));
  else if (target === "pane") setKeyState(initialKeymapState("pane"));
  else if (focusedPane && target === "dialog")
    setKeyState(initialKeymapState("pane"));
  else if (target === "dialog" || target === "editor")
    setKeyState(initialKeymapState("dialog"));
  else if (target === "chrome") setKeyState(initialKeymapState());
});
document.addEventListener("focusout", () => {
  // Invariant: Deferred blur cannot clear newer key state or a window prefix
  // when hidden or removed content drops focus to the document body.
  const before = keyState;
  setTimeout(() => {
    const active = document.activeElement;
    if (keyState !== before || keyTarget(active) !== "chrome") return;
    if (
      (before.mode === "g-prefix" || before.mode === "w-prefix") &&
      (!active || active === document.body)
    )
      return;
    setKeyState(initialKeymapState());
  }, 0);
});
function cancelKeyPrefix(): void {
  if (
    [
      "t-prefix",
      "g-prefix",
      "w-prefix",
      "delete-pending",
      "interrupt-pending",
    ].includes(keyState.mode)
  )
    setKeyState(initialKeymapState());
}
document.addEventListener("click", cancelKeyPrefix, true);
document.addEventListener("recurse:side-click", cancelKeyPrefix, true);
window.addEventListener("recurse:selection-change", cancelKeyPrefix);

// The sole shortcuts UI is rendered from dispatch metadata, including the live
// platform modifier spelling. On touch it starts collapsed but remains
// available.
function renderShortcuts(): void {
  const host = $("#shortcut-groups");
  if (!host) return;
  host.textContent = "";
  for (const group of SHORTCUT_GROUPS) {
    const section = document.createElement("section");
    section.className = "shortcut-group";
    const title = document.createElement("div");
    title.className = "shortcut-title";
    title.textContent = group.title;
    const keys = document.createElement("div");
    keys.className = "keys";
    for (const item of group.items) {
      const row = document.createElement("span");
      row.className = "k";
      item.keys.forEach((raw, index) => {
        const key = document.createElement("kbd");
        if (item.platform) {
          const shifted = !!item.shift && index === 0;
          key.textContent = chordLabel(raw, shifted, shifted);
        } else key.textContent = formatShortcutKey(raw);
        row.appendChild(key);
      });
      row.append(document.createTextNode(item.description));
      keys.appendChild(row);
    }
    section.append(title, keys);
    host.appendChild(section);
  }
}

// Shortcuts help restores desktop choices; touch always starts closed.
const SHORTCUT_PANE_KEY = "recurse.shortcutsPaneOpen";
function restoreShortcutPane(): void {
  const pane = $<HTMLDetailsElement>("#shortcut-pane");
  if (!pane) return;
  let wantOpen = false;
  if (!primaryPointerIsCoarse()) {
    try {
      wantOpen = localStorage.getItem(SHORTCUT_PANE_KEY) === "open";
    } catch {}
  }
  pane.open = wantOpen;
  pane.addEventListener("toggle", () => {
    try {
      localStorage.setItem(SHORTCUT_PANE_KEY, pane.open ? "open" : "closed");
    } catch {}
  });
}
renderShortcuts();
restoreShortcutPane();
paintKeyState();

window.addEventListener("recurse:update-ready", (event: Event) => {
  if (
    hasUnsentComposerWork() ||
    pendingCommentCount() > 0 ||
    stopPublicationPending()
  )
    event.preventDefault();
});
window.addEventListener("recurse:auth-expired", (event: Event) => {
  if (
    hasUnsentComposerWork() ||
    pendingCommentCount() > 0 ||
    stopPublicationPending()
  )
    event.preventDefault();
});
window.addEventListener("recurse:login-requested", (event: Event) => {
  if (pendingCommentCount() > 0 || !preserveUnsentForLogin())
    event.preventDefault();
});

// Recovery starts at boot; navigation waits for current tree/thread reads.
const initialAuthoritativeRead = waitForInitialAuthoritativeRead();
startConnectionMonitoring(poll, initialAuthoritativeRead);
void poll();
startPolling(() => !embedded || frameElement?.checkVisibility?.() !== false);
setInterval(renderSidebar, 30000);
refreshUpBtn();
