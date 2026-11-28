// Converted documents are sanitized and inert. Ordinary HTML runs with the
// opaque-origin Artifact app policy: no fetch or external subresources.
// Downloads are bounded; conversion runs in a time-limited worker.
import DOMPurify from "dompurify";
import { html, nothing, render } from "lit";
import { htmlPreviewSrcdoc } from "./document-media/index.js";
import {
  fileViewModes,
  HTML_OFFLINE_NOTE,
  HTML_PREVIEW_FAILED,
  PREVIEW_TOO_LARGE,
  isHtmlFile,
  MAX_HTML_PREVIEW_BYTES,
} from "./html-file-view.js";
import { highlightSource } from "./source-preview.js";

export interface DocumentSection {
  title: string;
  html: string;
  note?: string;
}
export interface DocumentPreview {
  sections: DocumentSection[];
  note?: string;
}

const MAX_BYTES = 8 * 1024 * 1024;
const views = new Map<HTMLElement, AbortController>();

function note(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "files-preview-note";
  element.textContent = text;
  return element;
}

async function bytes(
  url: string,
  signal: AbortSignal,
  htmlFile: boolean,
): Promise<{ data: ArrayBuffer; truncated: boolean }> {
  const response = await fetch(url, { signal, credentials: "same-origin" });
  if (response.status === 404)
    throw Error("File not found. Check the link or choose another file.");
  if (!response.ok || !response.body)
    throw Error("Couldn’t download this file.");
  if (!htmlFile && Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body.cancel();
    throw Error("This file is too large to preview (limit: 8 MB).");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const limit = htmlFile ? MAX_HTML_PREVIEW_BYTES : MAX_BYTES;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size + value.length > limit) {
      await reader.cancel();
      if (!htmlFile)
        throw Error("This file is too large to preview (limit: 8 MB).");
      parts.push(value.subarray(0, limit - size));
      size = limit;
      truncated = true;
      break;
    }
    parts.push(value);
    size += value.length;
  }
  signal.throwIfAborted();
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return { data: result.buffer, truncated };
}

function documentWork<T>(
  input: { bytes: ArrayBuffer; name: string } | { markup: string },
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker("/static/document-preview.worker.js", {
      type: "module",
    });
    const stop = () => {
      clearTimeout(timer);
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(signal?.reason);
    };
    const expire = () => {
      stop();
      reject(Error("This document took too long to preview."));
    };
    let timer = setTimeout(expire, 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      stop();
      reject(Error("Couldn’t read this document."));
    };
    worker.onmessage = (
      event: MessageEvent<{ started?: true; result?: T; error?: string }>,
    ) => {
      if (event.data.started) {
        clearTimeout(timer);
        timer = setTimeout(expire, 1_000);
        return;
      }
      stop();
      if (event.data.result) resolve(event.data.result);
      else reject(Error(event.data.error || "Couldn’t read this document."));
    };
    worker.postMessage(input, "bytes" in input ? [input.bytes] : []);
  });
}

function markdownCodeStyles(): string {
  const selectors = [".content code", ".content pre", ".content pre code"];
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules)
        if (
          rule instanceof CSSStyleRule &&
          selectors.includes(rule.selectorText)
        )
          rules.push(rule.cssText);
    } catch {}
  }
  const theme = getComputedStyle(document.documentElement);
  const tokens = [
    "--code-bg",
    "--border",
    "--text",
    "--font-mono",
    "--space-1",
    "--space-2",
    "--space-4",
    "--space-5",
  ]
    .map((name) => `${name}:${theme.getPropertyValue(name)}`)
    .join(";");
  return `<style>:root{font-size:${theme.fontSize};${tokens}}${rules.join("")}.content pre{color:var(--text)}</style>`;
}

const documentTags = (
  "p br h1 h2 h3 h4 h5 h6 strong em b i u s ul ol li table thead tbody th tr td " +
  "pre code blockquote hr img div span section a"
).split(" ");
const documentAttrs = ["src", "alt", "class", "scope", "colspan", "rowspan"];

function sanitizedMarkup(markup: string): string {
  const template = document.createElement("template");
  const fragment = DOMPurify.sanitize(markup, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: documentTags,
    ALLOWED_ATTR: documentAttrs,
    ALLOW_DATA_ATTR: false,
  });
  for (const image of fragment.querySelectorAll("img")) {
    if (
      !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(
        image.getAttribute("src") || "",
      )
    )
      image.replaceWith(
        document.createTextNode("[Remote or unsupported image omitted]"),
      );
  }
  template.content.replaceChildren(fragment);
  return template.innerHTML;
}

