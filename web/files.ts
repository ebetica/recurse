// Page bounded owner metadata newest-first; preview only visible files.
// Keep open collections during reads; bound caches and throttle probes.
// Image dialogs leave history before Files; browser-cache and share originals.
// Viewers navigate oldest-first; desktop keys share list cursors and scrolling.
import { html, nothing, render, type TemplateResult } from "lit";
import {
  ATTACHMENT_FILE_ICON,
  BACK_ICON as BACK,
  FILE_DELETE_ICON,
  FILE_DOWNLOAD_ICON,
  FILES_ICON,
  CLOSE_ICON,
  JUMP_ICON as JUMP,
  MORE_ICON,
  NEXT_ICON as NEXT,
  PEN_ICON,
  PREVIOUS_ICON as PREVIOUS,
} from "./icons.js";
import { repeat } from "lit/directives/repeat.js";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { mountPdf, releasePdfs } from "./pdf-view.js";
import { backendFor } from "./backends/backend.js";
import { attachmentSize } from "./agent-attachments.js";
import { jumpToFile, jumpToMessage } from "./conversation/navigation.js";
import { scrollToLatest } from "./conversation/controls.js";
import { canDraw, drawOn } from "./image-preview/drawing.js";
import { installImageZoom } from "./image-preview/zoom.js";
import { installImageCommentLayout } from "./image-preview/comments-layout.js";
import {
  closeDrawingEditor,
  closeDrawingFromKeyboard,
  drawingEditorOpen,
} from "./image-preview/editor.js";
import { state } from "./state.js";
import { commentMount, type CommentPane } from "./artifacts/artifact-state.js";
import { discardCurrent, renderComments } from "./artifacts/comment-bar.js";
import {
  claimComments,
  commentKey,
  comments,
  pendingFor,
  closeSelectionCommentFromKeyboard,
  handleCommentShortcut,
  reanchor,
  syncSelectionDraft,
} from "./artifacts/selection-comments.js";
import {
  fetchPaneData,
  openFileTab,
  openPane,
  registerPane,
  syncPanes,
} from "./panes.js";
import { registerFileTabSource } from "./panes/file-tabs.js";
import { panePowerbar, renderPowerbarControls } from "./panes/powerbar.js";
import { paneItem } from "./panes/navigation.js";
import { copyText } from "./tool_details.js";
import { renderDocumentMarkdown } from "./document-markdown.js";
import { installBoxComments, touchDrewBox } from "./files/box-comments.js";
import { diffPending, diffPreview, isDiff } from "./files/diff-preview.js";
import {
  currentFilesRequest,
  ensureFilePreview,
  fileKindLabel,
  filesPaneAvailable,
  filesRefreshDue,
  mergeSessionFiles,
  rendersAsMarkdown,
  retainFilePreview,
  selectedFile,
  SettledTurnFile,
  versionGroups,
  type FileSelection,
  type FilePreviewState,
  type SessionFile,
} from "./files/model.js";
import type { PaneContext, PaneNavigation, Turn } from "./types.js";
import { installReferenceImageViewer } from "./image-preview/references.js";

let documentViews: typeof import("./document-preview.js") | null = null;

function syncDocuments(root?: Element): void {
  documentViews?.releaseDocuments();
  if (!root) return;
  for (const view of root.querySelectorAll<HTMLElement>(
    "[data-files-document]",
  )) {
    void import("./document-preview.js").then((module) => {
      documentViews = module;
      module.releaseDocuments();
      if (view.isConnected)
        module.mountDocument(
          view,
          view.dataset.filesDocument!,
          view.dataset.name!,
          Number(view.dataset.size),
        );
    });
  }
}

const PANE_ID = "files";
const FILES_PAGE_SIZE = 100;
const MAX_CLIENT_SOURCES = 40;
const MAX_CONVERSATION_CACHES = 12;
const MAX_TEXT_PREVIEW_CACHES = 24;
const coarsePointer = matchMedia("(pointer: coarse)");
const phone = matchMedia("(max-width: 700px)");

interface FilesPage {
  files: SessionFile[];
  cursor: string | null;
  generation: number;
  stale?: boolean;
  done: boolean;
  capped?: boolean;
}

interface CacheEntry {
  files: Map<string, SessionFile>;
  displayFiles: Map<string, SessionFile> | null;
  filter: string;
  cursor: string | null;
  generation: number | null;
  initialized: boolean;
  complete: boolean;
  capped: boolean;
  inflight: boolean;
  pending?: Promise<void>;
  error: string | null;
  notice?: string;
  failedDeletion: SessionFile | null;
  request: number;
  controller: AbortController | null;
  previews: Map<string, FilePreviewState>;
  previewLru: string[];
  conversationVersion: string | null;
  lastRefresh: number;
  // A throttled running version still reloads at settle, including fast turns.
  refreshPending: boolean;
}

interface FilesEl extends HTMLElement {
  _filesHash?: string;
  _filesObserver?: IntersectionObserver;
  _markdownAbort?: AbortController;
  _filesSwipe?: boolean;
  _rs?: CommentPane["_rs"];
}

const cache = new Map<string, CacheEntry>();
// The file whose detail view replaces the list, per conversation.
const selections = new Map<string, FileSelection>();
let paneEl: FilesEl | null = null;
let shownId: string | null = null;
let lastSelectedId: string | null = null;
interface FileView {
  cid: string;
  file: SessionFile;
}
const fileViews = new Map<FilesEl, FileView>();
const retainedViews = new WeakMap<FilesEl, FileView>();
const settledTurnFile = new SettledTurnFile();
let autoOpenProbe: string | null = null;
let popout: {
  dialog: HTMLDialogElement;
  body: FilesEl;
  cid: string;
  file: SessionFile;
  focus: HTMLElement | null;
  closeLayout: () => void;
} | null = null;

function closeImage(): void {
  if (!popout) return;
  const { dialog, body, focus, closeLayout } = popout;
  closeLayout();
  closeDrawingEditor();
  popout = null;
  body._filesObserver?.disconnect();
  if (commentMount.current === body) commentMount.current = null;
  const commentPopover = dialog.querySelector(".report-comment-popover");
  if (commentPopover) document.body.append(commentPopover);
  dialog.close();
  dialog.remove();
  focus?.focus({ preventScroll: true });
  if (history.state?.imagePopout) history.back();
  repaint();
}

/** Escape on the open image viewer: closes it and reports that it did. */
export function closeImageFromKeyboard(): boolean {
  if (!popout) return false;
  closeImage();
  return true;
}

window.addEventListener("popstate", () => {
  if (popout && drawingEditorOpen()) {
    history.pushState({ ...history.state, imagePopout: true }, "");
    closeDrawingFromKeyboard();
  } else closeImage();
});

function openImage(cid: string, file: SessionFile): void {
  const opening = !popout;
  if (!popout) {
    const dialog = document.createElement("dialog");
    dialog.className = "image-popout";
    dialog.setAttribute("aria-label", "Image viewer");
    const body = document.createElement("div") as FilesEl;
    body.className = "image-popout-body";
    popout = {
      dialog,
      body,
      cid,
      file,
      focus: document.activeElement as HTMLElement | null,
      closeLayout: installImageCommentLayout(body),
    };
    dialog.append(body);
    document.body.append(dialog);
    dialog.addEventListener("keydown", (event) =>
      handleCommentShortcut(event, body),
    );
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!closeDrawingFromKeyboard() && !closeSelectionCommentFromKeyboard())
        closeImage();
    });
    let outside: { x: number; y: number } | null = null;
    dialog.addEventListener("pointerdown", (event) => {
      const target = event.target as Element;
      outside =
        target === dialog ||
        target.classList.contains("image-zoom-viewport") ||
        target === body
          ? { x: event.clientX, y: event.clientY }
          : null;
    });
    dialog.addEventListener("pointerup", (event) => {
      if (
        outside &&
        Math.hypot(event.clientX - outside.x, event.clientY - outside.y) >= 5
      )
        outside = null;
    });
    dialog.addEventListener("pointercancel", () => (outside = null));
    dialog.addEventListener("click", () => {
      if (outside) closeImage();
      outside = null;
    });
    installBoxComments(body);
    body.addEventListener("comments-submitting", () => {
      if (popout?.body !== body) return;
      closeImage();
      scrollToLatest();
    });
    installSwipe(body, (delta) => stepImage(delta));
    history.pushState({ ...history.state, imagePopout: true }, "");
    dialog.showModal();
  }
  popout.cid = cid;
  popout.file = file;
  renderImage();
  if (opening)
    popout.dialog
      .querySelector<HTMLButtonElement>('[aria-label="Close image"]')
      ?.focus({ preventScroll: true });
}

