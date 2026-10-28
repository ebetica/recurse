import {
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

export interface UserBubbleGates {
  isAllowedInlineImageSrc: typeof isAllowedInlineImageSrc;
  scopedAttachmentPreviewHref: typeof scopedAttachmentPreviewHref;
  isAllowedAttachmentHref: typeof isAllowedAttachmentHref;
}

const DEFAULT_GATES: UserBubbleGates = {
  isAllowedInlineImageSrc,
  scopedAttachmentPreviewHref,
  isAllowedAttachmentHref,
};

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
export function userBubbleParts(
  content: string,
  gates: UserBubbleGates = DEFAULT_GATES,
): UserBubbleParts {
  const images: UserBubbleImage[] = [];
  const files: UserBubbleFile[] = [];
  const visibleLines: string[] = [];
  const lines = stripPiImageResizeNotes(content || "").split("\n");
  const imageUrl = (alt: string, url: string): string | null => {
    if (gates.isAllowedInlineImageSrc(url)) {
      images.push({ url, alt });
      return "";
    }
    const preview = gates.scopedAttachmentPreviewHref(url);
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
            if (gates.isAllowedAttachmentHref(url)) {
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
