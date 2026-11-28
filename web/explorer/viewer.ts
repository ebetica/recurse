// One file viewer per pane body, shared by inline Explorer and file tabs.
// Draft text stays in memory and the save request; the agent sees only the path.
import { html, nothing, render, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { live } from "lit/directives/live.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor } from "../backends/index.js";
import { openFileTab, openPane } from "../panes.js";
import { copyText } from "../tool_details.js";
import { highlightSource } from "../source-preview.js";
import {
  fileViewModes,
  HTML_OFFLINE_NOTE,
  HTML_PREVIEW_FAILED,
  isHtmlFile,
  PREVIEW_TOO_LARGE,
} from "../html-file-view.js";
import { renderDocumentMarkdown } from "../document-markdown.js";
import { sendOperatorMessage } from "../conversation/index.js";
import {
  claimComments,
  commentRendering,
  createCommentState,
  currentCommentKey,
  discardCurrent,
  dropComments,
  pendingFor,
  reanchor,
  renderComments,
  syncSelectionDraft,
  type CommentPane,
} from "../artifacts/index.js";
import { commentMount } from "../comments/selection-draft/index.js";
import { BACK_ICON, FILE_DOWNLOAD_ICON } from "../icons.js";
import type { PaneCacheDef, PaneNavigation } from "../types.js";
import type { ExplorerPreview } from "../../src/web/explorer_io.js";
import { absolutePath, endpoint, read } from "./io.js";

interface ExplorerElement extends HTMLElement {
  _rs?: CommentPane["_rs"];
}
export interface Viewer {
  cid: string;
  element: ExplorerElement;
  readonly root: string;
  file: string | null;
  tabId?: string;
  filePaths: string[];
  notice: string;
  preview?: ExplorerPreview;
  previewText: string;
  formattedPreview: boolean;
  formattedLoading?: "open" | "switch";
  htmlFrameFailed?: boolean;
  markdownRender?: AbortController;
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
  repaint: () => void;
  listedPaths: () => string[];
}
const viewers = new WeakMap<HTMLElement, Viewer>();
const MAX_PREVIEW = 256 * 1024;
const previewFormat = (path: string) =>
  isHtmlFile(path)
    ? "HTML"
    : /\.(?:md|markdown)$/i.test(path)
      ? "Markdown"
      : null;
export const phone = matchMedia("(max-width: 700px)");

const filePath = (view: Viewer, path = view.file!): string =>
  view.root ? absolutePath(view.root, path) : path;
export const visiblePath = (path: string): string =>
  path.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
    (char) =>
      `\\u${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
  );
const unsaved = new Set<string>();
const draftKey = (view: Viewer): string => `${view.cid}\n${filePath(view)}`;

/** Leaving the editor keeps or discards unsaved text; false keeps editing. */
function closeEditor(view: Viewer | undefined, canLeave = () => true): boolean {
  if (!view?.editing) return canLeave();
  if (
    view.draft !== (view.editBase === null ? "" : view.previewText) &&
    !confirm(`Discard your unsaved changes to ${visiblePath(view.file!)}?`)
  )
    return false;
  if (!canLeave()) return false;
  unsaved.delete(draftKey(view));
  Object.assign(view, { editing: false, draft: "", saveError: "" });
  return true;
}

export function hasUnsaved(cid: string, path: string): boolean {
  return unsaved.has(`${cid}\n${path}`);
}

export function guardViewerClose(
  element: HTMLElement,
  preserveComments: boolean,
  leaveComments = () =>
    !(element as ExplorerElement)._rs || discardCurrent(element as CommentPane),
): boolean {
  return closeEditor(
    viewers.get(element),
    () => preserveComments || leaveComments(),
  );
}

export async function openFile(view: Viewer, path: string): Promise<void> {
  if (phone.matches) return loadFile(view, path);
  view.previewRequest?.abort();
  const controller = new AbortController();
  view.previewRequest = controller;
  view.notice = "Loading file…";
  view.repaint();
  try {
    const preview = await read<ExplorerPreview>(
      view.cid,
      endpoint(view.cid, "/file", { path }),
      controller.signal,
    );
    if (controller.signal.aborted || view.disposed) return;
    const paths = view.file ? view.filePaths : view.listedPaths();
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
    if (!controller.signal.aborted) view.repaint();
  }
}

async function loadFile(
  view: Viewer,
  path: string,
  more = false,
): Promise<void> {
  if (!more && !closeEditor(view)) return;
  if (!more && view.element._rs && !discardCurrent(view.element as CommentPane))
    return;
  if (!more) {
    if (!view.file) view.filePaths = view.listedPaths();
    view.notice = "";
    view.file = path;
    view.preview = undefined;
    view.previewText = "";
    view.formattedPreview = false;
    view.htmlFrameFailed = false;
  }
  await loadPreview(view, path, more ? "source" : "initial");
}

async function loadPreview(
  view: Viewer,
  path: string,
  stage: "source" | "initial" | "remaining" | "switch",
): Promise<void> {
  view.previewRequest?.abort();
  const controller = new AbortController();
  view.previewRequest = controller;
  view.previewError = "";
  view.formattedLoading =
    stage === "source" || !previewFormat(path)
      ? undefined
      : stage === "switch"
        ? "switch"
        : "open";
  view.previewLoading = true;
  view.repaint();
  try {
    if (stage === "source" || stage === "initial")
      await readFileChunk(view, path, controller.signal);
    if (view.formattedLoading)
      await completeFormattedPreview(view, path, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted)
      view.previewError =
        error instanceof Error ? error.message : "Could not open file.";
  } finally {
    if (!controller.signal.aborted) {
      view.previewLoading = false;
      view.formattedLoading = undefined;
      view.repaint();
    }
  }
}

async function readFileChunk(view: Viewer, path: string, signal: AbortSignal) {
  const query: Record<string, string> = { path: filePath(view, path) };
  const previous = view.preview;
  if (previous && previous.next !== null) {
    query.offset = String(previous.next);
    query.version = previous.version;
  }
  const preview = await read<ExplorerPreview>(
    view.cid,
    endpoint(view.cid, "/file", query),
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

async function completeFormattedPreview(
  view: Viewer,
  path: string,
  signal: AbortSignal,
) {
  while (!signal.aborted && !view.disposed) {
    const item = view.preview;
    if (item?.kind !== "text" || item.size > MAX_PREVIEW) return;
    if (item.next === null) {
      view.formattedPreview = true;
      return;
    }
    await readFileChunk(view, path, signal);
  }
}

function continueFormattedPreview(view: Viewer, path: string) {
  view.formattedLoading = undefined;
  const item = view.preview;
  if (!previewFormat(path) || item?.kind !== "text" || item.size > MAX_PREVIEW)
    return;
  if (item.next === null) view.formattedPreview = true;
  else void loadPreview(view, path, "remaining");
}

async function startEditing(view: Viewer): Promise<void> {
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
    formattedPreview: false,
  });
  view.repaint();
  view.element.querySelector<HTMLElement>(".explorer-editor")?.focus();
}

async function saveFile(view: Viewer, overwrite = false): Promise<void> {
  if (view.saving || !view.editing) return;
  const query: Record<string, string> = {
    path: filePath(view),
    canonicalPath: view.preview!.canonicalPath,
  };
  if (view.editBase) query.version = view.editBase;
  if (overwrite) query.overwrite = "true";
  const text = view.draft;
  Object.assign(view, { saving: true, saveError: "", conflict: false });
  view.repaint();
  try {
    const { response, data } = await backendFor(view.cid).apiJson<
      ExplorerPreview & { detail?: unknown }
    >(endpoint(view.cid, "/file", query), {
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
    view.repaint();
  }
}

function editor(view: Viewer): TemplateResult {
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

export function backToFiles(view: Viewer): void {
  if (view.tabId) {
    openPane("explorer", { focusTarget: "body" });
    return;
  }
  if (!closeEditor(view) || !discardCurrent(view.element as CommentPane))
    return;
  view.previewRequest?.abort();
  view.file = null;
  view.repaint();
}

function preview(view: Viewer): TemplateResult {
  const item = view.preview;
  const format = previewFormat(view.file!);
  const switching = view.formattedLoading === "switch";
  const showingHtml = view.formattedPreview && format === "HTML";
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
              view.repaint();
            }}
          >
            ${name}
          </button>`}
      ${view.editing
        ? html`<button
              class="btn sm"
              @click=${() => {
                if (closeEditor(view)) view.repaint();
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
      !view.formattedLoading &&
      !showingHtml
        ? html`<button class="btn sm" @click=${() => startEditing(view)}>
            Edit
          </button>`
        : nothing}
      ${item?.kind === "missing" || view.editing
        ? nothing
        : html`<a
            class="explorer-download"
            href=${endpoint(view.cid, "/raw", { path: filePath(view) })}
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
    ${view.formattedLoading !== "open" &&
    !view.editing &&
    item?.kind === "text" &&
    format
      ? html`${fileViewModes(
          `${format} view`,
          view.formattedPreview || switching,
          item.size > MAX_PREVIEW ||
            !!view.previewError ||
            !!view.htmlFrameFailed,
          (preview) => {
            if (switching) {
              if (!preview) {
                view.previewRequest?.abort();
                view.previewLoading = false;
                view.formattedLoading = undefined;
                view.repaint();
              }
              return;
            }
            if (preview === view.formattedPreview) return;
            if (preview && item.next !== null) {
              void loadPreview(view, view.file!, "switch");
              return;
            }
            view.formattedPreview = preview;
            view.repaint();
            if (format === "Markdown") syncSelectionDraft();
          },
        )}
        ${item.size > MAX_PREVIEW || view.htmlFrameFailed
          ? html`<p class="html-file-note" role="status">
              ${item.size > MAX_PREVIEW
                ? PREVIEW_TOO_LARGE
                : HTML_PREVIEW_FAILED}
            </p>`
          : nothing}`
      : nothing}
    ${view.formattedLoading
      ? html`<p class="explorer-status" role="status">Loading preview…</p>`
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
    ${item?.kind === "text" && !view.editing && !view.formattedLoading
      ? html`<pre
          class="explorer-source report-doc explorer-source-only"
          tabindex="0"
        ><code></code></pre>`
      : nothing}
    ${view.previewLoading && !view.formattedLoading
      ? html`<p class="explorer-status explorer-source-only" role="status">
          Loading file…
        </p>`
      : nothing}
    ${item?.kind === "text" &&
    item.next !== null &&
    !view.editing &&
    !view.formattedLoading
      ? html`<p class="explorer-status explorer-source-only">
            Showing ${view.previewText.length.toLocaleString()} characters of
            ${(item.size / 1024).toFixed(0)} KB.
          </p>
          ${view.previewText.length < MAX_PREVIEW
            ? html`<button
                class="btn sm explorer-more explorer-source-only"
                ?disabled=${view.previewLoading}
                @click=${() => void loadFile(view, view.file!, true)}
              >
                Load more
              </button>`
            : html`<p class="explorer-status explorer-source-only">
                Download the file to read the rest.
              </p>`}`
      : nothing}
    ${item?.kind === "text" &&
    !view.editing &&
    !view.formattedLoading &&
    !(view.formattedPreview && format === "Markdown")
      ? html`<div class="report-comments explorer-source-only"></div>
          <div class="report-bar explorer-source-only"></div>`
      : nothing}
    ${showingHtml
      ? html`<p class="html-file-note">${HTML_OFFLINE_NOTE}</p>
          <div class="explorer-html-preview"></div>`
      : nothing}
    ${view.formattedPreview && format === "Markdown"
      ? keyed(
          item?.version,
          html`<div class="explorer-markdown artifact-doc"></div>`,
        )
      : nothing}`;
}

function syncComments(view: Viewer): void {
  const item = view.preview;
  const code = view.element.querySelector(".explorer-source code");
  const path = code && item ? absolutePath(item.root, item.path) : null;
  const id = path ? `explorer:${path}` : null;
  view.element._rs ??= createCommentState(view.cid);
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
  if (!view.formattedPreview) highlightSource(code, item!.path);
  claimComments(pane, commentRendering);
  reanchor(pane, id);
  renderComments(pane);
}

function syncHtmlPreview(view: Viewer): void {
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
  void import("../document-preview.js")
    .then(async ({ htmlFileFrame }) => {
      if (!ownsView()) return;
      const frame = await htmlFileFrame(text, name);
      if (!ownsView()) return;
      container.replaceChildren(frame);
      container.removeAttribute("role");
    })
    .catch(() => {
      if (!ownsView()) return;
      view.formattedPreview = false;
      view.htmlFrameFailed = true;
      view.repaint();
    });
}

function syncMarkdownPreview(view: Viewer): void {
  const container =
    view.element.querySelector<HTMLElement>(".explorer-markdown");
  if (container?.firstChild && !view.markdownRender?.signal.aborted) return;
  view.markdownRender?.abort();
  if (!container || !view.preview) return;
  const controller = new AbortController();
  view.markdownRender = controller;
  container.replaceChildren();
  const { root, path } = view.preview;
  renderDocumentMarkdown(container, view.previewText, {
    title: path.split("/").at(-1)!,
    agentId: view.cid,
    signal: controller.signal,
    documentPath: absolutePath(root, path),
    doubleClickImages: true,
  });
}

export function renderExplorer(
  view: Viewer,
  browse?: () => TemplateResult,
): void {
  if (view.disposed) return;
  render(
    html`<section
      class="explorer ${view.file && view.formattedPreview
        ? "explorer-preview-mode"
        : ""}"
      aria-label=${view.tabId ? visiblePath(view.file!) : "Working folder"}
    >
      ${view.notice
        ? html`<p class="explorer-status" role="status">${view.notice}</p>`
        : nothing}
      ${view.file ? preview(view) : browse?.()}
    </section>`,
    view.element,
  );
  syncComments(view);
  syncHtmlPreview(view);
  syncMarkdownPreview(view);
}

export function viewerAt(element: HTMLElement): Viewer | undefined {
  return viewers.get(element);
}

export function copyPath(
  view: Viewer,
  path: string,
  root?: string | null,
): void {
  const element = view.element;
  const copiedPath = root ? absolutePath(root, path) : path;
  const focused = document.activeElement;
  void copyText(copiedPath).then((ok) => {
    if (view.disposed || !element.isConnected) return;
    view.notice = ok ? "Path copied." : "Could not copy path.";
    view.repaint();
    if (
      focused instanceof HTMLElement &&
      element.contains(focused) &&
      document.activeElement === document.body
    )
      focused.focus({ preventScroll: true });
  });
}

export function navigateFile(view: Viewer, command: PaneNavigation): boolean {
  if (!view.file) return false;
  if (command === "copy") {
    copyPath(view, view.file, view.preview?.root);
    return true;
  }
  const section = command === "previous-section" || command === "next-section";
  if (!section) return false;
  const index = view.filePaths.indexOf(view.file);
  const path = view.filePaths[index + (command === "next-section" ? 1 : -1)];
  if (index >= 0 && path) {
    void openFile(view, path);
    if (view.file === path) view.element.focus({ preventScroll: true });
  }
  return true;
}

function stopViewer(view: Viewer): void {
  view.previewRequest?.abort();
  view.markdownRender?.abort();
  view.previewLoading = false;
}

export const viewerCache: Pick<
  PaneCacheDef,
  "version" | "generation" | "resume"
> = {
  version: 1,
  generation: () => "staged-comments",
  resume(element) {
    const view = viewers.get(element);
    if (view) {
      view.disposed = false;
      if (
        view.formattedLoading &&
        view.file &&
        view.previewRequest?.signal.aborted
      ) {
        if (view.preview) continueFormattedPreview(view, view.file);
        else void loadFile(view, view.file);
      }
      view.repaint();
    }
  },
};

export function viewerFor(
  element: HTMLElement,
  cid: string,
  options: {
    root: () => string;
    tabId?: string;
    repaint?: () => void;
    listedPaths?: () => string[];
  },
): Viewer {
  if (!document.getElementById("explorer-style")) {
    const link = document.createElement("link");
    link.id = "explorer-style";
    link.rel = "stylesheet";
    link.href = "/static/explorer.css";
    document.head.append(link);
  }
  const prior = viewers.get(element);
  if (prior && prior.cid === cid && !prior.disposed) return prior;
  if (prior) {
    stopViewer(prior);
    prior.disposed = true;
  }
  const view: Viewer = {
    cid,
    element,
    get root() {
      return options.root();
    },
    tabId: options.tabId,
    repaint: options.repaint ?? (() => renderExplorer(view)),
    listedPaths: options.listedPaths ?? (() => []),
    file: null,
    filePaths: [],
    notice: "",
    previewText: "",
    formattedPreview: false,
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
  viewers.set(element, view);
  return view;
}

export function leaveViewer(element: HTMLElement): void {
  const view = viewers.get(element);
  if (!view) return;
  stopViewer(view);
  view.disposed = true;
  const key = view.element._rs
    ? currentCommentKey(view.element as CommentPane)
    : null;
  if (key && !pendingFor(key)) dropComments(key);
  if (commentMount.current === element) commentMount.current = null;
}

export function seedTab(
  view: Viewer,
  path: string,
  paths: string[],
  preview: ExplorerPreview,
): void {
  view.file = path;
  view.filePaths = paths;
  if (view.tabSeed !== preview) {
    view.tabSeed = preview;
    view.preview = preview;
    view.previewText = preview.text ?? "";
    view.previewError = "";
    view.formattedPreview = false;
    view.htmlFrameFailed = false;
    continueFormattedPreview(view, path);
  }
  view.repaint();
}