function imageGroups(cid: string, current: SessionFile): SessionFile[][] {
  const groups = versionGroups(allFiles(entry(cid)))
    .reverse()
    .filter(([file]) => file?.storage === "published" && imageHref(cid, file));
  return groups.some((group) => group.some((file) => file.key === current.key))
    ? groups
    : [[current]];
}

function stepImage(delta: -1 | 1): void {
  if (!popout) return;
  const groups = imageGroups(popout.cid, popout.file);
  const index = groups.findIndex((group) =>
    group.some((file) => file.key === popout!.file.key),
  );
  const next = groups[index + delta]?.[0];
  if (next) openImage(popout.cid, next);
}

function renderImage(): void {
  if (!popout) return;
  const { body, cid, file } = popout;
  const groups = imageGroups(cid, file);
  const index = groups.findIndex((group) =>
    group.some((candidate) => candidate.key === file.key),
  );
  render(
    html`<header class="viewer-topbar image-popout-bar">
        <span class="files-name" title=${file.name}>${file.name}</span>
        ${groups.length > 1
          ? html`${iconButton(
                "Previous image",
                PREVIOUS_ICON,
                () => stepImage(-1),
                "",
                index <= 0,
              )}
              <span class="files-position"
                >${index + 1} of ${groups.length}</span
              >
              ${iconButton(
                "Next image",
                NEXT_ICON,
                () => stepImage(1),
                "",
                index === groups.length - 1,
              )}`
          : nothing}
        ${downloadHref(cid, file)
          ? iconButton(
              "Download",
              DOWNLOAD_ICON,
              () => void downloadImage(cid, file),
            )
          : nothing}
        ${iconButton(
          "Draw",
          DRAW_ICON,
          () => drawOn(detailImage(), closeImage),
          "files-draw",
        )}
        ${file.image_url
          ? nothing
          : iconButton("Open in Files", unsafeHTML(FILES_ICON), () => {
              const open = () => {
                if (phone.matches) {
                  selections.set(cid, { key: file.key });
                  if (paneEl) paneEl._filesHash = undefined;
                  repaint();
                  openPane(PANE_ID);
                } else selectFile(cid, { key: file.key });
              };
              if (history.state?.imagePopout) {
                window.addEventListener("popstate", open, { once: true });
                closeImage();
              } else {
                closeImage();
                open();
              }
            })}
        ${iconButton("Close image", unsafeHTML(CLOSE_ICON), closeImage)}
      </header>
      <article
        class="files-detail"
        data-file-key=${file.key}
        aria-label=${file.name}
      >
        ${previewTemplate(cid, file, true)}
      </article>
      <aside class="image-comment-sidebar" aria-label="Image comments">
        <h2 class="image-comment-heading">Comments</h2>
        <div class="report-comments"></div>
        <div class="report-bar"></div>
      </aside>`,
    body,
  );
  const commentPopover = document.querySelector(".report-comment-popover");
  if (commentPopover)
    body.querySelector(".image-comment-sidebar")!.append(commentPopover);
  observePreviews(body, cid);
  syncComments(body, cid, file);
  syncDraw();
}

/** Watch the shown conversation's turns for one to open in the pane. */
export function noteTurns(cid: string, turns: readonly Turn[]): void {
  settledTurnFile.observe(cid, turns);
}

/** Rows for this conversation arrived from the server. */
export function noteRowsRead(cid: string): void {
  settledTurnFile.rowsRead(cid);
}

// The file to auto-open, once this conversation's listing can show it:
// undefined (unknown) holds the auto-open policy's decision until then.
function autoOpenGeneration(ctx: PaneContext): string | null | undefined {
  const id = settledTurnFile.current(ctx.agentId);
  if (!id) return null;
  const value = entry(ctx.agentId);
  if (value.error) return undefined;
  if (selectedFile(visibleFiles(value).values(), { id })) return id;
  // Invariant: An open pane reloads on its own; reloading here would cancel its
  // previews.
  if (paneEl?.isConnected && shownId === ctx.agentId) return undefined;
  if (!value.initialized || !value.complete) return undefined;
  if (autoOpenProbe === id) return null;
  autoOpenProbe = id;
  revalidate(value, value.generation);
  scheduleFetch(ctx.agentId);
  return undefined;
}

if (!document.getElementById("files-pane-css")) {
  const link = document.createElement("link");
  link.id = "files-pane-css";
  link.rel = "stylesheet";
  link.href = "/static/files.css";
  document.head.appendChild(link);
}

function entry(id: string): CacheEntry {
  let value = cache.get(id);
  if (value) {
    cache.delete(id);
    cache.set(id, value);
    return value;
  }
  while (cache.size >= MAX_CONVERSATION_CACHES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const removed = cache.get(oldest);
    if (removed) abandon(removed);
    cache.delete(oldest);
  }
  value = {
    files: new Map(),
    displayFiles: null,
    filter: "",
    cursor: null,
    generation: null,
    initialized: false,
    complete: false,
    capped: false,
    inflight: false,
    error: null,
    failedDeletion: null,
    request: 0,
    controller: null,
    previews: new Map(),
    previewLru: [],
    conversationVersion: null,
    lastRefresh: 0,
    refreshPending: false,
  };
  cache.set(id, value);
  return value;
}

function visibleFiles(value: CacheEntry): Map<string, SessionFile> {
  return value.displayFiles ?? value.files;
}

function allFiles(value: CacheEntry): SessionFile[] {
  return [...visibleFiles(value).values()];
}

async function attachmentFile(
  cid: string,
  attachmentId: string,
): Promise<SessionFile | null> {
  const value = entry(cid);
  let file = selectedFile(visibleFiles(value).values(), { id: attachmentId });
  if (!file && value.complete) revalidate(value, value.generation);
  while (!file && !value.complete && !value.error && cid === state.selectedId) {
    await loadPage(cid);
    file = selectedFile(visibleFiles(value).values(), { id: attachmentId });
  }
  return cid === state.selectedId ? file : null;
}

/** Open an attachment in a desktop file tab or the phone's Files pane. */
export async function showFileInPane(
  cid: string,
  attachmentId: string,
  userInitiated = true,
): Promise<void> {
  const file = await attachmentFile(cid, attachmentId);
  if (cid !== state.selectedId) return;
  if (file && !phone.matches && file.id) {
    selectFile(cid, { key: file.key }, userInitiated);
    return;
  }
  if (file && imageHref(cid, file)) return openImage(cid, file);
  selections.set(cid, { id: attachmentId });
  if (paneEl?.isConnected && shownId === cid) {
    paneEl._filesHash = undefined;
    repaint();
  }
  openPane(PANE_ID);
}

