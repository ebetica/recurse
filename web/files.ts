// Viewers navigate oldest-first; desktop keys share list cursors and scrolling.
import { html, nothing, render, type TemplateResult } from "lit";
import { isTextEditorTarget } from "../src/keyboard_target.js";
import {
  ATTACHMENT_FILE_ICON,
  BACK_ICON as BACK,
  FILE_DELETE_ICON,
  FILE_DOWNLOAD_ICON,
  FILES_ICON,
  JUMP_ICON as JUMP,
  MORE_ICON,
  NEXT_ICON as NEXT,
  PEN_ICON,
  PREVIOUS_ICON as PREVIOUS,
} from "./icons.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { attachmentSize } from "./agent-attachments.js";
import { jumpToFile, jumpToMessage } from "./conversation/navigation.js";
import { drawOn } from "./image-preview/index.js";
import { state } from "./state.js";
import { installBoxComments } from "./comments/box/index.js";
import { commentMount } from "./comments/selection-draft/index.js";
import {
  closeSelectionCommentFromKeyboard,
  commentKey,
  comments,
  discardCurrent,
  pendingFor,
  reanchor,
  type CommentPane,
} from "./artifacts/index.js";
import {
  openFileTab,
  openPane,
  registerPane,
  replaceFileTab,
  syncPanes,
} from "./panes.js";
import { decodeFileTabKey, registerFileTabSource } from "./panes/index.js";
import { panePowerbar, renderPowerbarControls } from "./panes/powerbar.js";
import { paneItem } from "./panes/navigation.js";
import { copyText } from "./tool_details.js";
import { scrollDocumentFragment } from "./document-markdown.js";
import { noteReviewed } from "./files/markdown.js";
import {
  abandon,
  allFiles,
  attachmentFile,
  available,
  badge,
  cachedEntry,
  coarsePointer,
  configureFileComments,
  configureFilePreviews,
  configureFilesCollection,
  configureImageViewer,
  deleteFile,
  detailImage,
  downloadHref,
  entry,
  iconButton,
  imageHref,
  installSwipe,
  isImageViewer,
  loadPage,
  mountViewers,
  observePreviews,
  openImage,
  PANE_ID,
  previewChangesStamp,
  previewTemplate,
  refreshCollection,
  releaseViewers,
  revalidate,
  scheduleFetch,
  stepImage,
  syncComments,
  syncDrawButton,
  visibleFiles,
  visitImageViewer,
  type CacheEntry,
  type FileCommentElement,
  type FilePreviewElement,
} from "./files/index.js";
import {
  fileKindLabel,
  fileTypeLabel,
  selectedFile,
  SettledTurnFile,
  versionGroups,
  versionLabel,
  type FileSelection,
  type SessionFile,
} from "./files/model.js";
import type { PaneContext, PaneNavigation, Turn } from "./types.js";

export {
  closeImageFromKeyboard,
  enlargeFileImage,
  handleImageEscape,
  invalidateFiles,
} from "./files/index.js";

const phone = matchMedia("(max-width: 700px)");

interface FilesEl extends FilePreviewElement, FileCommentElement {
  _filesHash?: string;
  _filesSwipe?: boolean;
}

// The file whose detail view replaces the list, per conversation.
const selections = new Map<string, FileSelection>();
let paneEl: FilesEl | null = null;
let shownId: string | null = null;
interface FileView {
  cid: string;
  file: SessionFile;
}
const fileViews = new Map<FilesEl, FileView>();
const retainedViews = new WeakMap<FilesEl, FileView>();
const settledTurnFile = new SettledTurnFile();
let autoOpenProbe: string | null = null;
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
  if (paneOpen(ctx.agentId)) return undefined;
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
  if (paneOpen(cid)) {
    paneEl!._filesHash = undefined;
    repaint();
  }
  openPane(PANE_ID);
}

function annotatedInlineFile(
  cid: string,
  files?: SessionFile[],
): SessionFile | null {
  const inline = selections.get(cid);
  const file = inline && selectedFile(files ?? allFiles(entry(cid)), inline);
  return file && pendingFor(commentKey(cid, file.id ?? null)) ? file : null;
}

