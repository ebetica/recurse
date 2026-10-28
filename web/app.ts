// Entry point: pulls the feature modules together, executes the pure
// centralized keymap's effects, and boots the poll loop.
// Auth/generation reload defers while browser-only work cannot survive.
// Capture dispatch precedes local input handlers; unclaimed keys stay native.
import { startMainThreadTiming } from "./main-thread-timing.js";
import { rowThreads } from "./row-thread-state.js";
import { startBackendDiscovery } from "./backends/discovery.js";
import { backends } from "./backends/backend.js";
import { treeOf } from "./backends/tree.js";
import {
  state,
  chordLabel,
  embedded,
  embeddedFrameHidden,
  primaryPointerIsCoarse,
} from "./state.js";
import { startInteractionTiming } from "./interaction-timing.js";

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
import { openEffortMenu } from "./models.js";
import { closePowerbarOverflow } from "./panes/powerbar.js";
import type { TreeNode } from "./types.js";
import { $, inputEl } from "./dom.js";
import {
  insertTextAtSelection,
  isDialogTarget,
  isTextEditorTarget,
  shouldTypeToCompose,
} from "./type_to_compose.js";
import {
  classifyKeyTarget,
  visibleCommentControl,
} from "./keyboard_context.js";
import { installKeyboardModeController } from "./modal-mode.js";
import {
  SHORTCUT_GROUPS,
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
  mobileSidebarOpen,
  closeMobileSidebar,
  focusAgentTree,
  restoreAgentFocus,
} from "./sidebar.js";
import {
  agentSurfaceOpen,
  closeAgentSurface,
  closeShellSurface,
  closeWorkingActivity,
  shellSurfaceOpen,
  workingActivityOpen,
} from "./conversation/shell-surface.js";
import { toggleLatestTurnEye } from "./conversation/thread.js";
import { poll, waitForInitialAuthoritativeRead } from "./conversation/poll.js";
import { requestStop, stopPublicationPending } from "./conversation/stop.js";
import {
  requestTakeoverToggle,
  scrollToLatest,
  type TakeoverToggleResult,
} from "./conversation/controls.js";
import {
  send,
  hasUnsentComposerWork,
  focusComposerAtEnd,
  preserveUnsentForLogin,
} from "./composer.js";
import { startConnectionMonitoring } from "./connection.js";
import { guardLeaveComments, pendingCommentCount } from "./comments.js";
import { closeSettings, settingsOpen } from "./settings.js";
import { closePrompt, promptOpen } from "./prompt.js";
import {
  closePaneKeyboardLayer,
  paneKeyboardLayerOpen,
  paneActionable,
  togglePaneFromKeyboard,
  focusPaneFromKeyboard,
  closeFocusedPaneFromKeyboard,
  switchPane,
  toggleFocusedPaneFullscreen,
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
  agentFinderOpen,
  closeAgentFinder,
  configureAgentFinderNavigation,
  openAgentFinderNavigate,
} from "./agent-finder/ui.js";
import "./resize.js";
import {
  artifactVersionMenuOpen,
  closeArtifactVersionMenuKeyboardLayer,
} from "./artifacts/pane.js";
import { openPullRequestFinder } from "./diff.js";
import { closeImageFromKeyboard } from "./files.js";
import { handleDownloadClick } from "./download.js";
import { UI_STATUS_EVENT } from "./ui-events.js";
import "./selection-comments.js";
import "./comments/touch-selection-edge.js";

document.addEventListener("click", handleDownloadClick, true);

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
  resizeObserver.observe(topbarEl);
  syncMobileShellHeight();
}

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

function paintKeyState(): void {
  const label = keymapModeLabel(keyState);
  modeEl.textContent = label;
  modeEl.classList.toggle("pending", keyState.mode === "t-prefix");
  modeEl.classList.toggle(
    "danger",
    keyState.mode === "delete-pending" || keyState.mode === "interrupt-pending",
  );
  document.body.classList.toggle(
    "interrupt-pending",
    keyState.mode === "interrupt-pending",
  );
  topActionsEl.classList.toggle("prefix-on", keyState.mode === "t-prefix");
  topActionsEl.setAttribute("aria-label", "Agent actions");
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
    settingsOpen() ||
    promptOpen() ||
    artifactVersionMenuOpen() ||
    paneKeyboardLayerOpen() ||
    mobileSidebarOpen() ||
    skillAutocompleteOpen() ||
    agentFinderOpen() ||
    drawingEditorOpen() ||
    shellSurfaceOpen() ||
    agentSurfaceOpen()
  );
}