function selectFile(
  cid: string,
  selection: FileSelection | null,
  userInitiated = true,
): void {
  const file = selection && selectedFile(allFiles(entry(cid)), selection);
  if (file && !phone.matches && file.id) {
    const value = entry(cid);
    const inline = selections.get(cid);
    const held = inline && selectedFile(allFiles(value), inline);
    if (held && pendingFor(commentKey(cid, held.id ?? null))) {
      if (held.key === file.key) {
        openPane(PANE_ID);
        return;
      }
    } else selections.delete(cid);
    if (userInitiated) closeSelectionCommentFromKeyboard();
    value.notice = file.unavailable
      ? unavailableLabel(file)!
      : openFileTab(
            "files",
            JSON.stringify([cid, file.key]),
            { cid, file },
            { userInitiated, focusHeading: userInitiated },
          )
        ? undefined
        : "Close a file tab before opening another file.";
    repaint();
    if (value.notice) openPane(PANE_ID);
    return;
  }
  if (file && imageHref(cid, file)) return openImage(cid, file);
  const returnKey =
    paneEl?.querySelector<HTMLElement>(".files-detail")?.dataset.fileKey;
  if (selection) selections.set(cid, selection);
  else selections.delete(cid);
  repaint();
  if (paneEl) {
    (selection ? panePowerbar(paneEl) : paneEl)
      .querySelector<HTMLElement>(selection ? ".files-back" : ".files-summary")
      ?.focus();
    const item =
      !selection &&
      !coarsePointer.matches &&
      [...paneEl.querySelectorAll<HTMLElement>(".files-card")].find(
        (row) => row.dataset.fileKey === returnKey,
      );
    if (item) {
      item.focus({ preventScroll: true });
      paneItem(paneEl, ".files-card", "open");
    }
  }
}

/** Navigate oldest to newest; return false at either end. */
function stepFile(cid: string, delta: -1 | 1, element?: FilesEl): boolean {
  const all = allFiles(entry(cid));
  const held = element && fileViews.get(element);
  const selection = held ? { key: held.file.key } : selections.get(cid);
  const shown = selection ? selectedFile(all, selection) : null;
  const groups = versionGroups(all).reverse();
  const index = shown ? groups.findIndex((group) => group.includes(shown)) : -1;
  const next = index < 0 ? null : groups[index + delta]?.[0];
  if (!next) return false;
  if (held) selectFile(cid, { key: next.key });
  else {
    selections.set(cid, { key: next.key, latest: true });
    repaint();
    paneEl?.scrollTo({ top: 0 });
  }
  return true;
}

function detailImage(
  element = popout?.body ?? paneEl,
): HTMLImageElement | null {
  return element?.querySelector<HTMLImageElement>(".files-detail img") ?? null;
}

function syncDraw(): void {
  for (const element of [popout?.body, paneEl, ...fileViews.keys()]) {
    if (!element) continue;
    const draw =
      element === popout?.body
        ? element.querySelector(".files-draw")
        : panePowerbar(element).querySelector(".files-draw");
    if (canDraw(detailImage(element))) draw?.removeAttribute("aria-disabled");
    else draw?.setAttribute("aria-disabled", "true");
  }
}
document.addEventListener("recurse:attachment-availability", syncDraw);

document.addEventListener("keydown", (event) => {
  if (
    popout &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
    !(event.target as Element).closest("input, textarea, select")
  ) {
    stepImage(event.key === "ArrowLeft" ? -1 : 1);
    event.preventDefault();
    return;
  }
  const target = event.target as Element | null;
  if (
    (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !target?.closest?.(
      '.pane-col[data-pane="files"], .pane-col.file-tab:has(.files-detail)',
    ) ||
    target.closest("input, textarea, select, [contenteditable]")
  )
    return;
  const element =
    target.closest<FilesEl>(".pane-body") ??
    target.closest(".pane-col")?.querySelector<FilesEl>(".pane-body");
  const cid = (element && fileViews.get(element)?.cid) || shownId;
  if (
    cid &&
    stepFile(cid, event.key === "ArrowLeft" ? -1 : 1, element ?? undefined)
  )
    event.preventDefault();
});

// Invariant: A horizontal swipe steps files only at normal zoom and only when
// no element under the finger scrolls sideways; pinch-zoomed drags pan.
function installSwipe(
  element: FilesEl,
  step: (delta: -1 | 1) => void = (delta) => {
    if (shownId) stepFile(shownId, delta);
  },
): void {
  let start: { x: number; y: number } | null = null;
  const scrollsSideways = (node: Element | null): boolean => {
    for (let at = node; at && at !== element; at = at.parentElement)
      if (at.scrollWidth > at.clientWidth + 1) return true;
    return false;
  };
  element.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target as Element;
      start =
        event.touches.length === 1 &&
        (window.visualViewport?.scale ?? 1) <= 1.01 &&
        !target.closest('[data-zoomed="true"]') &&
        target.closest(".files-detail") &&
        !scrollsSideways(target)
          ? { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY }
          : null;
    },
    { passive: true },
  );
  element.addEventListener("touchcancel", () => (start = null));
  element.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches[0];
      if (
        !start ||
        !touch ||
        touchDrewBox() ||
        (event.target as Element).closest('[data-zoomed="true"]')
      )
        return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      start = null;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy))
        step(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );
}

/** Enlarge an image without changing the Files tab selection. */
export async function enlargeFileImage(cid: string, id: string): Promise<void> {
  const file = await attachmentFile(cid, id);
  if (file && imageHref(cid, file)) openImage(cid, file);
  else if (cid === state.selectedId) await showFileInPane(cid, id);
}
installReferenceImageViewer(
  () => state.selectedId,
  openImage,
  enlargeFileImage,
);

function abandon(value: CacheEntry): void {
  value.request++;
  value.controller?.abort();
  value.controller = null;
  value.inflight = false;
  for (const preview of value.previews.values()) {
    preview.controller?.abort();
    preview.controller = undefined;
    if (preview.status === "loading") preview.status = "idle";
  }
}

function reset(
  value: CacheEntry,
  generation: number | null = null,
  preservePreviews = false,
): void {
  abandon(value);
  value.files.clear();
  value.displayFiles = null;
  if (!preservePreviews) {
    value.previews.clear();
    value.previewLru = [];
  }
  value.cursor = null;
  value.generation = generation;
  value.initialized = false;
  value.complete = false;
  value.capped = false;
  value.error = null;
  value.refreshPending = false;
}

function revalidate(value: CacheEntry, generation: number | null): void {
  abandon(value);
  if (value.displayFiles === null && value.files.size)
    value.displayFiles = new Map(value.files);
  value.files.clear();
  value.cursor = null;
  value.generation = generation;
  value.complete = false;
  value.capped = false;
  value.error = null;
}

function repaint(): void {
  if (popout && popout.cid !== state.selectedId) closeImage();
  if (paneEl?.isConnected && shownId === state.selectedId)
    renderPane(paneEl, shownId);
  for (const [element, view] of fileViews)
    if (element.isConnected && view.cid === state.selectedId)
      renderFile(element, view.cid, view.file);
  syncPanes();
  renderImage();
}
coarsePointer.addEventListener("change", repaint);

// The owned collection changed outside the conversation record (a
// completed upload or release): no poll version moves, so mark the entry
// owed and reload now when its pane is open. Closed panes reload on open
// through the version mismatch this leaves behind.
export function invalidateFiles(id: string): void {
  const value = cache.get(id);
  if (!value) return;
  value.conversationVersion = null;
  value.refreshPending = true;
  if (paneEl?.isConnected && shownId === id && !document.hidden) {
    revalidate(value, value.generation);
    void loadPage(id);
  }
}

