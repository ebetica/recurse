// Document HTML is sanitized in an inert template, then shown in the Artifact
// sandbox without scripts, network access or same-origin privileges.
// Downloads are bounded; conversion runs in a time-limited worker.
import DOMPurify from "dompurify";
import { htmlPreviewSrcdoc } from "./artifacts/model.js";

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

async function bytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, credentials: "same-origin" });
  if (!response.ok || !response.body)
    throw Error("Couldn’t download this file.");
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body.cancel();
    throw Error("This file is too large to preview (limit: 8 MB).");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw Error("This file is too large to preview (limit: 8 MB).");
    }
    parts.push(value);
  }
  signal.throwIfAborted();
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result.buffer;
}

function parse(
  data: ArrayBuffer,
  name: string,
  signal: AbortSignal,
): Promise<DocumentPreview> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker("/static/document-preview.worker.js", {
      type: "module",
    });
    const stop = () => {
      clearTimeout(timer);
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      stop();
      reject(Error("This document took too long to preview."));
    }, 15_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      stop();
      reject(Error("Couldn’t read this document."));
    };
    worker.onmessage = (
      event: MessageEvent<{ result?: DocumentPreview; error?: string }>,
    ) => {
      stop();
      if (event.data.result) resolve(event.data.result);
      else reject(Error(event.data.error || "Couldn’t read this document."));
    };
    worker.postMessage({ bytes: data, name }, [data]);
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

function source(html: string): string {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      "p",
      "br",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "b",
      "i",
      "u",
      "s",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "pre",
      "code",
      "blockquote",
      "hr",
      "img",
      "div",
      "span",
      "section",
      "a",
    ],
    ALLOWED_ATTR: ["src", "alt", "class", "scope", "colspan", "rowspan"],
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
  const template = document.createElement("template");
  template.content.append(fragment);
  return htmlPreviewSrcdoc(
    `${markdownCodeStyles()}<style>img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid GrayText;padding:var(--space-2,6px);white-space:pre-wrap;min-width:64px}th{position:sticky;top:0;background:Canvas}pre{white-space:pre-wrap}</style><div class="content">${template.innerHTML}</div>`,
    { scripts: false, embeddedImages: true },
  );
}

function display(
  container: HTMLElement,
  result: DocumentPreview,
  title: string,
): void {
  const frame = document.createElement("iframe");
  frame.className = "files-document-frame";
  frame.title = title;
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
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

/** Show already-loaded HTML through the same sanitized document viewer. */
export function mountHtmlPreview(
  container: HTMLElement,
  html: string,
  title: string,
): void {
  display(container, { sections: [{ title, html }] }, title);
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
  if (size !== undefined && size > MAX_BYTES) {
    container.replaceChildren(
      note(
        "This file is too large to preview (limit: 8 MB). Download it to open it.",
      ),
    );
    return;
  }
  container.replaceChildren(note("Loading document…"));
  void bytes(url, controller.signal)
    .then((data) => parse(data, name, controller.signal))
    .then((result) => {
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
