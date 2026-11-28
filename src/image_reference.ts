// Classify Markdown image sources before resolving any local file path.
const FLAT_ATTACHMENT = /^\/api\/attachments\/[A-Za-z0-9._-]+$/;
const SCOPED_ATTACHMENT =
  /^\/api\/conversations\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/attachments\/[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/;

export const isFlatAttachmentUrl = (source: string) =>
  !source.includes("..") && FLAT_ATTACHMENT.test(source);
export const isScopedAttachmentUrl = (source: string) =>
  !source.includes("..") && SCOPED_ATTACHMENT.test(source);

export function localImagePath(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  // Invariant: Like the Markdown sanitizer, classify the scheme without
  // attribute whitespace. Keep whitespace in the actual filename.
  const uri = trimmed.replace(/[\s\x00-\x20\u180e]/g, "");
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(uri)) return null;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return null;
  }
}