function loadPage(id: string, signal?: AbortSignal): Promise<void> | void {
  const value = entry(id);
  if (value.inflight) return value.pending;
  if (value.complete || value.error || id === "__draft__") return;
  const controller = signal ? null : new AbortController();
  const activeSignal = signal || controller!.signal;
  const request = ++value.request;
  value.controller = controller;
  value.inflight = true;
  if (!value.cursor) value.lastRefresh = performance.now();
  const query = new URLSearchParams();
  if (value.initialized && value.cursor) query.set("cursor", value.cursor);
  if (value.generation !== null)
    query.set("generation", String(value.generation));
  query.set("limit", String(FILES_PAGE_SIZE));
  const url = `/api/conversations/${encodeURIComponent(id)}/files?${query}`;
  return (value.pending = backendFor(id)
    .api(url, { signal: activeSignal })
    .then(async (response) => {
      if (
        !currentFilesRequest(lastSelectedId || id, id, value.request, request)
      ) {
        // Invariant: An unread body holds its connection open; release it.
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok) throw new Error(`files ${response.status}`);
      const page = (await response.json()) as FilesPage;
      if (
        !currentFilesRequest(lastSelectedId || id, id, value.request, request)
      )
        return;
      if (
        page.stale ||
        (value.generation !== null && value.generation !== page.generation)
      ) {
        revalidate(value, page.generation);
        if (
          !activeSignal.aborted &&
          !document.hidden &&
          paneEl?.isConnected &&
          shownId === id
        )
          void loadPage(id, activeSignal);
        return;
      }
      value.generation = page.generation;
      mergeSessionFiles(
        value.files,
        page.files || [],
        Number.POSITIVE_INFINITY,
        MAX_CLIENT_SOURCES,
      );
      value.cursor = page.cursor;
      value.capped = !!page.capped;
      value.complete = !!page.done || !page.cursor;
      value.initialized = true;
      value.error = null;
      value.displayFiles = null;
    })
    .catch(() => {
      if (request !== value.request) return;
      if (activeSignal.aborted) {
        if (!value.initialized) value.error = null;
        return;
      }
      value.error = value.displayFiles
        ? "Couldn’t refresh files. Showing the last loaded version."
        : value.initialized
          ? "Couldn’t load older files. Showing what loaded."
          : "Couldn’t load files.";
    })
    .finally(() => {
      if (request !== value.request) return;
      value.inflight = false;
      value.pending = undefined;
      value.controller = null;
      repaint();
      const selection = selections.get(id);
      if (
        selection &&
        !selectedFile(value.files.values(), selection) &&
        !value.complete &&
        !value.error &&
        paneEl?.isConnected &&
        shownId === id
      )
        requestAnimationFrame(() => void loadPage(id));
    }));
}

function conversationVersion(ctx: PaneContext): string | null {
  const conv = ctx.conv;
  if (!conv || conv.id !== ctx.agentId) return null;
  // Invariant: Status/version/tree stamps capture settle and between-poll
  // turns. Each distinct version reloads once; unchanged legacy message counts
  // do not prove no publication occurred.
  return [
    conv.message_log_generation ?? 0,
    conv.msg_count,
    conv.status,
    ctx.nodes[ctx.agentId]?.updated ?? 0,
    JSON.stringify(
      (conv.pending || []).map((message) => [
        message.id,
        message.attachment_ids,
        (message.attachments || []).map((file) => file.id),
      ]),
    ),
  ].join(":");
}

// Open panes read immediately; closed probes queue per agent and abort on
// switch. loadPage guards make completed repeat probes no-ops.
function scheduleFetch(id: string): void {
  if (!id || id === "__draft__") return;
  fetchPaneData(PANE_ID, id, (signal) => loadPage(id, signal));
}

function available(ctx: PaneContext): boolean | undefined {
  const id = ctx.agentId;
  const switched = lastSelectedId !== id;
  if (switched) {
    if (lastSelectedId) abandon(entry(lastSelectedId));
    lastSelectedId = id && id !== "__draft__" && ctx.node ? id : null;
  }
  if (!id || id === "__draft__" || !ctx.node) return false;
  const version = conversationVersion(ctx);
  if (version === null) return false;
  const value = entry(id);
  const paneOpen = paneEl?.isConnected && shownId === id;
  // Invariant: A selection boundary is a fresh opportunity to observe the owned
  // file collection. A completed empty (or stale) projection must not suppress
  // the next probe merely because conversation metadata did not change.
  if (switched && value.complete) revalidate(value, value.generation);
  // Invariant: Stale-while-revalidate like the Changes pane: a version move
  // resets the closed entry and its probe re-establishes availability, but a
  // matching version keeps its warm button while the probe converges the tail
  // pages. An open pane's refresh belongs to update(), never to this reset.
  if (!paneOpen && value.conversationVersion !== version) {
    reset(value, ctx.conv?.message_log_generation ?? null, true);
    value.conversationVersion = version;
  }
  // Invariant: First discovery needs a snapshot or error. An open pending read
  // stays offered; only a settled empty snapshot hides its controls.
  if (!paneOpen) scheduleFetch(id);
  if (
    (paneOpen && value.inflight) ||
    filesPaneAvailable(value.initialized, value.error, visibleFiles(value).size)
  )
    return true;
  return !value.complete && !value.error ? undefined : false;
}

function badge(ctx: PaneContext): string | number | null {
  const value = cache.get(ctx.agentId);
  if (!value?.initialized) return null;
  const count = visibleFiles(value).size;
  return value.complete && !value.capped ? count : `${count}+`;
}

function downloadHref(cid: string, file: SessionFile): string | null {
  if (file.image_url) return `${file.image_url}&download=1`;
  if (!file.id || file.unavailable) return null;
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/attachments/${encodeURIComponent(file.id)}`,
  );
}

async function downloadImage(cid: string, file: SessionFile): Promise<void> {
  const href = downloadHref(cid, file);
  if (!href) return;
  if (
    matchMedia("(pointer: coarse)").matches &&
    navigator.share &&
    navigator.canShare
  ) {
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error("Image download failed");
      const blob = await response.blob();
      const original = new File([blob], file.name, {
        type: file.image_url ? blob.type : file.media_type,
      });
      const files = [original];
      if (navigator.canShare({ files })) {
        await navigator.share({ files });
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  const link = document.createElement("a");
  link.href = href;
  link.download = file.name;
  link.dataset.bytes = String(file.size);
  document.body.append(link);
  link.click();
  link.remove();
}

function imageHref(cid: string, file: SessionFile): string | null {
  if (file.image_url) return file.image_url;
  const base = downloadHref(cid, file);
  if (!base || file.preview !== "image") return null;
  // Invariant: The bytes route forces octet-stream + nosniff (never renders);
  // raster display goes through the inline-only preview capability.
  return `${base}/preview`;
}

function mediaHref(cid: string, file: SessionFile): string | null {
  const base = downloadHref(cid, file);
  if (!base || (file.preview !== "audio" && file.preview !== "video"))
    return null;
  return `${base}/preview`;
}

function textPreviewHref(cid: string, file: SessionFile): string | null {
  if (!file.id || file.preview !== "text" || file.unavailable) return null;
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/files/${file.storage}/${encodeURIComponent(file.id)}/preview`,
  );
}

function retainPreview(id: string, key: string): void {
  const value = entry(id);
  const detailKey =
    shownId === id
      ? paneEl?.querySelector<HTMLElement>(".files-detail")?.dataset.fileKey
      : undefined;
  value.previewLru = retainFilePreview(
    value.previews,
    value.previewLru,
    key,
    MAX_TEXT_PREVIEW_CACHES,
    detailKey,
  );
}

function reloadPreview(id: string, key: string): void {
  const value = entry(id);
  const preview = ensureFilePreview(value.previews, key);
  preview.status = "idle";
  preview.text = undefined;
  preview.truncated = undefined;
  value.previewLru = value.previewLru.filter((candidate) => candidate !== key);
  repaint();
}

function loadTextPreview(id: string, file: SessionFile): void {
  const value = entry(id);
  const preview = ensureFilePreview(value.previews, file.key);
  const href = textPreviewHref(id, file);
  if (!href || preview.status !== "idle") return;
  const controller = new AbortController();
  preview.status = "loading";
  preview.controller = controller;
  backendFor(id)
    .api(href, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error("preview unavailable");
      const payload = (await response.json()) as {
        kind?: unknown;
        text?: unknown;
        truncated?: unknown;
      };
      if (id !== state.selectedId || value.previews.get(file.key) !== preview)
        return;
      if (payload.kind !== "text" || typeof payload.text !== "string")
        throw new Error("invalid preview");
      preview.status = "ready";
      preview.text = payload.text;
      preview.truncated = payload.truncated === true;
      retainPreview(id, file.key);
    })
    .catch(() => {
      if (!controller.signal.aborted) preview.status = "missing";
    })
    .finally(() => {
      preview.controller = undefined;
      if (id === state.selectedId) repaint();
    });
}