function closeLocalLayer(): void {
  const activeBefore = document.activeElement;
  let closed =
    closeDrawingFromKeyboard() ||
    closeImageFromKeyboard() ||
    closeArtifactVersionMenuKeyboardLayer() ||
    cancelRename() ||
    closeSettings() ||
    closePrompt() ||
    closePaneKeyboardLayer() ||
    closeShellSurface() ||
    closeAgentSurface();
  if (!closed && mobileSidebarOpen()) {
    closeMobileSidebar();
    closed = true;
  }
  if (!closed) closed = closeWorkingActivity();
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
  const insidePane = !!element?.closest?.("#panes");
  return classifyKeyTarget({
    composer: element === inputEl,
    rename: !!element?.closest?.(".rename-input"),
    finder: !!element?.closest?.("[data-agent-finder]"),
    insidePane,
    textEditor,
    interactiveControl: !!element?.closest?.(
      "button, a[href], summary, [role='button']",
    ),
    // Invariant: Fullscreen/mobile changes a pane's ARIA layer, not its
    // keyboard contract: o still toggles it and pane editors must retain
    // native input. The pane menu remains a local dialog because it is outside
    // #panes.
    modalLayer:
      settingsOpen() ||
      promptOpen() ||
      artifactVersionMenuOpen() ||
      (paneKeyboardLayerOpen() &&
        !insidePane &&
        !element?.closest?.("#scroll, #sidebar")) ||
      mobileSidebarOpen() ||
      (!insidePane && isDialogTarget(target)),
  });
}

function hasTextSelection(target: EventTarget | null): boolean {
  const control = target as HTMLInputElement | HTMLTextAreaElement | null;
  if (
    control &&
    (control.tagName === "INPUT" || control.tagName === "TEXTAREA")
  )
    return control.selectionStart !== control.selectionEnd;
  const selection = getSelection();
  return !!selection && !selection.isCollapsed;
}

