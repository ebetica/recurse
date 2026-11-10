// Working-folder tree and desktop file tabs share source/HTML previews; pane
// ownership cancels reads, HTML uses the sanitized offline viewer, comments
// share the outbox. Search is the pane's entry input; its results keep the
// last answer until the next arrives; desktop keys follow loaded rows.
import { html, nothing, render, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { apiJson } from "./api.js";
import { DRAFT } from "./state.js";
import { openFileTab, openPane, registerPane, syncPanes } from "./panes.js";
import { registerFileTabSource } from "./panes/file-tabs.js";
import { paneItem } from "./panes/navigation.js";
import { copyText } from "./tool_details.js";
import type { PaneCacheDef, PaneContext, PaneNavigation } from "./types.js";
import {
  ATTACHMENT_FILE_ICON,
  BACK_ICON,
  DISCLOSURE_ICON,
  EXPLORER_ICON,
  FILE_DOWNLOAD_ICON,
  REFRESH_ICON,
} from "./icons.js";
import { commentMount, type CommentPane } from "./artifacts/artifact-state.js";
import { discardCurrent, renderComments } from "./artifacts/comment-bar.js";
import {
  claimComments,
  comments,
  commentKey,
  currentCommentKey,
  dropComments,
  pendingFor,
  reanchor,
} from "./artifacts/selection-comments.js";
import type {
  ExplorerEntry,
  ExplorerListing,
  ExplorerPreview,
} from "../src/web/explorer_io.js";

interface ExplorerElement extends HTMLElement {
  _rs?: CommentPane["_rs"];
}
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
interface View {
  cid: string;
  element: ExplorerElement;
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
  file: string | null;
  tabId?: string;
  filePaths: string[];
  notice: string;
  preview?: ExplorerPreview;
  previewText: string;
  htmlPreview: boolean;
  previewError: string;
  previewLoading: boolean;
  previewRequest?: AbortController;
  disposed: boolean;
}
const views = new WeakMap<HTMLElement, View>();
const MAX_ROWS = 1000;
const MAX_PREVIEW = 256 * 1024;
const ROWS = ".explorer-row:not(:disabled), .explorer-result";
const FILE_ROWS = ".explorer-row[data-file]:not(:disabled), .explorer-result";
const phone = matchMedia("(max-width: 700px)");

function resetCursor(root: ParentNode): void {
  for (const item of root.querySelectorAll(".explorer-row, .explorer-result")) {
    item.classList.remove("pane-item-cursor");
    item.removeAttribute("aria-current");
    item.removeAttribute("tabindex");
  }
}
phone.addEventListener("change", () => resetCursor(document));

function absolutePath(root: string, path: string): string {
  return `${root.replace(/\/$/, "")}/${path}`;
}

function endpoint(
  view: View,
  suffix = "",
  query: Record<string, string> = {},
): string {
  return `/api/conversations/${encodeURIComponent(view.cid)}/tree${suffix}?${new URLSearchParams(query)}`;
}
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const { response, data } = await apiJson<T>(url, { signal });
  if (!response.ok)
    throw new Error(
      String(
        (data as { detail?: string }).detail ||
          "Could not load files; try again.",
      ),
    );
  return data;
}
function folder(view: View, path: string): Folder {
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
function rowCount(view: View): number {
  return [...view.folders.values()].reduce(
    (n, item) => n + item.entries.length,
    0,
  );
}

function discardChildren(view: View, path: string): void {
  for (const [key, item] of view.folders) {
    if (key !== path && (!path || key.startsWith(path + "/"))) {
      item.controller?.abort();
      view.folders.delete(key);
    }
  }
}

async function loadFolder(
  view: View,
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
      endpoint(view, "", {
        path: item.path,
        ...(item.cursor ? { cursor: item.cursor } : {}),
      }),
      controller.signal,
    );
    if (controller.signal.aborted || view.disposed) return;
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

function toggle(view: View, path: string): void {
  const existing = view.folders.get(path);
  if (existing) {
    for (const [key, item] of view.folders) {
      if (key === path || key.startsWith(path + "/")) {
        item.controller?.abort();
        view.folders.delete(key);
      }
    }
    paint(view);
  } else void loadFolder(view, folder(view, path));
}

async function openFile(view: View, path: string, more = false): Promise<void> {
  if (phone.matches || more) return loadFile(view, path, more);
  view.previewRequest?.abort();
  const controller = new AbortController();
  view.previewRequest = controller;
  view.notice = "Loading file…";
  paint(view);
  try {
    const preview = await read<ExplorerPreview>(
      endpoint(view, "/file", { path }),
      controller.signal,
    );
    if (controller.signal.aborted || view.disposed) return;
    const paths = view.file
      ? view.filePaths
      : [...view.element.querySelectorAll<HTMLElement>(FILE_ROWS)].map(
          (item) => item.dataset.path!,
        );
    const opened = openFileTab(
      "explorer",
      JSON.stringify([preview.root, preview.path]),
      { cid: view.cid, preview, paths },
    );
    view.notice = opened ? "" : "Close a file tab before opening another.";
  } catch (error) {
    if (!controller.signal.aborted)
      view.notice =
        error instanceof Error ? error.message : "Could not open file.";
  } finally {
    if (!controller.signal.aborted) paint(view);
  }
}

async function loadFile(view: View, path: string, more = false): Promise<void> {
  if (!more && view.element._rs && !discardCurrent(view.element as CommentPane))
    return;
  view.previewRequest?.abort();
  const controller = new AbortController();
  view.previewRequest = controller;
  if (!more) {
    if (!view.file)
      view.filePaths = [
        ...view.element.querySelectorAll<HTMLElement>(FILE_ROWS),
      ].map((item) => item.dataset.path!);
    view.notice = "";
    view.file = path;
    view.preview = undefined;
    view.previewText = "";
    view.htmlPreview = false;
  }
  view.previewError = "";
  view.previewLoading = true;
  paint(view);
  try {
    const query: Record<string, string> = { path };
    if (more && view.preview?.next !== null && view.preview) {
      query.offset = String(view.preview.next);
      query.version = view.preview.version;
    }
    const preview = await read<ExplorerPreview>(
      endpoint(view, "/file", query),
      controller.signal,
    );
    if (controller.signal.aborted || view.disposed) return;
    if (view.tabId && preview.root !== view.root)
      throw new Error("Working folder changed. Reopen the file from Explorer.");
    view.preview = preview;
    view.previewText += preview.text ?? "";
  } catch (error) {
    if (!controller.signal.aborted)
      view.previewError =
        error instanceof Error ? error.message : "Could not open file.";
  } finally {
    if (!controller.signal.aborted) {
      view.previewLoading = false;
      paint(view);
    }
  }
}

function setQuery(view: View, query: string): void {
  clearTimeout(view.timer);
  view.query = query;
  view.notice = "";
  if (!query.trim()) {
    view.search?.abort();
    resetCursor(view.element);
    Object.assign(view, { shown: "", results: [], active: 0, searchError: "" });
  } else view.timer = setTimeout(() => void search(view, query), 180);
  paint(view);
}
// Invariant: Only the newest request can answer; starting one aborts the
// previous, so a slow older answer never replaces a newer one.
async function search(view: View, query: string): Promise<void> {
  view.search?.abort();
  const controller = new AbortController();
  view.search = controller;
  try {
    const found = await read<{ results: string[] }>(
      endpoint(view, "/search", { q: query }),
      controller.signal,
    );
    if (controller.signal.aborted || view.disposed) return;
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
function focusTree(view: View): void {
  const row =
    view.element.querySelector<HTMLElement>(".explorer-row.pane-item-cursor") ??
    view.element.querySelector<HTMLElement>(ROWS);
  if (row) focusPath(view, row.dataset.path!);
  else view.element.focus({ preventScroll: true });
}
function searchKeys(view: View, event: KeyboardEvent): void {
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
    void openFile(view, view.results[view.active]!);
  }
}

function tree(view: View, item: Folder, depth = 0): TemplateResult {
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
            entry.restricted ||
            entry.type === "symlink" ||
            entry.type === "other";
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
                ? "Unavailable: private file, symbolic link or special file"
                : entry.name}
              @click=${() =>
                isFolder ? toggle(view, path) : void openFile(view, path)}
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

function backToFiles(view: View): void {
  if (view.tabId) {
    openPane("explorer", { focusTarget: "body" });
    return;
  }
  if (!discardCurrent(view.element as CommentPane)) return;
  view.previewRequest?.abort();
  view.file = null;
  paint(view);
}

function preview(view: View): TemplateResult {
  const item = view.preview;
  return html`<div class="explorer-filebar">
      <button class="btn sm explorer-back" @click=${() => backToFiles(view)}>
        ${unsafeHTML(BACK_ICON)} Files
      </button>
      <span class="explorer-filename" title=${view.file!}>${view.file}</span>
      ${item?.kind === "text" && /\.html?$/i.test(view.file!)
        ? html`<div class="explorer-modes" role="group" aria-label="HTML view">
            ${["Source", "Preview"].map(
              (label) =>
                html`<button
                  class="btn sm"
                  type="button"
                  aria-pressed=${String(
                    view.htmlPreview === (label === "Preview"),
                  )}
                  @click=${() => {
                    view.htmlPreview = label === "Preview";
                    paint(view);
                  }}
                >
                  ${label}
                </button>`,
            )}
          </div>`
        : nothing}
      <a
        class="explorer-download"
        href=${endpoint(view, "/raw", { path: view.file! })}
        download
        aria-label="Download file"
        >${unsafeHTML(FILE_DOWNLOAD_ICON)}</a
      >
    </div>
    ${view.previewError
      ? html`<p class="explorer-status" role="alert">
          ${view.previewError}
          <button
            class="btn sm"
            @click=${() => void loadFile(view, view.file!)}
          >
            Retry
          </button>
        </p>`
      : nothing}
    ${item?.kind === "binary"
      ? html`<p class="explorer-status">
          This file cannot be shown as text. Download it to open it.
        </p>`
      : nothing}
    ${item?.kind === "text"
      ? html`<pre
          class="explorer-source report-doc explorer-source-only"
          tabindex="0"
        ><code></code></pre>`
      : nothing}
    ${view.previewLoading
      ? html`<p class="explorer-status explorer-source-only" role="status">
          Loading file…
        </p>`
      : nothing}
    ${item?.kind === "text" && item.next !== null
      ? html`<p class="explorer-status explorer-source-only">
            Showing ${view.previewText.length.toLocaleString()} characters of
            ${(item.size / 1024).toFixed(0)} KB.
          </p>
          ${view.previewText.length < MAX_PREVIEW
            ? html`<button
                class="btn sm explorer-more explorer-source-only"
                ?disabled=${view.previewLoading}
                @click=${() => void openFile(view, view.file!, true)}
              >
                Load more
              </button>`
            : html`<p class="explorer-status explorer-source-only">
                Download the file to read the rest.
              </p>`}`
      : nothing}
    ${item?.kind === "text"
      ? html`<div class="report-comments explorer-source-only"></div>
          <div class="report-bar explorer-source-only"></div>`
      : nothing}
    ${view.htmlPreview
      ? html`<p class="explorer-status">
            Preview shows loaded text without scripts, styles or external
            resources.
          </p>
          <div class="explorer-html-preview files-document"></div>`
      : nothing}`;
}

function syncComments(view: View): void {
  const item = view.preview;
  const code = view.element.querySelector(".explorer-source code");
  const path = code && item ? absolutePath(item.root, item.path) : null;
  const id = path ? `explorer:${path}` : null;
  view.element._rs ??= {
    agentId: view.cid,
    selId: null,
    contentInfo: null,
    deleting: false,
    sending: false,
    sendFailed: false,
    sendSeq: 0,
  };
  Object.assign(view.element._rs, {
    agentId: view.cid,
    selId: id,
    contentInfo:
      path && item
        ? {
            noun: "file",
            id,
            title: item.path.split("/").at(-1)!,
            path,
            version: item.version,
          }
        : null,
  });
  const pane = view.element as CommentPane;
  if (!code || !id) {
    if (commentMount.current === pane) commentMount.current = null;
    return;
  }
  const shown = code.textContent ?? "";
  if (!view.previewText.startsWith(shown)) code.textContent = view.previewText;
  else if (shown.length < view.previewText.length)
    code.append(view.previewText.slice(shown.length));
  claimComments(pane);
  reanchor(pane, id);
  renderComments(pane);
}

function syncHtmlPreview(view: View): void {
  const container = view.element.querySelector<HTMLElement>(
    ".explorer-html-preview",
  );
  const text = view.previewText;
  const name = view.file;
  const length = String(text.length);
  if (!container || container.dataset.shownLength === length) return;
  container.setAttribute("role", "status");
  container.textContent = "Loading preview…";
  const ownsView = () =>
    !view.disposed &&
    container.isConnected &&
    view.file === name &&
    view.previewText === text;
  void import("./document-preview.js")
    .then(({ mountHtmlPreview }) => {
      if (!ownsView() || container.dataset.shownLength === length) return;
      mountHtmlPreview(container, text, name!);
      container.dataset.shownLength = length;
      container.removeAttribute("role");
    })
    .catch(() => {
      if (!ownsView() || container.dataset.shownLength === length) return;
      container.dataset.shownLength = length;
      container.setAttribute("role", "alert");
      container.textContent =
        "Could not show the preview. Choose Source to read the file.";
    });
}

function paint(view: View): void {
  if (view.disposed) return;
  render(
    html`<section
      class="explorer ${view.file && view.htmlPreview
        ? "explorer-preview-mode"
        : ""}"
      aria-label=${view.tabId ? view.file! : "Working folder"}
    >
      ${view.notice
        ? html`<p class="explorer-status" role="status">${view.notice}</p>`
        : nothing}
      ${view.file
        ? preview(view)
        : html`<div class="explorer-head">
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
                          @click=${() => void openFile(view, path)}
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
                ${tree(view, folder(view, ""))}`} `}
    </section>`,
    view.element,
  );
  if (phone.matches) resetCursor(view.element);
  syncComments(view);
  syncHtmlPreview(view);
}

function cursor(
  view: View,
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

function focusPath(view: View, path: string): void {
  const item = [...view.element.querySelectorAll<HTMLElement>(ROWS)].find(
    (row) => row.dataset.path === path,
  );
  item?.focus({ preventScroll: true });
  cursor(view, "open");
}

function navigate(element: HTMLElement, command: PaneNavigation): boolean {
  const view = views.get(element);
  if (!view || view.disposed || phone.matches) return false;
  if (view.tabId && (command === "filter" || command === "back")) {
    backToFiles(view);
    const explorer = document.querySelector<HTMLElement>(
      '.pane-body[data-pane="explorer"]',
    );
    if (command === "filter")
      explorer?.querySelector<HTMLInputElement>("#explorer-search")?.focus();
    else {
      const tree = explorer && views.get(explorer);
      if (tree && view.file) focusPath(tree, view.file);
    }
    return true;
  }
  if (command === "filter" || (command === "back" && view.file)) {
    const path = view.file;
    element
      .querySelector<HTMLButtonElement>(".explorer-filebar button")
      ?.click();
    if (!view.file) {
      if (command === "filter") {
        resetCursor(element);
        element.querySelector<HTMLInputElement>("#explorer-search")?.focus();
      } else if (path) focusPath(view, path);
    }
    return true;
  }
  if (command === "copy") {
    const path = view.file ?? cursor(view, "copy")?.dataset.path;
    if (!path) return true;
    const root = view.file ? view.preview?.root : view.shown ? null : view.root;
    const copiedPath = root ? absolutePath(root, path) : path;
    const focused = document.activeElement;
    void copyText(copiedPath).then((ok) => {
      if (view.disposed || !element.isConnected) return;
      view.notice = ok ? "Path copied." : "Could not copy path.";
      paint(view);
      if (
        focused instanceof HTMLElement &&
        element.contains(focused) &&
        document.activeElement === document.body
      )
        focused.focus({ preventScroll: true });
    });
    return true;
  }
  const section = command === "previous-section" || command === "next-section";
  if (view.file) {
    if (!section) return false;
    const index = view.filePaths.indexOf(view.file);
    const path = view.filePaths[index + (command === "next-section" ? 1 : -1)];
    if (index >= 0 && path) {
      void openFile(view, path);
      if (view.file === path) element.focus({ preventScroll: true });
    }
    return true;
  }
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
      if (view.file) element.focus({ preventScroll: true });
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

function stop(view: View): void {
  view.search?.abort();
  view.previewRequest?.abort();
  view.previewLoading = false;
  clearTimeout(view.timer);
  for (const item of view.folders.values()) {
    item.controller?.abort();
    item.loading = false;
  }
}
const cache: PaneCacheDef = {
  version: 1,
  key({ agentId }) {
    for (const [key, notes] of comments)
      if (key.startsWith(`${agentId}\nexplorer:`) && notes.size) return agentId;
    return null;
  },
  generation: () => "staged-comments",
  resume(element) {
    const view = views.get(element);
    if (view) {
      view.disposed = false;
      paint(view);
    }
  },
};

function viewFor(element: HTMLElement, cid: string): View {
  if (!document.getElementById("explorer-style")) {
    const link = document.createElement("link");
    link.id = "explorer-style";
    link.rel = "stylesheet";
    link.href = "/static/explorer.css";
    document.head.append(link);
  }
  const prior = views.get(element);
  if (prior && prior.cid === cid && !prior.disposed) return prior;
  if (prior) {
    stop(prior);
    prior.disposed = true;
  }
  const view: View = {
    cid,
    element,
    root: "",
    folders: new Map(),
    query: "",
    shown: "",
    results: [],
    active: 0,
    searchError: "",
    file: null,
    filePaths: [],
    notice: "",
    previewText: "",
    htmlPreview: false,
    previewError: "",
    previewLoading: false,
    disposed: false,
  };
  views.set(element, view);
  return view;
}

function leave(element: HTMLElement): void {
  const view = views.get(element);
  if (!view) return;
  stop(view);
  view.disposed = true;
  const key = view.element._rs
    ? currentCommentKey(view.element as CommentPane)
    : null;
  if (key && !pendingFor(key)) dropComments(key);
  if (commentMount.current === element) commentMount.current = null;
}

registerFileTabSource("explorer", (key, id) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((part) => typeof part !== "string") ||
    JSON.stringify(parsed) !== key
  )
    return null;
  const [root, path] = parsed as [string, string];
  if (
    !/^(\/|[A-Za-z]:[\\/])/.test(root) ||
    /[\x00-\x1f]/.test(root) ||
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\x00-\x1f\\]/.test(path)
  )
    return null;
  type Prepared = {
    cid: string;
    controller: AbortController;
    preview?: ExplorerPreview;
    exists?: boolean;
  };
  let prepared: Prepared | undefined;
  let paths = [path];
  const release = (): void => {
    prepared?.controller.abort();
    prepared = undefined;
  };
  return {
    id,
    title: path.split("/").at(-1)!,
    icon: ATTACHMENT_FILE_ICON,
    navigate,
    cache: {
      ...cache,
      key({ agentId }) {
        const key = commentKey(agentId, `explorer:${absolutePath(root, path)}`);
        return key && comments.get(key)?.size ? agentId : null;
      },
    },
    leave,
    release,
    guardClose(element) {
      return (
        !(element as ExplorerElement)._rs ||
        discardCurrent(element as CommentPane)
      );
    },
    visit(agentId) {
      if (prepared && prepared.cid !== agentId) release();
    },
    prepare(value) {
      const seed = value as {
        cid: string;
        preview: ExplorerPreview;
        paths: string[];
      };
      if (
        !seed?.cid ||
        seed.preview?.root !== root ||
        seed.preview.path !== path
      )
        return;
      release();
      paths = seed.paths.slice(0, MAX_ROWS);
      prepared = {
        cid: seed.cid,
        controller: new AbortController(),
        preview: seed.preview,
        exists: true,
      };
    },
    available(ctx: PaneContext) {
      if (ctx.agentId === DRAFT || ctx.agentId.includes("/") || !ctx.node)
        return false;
      const body = document.querySelector<HTMLElement>(
        '.pane-body[data-pane="explorer"]',
      );
      const inline = body && views.get(body);
      if (
        inline?.cid === ctx.agentId &&
        inline.file === path &&
        inline.preview?.root === root
      )
        return false;
      if (!prepared || prepared.cid !== ctx.agentId) {
        release();
        const attempt: Prepared = {
          cid: ctx.agentId,
          controller: new AbortController(),
        };
        prepared = attempt;
        const url = `/api/conversations/${encodeURIComponent(ctx.agentId)}/tree/file?${new URLSearchParams({ path })}`;
        void read<ExplorerPreview>(url, attempt.controller.signal)
          .then((preview) => {
            if (prepared !== attempt || attempt.controller.signal.aborted)
              return;
            attempt.preview = preview;
            attempt.exists = preview.root === root && preview.path === path;
          })
          .catch(() => {
            if (prepared === attempt) attempt.exists = false;
          })
          .finally(() => {
            if (prepared === attempt && !attempt.controller.signal.aborted)
              syncPanes();
          });
      }
      return prepared.exists;
    },
    render(element, ctx) {
      const preview =
        prepared?.cid === ctx.agentId ? prepared.preview : undefined;
      if (!preview || preview.root !== root) return;
      const view = viewFor(element, ctx.agentId);
      view.tabId = id;
      view.root = root;
      view.file = path;
      view.filePaths = paths;
      view.preview = preview;
      view.previewText = preview.text ?? "";
      paint(view);
    },
  };
});

registerPane({
  id: "explorer",
  title: "Explorer",
  icon: EXPLORER_ICON,
  available: (ctx) =>
    ctx.agentId !== DRAFT && !ctx.agentId.includes("/") && !!ctx.node,
  navigate,
  cache,
  leave,
  render(element, ctx) {
    const prior = views.get(element);
    const view = viewFor(element, ctx.agentId);
    if (view !== prior) void loadFolder(view, folder(view, ""));
    else paint(view);
  },
});
