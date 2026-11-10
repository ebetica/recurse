// Pane picker: it reuses the agent finder's styling and fuzzy matching. It
// lists the offered panes, then what each pane can show as `kind/name` rows,
// so one query matches the kind and the name together. Every item is searched;
// at most 50 matching items per pane are shown.
import { agentFinderKeyAction } from "./agent-finder.js";
import { closeAgentFinder } from "./agent-finder/ui.js";
import { normalizeSearchText, textRank, titleTokens } from "./fuzzy-match.js";
import { offeredPanes, openPane } from "./panes.js";
import { paneFrecency } from "./panes/frecency.js";
import { requestKeyboardMode } from "./modal-mode.js";
import { placeFinder } from "./finder-placement.js";

const finder = document.querySelector<HTMLElement>("#pane-finder");
const query = document.querySelector<HTMLInputElement>("#pane-finder-query");
const menu = document.querySelector<HTMLElement>("#pane-finder-menu");
const status = document.querySelector<HTMLElement>("#pane-finder-status");
let origin: HTMLElement | null = null;
interface Row {
  key: string;
  title: string;
  icon: string;
  open: boolean;
  pane: string;
  item: boolean;
  choose(): void;
}
let matches: Row[] = [];
let active = 0;

export function paneFinderOpen(): boolean {
  return !!finder?.classList.contains("on");
}

export function closePaneFinder(restoreFocus = true): boolean {
  if (!paneFinderOpen()) return false;
  finder?.classList.remove("on");
  if (finder) placeFinder(finder, false);
  query?.setAttribute("aria-expanded", "false");
  query?.removeAttribute("aria-activedescendant");
  requestKeyboardMode("normal");
  if (restoreFocus && origin?.isConnected) origin.focus();
  origin = null;
  matches = [];
  return true;
}

function select(index: number): void {
  if (!matches.length || !menu || !query) return;
  active = (index + matches.length) % matches.length;
  menu.querySelectorAll<HTMLElement>("[role=option]").forEach((row, i) => {
    row.classList.toggle("active", i === active);
    row.setAttribute("aria-selected", String(i === active));
    if (i === active) {
      query.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    }
  });
}

const ITEMS_PER_PANE = 50;

function rows(): Row[] {
  return offeredPanes({ includeChat: true }).flatMap((pane) => [
    {
      key: pane.id,
      title: pane.title,
      icon: pane.icon,
      open: pane.open,
      pane: pane.id,
      item: false,
      choose: () =>
        openPane(pane.id, { focusTarget: "body", focusEntry: true }),
    },
    ...(pane.finder?.items() ?? []).map((item) => ({
      key: `${pane.id}:${item.key}`,
      title: `${pane.finder!.kind}/${item.name}`,
      icon: pane.icon,
      open: false,
      pane: pane.id,
      item: true,
      choose: item.open,
    })),
  ]);
}

function choose(): void {
  const key = matches[active]?.key;
  const row = rows().find((entry) => entry.key === key);
  if (!row) {
    render();
    return;
  }
  closePaneFinder();
  row.choose();
}

function render(): void {
  if (!menu || !query || !status) return;
  const text = normalizeSearchText(query.value.slice(0, 96));
  const history = paneFrecency();
  const shown = new Map<string, number>();
  matches = rows()
    .map((row) => {
      const normalizedTitle = normalizeSearchText(row.title);
      return {
        row,
        rank: textRank(
          {
            normalizedTitle,
            normalizedId: row.item ? "" : row.pane,
            tokens: titleTokens(normalizedTitle),
          },
          text,
        ),
      };
    })
    .filter((entry) => entry.rank !== null)
    .sort(
      (a, b) =>
        a.rank!.tier - b.rank!.tier ||
        a.rank!.score - b.rank!.score ||
        Number(a.row.item) - Number(b.row.item) ||
        (history.get(b.row.pane) || 0) - (history.get(a.row.pane) || 0),
    )
    .map((entry) => entry.row)
    .filter((row) => {
      if (!row.item) return true;
      shown.set(row.pane, (shown.get(row.pane) || 0) + 1);
      return shown.get(row.pane)! <= ITEMS_PER_PANE;
    });
  active = 0;
  menu.replaceChildren();
  status.hidden = !!matches.length;
  query.removeAttribute("aria-activedescendant");
  matches.forEach((match, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-item agent-option pane-option";
    row.id = `pane-option-${index}`;
    row.tabIndex = -1;
    row.setAttribute("role", "option");
    const icon = document.createElement("span");
    icon.className = "pane-option-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = match.icon;
    const title = document.createElement("span");
    title.className = "agent-option-name";
    title.textContent = match.title;
    row.append(icon, title);
    if (match.open) {
      const open = document.createElement("span");
      open.className = "agent-option-relation";
      open.textContent = "Open";
      row.append(open);
    }
    row.addEventListener("pointerdown", (event) => event.preventDefault());
    row.onclick = () => {
      active = index;
      choose();
    };
    menu.append(row);
  });
  select(0);
}

export function openPaneFinder(): void {
  if (!finder || !query || !menu || !status) return;
  closeAgentFinder();
  placeFinder(finder, true);
  origin =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  query.value = "";
  finder.classList.add("on");
  query.setAttribute("aria-expanded", "true");
  render();
  query.focus();
  requestKeyboardMode("finder");
}

query?.addEventListener("input", render);
query?.addEventListener("blur", () => closePaneFinder(false));
query?.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const action = agentFinderKeyAction(
    "navigate",
    !!matches.length,
    event.key,
    event.shiftKey,
    event.isComposing || event.keyCode === 229,
  );
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === "close") closePaneFinder();
  if (action === "next") select(active + 1);
  if (action === "previous") select(active - 1);
  if (action === "choose") choose();
});
document.addEventListener("pointerdown", (event) => {
  if (paneFinderOpen() && !finder?.contains(event.target as Node))
    closePaneFinder(false);
});
window.addEventListener("recurse:selection-change", () =>
  closePaneFinder(false),
);
