// Shared limits and Source/Preview control for ordinary HTML files.
import { html } from "lit";

export const isHtmlFile = (name: string): boolean => /\.html?$/i.test(name);
export const MAX_HTML_PREVIEW_BYTES = 256 * 1024;
export const HTML_TOO_LARGE =
  "This file is too large to preview. Showing source.";
export const HTML_PREVIEW_FAILED = "Couldn’t show the preview. Showing source.";
export const HTML_OFFLINE_NOTE =
  "Embedded scripts and styles run here. Separate scripts, styles and images don’t load.";

export function htmlFileModes(
  preview: boolean,
  unavailable: boolean,
  select: (preview: boolean) => void,
) {
  return html`<div class="html-file-modes" role="group" aria-label="HTML view">
    <button
      class="btn sm"
      type="button"
      aria-pressed=${String(!preview)}
      @click=${() => select(false)}
    >
      Source
    </button>
    <button
      class="btn sm"
      type="button"
      aria-pressed=${String(preview)}
      ?disabled=${unavailable}
      @click=${() => select(true)}
    >
      Preview
    </button>
  </div>`;
}
