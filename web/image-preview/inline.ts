// Allows only shape-pinned same-origin uploads or validated preview routes.
// Rejects external/protocol-relative/data/script/traversal sources so authored
// Markdown cannot track users or smuggle active content past sanitization.
// Server owns admission; no tree gates. Scoped raw bytes are inert downloads.

import { responseFilename } from "../download.js";

// Block-sized, capped, lazy images bound layout and network work.
export const INLINE_IMAGE_STYLE =
  "display:block;width:auto;height:auto;max-width:100%;max-height:360px;" +
  "border:0;border-radius:0;margin:0;";

/** Wrap a vetted Markdown image with its filename, keeping its size caps. */
export function captionInlineImage(image: HTMLImageElement): void {
  image.loading = "lazy";
  image.decoding = "async";
  image.setAttribute("style", INLINE_IMAGE_STYLE);
  if (!image.alt.trim()) image.alt = "image";
  const frame = document.createElement("span");
  frame.className = "thread-image";
  const caption = document.createElement("span");
  caption.className = "image-filename";
  caption.textContent = "Image";
  image.replaceWith(frame);
  frame.append(image, caption);
}

const filenames = new Map<string, Promise<string>>();

/** Read admitted filenames without downloading the original image bytes. */
export function threadImageLoaded(event: Event): void {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  image.closest(".agent-attachment-item.image")?.classList.add("loaded");
  const caption = image
    .closest(".thread-image")
    ?.querySelector(".image-filename");
  if (!(caption instanceof HTMLElement)) return;
  const source = image.src.replace(/\/(?:thumbnail|preview)$/, "");
  const url = new URL(source);
  if (
    url.origin !== location.origin ||
    !/^\/api(?:\/backends\/[A-Za-z0-9._-]{1,32})?\/conversations\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/attachments\/[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/.test(
      url.pathname,
    )
  )
    return;
  let filename = filenames.get(source);
  if (!filename) {
    filename = fetch(source, {
      method: "HEAD",
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => (response.ok ? responseFilename(response) : ""))
      .catch(() => "");
    if (filenames.size >= 128) filenames.delete(filenames.keys().next().value!);
    filenames.set(source, filename);
  }
  void filename.then((name) => {
    if (
      !name ||
      !caption.isConnected ||
      image.src.replace(/\/(?:thumbnail|preview)$/, "") !== source
    )
      return;
    caption.textContent = name;
    caption.title = name;
  });
}

// Single-leading-slash upload path; no protocol-relative or absolute URLs.
const ATTACHMENT_URL = /^\/api\/attachments\/[A-Za-z0-9._-]+$/;

// Shape-pinned scoped raw downloads; only derived previews render inline.
const SCOPED_ATTACHMENT_URL =
  /^\/api\/conversations\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/attachments\/[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/;

export function isAllowedInlineImageSrc(
  src: string | null | undefined,
): boolean {
  if (!src || src.includes("..")) return false;
  return ATTACHMENT_URL.test(src);
}

// Download anchors for operator uploads in flat or conversation-scoped form.
// Shares the image gate's same-origin refusal; the scoped shape additionally
// pins every segment to the server's id contracts.
export function isAllowedAttachmentHref(
  href: string | null | undefined,
): boolean {
  if (!href || href.includes("..")) return false;
  return ATTACHMENT_URL.test(href) || SCOPED_ATTACHMENT_URL.test(href);
}

// Retries a failed thumbnail once as its original preview: a connected
// backend from before the /thumbnail route answers it 404. Rendered Markdown
// images (.artifact-image) retry inside their own loader.
export function thumbnailFallback(event: Event): void {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  if (image.classList.contains("artifact-image")) return;
  const src = image.getAttribute("src") ?? "";
  if (/\/attachments\/[^/]+\/thumbnail$/.test(src))
    image.src = src.replace(/\/thumbnail$/, "/preview");
}

// Derives /thumbnail only from a shape-validated scoped upload href. Raster
// bytes must be content-sniffed and manifest-matched under sandboxed CSP.
// Authored external/flat/traversal/suffixed preview shapes fail closed.
export function scopedAttachmentPreviewHref(
  href: string | null | undefined,
): string | null {
  if (!href || href.includes("..")) return null;
  if (!SCOPED_ATTACHMENT_URL.test(href)) return null;
  return `${href}/thumbnail`;
}
