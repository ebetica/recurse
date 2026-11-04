// Settings layout: a category sidebar on wide screens and, on phones, a
// category list that opens one category's page with a back link. Sections
// are a small label above rounded rows. Details stay inline on desktop;
// phones open the same controls in keyboard-contained sheets.
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
  row.append(
    span("settings-row-label", "", label),
    span("settings-row-value", "", value),
    span("settings-row-chevron", CHEVRON_RIGHT_ICON),
  );
  row.onclick = onClick;
  return row;
}

const openSheets: HTMLDialogElement[] = [];
const phoneDetails = matchMedia("(max-width: 700px)");
const detailLayouts = new WeakMap<HTMLElement, () => void>();
phoneDetails.addEventListener("change", () => {
  for (const body of document.querySelectorAll<HTMLElement>(".settings-detail"))
    detailLayouts.get(body)?.();
});

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

/** Show controls inline on desktop and in a labelled sheet on phones. */
export function settingsDetail(
  body: HTMLElement,
  label: string,
  value: () => string = () => "",
): { refresh(): void; open(): void; close(): void } {
  const sheet = document.createElement("dialog");
  sheet.className = "settings-sheet";
  sheet.setAttribute("aria-label", label);
  const head = document.createElement("header");
  head.className = "settings-sheet-head";
  const heading = document.createElement("h2");
  heading.textContent = label;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "settings-sheet-close";
  close.textContent = "Done";
  close.setAttribute("aria-label", `Close ${label}`);
  close.onclick = () => sheet.close();
  head.append(heading, close);
  const content = document.createElement("div");
  content.className = "settings-detail-content";
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", label);
  content.append(...body.childNodes);
  sheet.append(head);
  const summary = document.createElement("div");
  summary.className = "settings-detail-summary";
  const title = span("settings-row-label", "", label);
  title.setAttribute("role", "heading");
  title.setAttribute("aria-level", "3");
  summary.append(title, span("settings-row-value", "", value()));
  const refresh = () => {
    for (const header of [row, summary])
      header.querySelector(".settings-row-value")!.textContent = value();
  };
  const open = () => {
    if (!phoneDetails.matches || sheet.open || !sheet.isConnected) return;
    sheet.showModal();
    openSheets.push(sheet);
  };
  const row = settingsRow(label, value(), open);
  row.setAttribute("aria-haspopup", "dialog");
  sheet.addEventListener("close", () => {
    const index = openSheets.indexOf(sheet);
    if (index >= 0) openSheets.splice(index, 1);
    refresh();
    if (row.isConnected && phoneDetails.matches) row.focus();
  });
  sheet.addEventListener("click", (event) => {
    if (event.target !== sheet) return;
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
  body.append(row, summary, sheet);
  const layout = () => {
    if (!phoneDetails.matches && sheet.open) sheet.close();
    (phoneDetails.matches ? sheet : body).append(content);
  };
  detailLayouts.set(body, layout);
  layout();
  return { refresh, open, close: () => sheet.close() };
}

export type Category = keyof typeof SETTINGS_CATEGORY_ICONS;
export const CATEGORY_LABELS: Record<Category, string> = {
  account: "Account",
  appearance: "Appearance",
  auth: "Authentication",
  models: "Models",
  agents: "MCPs",
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
