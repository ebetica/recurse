// Working-folder tree, file tabs and reply file paths share one viewer and
// text editor; pane ownership cancels reads; comments share the outbox. Edited
// text lives only in page memory and the save request; the agent is told only
// the path. Search results keep the last answer; desktop keys follow rows.
import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor } from "./backends/backend.js";
import { DRAFT } from "./state.js";
import { openFileTab, openPane, registerPane, syncPanes } from "./panes.js";
import { registerFileTabSource } from "./panes/file-tabs.js";
import { paneItem } from "./panes/navigation.js";
import { copyText } from "./tool_details.js";
import { highlightSource } from "./source-preview.js";
import {
  htmlFileModes,
  HTML_OFFLINE_NOTE,
  HTML_PREVIEW_FAILED,
  HTML_TOO_LARGE,
  isHtmlFile,
  MAX_HTML_PREVIEW_BYTES,
} from "./html-file-view.js";
import { requestUiStatus } from "./ui-events.js";
import { sendOperatorMessage } from "./conversation/operator-send.js";
import type { PaneCacheDef, PaneContext, PaneNavigation } from "./types.js";
import {
  ATTACHMENT_FILE_ICON,
  BACK_ICON,
  DISCLOSURE_ICON,
  EXPLORER_ICON,
  FILE_DOWNLOAD_ICON,
  REFRESH_ICON,
} from "./icons.js";
import type { CommentPane } from "./artifacts/artifact-state.js";
import { commentMount } from "./comments/selection-draft/index.js";
import {
  commentRendering,
  discardCurrent,
  renderComments,
} from "./artifacts/comment-bar.js";
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
  htmlLoading?: boolean;
  htmlFrameFailed?: boolean;
  tabSeed?: ExplorerPreview;
  previewError: string;
  previewLoading: boolean;
  previewRequest?: AbortController;
  /** Editor text; `editBase` is the opened version, null for a new file. */
  editing: boolean;
  draft: string;
  editBase: string | null;
  saving: boolean;
  saveError: string;
  conflict: boolean;
  pathExpanded: boolean;
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
const filePath = (view: View, path = view.file!): string =>
  view.root ? absolutePath(view.root, path) : path;
