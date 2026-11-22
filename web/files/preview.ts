// Render each file kind and manage lazy previews and viewer resources.
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { canDraw, installImageZoom } from "../image-preview/index.js";
import { openFileTab } from "../panes.js";
import { mountPdf, releasePdfs } from "../pdf-view.js";
import { state } from "../state.js";
import {
  allFiles,
  cachedEntry,
  downloadHref,
  entry,
  imageHref,
  loadTextPreview,
  mediaHref,
  reloadPreview,
  textPreviewHref,
  visibleFiles,
} from "./collection.js";
import { diffPreview, isDiff } from "./diff-preview.js";
import { changesStamp, filesMarkdown } from "./markdown.js";
import { rendersAsMarkdown, type SessionFile } from "./model.js";

export interface FilePreviewElement extends HTMLElement {
  _filesObserver?: IntersectionObserver;
  _markdownAbort?: AbortController;
}

interface PreviewHooks {
  changed(): void;
  imageLoaded(element: FilePreviewElement): void;
  isActive(element: FilePreviewElement): boolean;
}

let hooks: PreviewHooks;

export function configureFilePreviews(options: PreviewHooks): void {
  hooks = options;
}

export function detailImage(element: HTMLElement): HTMLImageElement | null {
  return element.querySelector<HTMLImageElement>(".files-detail img");
}

export function syncDrawButton(
  element: HTMLElement,
  controls: HTMLElement,
): void {
  const draw = controls.querySelector(".files-draw");
  if (canDraw(detailImage(element))) draw?.removeAttribute("aria-disabled");
  else draw?.setAttribute("aria-disabled", "true");
}

export function iconButton(
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

export function previewTemplate(
  cid: string,
  file: SessionFile,
  detail = false,
  element?: FilePreviewElement,
): unknown {
  const image = imageHref(cid, file);
  const preview = cachedEntry(cid)?.previews.get(file.key);
  if (image) {
    // Invariant: The list shows the thread-sized thumbnail; detail views load
    // the original, which box comments, crops and drawing measure.
    const img = html`<img
      class="files-image"
      alt=${file.name}
      src=${detail ? image : image.replace(/\/preview$/, "/thumbnail")}
      loading=${detail ? "eager" : "lazy"}
      decoding="async"
      referrerpolicy="no-referrer"
      @load=${(event: Event) => {
        if (detail) {
          const image = event.target as HTMLImageElement;
          if (element?.contains(image) && hooks.isActive(element))
            hooks.imageLoaded(element);
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
            : html`<pre class="report-doc files-source">${preview.text}</pre>`}
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

const markdownSource = (cid: string) => ({
  files: allFiles(entry(cid)),
  previews: entry(cid).previews,
  load: (file: SessionFile) => {
    const preview = entry(cid).previews.get(file.key);
    if (preview?.status === "evicted") preview.status = "idle";
    loadTextPreview(cid, file);
  },
  refresh: hooks.changed,
});

function markdownPreview(
  cid: string,
  file: SessionFile,
  text: string,
  element?: FilePreviewElement,
): TemplateResult {
  const controller = new AbortController();
  if (element) element._markdownAbort = controller;
  return filesMarkdown(cid, file, text, controller.signal, {
    ...markdownSource(cid),
    href: (sibling, image) =>
      image
        ? (imageHref(cid, sibling)?.replace(/\/preview$/, "/thumbnail") ?? null)
        : downloadHref(cid, sibling),
    open: (sibling, fragment) =>
      openFileTab("files", JSON.stringify([cid, sibling.key]), {
        cid,
        file: sibling,
        fragment,
      }),
  });
}

export function previewChangesStamp(cid: string, file: SessionFile) {
  return changesStamp(cid, file, markdownSource(cid));
}

let documentViews: typeof import("../document-preview.js") | null = null;

function syncDocuments(root: Element): void {
  documentViews?.releaseDocuments();
  for (const view of root.querySelectorAll<HTMLElement>(
    "[data-files-document]",
  )) {
    void import("../document-preview.js").then((module) => {
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

export function mountViewers(root: Element): void {
  syncDocuments(root);
  releasePdfs();
  for (const pdf of root.querySelectorAll<HTMLElement>("[data-files-pdf]"))
    mountPdf(pdf, pdf.dataset.filesPdf!);
}

/** Dispose a view's resources, or prune only disconnected documents and PDFs. */
export function releaseViewers(root?: FilePreviewElement): void {
  root?._filesObserver?.disconnect();
  root?._markdownAbort?.abort();
  documentViews?.releaseDocuments(root);
  releasePdfs(root);
}

export function observePreviews(element: FilePreviewElement, id: string): void {
  element._filesObserver?.disconnect();
  const observer = new IntersectionObserver(
    (entries) => {
      if (id !== state.selectedId || !hooks.isActive(element)) return;
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
