// The working-folder tree, filename search and keyboard cursor.
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { paneItem } from "../panes/index.js";
import { comments } from "../artifacts/index.js";
import { DISCLOSURE_ICON, REFRESH_ICON } from "../icons.js";
import type { PaneCacheDef, PaneContext, PaneNavigation } from "../types.js";
import type {
  ExplorerEntry,
  ExplorerListing,
} from "../../src/web/explorer_io.js";
import { endpoint, read } from "./io.js";
import {
  copyPath,
  leaveViewer,
  navigateFile,
  openFile,
  phone,
  renderExplorer,
  viewerCache,
  viewerFor,
  type Viewer,
} from "./viewer.js";

interface Folder {
  path: string;
  entries: ExplorerEntry[];
  loaded: boolean;
  skipped: number;
  cursor: string | null;
  loading: boolean;
  error: string;
  controller?: AbortController;
}
interface Browser {
  cid: string;
  element: HTMLElement;
  root: string;
  folders: Map<string, Folder>;
  query: string;
  // The query `results` answer; empty while the tree shows.
  shown: string;
  results: string[];
  active: number;
  searchError: string;
  search?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  viewer: Viewer;
}
const browsers = new WeakMap<HTMLElement, Browser>();
export const MAX_ROWS = 1000;
const ROWS = ".explorer-row:not(:disabled), .explorer-result";
const FILE_ROWS = ".explorer-row[data-file]:not(:disabled), .explorer-result";

function resetCursor(root: ParentNode): void {
  for (const item of root.querySelectorAll(".explorer-row, .explorer-result")) {
    item.classList.remove("pane-item-cursor");
    item.removeAttribute("aria-current");
    item.removeAttribute("tabindex");
  }
}
phone.addEventListener("change", () => resetCursor(document));

function folder(view: Browser, path: string): Folder {
  let item = view.folders.get(path);
  if (!item) {
    item = {
      path,
      entries: [],
      loaded: false,
      skipped: 0,
      cursor: null,
      loading: false,
      error: "",
    };
    view.folders.set(path, item);
  }
  return item;
}
function rowCount(view: Browser): number {
  return [...view.folders.values()].reduce(
    (n, item) => n + item.entries.length,
    0,
  );
}

function discardChildren(view: Browser, path: string): void {
  for (const [key, item] of view.folders) {
    if (key !== path && (!path || key.startsWith(path + "/"))) {
      item.controller?.abort();
      view.folders.delete(key);
    }
  }
}

async function loadFolder(
  view: Browser,
  item: Folder,
  reset = false,
): Promise<void> {
  if (item.loading) return;
  if (reset) {
    discardChildren(view, item.path);
    item.entries = [];
    item.cursor = null;
    item.loaded = false;
    item.skipped = 0;
  }
  if (rowCount(view) >= MAX_ROWS) {
    if (item.entries.length) {
      discardChildren(view, item.path);
      item.skipped += item.entries.length;
      item.entries = [];
    } else {
      item.error = "Close a folder to browse more entries.";
      paint(view);
      return;
    }
  }
  const controller = new AbortController();
  item.controller = controller;
  item.loading = true;
  item.error = "";
  paint(view);
  try {
    const page = await read<ExplorerListing>(
      view.cid,
      endpoint(view.cid, "", {
        path: item.path,
        ...(item.cursor ? { cursor: item.cursor } : {}),
      }),
      controller.signal,
    );
    if (controller.signal.aborted || view.viewer.disposed) return;
    view.root = page.root;
    item.entries = [
      ...new Map(
        [...item.entries, ...page.entries].map((entry) => [entry.name, entry]),
      ).values(),
    ];
    item.cursor = page.cursor;
    item.loaded = true;
  } catch (error) {
    if (!controller.signal.aborted)
      item.error =
        error instanceof Error ? error.message : "Could not load folder.";
  } finally {
    item.loading = false;
    if (!controller.signal.aborted) paint(view);
  }
}

function toggle(view: Browser, path: string): void {
  const existing = view.folders.get(path);
  if (existing) {
    existing.controller?.abort();
    discardChildren(view, path);
    view.folders.delete(path);
    paint(view);
  } else void loadFolder(view, folder(view, path));
}