async function deleteFile(cid: string, file: SessionFile): Promise<void> {
  const href = downloadHref(cid, file);
  if (!href) return;
  if (!confirm(`Delete ${file.name}? This cannot be undone.`)) return;
  const value = entry(cid);
  try {
    const response = await backendFor(cid).api(href, { method: "DELETE" });
    if (!response.ok) throw new Error(`delete ${response.status}`);
  } catch {
    value.failedDeletion = file;
    repaint();
    return;
  }
  if (value.failedDeletion?.key === file.key) value.failedDeletion = null;
  value.files.delete(file.key);
  value.displayFiles?.delete(file.key);
  value.previews.delete(file.key);
  value.previewLru = value.previewLru.filter(
    (candidate) => candidate !== file.key,
  );
  for (const view of fileViews.values())
    if (view.cid === cid && view.file.key === file.key)
      view.file.unavailable = "missing";
  repaint();
}

function previewTemplate(
  cid: string,
  file: SessionFile,
  detail = false,
  element?: FilesEl,
): unknown {
  const image = imageHref(cid, file);
  const preview = cache.get(cid)?.previews.get(file.key);
  if (image) {
    // Invariant: The list shows the thread-sized thumbnail; detail views load
    // the original, which box comments, crops and drawing measure.
    const img = html`<img
      class="files-image"
      alt=${file.name}
      src=${detail ? image : image.replace(/\/preview$/, "/thumbnail")}
      loading=${detail ? "eager" : "lazy"}
      decoding="async"
      @load=${(event: Event) => {
        syncDraw();
        if (detail) {
          const image = event.target as HTMLImageElement;
          image
            .closest<HTMLElement>(".files-image-frame")
            ?.style.setProperty(
              "--image-aspect",
              String(image.naturalWidth / image.naturalHeight),
            );
          installImageZoom(image);
        }
      }}
    />`;
    // Invariant: Box marks are appended beside the image, so another file gets
    // a fresh frame instead of inheriting them.
    return detail
      ? keyed(
          file.key,
          html`<div class="image-zoom-viewport">
            <div class="files-image-frame report-doc report-box-frame">
              ${img}
            </div>
          </div>`,
        )
      : img;
  }
  const media = mediaHref(cid, file);
  if (media)
    return file.preview === "audio"
      ? html`<audio
          class="files-media"
          controls
          preload="metadata"
          src=${media}
          aria-label=${file.name}
        ></audio>`
      : html`<video
          class="files-media"
          controls
          playsinline
          preload="metadata"
          src=${media}
          aria-label=${file.name}
        ></video>`;
  const pdf = file.preview === "pdf" ? downloadHref(cid, file) : null;
  if (pdf)
    return html`<div class="files-pdf report-doc" data-files-pdf=${pdf}></div>`;
  if (file.preview === "document") {
    const url = downloadHref(cid, file);
    if (url)
      return keyed(
        file.key,
        html`<div
          class="files-document"
          data-files-document=${url}
          data-name=${file.name}
          data-size=${file.size}
        ></div>`,
      );
  }
  if (file.preview !== "text")
    return html`<div class="files-preview-note">
      No preview for this kind of file. Download it to open it.
    </div>`;
  if (preview?.status === "evicted")
    return html`<button
      class="files-preview-placeholder"
      type="button"
      @click=${() => reloadPreview(cid, file.key)}
    >
      Reload preview
    </button>`;
  if (!textPreviewHref(cid, file))
    return html`<div class="files-preview-note">
      Preview available after the queued message appears.
    </div>`;
  // Invariant: Comment marks rewrite the preview's text nodes, so another
  // file gets fresh DOM rather than Lit updating those nodes in place.
  if (preview?.status === "ready")
    return keyed(
      file.key,
      html`<div class="files-text-wrap">
        ${isDiff(file, preview.text ?? "")
          ? diffPreview(preview)
          : rendersAsMarkdown(file)
            ? markdownPreview(cid, file, preview.text ?? "", element)
            : html`<pre class="report-doc">${preview.text}</pre>`}
        ${preview.truncated
          ? html`<span class="files-preview-note">Preview truncated.</span>`
          : nothing}
      </div>`,
    );
  if (preview?.status === "missing")
    return html`<div class="files-preview-note">Preview unavailable.</div>`;
  return html`<div
    class="files-preview-placeholder"
    data-files-text=${file.key}
    aria-label=${`Text preview for ${file.name}`}
  >
    ${preview?.status === "loading"
      ? "Loading preview…"
      : "Preview loads when visible."}
  </div>`;
}

function versionLabel(file: SessionFile, number: number, latest: boolean) {
  const when = file.created_at
    ? new Date(file.created_at * 1000).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
  return [`Version ${number}`, when, latest ? "latest" : ""]
    .filter(Boolean)
    .join(" · ");
}

// Picking a version opens its tab or updates the legacy detail view.
function versionMenu(
  element: FilesEl,
  cid: string,
  file: SessionFile,
  versions: SessionFile[],
) {
  if (versions.length < 2) return nothing;
  return html`<div class="files-versions">
    <select
      aria-label="Version"
      @change=${(event: Event) => {
        const select = event.currentTarget as HTMLSelectElement;
        const key = select.value;
        if (fileViews.has(element)) {
          select.value = file.key;
          selectFile(cid, { key });
        } else {
          selections.set(cid, { key, latest: key === versions[0]!.key });
          repaint();
        }
        if (!fileViews.has(element))
          panePowerbar(element)
            .querySelector<HTMLElement>(".files-versions select")
            ?.focus();
      }}
    >
      ${versions.map(
        (version, index) =>
          html`<option
            value=${version.key}
            .selected=${version.key === file.key}
          >
            ${versionLabel(version, versions.length - index, index === 0)}
          </option>`,
      )}
    </select>
  </div>`;
}

const BACK_ICON = unsafeHTML(BACK);
const JUMP_ICON = unsafeHTML(JUMP);
const DOWNLOAD_ICON = unsafeHTML(FILE_DOWNLOAD_ICON);
const PREVIOUS_ICON = unsafeHTML(PREVIOUS);
const NEXT_ICON = unsafeHTML(NEXT);
const DRAW_ICON = unsafeHTML(PEN_ICON);
const TRASH_ICON = unsafeHTML(FILE_DELETE_ICON);

function markdownPreview(
  cid: string,
  file: SessionFile,
  text: string,
  element?: FilesEl,
): HTMLElement {
  const body = document.createElement("div");
  body.className = "files-markdown artifact-doc report-doc";
  const controller = new AbortController();
  if (element) element._markdownAbort = controller;
  renderDocumentMarkdown(body, text, {
    title: file.name,
    signal: controller.signal,
    agentId: cid,
    documentPath: file.source_path,
    resolveRelative: (path, image) => {
      let name: string;
      try {
        name = decodeURIComponent(
          new URL(
            path,
            new URL(file.name, "https://files.invalid/"),
          ).pathname.slice(1),
        );
      } catch {
        return null;
      }
      const sibling = versionGroups(allFiles(entry(cid))).find(
        (group) => group[0]!.name === name,
      )?.[0];
      return sibling
        ? image
          ? (imageHref(cid, sibling)?.replace(/\/preview$/, "/thumbnail") ??
            null)
          : downloadHref(cid, sibling)
        : null;
    },
  });
  return body;
}

function unavailableLabel(file: SessionFile): string | null {
  return file.unavailable === "copied"
    ? "Unavailable in copied conversation"
    : file.unavailable
      ? "File unavailable"
      : null;
}

function metaLine(file: SessionFile, extra: string[]): string {
  return [
    file.preview === "document" &&
    (!file.media_type || file.media_type === "application/octet-stream")
      ? ""
      : file.media_type || "application/octet-stream",
    file.size > 0 ? attachmentSize(file.size) : "",
    fileKindLabel(file.storage),
    ...extra,
  ]
    .filter(Boolean)
    .join(" · ");
}

