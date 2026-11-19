// Settings layout: a category sidebar on wide screens and, on phones, a
// category list that opens one category's page with a back link. Sections
// are a small label above rounded rows. A row opens its controls in a
// sub-page over the category on desktop and in a sheet on phones.
import {
  CHEVRON_RIGHT_ICON,
  SETTINGS_CATEGORY_ICONS,
  UP_ICON,
} from "../icons.js";

/** A full-width setting or action with its current value and a chevron. */
export function settingsRow(
  label: string,
  value: string,
  onClick: () => void,
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "settings-row";
  row.dataset.theme = "button";
  row.append(
    span("settings-row-label", "", label),
    span("settings-row-value", "", value),
    span("settings-row-chevron", CHEVRON_RIGHT_ICON),
  );
  row.onclick = onClick;
  return row;
}

const openSheets: HTMLDialogElement[] = [];
const reopen = new WeakMap<HTMLDialogElement, (force: boolean) => boolean>();
const phoneDetails = matchMedia("(max-width: 700px)");

/** Switch open details between sub-page and sheet, keeping inputs and focus. */
export function relayoutSettingsDetails(): void {
  const moved: HTMLDialogElement[] = [];
  for (const sheet of openSheets.slice()) {
    if (!sheet.isConnected || !sheet.open) continue;
    const inside = moved.some((outer) => outer.contains(sheet));
    if (reopen.get(sheet)?.(inside)) moved.push(sheet);
  }
}

/**
 * Whether focus is in `entry`, or in its open detail before a control there
 * was disabled mid-request (the browser then moves focus to the page).
 */
export function holdsFocus(entry: HTMLElement): boolean {
  const active = document.activeElement;
  if (entry.contains(active)) return true;
  return (
    (!active || active === document.body) &&
    !!entry.querySelector(":scope > dialog[open]")
  );
}

/** Order rows without moving the one holding focus or an open detail. */
export function arrangeRows(list: HTMLElement, rows: HTMLElement[]): void {
  const held = rows.findIndex(
    (row) =>
      row.contains(document.activeElement) ||
      row.querySelector(":scope > dialog[open]"),
  );
  if (held < 0) return list.append(...rows);
  rows[held]!.before(...rows.slice(0, held));
  rows[held]!.after(...rows.slice(held + 1));
}

/** Dismiss editors before closing or rebuilding Settings. */
export function closeSettingsDetails(): void {
  for (const sheet of [...openSheets].reverse()) sheet.close();
  openSheets.length = 0;
}

document.addEventListener(
  "keydown",
  (event) => {
    while (
      openSheets.length &&
      (!openSheets.at(-1)!.isConnected || !openSheets.at(-1)!.open)
    )
      openSheets.pop();
    if (event.key !== "Escape" || !openSheets.length) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[role="combobox"][aria-expanded="true"]')
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openSheets.at(-1)?.close();
  },
  true,
);

/**
 * A row opening its controls: a sub-page with a back link on desktop, or a
 * labelled sheet on phones and when `alwaysSheet` is set.
 */
