// Allows only shape-pinned same-origin uploads or validated preview routes.
// Rejects external/protocol-relative/data/script/traversal sources so authored
// Markdown cannot track users or smuggle active content past sanitization.
// Server owns admission; no tree gates. Scoped raw bytes are inert downloads.

// Block-sized, capped, lazy images bound layout and network work.
export const INLINE_IMAGE_STYLE =
  "display:block;max-width:100%;max-height:360px;border-radius:10px;" +
  "border:1px solid var(--border);margin:var(--space-2) 0 0;";

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

// Derives /preview only from a shape-validated scoped upload href. Raster bytes
// must be content-sniffed and manifest-matched under sandboxed CSP. Authored
// external/flat/traversal/suffixed preview shapes fail closed.
export function scopedAttachmentPreviewHref(
  href: string | null | undefined,
): string | null {
  if (!href || href.includes("..")) return null;
  if (!SCOPED_ATTACHMENT_URL.test(href)) return null;
  return `${href}/preview`;
}