function iconButton(
  label: string,
  glyph: unknown,
  onClick: (event: Event) => void,
  extraClass = "",
  disabled = false,
): TemplateResult {
  return html`<button
    class=${`icon-btn lg ${extraClass}`}
    type="button"
    aria-label=${label}
    title=${label}
    aria-disabled=${disabled ? "true" : nothing}
    @click=${(event: Event) => disabled || onClick(event)}
  >
    ${glyph}
  </button>`;
}

const backButton = (cid: string, element?: FilesEl) =>
  iconButton(
    "All files",
    BACK_ICON,
    () => {
      if (element && fileViews.has(element)) openPane(PANE_ID);
      else selectFile(cid, null);
    },
    "files-back",
  );

// Jump to the file's first source message, or find one when none is known.
async function jumpToSource(cid: string, file: SessionFile, event: Event) {
  window.dispatchEvent(
    new CustomEvent("recurse:show-chat", { cancelable: true }),
  );
  const source = file.sources.find((candidate) => candidate.offset !== null);
  if (source) return void jumpToMessage(cid, source.offset!, source.message_id);
  const button = event.currentTarget as HTMLButtonElement;
  const status = button.parentElement!.querySelector(".files-jump-status")!;
  button.disabled = true;
  status.textContent = "Finding message…";
  try {
    status.textContent = (await jumpToFile(cid, file.id!))
      ? ""
      : "Message unavailable";
  } catch {
    status.textContent = "Couldn’t find message";
  } finally {
    button.disabled = false;
  }
}

// The whole row, including thumbnail, opens the detail view.
function rowTemplate(
  cid: string,
  file: SessionFile,
  versions: SessionFile[],
): TemplateResult {
  const unavailable = unavailableLabel(file);
  const count = versions.length > 1 ? `${versions.length} versions` : "";
  return html`<article
    class="files-card"
    tabindex="-1"
    data-file-key=${file.key}
    aria-label=${file.name}
    role="listitem"
  >
    ${file.preview === "image" && !unavailable
      ? html`<span
          class="files-thumb"
          @click=${() => selectFile(cid, { key: file.key, latest: true })}
          >${previewTemplate(cid, file)}</span
        >`
      : html`<span class="files-kind" aria-hidden="true"
          >${unsafeHTML(ATTACHMENT_FILE_ICON)}</span
        >`}
    <button
      class="files-open"
      type="button"
      title=${file.name}
      aria-label=${`Open ${file.name}`}
      @click=${() => selectFile(cid, { key: file.key, latest: true })}
    >
      <span class="files-name">${file.name}</span>
      <span class="files-meta"
        >${metaLine(file, [count, unavailable ?? ""])}</span
      >
    </button>
  </article>`;
}

// The detail view: one header row (back, name, actions) and one row with
// previous/next and metadata over a preview that fills the rest of the pane.
function detailTemplate(
  element: FilesEl,
  cid: string,
  file: SessionFile,
  versions: SessionFile[],
  position: { index: number; total: number },
): TemplateResult {
  const href = downloadHref(cid, file);
  const unavailable = unavailableLabel(file);
  const jump =
    file.sources.some((source) => source.offset !== null) ||
    (!file.sources.length && file.id && !unavailable);
  const references = file.references > 1 ? `${file.references} references` : "";
  renderPowerbarControls(
    element,
    html`<header class="files-detail-head">
      ${backButton(cid, element)}
      <div class="files-detail-title">
        <h3 class="files-name" title=${file.name}>${file.name}</h3>
        ${versions.length > 1
          ? html`<details class="pane-powerbar-overflow">
              <summary aria-label="File options" title="File options">
                ${unsafeHTML(MORE_ICON)}
              </summary>
              <div class="menu form pane-powerbar-menu">
                ${versionMenu(element, cid, file, versions)}
              </div>
            </details>`
          : nothing}
      </div>
      <div class="files-actions">
        <span class="files-jump-status" role="status"></span>
        ${imageHref(cid, file) && !unavailable
          ? iconButton(
              "Draw",
              DRAW_ICON,
              () => drawOn(detailImage(element)),
              "files-draw",
            )
          : nothing}
        ${jump
          ? iconButton("Jump to message", JUMP_ICON, (event) =>
              jumpToSource(cid, file, event),
            )
          : nothing}
        ${href
          ? html`<a
              class="icon-btn lg"
              href=${href}
              download=${file.name}
              data-bytes=${file.size}
              aria-label="Download"
              title="Download"
              >${DOWNLOAD_ICON}</a
            >`
          : nothing}
        ${downloadHref(cid, file)
          ? iconButton("Delete", TRASH_ICON, () => void deleteFile(cid, file))
          : nothing}
      </div>
    </header>`,
    true,
  );
  return html`<article
      class="files-detail"
      data-file-key=${file.key}
      aria-label=${file.name}
    >
      <div class="files-detail-bar">
        ${position.total > 1
          ? html`<div class="files-nav">
              ${iconButton(
                "Previous file",
                PREVIOUS_ICON,
                () => stepFile(cid, -1, element),
                "files-previous",
                position.index === 0,
              )}
              <span class="files-position"
                >${position.index + 1} of ${position.total}</span
              >
              ${iconButton(
                "Next file",
                NEXT_ICON,
                () => stepFile(cid, 1, element),
                "files-next",
                position.index === position.total - 1,
              )}
            </div>`
          : nothing}
        <span class="files-meta">${metaLine(file, [references])}</span>
      </div>
      ${unavailable
        ? html`<div class="files-unavailable" role="status">
            ${unavailable}
          </div>`
        : previewTemplate(cid, file, true, element)}
    </article>
    <div class="report-comments"></div>
    <div class="report-bar"></div>`;
}

// Spec: A shown text preview takes selection comments exactly like an Artifact
// version: staged in the comment bar, submitted to this conversation.
function syncComments(element: FilesEl, cid: string, file: SessionFile | null) {
  syncSelectionDraft();
  const pending = file && diffPending(cache.get(cid)?.previews.get(file.key));
  if (pending)
    void pending.then(() => {
      if ((paneEl === element && shownId === cid) || fileViews.has(element))
        repaint();
    });
  const doc = file?.id && element.querySelector(".report-doc") ? file : null;
  // Invariant: Mutated in place: an in-flight send clears the flags on the
  // object it started with.
  element._rs ??= {
    deleting: false,
    sending: false,
    sendFailed: false,
    sendSeq: 0,
    agentId: cid,
    selId: null,
    contentInfo: null,
  };
  Object.assign(element._rs, {
    agentId: cid,
    selId: doc?.id ?? null,
    contentInfo: doc
      ? { noun: "file", id: doc.id!, title: doc.name, version: doc.key }
      : null,
  });
  const pane = element as CommentPane;
  if (!doc) {
    if (commentMount.current === pane) commentMount.current = null;
    return;
  }
  claimComments(pane);
  reanchor(pane, doc.id!);
  renderComments(pane);
}

function observePreviews(element: FilesEl, id: string): void {
  element._filesObserver?.disconnect();
  const observer = new IntersectionObserver(
    (entries) => {
      if (
        id !== state.selectedId ||
        (element !== paneEl &&
          element !== popout?.body &&
          !fileViews.has(element))
      )
        return;
      for (const observation of entries) {
        if (!observation.isIntersecting) continue;
        const target = observation.target as HTMLElement;
        if (target.dataset.filesText) {
          const file = visibleFiles(entry(id)).get(target.dataset.filesText);
          if (file) loadTextPreview(id, file);
        }
        observer.unobserve(target);
      }
    },
    { root: element, rootMargin: "160px 0px" },
  );
  element._filesObserver = observer;
  for (const target of element.querySelectorAll<HTMLElement>(
    "[data-files-text]",
  ))
    observer.observe(target);
}