function setQuery(view: Browser, query: string): void {
  clearTimeout(view.timer);
  view.query = query;
  view.viewer.notice = "";
  if (!query.trim()) {
    view.search?.abort();
    resetCursor(view.element);
    Object.assign(view, { shown: "", results: [], active: 0, searchError: "" });
  } else view.timer = setTimeout(() => void search(view, query), 180);
  paint(view);
}
// Invariant: Only the newest request can answer; starting one aborts the
// previous, so a slow older answer never replaces a newer one.
async function search(view: Browser, query: string): Promise<void> {
  view.search?.abort();
  const controller = new AbortController();
  view.search = controller;
  try {
    const found = await read<{ results: string[] }>(
      view.cid,
      endpoint(view.cid, "/search", { q: query }),
      controller.signal,
    );
    if (controller.signal.aborted || view.viewer.disposed) return;
    const focused = document.activeElement;
    const held = view.element.contains(focused) ? focused : null;
    resetCursor(view.element);
    Object.assign(view, {
      shown: query,
      results: found.results,
      active: 0,
      searchError: "",
    });
    paint(view);
    if (held && !held.isConnected) focusTree(view);
  } catch (error) {
    if (controller.signal.aborted) return;
    view.searchError =
      error instanceof Error ? error.message : "Could not search files.";
    paint(view);
  }
}

/**
 * Highlight only bounded returned paths; never interpret filenames as HTML.
 */
function highlighted(path: string, query: string): TemplateResult {
  const marked = new Set<number>();
  const characters = Array.from(path);
  const folded = characters.map((char) => char.toLowerCase());
  const lower = folded.join("");
  const positions = folded.flatMap((char, index) =>
    Array.from({ length: char.length }, () => index),
  );
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let at = -1;
    for (const char of word) {
      at = lower.indexOf(char, at + 1);
      if (at < 0) break;
      marked.add(positions[at]!);
    }
  }
  const parts = characters.map((char, index) =>
    marked.has(index) ? html`<mark>${char}</mark>` : char,
  );
  const name = characters.lastIndexOf("/") + 1;
  return html`<span class="explorer-result-folder">${parts.slice(0, name)}</span
    ><span class="explorer-result-name">${parts.slice(name)}</span>`;
}
/** Search keeps Escape: clear the query, then on desktop leave for the tree. */
export function explorerSearchOwnsKey(event: KeyboardEvent): boolean {
  const composing = event.isComposing || event.keyCode === 229;
  return (
    (composing || event.key === "Escape") &&
    event.target instanceof HTMLInputElement &&
    event.target.id === "explorer-search" &&
    (composing || !!event.target.value || !phone.matches)
  );
}
function focusTree(view: Browser): void {
  const row =
    view.element.querySelector<HTMLElement>(".explorer-row.pane-item-cursor") ??
    view.element.querySelector<HTMLElement>(ROWS);
  if (row) focusPath(view, row.dataset.path!);
  else view.element.focus({ preventScroll: true });
}
function searchKeys(view: Browser, event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape" || (event.key === "ArrowDown" && !view.shown)) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && view.query) setQuery(view, "");
    else focusTree(view);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    resetCursor(view.element);
    event.preventDefault();
    event.stopPropagation();
    view.active = Math.max(
      0,
      Math.min(
        view.results.length - 1,
        view.active + (event.key === "ArrowDown" ? 1 : -1),
      ),
    );
    paint(view);
    view.element
      .querySelector(`#explorer-result-${view.active}`)
      ?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && view.results[view.active]) {
    event.preventDefault();
    event.stopPropagation();
    void openFile(view.viewer, view.results[view.active]!);
  }
}

