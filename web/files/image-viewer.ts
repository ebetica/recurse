// Image dialogs own their history entry, gallery and original sharing.
import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
  CLOSE_ICON,
  FILE_DOWNLOAD_ICON,
  FILES_ICON,
  NEXT_ICON,
  PEN_ICON,
  PREVIOUS_ICON,
} from "../icons.js";
import { scrollToLatest } from "../conversation/index.js";
import { popImageVisitHistory } from "../phone-nav.js";
import { state } from "../state.js";
import { installBoxComments } from "../comments/box/index.js";
import { commentMount } from "../comments/selection-draft/index.js";
import {
  cancelSelectionComment,
  closeSelectionCommentFromKeyboard,
  handleCommentShortcut,
} from "../artifacts/index.js";
import {
  closeDrawingEditor,
  closeDrawingFromKeyboard,
  drawOn,
  drawingEditorOpen,
  installImageCommentLayout,
  installReferenceImageViewer,
} from "../image-preview/index.js";
import {
  allFiles,
  attachmentFile,
  downloadHref,
  entry,
  imageHref,
  subscribeFilesCollection,
} from "./collection.js";
import { syncComments, type FileCommentElement } from "./comments.js";
import { versionGroups, type SessionFile } from "./model.js";
import {
  detailImage,
  iconButton,
  previewTemplate,
  syncDrawButton,
} from "./preview.js";
import { coarsePointer, installSwipe } from "./swipe.js";

const phone = matchMedia("(max-width: 700px)");

interface ImageViewerHooks {
  closed(): void;
  openInFiles(cid: string, file: SessionFile): void;
  showAttachment(cid: string, id: string): Promise<void>;
}

let hooks: ImageViewerHooks;

export function configureImageViewer(options: ImageViewerHooks): void {
  hooks = options;
  installReferenceImageViewer(
    () => state.selectedId,
    openImage,
    enlargeFileImage,
  );
}

let popout: {
  dialog: HTMLDialogElement;
  body: FileCommentElement;
  cid: string;
  file: SessionFile;
  focus: HTMLElement | null;
  closeLayout: () => void;
} | null = null;

function closeImage(popHistory = () => history.back()): void {
  if (!popout) return;
  const { dialog, body, focus, closeLayout } = popout;
  closeLayout();
  closeDrawingEditor();
  popout = null;
  cancelSelectionComment(body);
  if (commentMount.current === body) commentMount.current = null;
  dialog.close();
  dialog.remove();
  focus?.focus({ preventScroll: true });
  if (history.state?.imagePopout) popHistory();
  hooks.closed();
}

/** Escape on the open image viewer: closes it and reports that it did. */
export function closeImageFromKeyboard(): boolean {
  if (!popout) return false;
  closeImage();
  return true;
}

/** Close the active layer of the image viewer on Escape. */
export function handleImageEscape(): void {
  if (!popout) return;
  if (
    !closeDrawingFromKeyboard() &&
    !closeSelectionCommentFromKeyboard(popout.body)
  )
    closeImage();
}

window.addEventListener("popstate", () => {
  if (popout && drawingEditorOpen()) {
    history.pushState({ ...history.state, imagePopout: true }, "");
    closeDrawingFromKeyboard();
  } else closeImage();
});

export function openImage(cid: string, file: SessionFile): void {
  const opening = !popout;
  if (!popout) {
    const dialog = document.createElement("dialog");
    dialog.className = "image-popout";
    dialog.setAttribute("aria-label", "Image viewer");
    const body = document.createElement("div") as FileCommentElement;
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
      handleImageEscape();
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
    dialog.addEventListener("click", (event) => {
      if (outside && (phone.matches || event.detail < 2)) closeImage();
      outside = null;
    });
    installBoxComments(body);
    body.addEventListener("comments-submitting", () => {
      if (popout?.body !== body) return;
      closeImage();
      scrollToLatest();
    });
    installSwipe(body, stepImage);
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

export function stepImage(delta: -1 | 1): boolean {
  if (!popout) return false;
  const groups = imageGroups(popout.cid, popout.file);
  const index = groups.findIndex((group) =>
    group.some((file) => file.key === popout!.file.key),
  );
  const next = groups[index + delta]?.[0];
  if (next) openImage(popout.cid, next);
  return true;
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
                unsafeHTML(PREVIOUS_ICON),
                () => stepImage(-1),
                "",
                index <= 0,
              )}
              <span class="files-position"
                >${index + 1} of ${groups.length}</span
              >
              ${iconButton(
                "Next image",
                unsafeHTML(NEXT_ICON),
                () => stepImage(1),
                "",
                index === groups.length - 1,
              )}`
          : nothing}
        ${downloadHref(cid, file)
          ? iconButton(
              "Download",
              unsafeHTML(FILE_DOWNLOAD_ICON),
              () => void downloadImage(cid, file),
            )
          : nothing}
        ${iconButton(
          "Draw",
          unsafeHTML(PEN_ICON),
          () => drawOn(detailImage(body), closeImage),
          "files-draw",
        )}
        ${file.image_url
          ? nothing
          : iconButton("Open in Files", unsafeHTML(FILES_ICON), () => {
              const open = () => hooks.openInFiles(cid, file);
              if (history.state?.imagePopout) {
                window.addEventListener("popstate", open, { once: true });
                closeImage();
              } else {
                closeImage();
                open();
              }
            })}
        ${iconButton("Close image", unsafeHTML(CLOSE_ICON), () => closeImage())}
      </header>
      <article
        class="files-detail"
        data-file-key=${file.key}
        aria-label=${file.name}
      >
        ${previewTemplate(cid, file, true, body)}
      </article>
      <aside class="image-comment-sidebar" aria-label="Image comments">
        <h2 class="image-comment-heading">Comments</h2>
        <div class="report-comments"></div>
        <div class="report-bar"></div>
      </aside>`,
    body,
  );
  syncComments(body, cid, file);
  syncDrawButton(body, body);
}

export function isImageViewer(element: HTMLElement): boolean {
  return element === popout?.body;
}

export function visitImageViewer(cid: string): void {
  if (popout && popout.cid !== cid) closeImage(popImageVisitHistory);
}

subscribeFilesCollection(() => {
  visitImageViewer(state.selectedId);
  renderImage();
});

document.addEventListener("recurse:attachment-availability", () => {
  if (popout) syncDrawButton(popout.body, popout.body);
});

/** Enlarge an image without changing the Files tab selection. */
export async function enlargeFileImage(cid: string, id: string): Promise<void> {
  const file = await attachmentFile(cid, id);
  if (file && imageHref(cid, file)) openImage(cid, file);
  else if (cid === state.selectedId) await hooks.showAttachment(cid, id);
}

async function downloadImage(cid: string, file: SessionFile): Promise<void> {
  const href = downloadHref(cid, file);
  if (!href) return;
  if (coarsePointer.matches && navigator.share && navigator.canShare) {
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