function fileErrorBanner(
  id: string,
  value: CacheEntry,
  fileKey?: string,
): unknown {
  if (fileKey && value.failedDeletion?.key !== fileKey) return nothing;
  return value.failedDeletion || value.error || value.notice
    ? html`<div class="files-error" role="alert">
        ${value.failedDeletion
          ? `Couldn’t delete ${value.failedDeletion.name}.`
          : value.error || value.notice}
        ${value.notice && !value.error && !value.failedDeletion
          ? nothing
          : html`<button
              class="btn sm"
              type="button"
              @click=${async () => {
                if (value.failedDeletion)
                  void deleteFile(id, value.failedDeletion);
                else {
                  value.error = null;
                  await loadPage(id);
                  const selection = selections.get(id);
                  if (
                    !phone.matches &&
                    state.selectedId === id &&
                    selection &&
                    "id" in selection &&
                    selection.id
                  )
                    await showFileInPane(id, selection.id);
                }
              }}
            >
              Retry
            </button>`}
      </div>`
    : nothing;
}

function renderPane(element: FilesEl, id: string): void {
  const value = entry(id);
  const all = allFiles(value);
  const groups = versionGroups(all);
  const files = groups.map((group) => group[0]!);
  const query = coarsePointer.matches ? "" : value.filter.trim().toLowerCase();
  const matching = groups.filter((group) =>
    group[0]!.name.toLowerCase().includes(query),
  );
  const selection = selections.get(id) ?? null;
  let shown = selection ? selectedFile(all, selection) : null;
  if (shown && selection?.latest)
    shown = groups.find((group) => group.includes(shown!))![0]!;
  // Invariant: A list click names a loaded row; a reply attachment may name one
  // whose row is still loading. Once loading finishes without it, show the
  // list.
  if (selection && !shown && value.complete) selections.delete(id);
  const hash = JSON.stringify({
    id,
    shown: shown?.key ?? (selections.has(id) ? "pending" : null),
    initialized: value.initialized,
    complete: value.complete,
    capped: value.capped,
    inflight: value.inflight,
    error: value.error,
    notice: value.notice,
    failedDeletion: value.failedDeletion?.key,
    filter: value.filter,
    query,
    files: all.map((file) => [
      file.key,
      file.references,
      file.sources.map((source) => [source.offset, source.message_id]),
      value.previews.get(file.key)?.status,
      value.previews.get(file.key)?.truncated,
    ]),
  });
  // Invariant: Another pane may have taken selection comments since the last
  // paint, so an unchanged view still reclaims them.
  if (element._filesHash === hash)
    return syncComments(element, id, selections.has(id) ? shown : null);
  element._filesHash = hash;
  element._markdownAbort?.abort();
  if (!shown) renderPowerbarControls(element, nothing);
  const status = !value.initialized
    ? html`<div class="files-state" role="status">Loading files…</div>`
    : !files.length && value.complete
      ? html`<div class="files-state">No files in this conversation.</div>`
      : query && !matching.length
        ? html`<div class="files-state" role="status">No matching files.</div>`
        : nothing;
  const errorBanner = fileErrorBanner(id, value);
  if (selections.has(id)) {
    render(
      shown
        ? html`${errorBanner}${detailTemplate(
            element,
            id,
            shown,
            groups.find((group) => group.includes(shown)) ?? [shown],
            {
              index:
                groups.length -
                1 -
                groups.findIndex((group) => group.includes(shown)),
              total: groups.length,
            },
          )}`
        : value.error
          ? html`${backButton(id)}${errorBanner}`
          : html`<div class="files-state" role="status">Loading file…</div>`,
      element,
    );
    syncDocuments(element);
    releasePdfs();
    for (const view of element.querySelectorAll<HTMLElement>(
      "[data-files-pdf]",
    ))
      mountPdf(view, view.dataset.filesPdf!);
    syncDraw();
    syncComments(element, id, shown);
    requestAnimationFrame(() => {
      if (shownId === id) observePreviews(element, id);
    });
    return;
  }
  syncComments(element, id, null);
  render(
    html`<div
        class="files-summary"
        role="status"
        aria-live="polite"
        tabindex="-1"
      >
        ${value.initialized
          ? `${matching.length === files.length ? "" : `${matching.length} of `}${files.length}${value.complete && !value.capped ? "" : "+"} file${files.length === 1 ? "" : "s"}`
          : "Loading files…"}
      </div>
      ${files.length
        ? html`<div class="files-filter-bar">
            <input
              class="files-filter"
              type="search"
              aria-label="Filter files"
              placeholder="Filter files"
              .value=${value.filter}
              @input=${(event: Event) => {
                value.filter = (event.currentTarget as HTMLInputElement).value;
                repaint();
              }}
            />
            <span class="files-navigation-status" role="status"></span>
          </div>`
        : nothing}
      ${errorBanner} ${status}
      ${value.capped
        ? html`<div class="files-error" role="status">
            Some files could not be listed.
          </div>`
        : nothing}
      ${matching.length
        ? html`<div class="files-grid" role="list">
            ${repeat(
              matching,
              (group) => group[0]!.key,
              (group) => rowTemplate(id, group[0]!, group),
            )}
          </div>`
        : nothing}
      ${value.initialized && !value.complete && !value.inflight && !value.error
        ? html`<button
            class="btn sm files-load-more"
            type="button"
            @click=${() => void loadPage(id)}
          >
            Load older files
          </button>`
        : nothing}`,
    element,
  );
  syncDocuments();
  releasePdfs();
  requestAnimationFrame(() => {
    if (shownId === id) observePreviews(element, id);
  });
}

function update(element: FilesEl, ctx: PaneContext, opened = false): void {
  const id = ctx.agentId;
  const value = entry(id);
  const version = conversationVersion(ctx);
  const running = ctx.conv?.status === "running";
  const changed = value.conversationVersion !== version;
  // Invariant: A change throttled away while running is still owed: the settle
  // poll consumes it, so a fast turn never slips through between polls.
  if (changed && running) value.refreshPending = true;
  const refresh =
    !document.hidden &&
    version !== null &&
    (opened ||
      shownId !== id ||
      (!value.inflight &&
        filesRefreshDue(
          running,
          changed || value.refreshPending,
          value.lastRefresh,
          performance.now(),
        )));
  if (refresh) {
    if (value.initialized)
      revalidate(value, ctx.conv?.message_log_generation ?? null);
    value.conversationVersion = version;
    value.refreshPending = false;
  }
  if (shownId !== id) {
    if (shownId) abandon(entry(shownId));
    shownId = id;
  }
  paneEl = element;
  if (!element._filesSwipe) {
    element._filesSwipe = true;
    installSwipe(element);
    installBoxComments(element);
    element.addEventListener("recurse:pdf-pages", repaint);
  }
  renderPane(element, id);
  if (!document.hidden && (!value.initialized || refresh)) void loadPage(id);
}

function renderFile(element: FilesEl, cid: string, file: SessionFile): void {
  const value = entry(cid);
  const preview = value.previews.get(file.key);
  const groups = versionGroups(allFiles(value));
  const versions = groups.find((group) =>
    group.some((item) => item.key === file.key),
  ) ?? [file];
  const position = {
    index: Math.max(0, groups.length - 1 - groups.indexOf(versions)),
    total: groups.length,
  };
  const hash = JSON.stringify([
    cid,
    file.key,
    preview?.status,
    preview?.truncated,
    versions.map((item) => item.key),
    position,
  ]);
  if (
    element._filesHash !== hash &&
    !(
      (preview?.status === "evicted" || !preview) &&
      element.querySelector(".files-detail .report-doc")
    )
  ) {
    element._filesHash = hash;
    element._markdownAbort?.abort();
    render(
      html`<div class="files-errors"></div>
        ${detailTemplate(element, cid, file, versions, position)}`,
      element,
    );
  }
  render(
    fileErrorBanner(cid, value, file.key),
    element.querySelector<HTMLElement>(".files-errors")!,
  );
  syncDocuments(element);
  releasePdfs();
  for (const pdf of element.querySelectorAll<HTMLElement>("[data-files-pdf]"))
    mountPdf(pdf, pdf.dataset.filesPdf!);
  syncComments(element, cid, file);
  syncDraw();
  observePreviews(element, cid);
}