const visiblePath = (path: string): string =>
  path.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
    (char) =>
      `\\u${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
  );
const unsaved = new Set<string>();
const draftKey = (view: View): string => `${view.cid}\n${filePath(view)}`;

/** Leaving the editor keeps or discards unsaved text; false keeps editing. */
function closeEditor(view: View): boolean {
  if (!view.editing) return true;
  if (
    view.draft !== (view.editBase === null ? "" : view.previewText) &&
    !confirm(`Discard your unsaved changes to ${visiblePath(view.file!)}?`)
  )
    return false;
  unsaved.delete(draftKey(view));
  Object.assign(view, { editing: false, draft: "", saveError: "" });
  return true;
}

function endpoint(
  view: View,
  suffix = "",
  query: Record<string, string> = {},
): string {
  return backendFor(view.cid).url(
    `/api/conversations/${encodeURIComponent(view.cid)}/tree${suffix}?${new URLSearchParams(query)}`,
  );
}
async function read<T>(
  cid: string,
  url: string,
  signal: AbortSignal,
): Promise<T> {
  const { response, data } = await backendFor(cid).apiJson<T>(url, { signal });
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
      view.cid,
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
      view.cid,
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
  if (!more && !closeEditor(view)) return;
  if (!more && view.element._rs && !discardCurrent(view.element as CommentPane))
    return;
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
    view.htmlFrameFailed = false;
  }
  await loadPreview(view, path, more ? "source" : "initial");
}

async function loadPreview(
  view: View,
  path: string,
  stage: "source" | "initial" | "remaining",
): Promise<void> {
  view.previewRequest?.abort();
  const controller = new AbortController();
  view.previewRequest = controller;
  view.previewError = "";
  view.htmlLoading = stage !== "source" && isHtmlFile(path);
  view.previewLoading = true;
  paint(view);
  try {
    if (stage !== "remaining")
      await readFileChunk(view, path, controller.signal);
    if (view.htmlLoading) await completeHtml(view, path, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted)
      view.previewError =
        error instanceof Error ? error.message : "Could not open file.";
  } finally {
    if (!controller.signal.aborted) {
      view.previewLoading = false;
      view.htmlLoading = false;
      paint(view);
    }
  }
}

async function readFileChunk(view: View, path: string, signal: AbortSignal) {
  const query: Record<string, string> = { path: filePath(view, path) };
  const previous = view.preview;
  if (previous && previous.next !== null) {
    query.offset = String(previous.next);
    query.version = previous.version;
  }
  const preview = await read<ExplorerPreview>(
    view.cid,
    endpoint(view, "/file", query),
    signal,
  );
  if (signal.aborted || view.disposed) return;
  if (view.tabId && preview.root !== view.root)
    throw new Error("Working folder changed. Reopen the file from Explorer.");
  if (
    preview.next !== null &&
    (preview.next <= Number(query.offset ?? 0) || preview.next >= preview.size)
  )
    throw new Error("Couldn’t load the complete file for preview.");
  view.preview = preview;
  view.previewText += preview.text ?? "";
}

async function completeHtml(view: View, path: string, signal: AbortSignal) {
  while (!signal.aborted && !view.disposed) {
    const item = view.preview;
    if (item?.kind !== "text" || item.size > MAX_HTML_PREVIEW_BYTES) return;
    if (item.next === null) {
      view.htmlPreview = true;
      return;
    }
    await readFileChunk(view, path, signal);
  }
}

function continueHtmlPreview(view: View, path: string) {
  view.htmlLoading = false;
  const item = view.preview;
  if (
    !isHtmlFile(path) ||
    item?.kind !== "text" ||
    item.size > MAX_HTML_PREVIEW_BYTES
  )
    return;
  if (item.next === null) view.htmlPreview = true;
  else void loadPreview(view, path, "remaining");
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
      view.cid,
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

async function startEditing(view: View): Promise<void> {
  while (view.preview?.kind === "text" && view.preview.next !== null) {
    await loadFile(view, view.file!, true);
    if (view.previewError || view.disposed) return;
  }
  const item = view.preview;
  if (!item?.canonicalPath || item.kind === "binary") return;
  Object.assign(view, {
    editing: true,
    draft: item.kind === "missing" ? "" : view.previewText,
    editBase: item.kind === "missing" ? null : item.version,
    saveError: "",
    conflict: false,
    notice: "",
    htmlPreview: false,
  });
  paint(view);
  view.element.querySelector<HTMLElement>(".explorer-editor")?.focus();
}

async function saveFile(view: View, overwrite = false): Promise<void> {
  if (view.saving || !view.editing) return;
  const query: Record<string, string> = {
    path: filePath(view),
    canonicalPath: view.preview!.canonicalPath,
  };
  if (view.editBase) query.version = view.editBase;
  if (overwrite) query.overwrite = "true";
  const text = view.draft;
  Object.assign(view, { saving: true, saveError: "", conflict: false });
  paint(view);
  try {
    const { response, data } = await backendFor(view.cid).apiJson<
      ExplorerPreview & { detail?: unknown }
    >(endpoint(view, "/file", query), {
      method: "PUT",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: text,
    });
    if (!response.ok) {
      view.conflict =
        response.status === 409 &&
        [
          "The file changed on disk since you opened it.",
          "A file with this name already exists.",
        ].includes(String(data.detail));
      view.saveError =
        response.status === 405
          ? "This backend can’t save files yet. Update it, then try again."
          : typeof data.detail === "string"
            ? data.detail
            : "Could not save the file; try again.";
      return;
    }
    unsaved.delete(draftKey(view));
    Object.assign(view, {
      editing: view.draft !== text,
      editBase: data.version,
      preview: data,
      previewText: data.text ?? "",
      notice: view.draft === text ? "Saved." : "",
    });
    const told = await sendOperatorMessage(view.cid, {
      content: `I edited ${filePath(view)}`,
    }).catch(() => null);
    if (!told?.ok)
      view.notice = "Saved, but the agent wasn’t told. Tell it yourself.";
  } catch {
    view.saveError = "Could not save the file; try again.";
  } finally {
    view.saving = false;
    paint(view);
  }
}

function editor(view: View): TemplateResult {
  return html`${view.saveError
      ? html`<p class="explorer-status" role="alert">
          ${view.saveError}
          ${view.conflict
            ? html`<button class="btn sm" @click=${() => saveFile(view, true)}>
                Overwrite
              </button>`
            : nothing}
        </p>`
      : nothing}
    <textarea
      class="explorer-editor"
      aria-label="File text"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      .value=${live(view.draft)}
      @input=${(event: Event) => {
        view.draft = (event.target as HTMLTextAreaElement).value;
        unsaved.add(draftKey(view));
      }}
      @keydown=${(event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          void saveFile(view);
        }
      }}
    ></textarea>`;
}

function backToFiles(view: View): void {
  if (view.tabId) {
    openPane("explorer", { focusTarget: "body" });
    return;
  }
  if (!closeEditor(view) || !discardCurrent(view.element as CommentPane))
    return;
  view.previewRequest?.abort();
  view.file = null;
  paint(view);
}

function preview(view: View): TemplateResult {
  const item = view.preview;
  const destination = visiblePath(item?.canonicalPath ?? filePath(view));
  const name = html`<bdi dir="ltr">${destination}</bdi>`;
  return html`<div
      class="explorer-filebar"
      data-theme-protected="file-destination"
    >
      <button class="btn sm explorer-back" @click=${() => backToFiles(view)}>
        ${unsafeHTML(BACK_ICON)} Files
      </button>
      ${view.editing
        ? html`<span class="explorer-filename expanded" title=${destination}
            >${name}</span
          >`
        : html`<button
            class="explorer-filename ${view.pathExpanded ? "expanded" : ""}"
            title=${destination}
            aria-label=${view.pathExpanded
              ? "Collapse file path"
              : "Expand file path"}
            aria-expanded=${String(view.pathExpanded)}
            @click=${() => {
              view.pathExpanded = !view.pathExpanded;
              paint(view);
            }}
          >
            ${name}
          </button>`}
      ${view.editing
        ? html`<button
              class="btn sm"
              @click=${() => {
                if (closeEditor(view)) paint(view);
              }}
            >
              Cancel
            </button>
            <button
              class="btn sm primary"
              ?disabled=${view.saving}
              @click=${() => saveFile(view)}
            >
              ${view.saving ? "Saving…" : "Save"}
            </button>`
        : nothing}
      ${!view.editing &&
      item?.kind === "text" &&
      item.canonicalPath &&
      item.size <= MAX_PREVIEW &&
      !view.htmlLoading &&
      !view.htmlPreview
        ? html`<button class="btn sm" @click=${() => startEditing(view)}>
            Edit
          </button>`
        : nothing}
      ${item?.kind === "missing" || view.editing
        ? nothing
        : html`<a
            class="explorer-download"
            href=${endpoint(view, "/raw", { path: filePath(view) })}
            download
            aria-label="Download file"
            >${unsafeHTML(FILE_DOWNLOAD_ICON)}</a
          >`}
    </div>
    ${item?.canonicalPath && item.canonicalPath !== filePath(view)
      ? html`<p
          class="explorer-status explorer-alias"
          data-theme-protected="file-destination"
        >
          Opens ${visiblePath(filePath(view))} → saves to ${destination}
        </p>`
      : nothing}
    ${item?.promptResource
      ? html`<p
          class="explorer-status"
          data-theme-protected="model-file-warning"
          role="note"
        >
          This file’s contents are sent to the model. Don’t save secrets here.
        </p>`
      : nothing}
    ${view.htmlLoading
      ? html`<p class="explorer-status" role="status">Loading preview…</p>`
      : nothing}
    ${!view.htmlLoading &&
    !view.editing &&
    item?.kind === "text" &&
    isHtmlFile(view.file!)
      ? html`${htmlFileModes(
          view.htmlPreview,
          item.next !== null ||
            item.size > MAX_HTML_PREVIEW_BYTES ||
            !!view.htmlFrameFailed,
          (preview) => {
            if (preview === view.htmlPreview) return;
            view.htmlPreview = preview;
            paint(view);
          },
        )}
        ${item.size > MAX_HTML_PREVIEW_BYTES || view.htmlFrameFailed
          ? html`<p class="html-file-note" role="status">
              ${item.size > MAX_HTML_PREVIEW_BYTES
                ? HTML_TOO_LARGE
                : HTML_PREVIEW_FAILED}
            </p>`
          : nothing}`
      : nothing}
    ${view.editing ? editor(view) : nothing}
    ${item && !item.canonicalPath
      ? html`<p class="explorer-status" role="alert">
          Update this backend before editing files; it doesn’t identify the save
          destination.
        </p>`
      : nothing}
    ${item?.kind === "missing" && item.canonicalPath && !view.editing
      ? html`<p class="explorer-status">This file doesn’t exist yet.</p>
          <button
            class="btn sm primary explorer-more"
            @click=${() => startEditing(view)}
          >
            Create file
          </button>`
      : nothing}
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
    ${item?.kind === "text" && !view.editing && !view.htmlLoading
      ? html`<pre
          class="explorer-source report-doc explorer-source-only"
          tabindex="0"
        ><code></code></pre>`
      : nothing}
    ${view.previewLoading && !view.htmlLoading
      ? html`<p class="explorer-status explorer-source-only" role="status">
          Loading file…
        </p>`
      : nothing}
    ${item?.kind === "text" &&
    item.next !== null &&
    !view.editing &&
    !view.htmlLoading
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
    ${item?.kind === "text" && !view.editing && !view.htmlLoading
      ? html`<div class="report-comments explorer-source-only"></div>
          <div class="report-bar explorer-source-only"></div>`
      : nothing}
    ${view.htmlPreview
      ? html`<p class="html-file-note">${HTML_OFFLINE_NOTE}</p>
          <div class="explorer-html-preview"></div>`
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
  highlightSource(code, item!.path);
  claimComments(pane, commentRendering);
  reanchor(pane, id);
  renderComments(pane);
}

function syncHtmlPreview(view: View): void {
  const container = view.element.querySelector<HTMLElement>(
    ".explorer-html-preview",
  );
  if (!container || container.dataset.loading) return;
  const text = view.previewText;
  const name = view.file!;
  container.dataset.loading = "true";
  container.setAttribute("role", "status");
  container.textContent = "Loading preview…";
  const ownsView = () =>
    !view.disposed &&
    view.element.contains(container) &&
    view.file === name &&
    view.previewText === text;
  void import("./document-preview.js")
    .then(async ({ htmlFileFrame }) => {
      if (!ownsView()) return;
      const frame = await htmlFileFrame(text, name);
      if (!ownsView()) return;
      container.replaceChildren(frame);
      container.removeAttribute("role");
    })
    .catch(() => {
      if (!ownsView()) return;
      view.htmlPreview = false;
      view.htmlFrameFailed = true;
      paint(view);
    });
}

function paint(view: View): void {
  if (view.disposed) return;
  render(
    html`<section
      class="explorer ${view.file && view.htmlPreview
        ? "explorer-preview-mode"
        : ""}"
      aria-label=${view.tabId ? visiblePath(view.file!) : "Working folder"}
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
      if (
        view.htmlLoading &&
        view.file &&
        view.previewRequest?.signal.aborted
      ) {
        if (view.preview) continueHtmlPreview(view, view.file);
        else void loadFile(view, view.file);
      }
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
    editing: false,
    draft: "",
    editBase: null,
    saving: false,
    saveError: "",
    conflict: false,
    pathExpanded: false,
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
    title: visiblePath(path.split("/").at(-1)!),
    icon: ATTACHMENT_FILE_ICON,
    navigate,
    cache: {
      ...cache,
      key({ agentId }) {
        const key = commentKey(agentId, `explorer:${absolutePath(root, path)}`);
        return (key && comments.get(key)?.size) ||
          unsaved.has(`${agentId}\n${absolutePath(root, path)}`)
          ? agentId
          : null;
      },
    },
    leave,
    release,
    guardClose(element) {
      const view = views.get(element);
      return (
        (!view || closeEditor(view)) &&
        (!(element as ExplorerElement)._rs ||
          discardCurrent(element as CommentPane))
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
      if (ctx.agentId === DRAFT || !ctx.node) return false;
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
        const url = `/api/conversations/${encodeURIComponent(ctx.agentId)}/tree/file?${new URLSearchParams({ path: absolutePath(root, path) })}`;
        void read<ExplorerPreview>(ctx.agentId, url, attempt.controller.signal)
          .then((preview) => {
            if (prepared !== attempt || attempt.controller.signal.aborted)
              return;
            attempt.preview = preview;
            attempt.exists =
              preview.root === root &&
              preview.path === path &&
              preview.kind !== "missing";
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
      if (view.tabSeed !== preview) {
        view.tabSeed = preview;
        view.preview = preview;
        view.previewText = preview.text ?? "";
        view.previewError = "";
        view.htmlPreview = false;
        view.htmlFrameFailed = false;
        continueHtmlPreview(view, path);
      }
      paint(view);
    },
  };
});

registerPane({
  id: "explorer",
  title: "Explorer",
  icon: EXPLORER_ICON,
  available: (ctx) => ctx.agentId !== DRAFT && !!ctx.node,
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

/** Open a file path from a reply in the shared viewer, at any location. */
export async function openFilePath(cid: string, path: string): Promise<void> {
  try {
    const preview = await read<ExplorerPreview>(
      cid,
      `/api/conversations/${encodeURIComponent(cid)}/tree/file?${new URLSearchParams({ path })}`,
      AbortSignal.timeout(30_000),
    );
    if (!preview.path) throw new Error("This path is a folder.");
    if (
      !openFileTab("explorer", JSON.stringify([preview.root, preview.path]), {
        cid,
        preview,
        paths: [preview.path],
      })
    )
      requestUiStatus(
        "File not opened. Close a file tab or finish the current comments first.",
      );
  } catch (error) {
    requestUiStatus(
      error instanceof Error ? error.message : "Could not open the file.",
    );
  }
}

document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>(
    "a[data-file-path]",
  );
  const cid = link?.dataset.fileOwner;
  if (
    !link ||
    !cid ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  void openFilePath(cid, link.dataset.filePath!);
});
