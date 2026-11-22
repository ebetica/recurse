// Phones use the agent list as their root and one replaceable conversation
// entry above it. Seed that root for direct links, but never trap Back there.
// Settings and full-screen panes keep their own steps above the conversation.
import { $ } from "./dom.js";
import { BACK_ICON, MENU_ICON, NEW_ICON } from "./icons.js";
import { embedded } from "./state.js";
import type { FileTabDescriptor } from "./panes/file-tabs.js";
import { sharedTrees } from "./shared-trees.js";
import {
  agentLinkUrl,
  readAgentLink,
  readArtifactLink,
  type HistoryView,
} from "./deep-link.js";

const phone = matchMedia("(max-width: 700px)");
export const phoneNavigation = (): boolean => !embedded && phone.matches;
export const phoneListEntry = (): boolean =>
  phoneNavigation() && history.state?.phoneScreen === "list";
const sidebar = $("#sidebar")!;
const main = $("#main")!;
const settings = $("#settings-btn")!;
const menu = $("#menu-btn")!;
const listActions = $("#agent-list-actions")!;
let pendingSelection: { view: HistoryView; url: string } | null = null;
let imageVisit: { writeSelection?: () => void } | null = null;
let syncPaneSelection = () => {};
let closeViewer: (() => void) | undefined;
let viewerStep:
  | { url: string; before: string; entry: string; current: boolean }
  | undefined;

function dismissOpenViewer(): void {
  const close = closeViewer;
  closeViewer = undefined;
  close?.();
}

/** Dismiss on navigation everywhere; add a Back step only on top-level phones. */
export function viewerHistoryDismiss(close: () => void): () => void {
  closeViewer = close;
  if (phoneNavigation() && window === window.top) {
    const entry = { ...history.state, phoneViewer: true };
    viewerStep = {
      url: location.href,
      before: JSON.stringify(history.state),
      entry: JSON.stringify(entry),
      current: true,
    };
    history.pushState(entry, "");
  }
  let dismissing = false;
  return () => {
    if (dismissing) return;
    dismissing = true;
    if (viewerStep?.current && history.state?.phoneViewer) history.back();
    else dismissOpenViewer();
  };
}

function consumesViewerTraversal(event: PopStateEvent): boolean {
  dismissOpenViewer();
  const step = viewerStep;
  if (step?.url === location.href) {
    const destination = JSON.stringify(event.state);
    if (step.current && step.before === destination) {
      step.current = false;
      return true;
    }
    if (!step.current && step.entry === destination) {
      // The closed viewer's Forward entry doesn't reopen the document.
      step.current = true;
      history.back();
      return true;
    }
  }
  viewerStep = undefined;
  return false;
}

function sync(): void {
  const active = phoneNavigation();
  const list = phoneListEntry();
  const leavingList =
    active && !list && sidebar.contains(document.activeElement);
  document.documentElement.classList.toggle("phone-list", list);
  sidebar.classList.toggle("open", list);
  sidebar.inert = active && !list;
  if (active) sidebar.setAttribute("aria-hidden", String(!list));
  else sidebar.removeAttribute("aria-hidden");
  main.inert = list;
  $("#panes")!.inert = list;
  menu.setAttribute(
    "aria-expanded",
    String(active ? list : !sidebar.classList.contains("desktop-hidden")),
  );
  if (list && !$("#settings-overlay")!.classList.contains("on"))
    sidebar.querySelector<HTMLElement>(".agent[tabindex='0']")?.focus();
  menu.innerHTML = active ? BACK_ICON : MENU_ICON;
  menu.setAttribute(
    "aria-label",
    active ? "Back to agents" : "Open agent list",
  );
  menu.title = active ? "Back to agents" : "Open agent list";
  if (leavingList) menu.focus({ preventScroll: true });
  settings.classList.toggle("icon-btn", active);
  settings.classList.toggle("lg", active);
  if (active) listActions.append(settings);
  else $("#agent-list-foot")!.prepend(settings);
  dispatchEvent(new Event("recurse:phone-view"));
}
function seed(): void {
  if (!phoneNavigation() || history.state?.phoneScreen) return;
  const base = history.state ?? {};
  const href = location.href;
  history.replaceState(
    { ...base, phoneScreen: "list" },
    "",
    agentLinkUrl(href, "", false),
  );
  const hash = new URL(href).hash;
  if (
    readAgentLink(hash).present ||
    readArtifactLink(hash) ||
    base.recurseView?.draft
  )
    history.pushState({ ...base, phoneScreen: "conversation" }, "", href);
}
/** Return true when phone navigation owns this selection's history. */
export function syncPhoneSelection(
  view: HistoryView,
  url: string,
  correction: boolean,
): boolean {
  if (!phoneNavigation()) return false;
  seed();
  if (pendingSelection || (phoneListEntry() && correction)) return true;
  const layers =
    Number(history.state?.settings || 0) +
    paneDepth() +
    (history.state?.artifactView?.depth || 0);
  if (!correction && layers) {
    pendingSelection = { view, url };
    history.go(-layers - Number(!phoneListEntry()));
    return true;
  }
  const {
    settings: _settings,
    phonePane: _pane,
    artifactView: _artifact,
    ...base
  } = history.state ?? {};
  const next = {
    ...(correction ? history.state : base),
    phoneScreen: "conversation",
    recurseView: view,
  };
  if (phoneListEntry()) history.pushState(next, "", url);
  else history.replaceState(next, "", url);
  sync();
  return true;
}