export function settingsDetail(
  body: HTMLElement,
  label: string,
  value: () => string = () => "",
  { alwaysSheet = false } = {},
): { refresh(): void; open(): void; close(): void } {
  const sheet = document.createElement("dialog");
  sheet.className = "settings-sheet";
  sheet.dataset.theme = "dialog";
  sheet.setAttribute("aria-label", label);
  const head = document.createElement("header");
  head.className = "settings-sheet-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "settings-sub-back";
  back.onclick = () => sheet.close();
  const heading = document.createElement("h2");
  heading.textContent = label;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "settings-sheet-close";
  close.textContent = "Done";
  close.setAttribute("aria-label", `Close ${label}`);
  close.onclick = () => sheet.close();
  head.append(back, heading, close);
  const content = document.createElement("div");
  content.className = "settings-detail-content";
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", label);
  content.append(...body.childNodes);
  sheet.append(head, content);
  const refresh = () => {
    row.querySelector(".settings-row-value")!.textContent = value();
  };
  const open = () => {
    if (sheet.open || !sheet.isConnected) return;
    const page = !alwaysSheet && !phoneDetails.matches;
    sheet.classList.toggle("settings-subpage", page);
    back.hidden = !page;
    close.hidden = page;
    if (page) {
      const under =
        body.parentElement?.closest<HTMLElement>(".settings-sheet[open]") ??
        body.closest<HTMLElement>(".settings-cat");
      const name =
        under?.querySelector(":scope > header h2")?.textContent ?? "Settings";
      back.innerHTML = UP_ICON;
      back.append(name);
      back.setAttribute("aria-label", `Back to ${name}`);
      sheet.show();
      back.focus();
    } else sheet.showModal();
    if (openSheets.includes(sheet))
      openSheets.splice(openSheets.indexOf(sheet), 1);
    openSheets.push(sheet);
  };
  const row = settingsRow(label, value(), open);
  row.setAttribute("aria-haspopup", "dialog");
  reopen.set(sheet, (force) => {
    const page = !alwaysSheet && !phoneDetails.matches;
    if (!force && page === sheet.classList.contains("settings-subpage"))
      return false;
    const focused = document.activeElement;
    sheet.close();
    open();
    if (focused instanceof HTMLElement && sheet.contains(focused))
      focused.focus();
    return true;
  });
  sheet.addEventListener("close", () => {
    if (sheet.open) return;
    const index = openSheets.indexOf(sheet);
    if (index >= 0) openSheets.splice(index, 1);
    refresh();
    if (row.isConnected) row.focus();
  });
  sheet.addEventListener("click", (event) => {
    if (event.target !== sheet || !sheet.matches(":modal")) return;
    const box = sheet.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      sheet.close();
  });
  body.classList.add("settings-detail");
  body.append(row, sheet);
  return { refresh, open, close: () => sheet.close() };
}

export type Category = keyof typeof SETTINGS_CATEGORY_ICONS;
/** Category names in navigation order. */
export const CATEGORY_LABELS: Record<Category, string> = {
  providers: "Providers",
  models: "Models",
  agents: "Agents",
  appearance: "Appearance",
  remotes: "Remotes",
  account: "Account",
};

const span = (className: string, html = "", text = "") => {
  const el = document.createElement("span");
  el.className = className;
  if (html) el.innerHTML = html;
  else el.textContent = text;
  return el;
};

/** A category button: coloured icon tile, name, and a chevron on phones. */
export function categoryButton(cat: Category): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.cat = cat;
  button.append(
    span("settings-tile", SETTINGS_CATEGORY_ICONS[cat]),
    span("settings-nav-label", "", CATEGORY_LABELS[cat]),
    span("settings-chevron", CHEVRON_RIGHT_ICON),
  );
  return button;
}

/** One category's page: its title, and the phone link back to the list. */
export function categoryPage(cat: Category, back: () => void): HTMLElement {
  const page = document.createElement("div");
  page.className = "settings-cat";
  page.dataset.cat = cat;
  page.hidden = true;
  const head = document.createElement("header");
  head.className = "settings-page-head";
  const link = document.createElement("button");
  link.type = "button";
  link.className = "settings-back";
  link.setAttribute("aria-label", "Back to all settings");
  link.innerHTML = UP_ICON;
  link.append("Settings");
  link.onclick = back;
  const title = document.createElement("h2");
  title.textContent = CATEGORY_LABELS[cat];
  head.append(link, title);
  page.append(head);
  return page;
}

/**
 * A section: its label, then the body its builder fills. A login section
 * shows the provider's initial tile and a login state chip in its head.
 */
export function settingsSectionShell(
  title: string,
  provider: boolean,
): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement("section");
  section.className = "settings-section";
  const head = document.createElement("div");
  head.className = "sec-head";
  const heading = document.createElement("h3");
  heading.textContent = title;
  head.append(heading);
  if (provider) {
    section.classList.add("provider");
    section.dataset.provider = title.toLowerCase();
    const name = document.createElement("div");
    name.className = "provider-name";
    name.append(heading, span("state off", "", "…"));
    head.append(span("provider-tile", "", title[0]), name);
  }
  const body = document.createElement("div");
  section.append(head, body);
  return { section, body };
}