function tree(view: Browser, item: Folder, depth = 0): TemplateResult {
  const indent = `--explorer-depth: ${depth}`;
  return html`${item.skipped
      ? html`<p class="explorer-status" style=${indent}>
          Earlier entries hidden.
          <button
            class="btn sm"
            @click=${() => void loadFolder(view, item, true)}
          >
            Refresh folder
          </button>
        </p>`
      : nothing}
    <ul class="explorer-tree">
      ${repeat(
        item.entries,
        (entry) => entry.name,
        (entry) => {
          const path = item.path ? `${item.path}/${entry.name}` : entry.name;
          const child = view.folders.get(path);
          const isFolder = entry.type === "directory";
          const unavailable =
            entry.type === "symlink" || entry.type === "other";
          return html`<li>
            <button
              class="explorer-row ${entry.ignored ? "ignored" : ""}"
              style=${indent}
              ?disabled=${unavailable}
              data-path=${path}
              data-file=${isFolder ? nothing : ""}
              aria-expanded=${isFolder && !unavailable
                ? String(!!child)
                : nothing}
              title=${unavailable
                ? "Unavailable: broken link or special file"
                : entry.name}
              @click=${() =>
                isFolder
                  ? toggle(view, path)
                  : void openFile(view.viewer, path)}
            >
              <span
                class="explorer-twisty ${child ? "open" : ""}"
                aria-hidden="true"
                >${isFolder ? unsafeHTML(DISCLOSURE_ICON) : nothing}</span
              ><span class="explorer-name">${entry.name}</span>
              ${unavailable
                ? html`<span class="explorer-unavailable">Unavailable</span>`
                : nothing}
            </button>
            ${child ? tree(view, child, depth + 1) : nothing}
          </li>`;
        },
      )}
    </ul>
    ${item.loading
      ? html`<p class="explorer-status" role="status" style=${indent}>
          Loading folder…
        </p>`
      : nothing}
    ${item.error
      ? html`<p class="explorer-status" role="alert" style=${indent}>
          ${item.error}
          <button
            class="btn sm"
            @click=${() => void loadFolder(view, item, true)}
          >
            Refresh folder
          </button>
        </p>`
      : nothing}
    ${!item.loading && item.cursor
      ? html`<button
          class="btn sm explorer-more"
          style=${indent}
          @click=${() => void loadFolder(view, item)}
        >
          Show more
        </button>`
      : nothing}
    ${item.loaded && !item.entries.length
      ? html`<p class="explorer-status" style=${indent}>Empty folder</p>`
      : nothing}`;
}

function browserTemplate(view: Browser): TemplateResult {
  return html`<div class="explorer-head">
      <span class="explorer-root" title=${view.root}
        >${view.root.split("/").filter(Boolean).at(-1) ||
        "Working folder"}</span
      >
      <button
        class="icon-btn"
        type="button"
        title="Refresh"
        aria-label="Refresh working folder"
        @click=${() => {
          view.folders.forEach((item) => item.controller?.abort());
          view.folders.clear();
          void loadFolder(view, folder(view, ""));
        }}
      >
        ${unsafeHTML(REFRESH_ICON)}
      </button>
    </div>
    <div class="explorer-controls">
      <input
        id="explorer-search"
        data-pane-entry
        type="search"
        placeholder="Search files"
        aria-label="Search files"
        autocomplete="off"
        maxlength="128"
        .value=${view.query}
        role="combobox"
        aria-controls="explorer-results"
        aria-expanded=${String(!!view.shown)}
        aria-activedescendant=${view.shown && view.results.length
          ? `explorer-result-${view.active}`
          : nothing}
        @input=${(event: Event) =>
          setQuery(view, (event.target as HTMLInputElement).value)}
        @keydown=${(event: KeyboardEvent) => searchKeys(view, event)}
      />
    </div>
    ${view.shown
      ? html`<div
            id="explorer-results"
            role="listbox"
            aria-label="Matching files"
          >
            ${repeat(
              view.results,
              (path) => path,
              (path, i) =>
                html`<button
                  id=${`explorer-result-${i}`}
                  class="explorer-result"
                  data-path=${path}
                  role="option"
                  aria-selected=${String(i === view.active)}
                  @click=${() => void openFile(view.viewer, path)}
                >
                  ${highlighted(path, view.shown)}
                </button>`,
            )}
          </div>
          ${view.searchError
            ? html`<p class="explorer-status" role="alert">
                ${view.searchError}
              </p>`
            : nothing}
          ${!view.searchError && !view.results.length
            ? html`<p class="explorer-status">No matching files</p>`
            : nothing}`
      : html`${view.searchError
          ? html`<p class="explorer-status" role="alert">
              ${view.searchError}
            </p>`
          : nothing}
        ${tree(view, folder(view, ""))}`} `;
}

function paint(view: Browser): void {
  if (view.viewer.disposed) return;
  renderExplorer(view.viewer, () => browserTemplate(view));
  if (phone.matches) resetCursor(view.element);
}

function cursor(
  view: Browser,
  command: PaneNavigation,
  selector = ROWS,
): HTMLElement | null {
  const item = paneItem(view.element, selector, command);
  if (item?.classList.contains("explorer-result")) {
    view.active = view.results.indexOf(item.dataset.path!);
    paint(view);
  }
  return item;
}