$("#new-list")!.innerHTML = NEW_ICON;
$("#new-list")!.hidden = sharedTrees !== null;
$("#new-list")!.onclick = () => $("#new-top")!.click();
function paneDepth(): number {
  const pane = history.state?.phonePane;
  return pane &&
    typeof pane === "object" &&
    Number.isSafeInteger(pane.depth) &&
    pane.depth > 0
    ? pane.depth
    : Number(!!pane);
}

/** Pop the image and any phone pane steps the conversation is leaving. */
export function popImageVisitHistory(): void {
  const panes =
    phoneNavigation() && history.state?.phonePane && !history.state?.settings
      ? paneDepth() + (history.state?.artifactView?.depth || 0)
      : 0;
  imageVisit = {};
  history.go(-1 - panes);
}

/** Write the selection only after its outgoing image and pane have popped. */
export function deferImageVisitSelectionHistory(write: () => void): boolean {
  if (!imageVisit) return false;
  imageVisit.writeSelection = write;
  return true;
}

/** Linked files add a Back step above the currently open phone pane. */
export function openLinkedPhonePane(
  id: string,
  previous: string | null,
  open: () => boolean,
  describe: (id: string) => FileTabDescriptor | undefined,
): boolean {
  const nested = phoneNavigation() && previous && history.state?.phonePane;
  const depth = paneDepth();
  const prior = {
    ...history.state,
    phonePane: {
      id: previous,
      depth,
      file: previous ? describe(previous) : undefined,
    },
  };
  if (!open()) return false;
  if (nested && previous !== id) {
    history.replaceState(prior, "");
    history.pushState(
      { ...prior, phonePane: { id, depth: depth + 1, file: describe(id) } },
      "",
    );
  }
  return true;
}

/** Back closes the phone pane first; a refused close restores its entry. */
export function installPhonePaneHistory(
  close: () => boolean,
  restore: (id: string, file?: unknown) => boolean | null,
): void {
  const panes = $("#panes")!;
  let wasOpen = false;
  let paneUrl = "";
  const observe = () => {
    const open =
      phoneNavigation() && !phoneListEntry() && panes.classList.contains("on");
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) paneUrl = location.href;
    const saved = history.state?.phonePane;
    if (open && saved?.file) restore(saved.id, saved.file);
    if (open && !history.state?.phonePane)
      history.pushState({ ...history.state, phonePane: true }, "");
    else if (
      !open &&
      !pendingSelection &&
      !imageVisit &&
      history.state?.phonePane &&
      !history.state?.settings
    )
      history.go(-paneDepth() - (history.state?.artifactView?.depth || 0));
  };
  syncPaneSelection = () => {
    wasOpen = false;
    observe();
  };
  new MutationObserver(observe).observe(panes, {
    attributes: true,
    attributeFilter: ["class"],
  });
  addEventListener("popstate", () => {
    const pane = history.state?.phonePane;
    if (pane) paneUrl = location.href;
    if (
      phoneNavigation() &&
      pane &&
      typeof pane === "object" &&
      typeof pane.id === "string"
    ) {
      const restored = restore(pane.id, pane.file);
      if (restored === null) history.back();
      else if (!restored) history.forward();
      return;
    }
    if (wasOpen && !history.state?.phonePane) {
      wasOpen = false;
      if (location.href !== paneUrl && readArtifactLink(location.hash))
        observe();
      else if (!close()) {
        wasOpen = true;
        history.forward();
      }
    }
  });
}
phone.addEventListener("change", () => {
  seed();
  sync();
});
window.addEventListener("popstate", (event) => {
  if (imageVisit) {
    const { writeSelection } = imageVisit;
    imageVisit = null;
    writeSelection?.();
    syncPaneSelection();
  }
  if (consumesViewerTraversal(event)) {
    event.stopImmediatePropagation();
    return;
  }
  if (pendingSelection) {
    const { view, url } = pendingSelection;
    pendingSelection = null;
    syncPhoneSelection(view, url, false);
    syncPaneSelection();
  }
  sync();
});
seed();
sync();