function source(markup: string): string {
  return htmlPreviewSrcdoc(
    `${markdownCodeStyles()}<style>img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid GrayText;padding:var(--space-2,6px);white-space:pre-wrap;min-width:64px}th{position:sticky;top:0;background:Canvas}pre{white-space:pre-wrap}</style><div class="content">${sanitizedMarkup(markup)}</div>`,
    { scripts: false, embeddedImages: true },
  );
}

function documentFrame(title: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "files-document-frame";
  frame.title = title;
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  return frame;
}

function display(
  container: HTMLElement,
  result: DocumentPreview,
  title: string,
): void {
  const frame = documentFrame(title);
  const sections = result.sections;
  container.replaceChildren();
  const limitNote = note("");
  container.append(limitNote);
  const tabs = document.createElement("div");
  tabs.className = "files-document-tabs";
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Document sections");
  const select = (index: number) => {
    limitNote.textContent = [result.note, sections[index]!.note]
      .filter(Boolean)
      .join(" ");
    limitNote.hidden = !limitNote.textContent;
    frame.srcdoc = source(sections[index]!.html);
    for (const [at, button] of [...tabs.querySelectorAll("button")].entries())
      button.setAttribute("aria-pressed", String(at === index));
  };
  if (sections.length > 1) {
    sections.forEach((section, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = section.title;
      button.addEventListener("click", () => select(index));
      tabs.append(button);
    });
    container.append(tabs);
  }
  container.append(frame);
  select(0);
}

/** Run an HTML file with the same isolation as an Artifact app. */
export async function htmlFileFrame(
  markup: string,
  title: string,
  signal?: AbortSignal,
): Promise<HTMLIFrameElement> {
  const frame = documentFrame(`Preview of ${title}`);
  if (!("sandbox" in frame)) throw Error(HTML_PREVIEW_FAILED);
  frame.classList.add("html-file-frame");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = await documentWork<string>({ markup }, signal);
  return frame;
}

async function displayHtml(
  container: HTMLElement,
  markup: string,
  title: string,
  truncated: boolean,
  signal: AbortSignal,
): Promise<void> {
  let frame: HTMLIFrameElement | undefined;
  let reason = truncated ? PREVIEW_TOO_LARGE : "";
  if (!reason) {
    try {
      frame = await htmlFileFrame(markup, title, signal);
    } catch {
      reason = HTML_PREVIEW_FAILED;
    }
  }
  if (signal.aborted) return;
  const root = document.createElement("div");
  container.replaceChildren(root);
  const select = (preview: boolean) => {
    render(
      html`${fileViewModes("HTML view", preview, !!reason, select)}
      ${preview || reason
        ? html`<p class="html-file-note">
            ${preview
              ? HTML_OFFLINE_NOTE
              : reason +
                (truncated ? " Download the file to read the rest." : "")}
          </p>`
        : nothing}
      ${preview
        ? frame
        : html`<pre
            class="report-doc files-source"
            tabindex="0"
          ><code>${markup}</code></pre>`}`,
      root,
    );
    if (!preview) highlightSource(root.querySelector("code")!, title);
  };
  select(!!frame);
}

/** Mount from a download URL; the caller keeps its Download action. */
export function mountDocument(
  container: HTMLElement,
  url: string,
  name: string,
  size?: number,
): void {
  if (container.dataset.documentShown === url && views.has(container)) return;
  views.get(container)?.abort();
  const controller = new AbortController();
  views.set(container, controller);
  container.dataset.documentShown = url;
  const htmlFile = isHtmlFile(name);
  if (!htmlFile && size !== undefined && size > MAX_BYTES) {
    container.replaceChildren(
      note(
        "This file is too large to preview (limit: 8 MB). Download it to open it.",
      ),
    );
    return;
  }
  container.replaceChildren(note("Loading document…"));
  void bytes(url, controller.signal, htmlFile)
    .then(async ({ data, truncated }) => {
      if (controller.signal.aborted) return;
      if (htmlFile) {
        return displayHtml(
          container,
          new TextDecoder().decode(data),
          name,
          truncated,
          controller.signal,
        );
      }
      const result = await documentWork<DocumentPreview>(
        { bytes: data, name },
        controller.signal,
      );
      if (!controller.signal.aborted) display(container, result, name);
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted)
        container.replaceChildren(
          note(
            `${error instanceof Error ? error.message : "Couldn’t show this document."} Download it to open it.`,
          ),
        );
    });
}

/** Cancel disconnected document views or all views inside a disposed pane. */
export function releaseDocuments(root?: Element): void {
  for (const [container, controller] of views) {
    if (container.isConnected && !root?.contains(container)) continue;
    controller.abort();
    views.delete(container);
    delete container.dataset.documentShown;
  }
}
