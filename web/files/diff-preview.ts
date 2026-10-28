// Published patches share Changes' bounded per-hunk renderer and tokens.
import { html, type TemplateResult } from "lit";
import { until } from "lit/directives/until.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { FilePreviewState, SessionFile } from "./model.js";
import { MAX_RENDER_ROWS, renderPatch, type ViewLine } from "../diff/render.js";

const previews = new WeakMap<FilePreviewState, Promise<TemplateResult>>();
const settled = new WeakSet<FilePreviewState>();

/** Resolves after a still-highlighting diff preview is shown, else null. */
export function diffPending(
  preview: FilePreviewState | undefined,
): Promise<unknown> | null {
  return preview && !settled.has(preview)
    ? (previews.get(preview) ?? null)
    : null;
}

export function isDiff(file: SessionFile, text: string): boolean {
  return (
    /\.(diff|patch)$/i.test(file.name) ||
    /^(text\/x-diff|text\/x-patch)$/.test(file.media_type) ||
    (/^(application\/octet-stream|text\/plain)(;|$)/.test(file.media_type) &&
      /^(diff --git |--- [^\n]+\n\+\+\+ |@@ )/.test(text))
  );
}

export function diffPreview(preview: FilePreviewState): unknown {
  let result = previews.get(preview);
  if (!result) {
    result = renderDiff(preview.text ?? "")
      .catch(() => html`<pre class="report-doc">${preview.text}</pre>`)
      .finally(() => settled.add(preview));
    previews.set(preview, result);
  }
  return until(
    result,
    html`<div class="files-preview-note">Highlighting diff…</div>`,
  );
}

async function renderDiff(text: string): Promise<TemplateResult> {
  if (!document.getElementById("diff-pane-css")) {
    const link = document.createElement("link");
    link.id = "diff-pane-css";
    link.rel = "stylesheet";
    link.href = "/static/diff.css";
    document.head.appendChild(link);
  }
  const lines = text.slice(0, 128_000).split("\n");
  const bounded = lines.slice(0, MAX_RENDER_ROWS).join("\n");
  const parts: string[] = [];
  let part: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  let hasFile = false;
  for (const line of bounded.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (
      line.startsWith("diff --git ") ||
      (!oldLeft && !newLeft && hasFile && line.startsWith("--- "))
    ) {
      parts.push(part.join("\n"));
      part = [];
      hasFile = false;
    }
    if (hunk) {
      oldLeft = Number(hunk[2] ?? 1);
      newLeft = Number(hunk[4] ?? 1);
    } else if (oldLeft || newLeft) {
      if (/^[ -]/.test(line)) oldLeft = Math.max(0, oldLeft - 1);
      if (/^[ +]/.test(line)) newLeft = Math.max(0, newLeft - 1);
    } else if (line.startsWith("+++ ")) hasFile = true;
    part.push(line);
  }
  parts.push(part.join("\n"));
  const rendered: TemplateResult[] = [];
  for (const part of parts) {
    if (!part) continue;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    const start = part.search(/^@@ /m);
    const headers = start < 0 ? part : part.slice(0, start).trimEnd();
    const paths = [...headers.matchAll(/^(?:\+\+\+|---) (.+)$/gm)]
      .map((match) => match[1].split("\t")[0])
      .filter((path) => path !== "/dev/null");
    const rawPath = paths.at(-1) ?? "txt";
    const path = (
      rawPath.startsWith('"') ? (JSON.parse(rawPath) as string) : rawPath
    ).replace(/^[ab]\//, "");
    const rows =
      start < 0
        ? null
        : ((await renderPatch(part, path, "unified")) as ViewLine[] | null);
    rendered.push(
      html`${headers
        .split("\n")
        .map(
          (line) =>
            html`<div class="diff-hunk files-diff-header">${line}</div>`,
        )}
      ${rows
        ? rows.map((row) =>
            row.kind === "hunk"
              ? html`<div class="diff-hunk">${row.html}</div>`
              : html`<div class=${`diff-row ${row.kind}`}>
                  <span class="diff-line"
                    ><span class="diff-sign"
                      >${row.kind === "add"
                        ? "+"
                        : row.kind === "del"
                          ? "-"
                          : " "}</span
                    >${unsafeHTML(row.html)}</span
                  >
                </div>`,
          )
        : start < 0
          ? null
          : html`<div class="diff-row">
              <span class="diff-line">${part.slice(start)}</span>
            </div>`}`,
    );
  }
  return html`<div class="files-diff diff-patch report-doc">
      <div class="diff-patch-content">${rendered}</div>
    </div>
    ${bounded.length < text.length
      ? html`<div class="files-preview-note">
          Diff preview truncated. Download for the complete file.
        </div>`
      : null}`;
}