function selectFile(
  cid: string,
  selection: FileSelection | null,
  userInitiated = true,
  viewer = paneEl,
): void {
  const file = selection && selectedFile(allFiles(entry(cid)), selection);
  if (file && !phone.matches && file.id) {
    const value = entry(cid);
    const held = annotatedInlineFile(cid, allFiles(value));
    if (held) {
      if (held.key === file.key) {
        openPane(PANE_ID);
        return;
      }
    } else selections.delete(cid);
    if (userInitiated && viewer) closeSelectionCommentFromKeyboard(viewer);
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

function fileTabGroups(cid: string, files: SessionFile[]): SessionFile[][] {
  const inline = annotatedInlineFile(cid, files);
  return versionGroups(
    files.filter((file) => file.id && !file.unavailable && file !== inline),
  );
}

/** Navigate oldest to newest; return false at either end. */
function stepFile(cid: string, delta: -1 | 1, element?: FilesEl): boolean {
  const all = allFiles(entry(cid));
  const held = element && fileViews.get(element);
  const tab = held && !phone.matches;
  const groups = (tab ? fileTabGroups(cid, all) : versionGroups(all)).reverse();
  const selection = held ? { key: held.file.key } : selections.get(cid);
  const index = selection
    ? groups.findIndex((group) => selectedFile(group, selection))
    : -1;
  const next = index < 0 ? null : groups[index + delta]?.[0];
  if (!next) return false;
  if (tab && element) {
    const focused = [".files-previous", ".files-next"].find(
      (selector) => element.querySelector(selector) === document.activeElement,
    );
    closeSelectionCommentFromKeyboard(element);
    const body = replaceFileTab(element, JSON.stringify([cid, next.key]), {
      cid,
      file: next,
    });
    if (body && focused)
      (
        body.querySelector<HTMLButtonElement>(`${focused}:enabled`) ??
        body.querySelector<HTMLButtonElement>(".files-nav button:enabled")
      )?.focus({ preventScroll: true });
    return !!body;
  }
  if (held) selectFile(cid, { key: next.key }, true, element);
  else {
    selections.set(cid, { key: next.key, latest: true });
    repaint();
    paneEl?.scrollTo({ top: 0 });
  }
  return true;
}

function syncDrawIn(element: FilePreviewElement): void {
  syncDrawButton(
    element,
    isImageViewer(element) ? element : panePowerbar(element),
  );
}

function syncDraw(): void {
  for (const element of [paneEl, ...fileViews.keys()]) {
    if (element) syncDrawIn(element);
  }
}
document.addEventListener("recurse:attachment-availability", syncDraw);

document.addEventListener("keydown", (event) => {
  const target = event.target as Element | null;
  if (
    (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isTextEditorTarget(target)
  )
    return;
  if (stepImage(event.key === "ArrowLeft" ? -1 : 1)) {
    event.preventDefault();
    return;
  }
  if (
    !target?.closest?.(
      '.pane-col[data-pane="files"], .pane-col.file-tab:has(.files-detail)',
    )
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

function repaint(): void {
  if (paneOpen(state.selectedId)) renderPane(paneEl!, state.selectedId);
  for (const [element, view] of fileViews)
    if (element.isConnected && view.cid === state.selectedId)
      renderFile(element, view.cid, view.file);
  syncPanes();
}
coarsePointer.addEventListener("change", repaint);

function paneOpen(id: string): boolean {
  return !!paneEl?.isConnected && shownId === id;
}

configureFilesCollection({
  changed: repaint,
  paneOpen,
  detailKey: (id) =>
    shownId === id
      ? paneEl?.querySelector<HTMLElement>(".files-detail")?.dataset.fileKey
      : undefined,
});

configureFilePreviews({
  changed: repaint,
  imageLoaded: syncDrawIn,
  isActive: (element) =>
    element === paneEl || isImageViewer(element) || fileViews.has(element),
});

configureFileComments(fileViews, (element, cid) => {
  if ((paneEl === element && shownId === cid) || fileViews.has(element))
    repaint();
});

configureImageViewer({
  closed: repaint,
  showAttachment: showFileInPane,
  openInFiles(cid, file) {
    if (phone.matches) {
      selections.set(cid, { key: file.key });
      if (paneEl) paneEl._filesHash = undefined;
      repaint();
      openPane(PANE_ID);
    } else selectFile(cid, { key: file.key });
  },
});

document.addEventListener("recurse:file-deleted", (event) => {
  const { cid, key } = (event as CustomEvent<{ cid: string; key: string }>)
    .detail;
  for (const view of fileViews.values())
    if (view.cid === cid && view.file.key === key)
      view.file.unavailable = "missing";
});

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
          selectFile(cid, { key }, true, element);
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

function unavailableLabel(file: SessionFile): string | null {
  return file.unavailable === "copied"
    ? "Unavailable in copied conversation"
    : file.unavailable
      ? "File unavailable"
      : null;
}

function metaLine(file: SessionFile, extra: string[]): string {
  return [
    fileTypeLabel(file.name, file.media_type || ""),
    file.size > 0 ? attachmentSize(file.size) : "",
    fileKindLabel(file.storage),
    ...extra,
  ]
    .filter(Boolean)
    .join(" · ");
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
  noteReviewed(id, files);
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
  if (
    selection &&
    !value.inflight &&
    !value.complete &&
    !value.error &&
    !selectedFile(value.files.values(), selection)
  )
    requestAnimationFrame(() => {
      if (
        paneOpen(id) &&
        selections.get(id) === selection &&
        !selectedFile(value.files.values(), selection)
      )
        void loadPage(id);
    });
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
    changes: shown && previewChangesStamp(id, shown),
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
    mountViewers(element);
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
  releaseViewers();
  requestAnimationFrame(() => {
    if (shownId === id) observePreviews(element, id);
  });
}

function update(element: FilesEl, ctx: PaneContext, opened = false): void {
  const id = ctx.agentId;
  const value = entry(id);
  const refresh = refreshCollection(value, ctx, opened, shownId !== id);
  if (shownId !== id) {
    if (shownId) abandon(entry(shownId));
    shownId = id;
  }
  paneEl = element;
  if (!element._filesSwipe) {
    element._filesSwipe = true;
    installSwipe(element, (delta) => {
      if (shownId) stepFile(shownId, delta);
    });
    installBoxComments(element);
    element.addEventListener("recurse:pdf-pages", repaint);
  }
  renderPane(element, id);
  if (!document.hidden && (!value.initialized || refresh)) void loadPage(id);
}

function renderFile(element: FilesEl, cid: string, file: SessionFile): void {
  const value = entry(cid);
  const preview = value.previews.get(file.key);
  const all = allFiles(value);
  const groups = phone.matches ? versionGroups(all) : fileTabGroups(cid, all);
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
    previewChangesStamp(cid, file),
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
  mountViewers(element);
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
  const parts = decodeFileTabKey(key, 2, 1024);
  if (!parts) return null;
  const [cid, fileKey] = parts as [string, string];
  if (
    !/^(?:published:[0-9a-f]{32}|upload:[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?)$/.test(
      fileKey,
    )
  )
    return null;
  let fragment = "";
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
    guardClose: (element: HTMLElement, preserveComments: boolean) =>
      preserveComments ||
      !(element as FilesEl)._rs ||
      discardCurrent(element as CommentPane),
    visit(agentId: string) {
      if (agentId === cid) return;
      release();
      const value = cachedEntry(cid);
      if (value) {
        abandon(value);
        value.refreshPending = true;
      }
    },
    prepare(seed: unknown) {
      const value = seed as {
        cid: string;
        file: SessionFile;
        fragment?: string;
      };
      if (value?.cid !== cid || value.file?.key !== fileKey) return;
      fragment = value.fragment || "";
      release();
      attempt = { cancelled: false, file: value.file };
      pane.title = value.file.name;
    },
    available(ctx: PaneContext) {
      if (ctx.agentId !== cid || !ctx.node) return false;
      if (annotatedInlineFile(cid)?.key === fileKey) return false;
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
    render(element: HTMLElement, ctx: PaneContext) {
      pane.refresh(element, ctx);
    },
    refresh(element: HTMLElement, ctx: PaneContext) {
      const body = element as FilesEl;
      const file = attempt?.file;
      if (!file || ctx.agentId !== cid) {
        if (file !== undefined || !fileViews.has(body)) {
          delete body._filesHash;
          render(
            html`<div class="files-state" role="status">
              ${file === null || ctx.agentId !== cid
                ? "File unavailable."
                : "Loading file…"}
            </div>`,
            body,
          );
        }
        return;
      }
      if (!fileViews.has(body)) {
        const view = { cid, file };
        fileViews.set(body, view);
        retainedViews.set(body, view);
        body.classList.add("files-view");
        installBoxComments(body);
        installSwipe(body, (delta) => stepFile(cid, delta, body));
        body.addEventListener("recurse:pdf-pages", repaint);
      }
      renderFile(body, cid, fileViews.get(body)!.file);
      if (scrollDocumentFragment(body, fragment)) fragment = "";
    },
    navigate: navigateFiles,
    leave(element: HTMLElement) {
      const body = element as FilesEl;
      fileViews.delete(body);
      body._filesObserver?.disconnect();
      const preview = cachedEntry(cid)?.previews.get(fileKey);
      preview?.controller?.abort();
      if (preview?.status === "loading") preview.status = "idle";
      if (commentMount.current === body) commentMount.current = null;
    },
    cache: {
      version: 1,
      key() {
        const scope = commentKey(cid, fileKey.slice(fileKey.indexOf(":") + 1));
        return scope && comments.get(scope)?.size ? fileKey : null;
      },
      resume(element: HTMLElement) {
        const body = element as FilesEl;
        const view = retainedViews.get(body);
        if (view) {
          fileViews.set(body, view);
          if (view.file.id)
            reanchor(body as CommentPane, view.file.id, { pruneStale: true });
          renderFile(body, cid, view.file);
        }
      },
      dispose(element: HTMLElement) {
        const body = element as FilesEl;
        releaseViewers(body);
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
      const value = cachedEntry(cid);
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
  visit(agentId) {
    settledTurnFile.beginVisit(agentId);
    visitImageViewer(agentId);
  },
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
      releaseViewers(files);
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
