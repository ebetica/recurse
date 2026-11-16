// Plain-text user bubbles and safe upload controls; fences stay literal code.
import { html, nothing, type TemplateResult } from "lit";
import { backendFor, homeBackend, resolveUrl } from "../backends/backend.js";
import { state } from "../state.js";
import {
  INLINE_IMAGE_STYLE,
  isAllowedAttachmentHref,
  isAllowedInlineImageSrc,
  scopedAttachmentPreviewHref,
} from "../image-preview/inline.js";

const PI_IMAGE_RESIZE_NOTE =
  /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+\.\d{2} to map to original image\.\]$/u;
const IMAGE_MARKDOWN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const WHOLE_IMAGE_MARKDOWN = /^!\[([^\]]*)\]\(([^)\s]+)\)$/u;

export interface UserBubbleImage {
  url: string;
  alt: string;
}

export interface UserBubbleFile {
  label: string;
  url: string;
}

export interface UserBubbleParts {
  text: string;
  images: UserBubbleImage[];
  files: UserBubbleFile[];
}

/** Upload controls must stay visible even when the message prose folds. */
export function hasUserAttachments(entry: { content: string }): boolean {
  const { images, files } = userBubbleParts(entry.content);
  return images.length > 0 || files.length > 0;
}

/** Remove only Pi's exact image coordinate note from operator-visible text. */
export function stripPiImageResizeNotes(content: string): string {
  return content
    .split(/\r?\n/u)
    .filter((line) => !PI_IMAGE_RESIZE_NOTE.test(line))
    .join("\n");
}

/** Split operator text into visible prose and safe upload controls. */
export function userBubbleParts(content: string): UserBubbleParts {
  const images: UserBubbleImage[] = [];
  const files: UserBubbleFile[] = [];
  const visibleLines: string[] = [];
  const lines = stripPiImageResizeNotes(content || "").split("\n");
  const imageUrl = (alt: string, url: string): string | null => {
    if (isAllowedInlineImageSrc(url)) {
      images.push({ url, alt });
      return "";
    }
    const preview = scopedAttachmentPreviewHref(url);
    if (preview) {
      images.push({ url: preview, alt });
      return "";
    }
    return null;
  };
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = /^```/.test(line.trim());
    // Invariant: Fenced code is displayed verbatim by fencedUserText. Do not
    // interpret attachment or image Markdown inside it as a browser control.
    if (inFence || fence) {
      visibleLines.push(line);
      if (fence) inFence = !inFence;
      continue;
    }
    const whole = WHOLE_IMAGE_MARKDOWN.exec(line.trim());
    if (whole && imageUrl(whole[1]!, whole[2]!) !== null) {
      while (visibleLines.at(-1)?.trim() === "") visibleLines.pop();
      while (lines[index + 1]?.trim() === "") index += 1;
      continue;
    }
    visibleLines.push(
      line
        .replace(IMAGE_MARKDOWN, (match, alt: string, url: string) => {
          return imageUrl(alt, url) ?? match;
        })
        .replace(
          /\[([^\]]*)\]\(([^)\s]+)\)/g,
          (match, label: string, url: string) => {
            if (isAllowedAttachmentHref(url)) {
              files.push({ label: label || "file", url });
              return "";
            }
            return match;
          },
        ),
    );
  }
  const text = visibleLines.join("\n");
  return { text: text.trim(), images, files };
}

function fencedUserText(text: string): TemplateResult | typeof nothing {
  if (!text) return nothing;
  const parts: Array<string | TemplateResult> = [];
  const fence = /```[^\n]*\n([\s\S]*?)\n```/g;
  let cursor = 0;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(html`<pre><code>${match[1]}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return html`${parts}`;
}

const renderingBackend = () =>
  state.currentConv ? backendFor(state.currentConv.id) : homeBackend;

export function userBubble(
  content: string,
  attachmentsOnly = false,
): TemplateResult {
  const { text, images, files } = userBubbleParts(content);
  const visibleText = attachmentsOnly ? nothing : fencedUserText(text);
  // Invariant: Keep the interpolations flush against each other: the bubble is
  // `white-space: pre-wrap`, so template whitespace would create a gap after
  // the prose and before the upload previews.
  return html`${visibleText}${images.map(
    ({ url, alt }) =>
      html`<span class="thread-image"
        ><img
          src=${resolveUrl(renderingBackend(), url)}
          alt=${alt || "image.png"}
          loading="lazy"
          decoding="async"
          style=${INLINE_IMAGE_STYLE}
        /><span class="image-filename">Image</span></span
      >`,
  )}${files.map(
    (f) =>
      html`<a
        href=${resolveUrl(renderingBackend(), f.url)}
        download=${f.label}
        style="display:inline-block;margin:var(--space-2) var(--space-3) 0 0;color:var(--accent);"
        >${f.label}</a
      >`,
  )}`;
}