function navigateFiles(element: HTMLElement, command: PaneNavigation): boolean {
  const view = fileViews.get(element as FilesEl);
  const id = view?.cid ?? shownId;
  if (!id) return false;
  const detail = !!view || selections.has(id);
  if (command === "back" || command === "filter") {
    if (view) openPane(PANE_ID);
    else if (detail) selectFile(id, null);
    if (command === "filter")
      (view ? paneEl : element)
        ?.querySelector<HTMLInputElement>(".files-filter")
        ?.focus();
    return true;
  }
  if (command === "half-down" || command === "half-up") return false;
  if (
    detail &&
    (command === "previous-section" || command === "next-section")
  ) {
    stepFile(id, command === "previous-section" ? -1 : 1, element as FilesEl);
    return true;
  }
  if (detail && command !== "copy") return false;
  const item =
    element.querySelector<HTMLElement>(".files-detail") ??
    paneItem(element, ".files-card", command);
  if (!item) return false;
  if (command === "open")
    item.querySelector<HTMLButtonElement>(".files-open")?.click();
  if (command === "copy") {
    const file =
      view?.file ?? visibleFiles(entry(id)).get(item.dataset.fileKey!);
    if (!file) return true;
    const href = downloadHref(id, file);
    const focus = document.activeElement as HTMLElement | null;
    void copyText(href ? new URL(href, location.href).href : file.name).then(
      (copied) => {
        if (state.selectedId !== id || !element.isConnected) return;
        const status =
          panePowerbar(element).querySelector(".files-jump-status") ??
          element.querySelector(".files-navigation-status");
        if (status)
          status.textContent = copied
            ? href
              ? "Link copied."
              : "Filename copied."
            : "Could not copy. Select and copy the filename.";
        if (focus?.isConnected && document.activeElement === document.body)
          focus.focus({ preventScroll: true });
      },
    );
  }
  return command !== "top" && command !== "bottom";
}

registerFileTabSource("files", (key, id) => {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== 2 ||
    JSON.stringify(parts) !== key
  )
    return null;
  const [cid, fileKey] = parts;
  if (
    typeof cid !== "string" ||
    !cid ||
    cid.length > 1024 ||
    /[\x00-\x1f]/.test(cid) ||
    typeof fileKey !== "string" ||
    /[\x00-\x1f]/.test(fileKey) ||
    !/^(?:published:[0-9a-f]{32}|upload:[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?)$/.test(
      fileKey,
    )
  )
    return null;
  let attempt: { cancelled: boolean; file?: SessionFile | null } | undefined;
  const release = () => {
    if (attempt) attempt.cancelled = true;
    attempt = undefined;
  };
  const pane = {
    id,
    title: "File",
    icon: ATTACHMENT_FILE_ICON,
    release,
    guardClose: (element: HTMLElement) =>
      !(element as FilesEl)._rs || discardCurrent(element as CommentPane),
    visit(agentId: string) {
      if (agentId === cid) return;
      release();
      const value = cache.get(cid);
      if (value) {
        abandon(value);
        value.refreshPending = true;
      }
    },
    prepare(seed: unknown) {
      const value = seed as { cid: string; file: SessionFile };
      if (value?.cid !== cid || value.file?.key !== fileKey) return;
      release();
      attempt = { cancelled: false, file: value.file };
      pane.title = value.file.name;
    },
    available(ctx: PaneContext) {
      if (ctx.agentId !== cid || !ctx.node) return false;
      const inline = selections.get(cid);
      if (
        inline &&
        selectedFile(allFiles(entry(cid)), inline)?.key === fileKey &&
        pendingFor(commentKey(cid, fileKey.slice(fileKey.indexOf(":") + 1)))
      )
        return false;
      if (!attempt) {
        const pending = { cancelled: false } as {
          cancelled: boolean;
          file?: SessionFile | null;
        };
        attempt = pending;
        void (async () => {
          const value = entry(cid);
          // Invariant: Visits may end before collection probes run.
          if (value.refreshPending) {
            value.refreshPending = false;
            if (!value.inflight) revalidate(value, value.generation);
          }
          while (!pending.cancelled && state.selectedId === cid) {
            const file = value.files.get(fileKey);
            if (file || value.complete || value.error) {
              pending.file = file && !file.unavailable ? file : null;
              if (pending.file) pane.title = pending.file.name;
              break;
            }
            await loadPage(cid);
          }
          if (attempt === pending && !pending.cancelled) syncPanes();
        })();
      }
      return attempt.file === undefined
        ? undefined
        : !!attempt.file && !attempt.file.unavailable;
    },
    render(element: HTMLElement) {
      const file = attempt?.file;
      if (!file) return;
      const body = element as FilesEl;
      const view = { cid, file };
      fileViews.set(body, view);
      retainedViews.set(body, view);
      body.classList.add("files-view");
      installBoxComments(body);
      installSwipe(body, (delta) => stepFile(cid, delta, body));
      body.addEventListener("recurse:pdf-pages", repaint);
      renderFile(body, cid, file);
    },
    refresh(element: HTMLElement) {
      const view = fileViews.get(element as FilesEl);
      if (view) renderFile(element as FilesEl, cid, view.file);
    },
    navigate: navigateFiles,
    leave(element: HTMLElement) {
      const body = element as FilesEl;
      fileViews.delete(body);
      body._filesObserver?.disconnect();
      const preview = cache.get(cid)?.previews.get(fileKey);
      preview?.controller?.abort();
      if (preview?.status === "loading") preview.status = "idle";
      if (commentMount.current === body) commentMount.current = null;
    },
    cache: {
      version: 1,
      key() {
        const scope = commentKey(cid, fileKey.slice(fileKey.indexOf(":") + 1));
        return scope && comments.get(scope)?.size ? cid : null;
      },
      resume(element: HTMLElement) {
        const body = element as FilesEl;
        const view = retainedViews.get(body);
        if (view) {
          fileViews.set(body, view);
          renderFile(body, cid, view.file);
        }
      },
      dispose(element: HTMLElement) {
        const body = element as FilesEl;
        body._filesObserver?.disconnect();
        body._markdownAbort?.abort();
        documentViews?.releaseDocuments(body);
        releasePdfs(body);
        retainedViews.delete(body);
      },
    },
  };
  return pane;
});

registerPane({
  id: PANE_ID,
  title: "Files",
  icon: FILES_ICON,
  finder: {
    kind: "file",
    items() {
      const cid = state.selectedId;
      const value = cache.get(cid);
      return (value ? allFiles(value) : [])
        .filter((file) => !file.unavailable)
        .map((file) => ({
          key: file.key,
          name: file.name,
          open: () => selectFile(cid, { key: file.key }),
        }));
    },
  },
  available,
  visit: (agentId) => settledTurnFile.beginVisit(agentId),
  autoOpenGeneration,
  autoOpened(ctx) {
    const id = settledTurnFile.current(ctx.agentId);
    if (id) {
      if (phone.matches) selections.set(ctx.agentId, { id, latest: true });
      else void showFileInPane(ctx.agentId, id, false);
    }
  },
  badge,
  navigate: navigateFiles,
  cache: {
    version: 1,
    key: (ctx) => ctx.agentId,
    resume(element, ctx) {
      update(element as FilesEl, ctx, true);
    },
    dispose(element) {
      const files = element as FilesEl;
      files._filesObserver?.disconnect();
      files._markdownAbort?.abort();
      documentViews?.releaseDocuments(files);
      releasePdfs(files);
      if (paneEl === element) paneEl = null;
      if (commentMount.current === element) commentMount.current = null;
    },
  },
  render(element, ctx) {
    update(element as FilesEl, ctx, true);
  },
  refresh(element, ctx) {
    update(element as FilesEl, ctx);
  },
});