function focusPath(view: Browser, path: string): void {
  const item = [...view.element.querySelectorAll<HTMLElement>(ROWS)].find(
    (row) => row.dataset.path === path,
  );
  item?.focus({ preventScroll: true });
  cursor(view, "open");
}

function paneBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.pane-body[data-pane="explorer"]',
  );
}

export function inlineFileIsOpen(
  cid: string,
  path: string,
  root: string,
): boolean {
  const body = paneBody();
  const inline = body && browsers.get(body)?.viewer;
  return (
    inline?.cid === cid && inline.file === path && inline.preview?.root === root
  );
}

export function focusBrowser(
  command: "filter" | "back",
  file: string | null,
): void {
  const explorer = paneBody();
  if (command === "filter")
    explorer?.querySelector<HTMLInputElement>("#explorer-search")?.focus();
  else {
    const tree = explorer && browsers.get(explorer);
    if (tree && file) focusPath(tree, file);
  }
}

export function navigateBrowser(
  element: HTMLElement,
  command: PaneNavigation,
): boolean {
  const view = browsers.get(element);
  if (!view || view.viewer.disposed || phone.matches) return false;
  if (command === "filter" || (command === "back" && view.viewer.file)) {
    const path = view.viewer.file;
    element
      .querySelector<HTMLButtonElement>(".explorer-filebar button")
      ?.click();
    if (!view.viewer.file) {
      if (command === "filter") {
        resetCursor(element);
        element.querySelector<HTMLInputElement>("#explorer-search")?.focus();
      } else if (path) focusPath(view, path);
    }
    return true;
  }
  if (view.viewer.file) return navigateFile(view.viewer, command);
  if (command === "copy") {
    const path = cursor(view, "copy")?.dataset.path;
    if (path) copyPath(view.viewer, path, view.shown ? null : view.root);
    return true;
  }
  const section = command === "previous-section" || command === "next-section";
  if (command === "back" && view.query.trim()) {
    const path = view.results[view.active] ?? "";
    setQuery(view, "");
    focusPath(view, path);
    return true;
  }
  if (
    !["next", "previous", "top", "bottom", "open", "back"].includes(command) &&
    !section
  )
    return false;
  const item = cursor(view, command, section ? FILE_ROWS : ROWS);
  if (!item) return true;
  if (command === "open") {
    if (item.getAttribute("aria-expanded") === "true") {
      const child = item.parentElement?.querySelector<HTMLElement>(
        "ul .explorer-row:not(:disabled)",
      );
      if (child) focusPath(view, child.dataset.path!);
    } else {
      item.click();
      if (view.viewer.file) element.focus({ preventScroll: true });
    }
  } else if (command === "back") {
    const parent =
      item.getAttribute("aria-expanded") === "true"
        ? item
        : item
            .closest("li")
            ?.parentElement?.closest("li")
            ?.querySelector<HTMLElement>(":scope > .explorer-row");
    if (parent) {
      const path = parent.dataset.path!;
      parent.click();
      focusPath(view, path);
    }
  }
  return true;
}

function stopBrowser(view: Browser): void {
  view.search?.abort();
  clearTimeout(view.timer);
  for (const item of view.folders.values()) {
    item.controller?.abort();
    item.loading = false;
  }
}
export const browserCache: PaneCacheDef = {
  ...viewerCache,
  key({ agentId }) {
    for (const [key, notes] of comments)
      if (key.startsWith(`${agentId}\nexplorer:`) && notes.size) return agentId;
    return null;
  },
};

export function renderBrowser(
  element: HTMLElement,
  { agentId: cid }: PaneContext,
): void {
  const prior = browsers.get(element);
  if (prior && prior.cid === cid && !prior.viewer.disposed) {
    paint(prior);
    return;
  }
  if (prior) stopBrowser(prior);
  const view: Browser = {
    cid,
    element,
    root: "",
    folders: new Map(),
    query: "",
    shown: "",
    results: [],
    active: 0,
    searchError: "",
    viewer: viewerFor(element, cid, {
      root: () => view.root,
      repaint: () => paint(view),
      listedPaths: () =>
        [...element.querySelectorAll<HTMLElement>(FILE_ROWS)].map(
          (item) => item.dataset.path!,
        ),
    }),
  };
  browsers.set(element, view);
  void loadFolder(view, folder(view, ""));
}

export function leaveBrowser(element: HTMLElement): void {
  const view = browsers.get(element);
  if (!view) return;
  stopBrowser(view);
  leaveViewer(element);
}
