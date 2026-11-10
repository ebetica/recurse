// Phones use the agent list as their root and one replaceable conversation
// entry above it. Seed that root for direct links, but never trap Back there.
// Settings and full-screen panes keep their own steps above the conversation.
import { $ } from "./dom.js";
import { BACK_ICON, MENU_ICON, NEW_ICON } from "./icons.js";
import { embedded } from "./state.js";
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
let syncPaneSelection = () => {};

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
    Number(history.state?.settings || 0) + Number(!!history.state?.phonePane);
  if (!correction && layers) {
    pendingSelection = { view, url };
    history.go(-layers - Number(!phoneListEntry()));
    return true;
  }
  const {
    settings: _settings,
    phonePane: _pane,
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
/** A phone pane closes before the conversation's Back step. */
export function installPhonePaneHistory(close: () => void): void {
  const panes = $("#panes")!;
  let wasOpen = false;
  let paneUrl = "";
  const observe = () => {
    const open =
      phoneNavigation() && !phoneListEntry() && panes.classList.contains("on");
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) paneUrl = location.href;
    if (open && !history.state?.phonePane)
      history.pushState({ ...history.state, phonePane: true }, "");
    else if (
      !open &&
      !pendingSelection &&
      history.state?.phonePane &&
      !history.state?.settings
    )
      history.back();
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
    if (wasOpen && !history.state?.phonePane) {
      wasOpen = false;
      if (location.href !== paneUrl && readArtifactLink(location.hash))
        observe();
      else close();
    }
  });
}
phone.addEventListener("change", () => {
  seed();
  sync();
});
addEventListener("popstate", () => {
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