function keyContext(
  event: KeyboardEvent,
  target = keyTarget(event.target),
): KeyContext {
  // Invariant: Activity buttons keep focus after a tap without blocking thread
  // shortcuts. Enter and Space still activate the focused button natively.
  if (
    target === "control" &&
    event.key !== "Enter" &&
    event.key !== " " &&
    (event.target as HTMLElement | null)?.closest?.(
      "#messages .activity-group-toggle, #messages .turn-expand",
    )
  )
    target = "chrome";
  return {
    now: Date.now(),
    desktop: !primaryPointerIsCoarse(),
    target,
    selectedId: state.selectedId,
    interruptible: state.selectedRunning && !localLayerOpen(),
    deletable: !!state.nodes[state.cursorId],
    paneAvailable: paneActionable(),
    textSelected: hasTextSelection(event.target),
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
    case "toggle-pane":
      togglePaneFromKeyboard();
      break;
    case "focus-pane":
      focusPaneFromKeyboard();
      break;
    case "focus-thread": {
      const thread = $("#scroll");
      if (thread) {
        thread.tabIndex = -1;
        thread.focus({ preventScroll: true });
      }
      break;
    }
    case "focus-agents":
      restoreAgentFocus();
      break;
    case "pane-next":
      switchPane(1);
      break;
    case "pane-previous":
      switchPane(-1);
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
    case "toggle-latest-turn":
      toggleLatestTurnEye();
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
  setKeyState(result.state);
  if (result.handled) {
    event.preventDefault();
    event.stopPropagation();
  }
  execute(result.command);
  return result.handled;
}

window.addEventListener("message", (event: MessageEvent) => {
  // Invariant: Opaque origins cannot authenticate Artifacts; only the
  // focused mounted frame may relay keys through the keymap dispatcher.
  const key: unknown = event.data?.recurseArtifactKey;
  if (
    typeof key !== "string" ||
    !["j", "k", "z", "o", "p", "Escape", "h", "P", "G"].includes(key)
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
    // Invariant: An embedded view has no tree or panes; only its composer's
    // keys run, and nothing reaches the page around the frame.
    if (embedded && keyTarget(event.target) !== "composer") return;
    // Invariant: The drawing editor owns its keys; idle Escape still closes.
    if (drawingEditorOwnsKey(event)) return;
    if (event.key === "Escape" && closePowerbarOverflow(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const mobileDrawerEscape =
      event.key === "Escape" &&
      mobileSidebarOpen() &&
      window.matchMedia("(max-width: 700px)").matches;
    if (mobileDrawerEscape && isRenaming()) {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
      return;
    }
    const higherLayerOpen =
      settingsOpen() ||
      promptOpen() ||
      artifactVersionMenuOpen() ||
      drawingEditorOpen() ||
      workingActivityOpen() ||
      shellSurfaceOpen() ||
      agentSurfaceOpen() ||
      skillAutocompleteOpen() ||
      agentFinderOpen();
    if (mobileDrawerEscape && !higherLayerOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeMobileSidebar(true);
      return;
    }
    // Invariant: Touch layouts skip the desktop navigation reducer, but a
    // hardware Escape key must still dismiss an ARIA-modal surface and restore
    // visible focus.
    if (primaryPointerIsCoarse() && event.key === "Escape") {
      const eventElement = event.target as HTMLElement | null;
      const paneColumn = eventElement?.closest?.(".pane-col");
      const paneMenu = eventElement?.closest?.("#pane-menu");
      const closed = drawingEditorOpen()
        ? closeDrawingFromKeyboard()
        : /* Invariant: Inner menu owns Escape. */
          artifactVersionMenuOpen()
          ? closeArtifactVersionMenuKeyboardLayer()
          : paneColumn
            ? closeFocusedPaneFromKeyboard(undefined, true)
            : paneMenu
              ? closePaneKeyboardLayer()
              : false;
      if (closed) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
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
    const paneElement = eventElement?.closest?.(".pane-col");
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
    // Invariant: Expanded activity is an inline disclosure, not a global modal:
    // navigation and typing continue normally. Escape alone closes it before
    // interruption.
    if (event.key === "Escape" && workingActivityOpen()) target = "dialog";

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
    // Invariant: Native buttons/links and any excluded editor/dialog keep
    // unclaimed keys — especially Enter activation — rather than falling into
    // type-to-compose.
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
  const focusedPane = (event.target as HTMLElement | null)?.closest?.(
    ".pane-col",
  );
  if (target === "composer") setKeyState(initialKeymapState("insert"));
  else if (target === "rename") setKeyState(initialKeymapState("rename"));
  else if (target === "finder") setKeyState(initialKeymapState("finder"));
  else if (target === "pane") setKeyState(initialKeymapState("pane"));
  else if (focusedPane && target === "dialog")
    setKeyState(initialKeymapState("pane"));
  else if (target === "dialog" || target === "editor")
    setKeyState(initialKeymapState("dialog"));
  else if (target === "control") setKeyState(initialKeymapState());
});
document.addEventListener("focusout", () => {
  // Invariant: Blur captures the old key-state identity. A later key replaces
  // it, so deferred reset cannot clear a newer destructive-chord arm.
  const before = keyState;
  setTimeout(() => {
    if (keyState === before && keyTarget(document.activeElement) === "chrome")
      setKeyState(initialKeymapState());
  }, 0);
});
document.addEventListener(
  "click",
  () => {
    if (
      ["t-prefix", "delete-pending", "interrupt-pending"].includes(
        keyState.mode,
      )
    )
      setKeyState(initialKeymapState());
  },
  true,
);
window.addEventListener("recurse:selection-change", () => {
  if (
    ["t-prefix", "delete-pending", "interrupt-pending"].includes(keyState.mode)
  )
    setKeyState(initialKeymapState());
});

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
setInterval(() => {
  // Spec: Hidden Side frames skip polls and catch up on their next shown tick.
  if (!embedded || frameElement?.checkVisibility?.() !== false) void poll();
}, 1500);
setInterval(renderSidebar, 30000);
refreshUpBtn();
