// URL allowlist for composer image thumbnails: same-origin uploaded images
// only. Image clicks use the shared Files image pop-out (files.ts).

export interface PreviewTarget {
  url: string;
  alt: string;
}

// Allows images only after upload, using scoped validated preview capabilities.
// Raw scoped bytes are downloads; draft upload URLs serve inline images.
// Outside the pinned allowlist, previews fail closed.
export function previewTargetFor(a: {
  isImage: boolean;
  url: string | null;
  filename?: string;
}): PreviewTarget | null {
  if (!a.isImage || !a.url) return null;
  const alt = a.filename || "image";
  const scoped = /^\/api\/conversations\/[^/?#]+\/attachments\/[^/?#]+$/.exec(
    a.url,
  );
  if (scoped) return { url: `${scoped[0]}/preview`, alt };
  if (!isServedAttachmentUrl(a.url)) return null;
  return { url: a.url, alt };
}

// Preview URLs stay on the narrow authenticated routes that already served the
// thumbnail. Never admit data:, blob:, cross-origin, asset, or content URLs.
export function isServedAttachmentUrl(url: string): boolean {
  return (
    /^\/api\/attachments\/[\w.\-]+$/.test(url) ||
    /^\/api\/conversations\/[^/?#]+\/attachments\/[^/?#]+\/preview$/.test(
      url,
    ) ||
    // Invariant: Draft-staged uploads serve image bytes inline at the upload
    // URL; an <img> cannot execute active content. The rest still fail.
    /^\/api\/attachment-drafts\/[^/?#]+\/[^/?#]+$/.test(url)
  );
}
