// Live HTML file view shared by Files and Explorer. The server serves the page
// with the Artifact sandbox CSP; this iframe's sandbox adds an opaque origin,
// so the page's own styles and scripts run without session or network access.
import { html, type TemplateResult } from "lit";

/** Names of files that open as a live page. */
export const HTML_NAME_RE = /\.html?$/i;

export function htmlPage(src: string, title: string): TemplateResult {
  return html`<iframe
    class="html-page-frame"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    title=${`${title} preview`}
    src=${src}
  ></iframe>`;
}

/** The Preview/Source switch above an HTML file. */
export function htmlModes(
  source: boolean,
  choose: (source: boolean) => void,
): TemplateResult {
  return html`<div class="html-modes" role="group" aria-label="HTML view">
    ${["Preview", "Source"].map(
      (label) =>
        html`<button
          class="btn sm"
          type="button"
          aria-pressed=${String(source === (label === "Source"))}
          @click=${() => choose(label === "Source")}
        >
          ${label}
        </button>`,
    )}
  </div>`;
}
