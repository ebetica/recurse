// Shared inert Markdown preview for Artifacts and Files, including embeds,
// images, links, highlighting, Mermaid, and math. Callers resolve owned files.
import {
  externalHttpHostname,
  htmlPreviewSrcdoc,
  URL_ATTRIBUTES,
} from "./artifacts/model.js";
import { nextArtifactFrameDescriptionId } from "./artifacts/embed.js";
import { loadDecodedArtifactImage } from "./artifacts/image-loading.js";
import { renderMathIn, renderMathPlaceholders } from "./math.js";
import { isMermaidLang, renderMermaidIn } from "./mermaid.js";
import { md } from "./util.js";

const EMBED_RE = /```html-embed[^\n]*\n([\s\S]*?)```/g;
const FORBIDDEN_DOCUMENT_TAGS =
  "base,embed,form,frame,frameset,iframe,link,math,meta,object,script,style,svg";

function isRelative(value: string | null): boolean {
  return !!value && !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value);
}

function removeUrlSurfaces(root: ParentNode): void {
  for (const blocked of root.querySelectorAll(FORBIDDEN_DOCUMENT_TAGS))
    blocked.remove();
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    element.removeAttribute("style");
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const localName = attribute.localName.toLowerCase();
      if (
        URL_ATTRIBUTES.has(name) ||
        URL_ATTRIBUTES.has(localName) ||
        name.endsWith(":href")
      ) {
        element.removeAttributeNode(attribute);
      }
    }
  }
}

export function imagePlaceholder(
  image: HTMLImageElement,
  standalone = false,
): HTMLElement {
  const frame = document.createElement("span");
  frame.className = `artifact-image-frame${standalone ? " standalone" : ""}`;
  frame.setAttribute("aria-busy", "true");
  if (!standalone) {
    frame.setAttribute("role", "img");
    frame.setAttribute("aria-label", image.alt);
  }
  const width = Number(image.getAttribute("width"));
  const height = Number(image.getAttribute("height"));
  if (width > 0 && height > 0) {
    frame.style.aspectRatio = `${width} / ${height}`;
    frame.style.width = `${width}px`;
  } else {
    frame.style.width = "min(100%, 640px)";
  }
  const skeleton = document.createElement("span");
  skeleton.className = "artifact-image-placeholder";
  skeleton.setAttribute("aria-hidden", "true");
  image.hidden = true;
  image.decoding = "async";
  frame.appendChild(skeleton);
  return frame;
}

export async function revealArtifactImage(
  frame: HTMLElement,
  image: HTMLImageElement,
  source: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const dimensions = await loadDecodedArtifactImage(image, source, signal);
    if (signal.aborted || !frame.parentNode) return false;
    const width = Number(image.getAttribute("width"));
    const height = Number(image.getAttribute("height"));
    const requestedWidth =
      width > 0
        ? width
        : height > 0
          ? (height * dimensions.width) / dimensions.height
          : dimensions.width;
    frame.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
    frame.style.width = `${Math.min(requestedWidth, dimensions.width)}px`;
    image.hidden = false;
    frame.querySelector(".artifact-image-placeholder")?.remove();
    frame.removeAttribute("aria-busy");
    frame.removeAttribute("role");
    frame.removeAttribute("aria-label");
    return true;
  } catch {
    return false;
  }
}

export interface DocumentMarkdownOptions {
  resolveRelative: (path: string, image: boolean) => string | null;
  signal: AbortSignal;
  title: string;
}

function markdownFragment(
  source: string,
  options: DocumentMarkdownOptions,
): DocumentFragment {
  // Invariant: A template is inert: remote images, srcset candidates, CSS URLs,
  // SVG refs, and media cannot issue a request in the gap before this policy
  // runs.
  const template = document.createElement("template");
  template.innerHTML = md(source);
  const mermaidBlocks = [
    ...template.content.querySelectorAll<HTMLElement>("pre > code"),
  ].filter((el) =>
    isMermaidLang([...el.classList].find((c) => c.startsWith("language-"))),
  );
  const images = [
    ...template.content.querySelectorAll<HTMLImageElement>("img"),
  ].map((image) => ({ image, source: image.getAttribute("src") }));
  const links = [
    ...template.content.querySelectorAll<HTMLAnchorElement>("a"),
  ].map((link) => ({ link, href: link.getAttribute("href") }));
  removeUrlSurfaces(template.content);
  renderMathPlaceholders(template.content);

  for (const { image, source } of images) {
    if (!image.isConnected && !template.content.contains(image)) continue;
    const resolved = isRelative(source)
      ? options.resolveRelative(source!, true)
      : null;
    if (resolved) {
      if (!(image.alt || "").trim()) image.alt = "Image without a description";
      image.classList.add("artifact-image");
      const frame = imagePlaceholder(image);
      image.replaceWith(frame);
      frame.appendChild(image);
      void revealArtifactImage(frame, image, resolved, options.signal).then(
        (loaded) => {
          if (loaded || options.signal.aborted || !frame.parentNode) return;
          const failed = document.createElement("span");
          failed.className = "artifact-blocked-image artifact-failed-image";
          failed.textContent = "Image preview unavailable";
          frame.replaceWith(failed);
        },
      );
      continue;
    }
    const host = externalHttpHostname(source);
    const blocked = document.createElement("span");
    blocked.className = "artifact-blocked-image";
    blocked.textContent = host
      ? `External image blocked (${host})`
      : "Image blocked";
    image.replaceWith(blocked);
  }
  for (const { link, href } of links) {
    if (!link.isConnected && !template.content.contains(link)) continue;
    const resolved = isRelative(href)
      ? options.resolveRelative(href!, false)
      : null;
    if (resolved) {
      link.href = resolved;
      continue;
    }
    if (href?.startsWith("#")) {
      link.href = href;
      continue;
    }
    const host = externalHttpHostname(href);
    if (host) {
      link.href = href!;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      const visible = document.createElement("span");
      visible.className = "artifact-link-host";
      visible.textContent = ` (${host})`;
      link.after(visible);
    } else {
      link.classList.add("artifact-blocked-link");
      const visible = document.createElement("span");
      visible.className = "artifact-link-host";
      visible.textContent = " (link blocked)";
      link.after(visible);
    }
  }
  const fragment = template.content;
  // Invariant: Mermaid replaces the code element inside its <pre>, so it
  // happens after the fragment is attached and the sanitizer's done with it.
  queueMicrotask(() => {
    for (const el of mermaidBlocks) {
      if (!el.parentElement?.isConnected) continue;
      renderMermaidIn(el.parentElement.parentElement ?? fragment);
    }
  });
  return fragment;
}

function appendMarkdown(
  body: HTMLElement,
  source: string,
  options: DocumentMarkdownOptions,
): void {
  const section = document.createElement("section");
  section.className = "content artifact-markdown";
  section.appendChild(markdownFragment(source, options));
  body.appendChild(section);
  queueMicrotask(() => renderMathIn(section));
}

function appendEmbed(body: HTMLElement, source: string, title: string): void {
  const frame = document.createElement("iframe");
  const description = document.createElement("p");
  description.className = "sr-only";
  description.id = nextArtifactFrameDescriptionId();
  description.textContent = `Live offline preview for ${title}. Download original is available above.`;
  frame.className = "report-embed artifact-embed";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = `${title} live preview`;
  frame.setAttribute("aria-describedby", description.id);
  frame.srcdoc = htmlPreviewSrcdoc(source);
  body.append(description, frame);
}

export function renderDocumentMarkdown(
  body: HTMLElement,
  source: string,
  options: DocumentMarkdownOptions,
): void {
  let last = 0,
    match: RegExpExecArray | null;
  EMBED_RE.lastIndex = 0;
  while ((match = EMBED_RE.exec(source)) !== null) {
    const before = source.slice(last, match.index);
    if (before.trim()) appendMarkdown(body, before, options);
    appendEmbed(body, match[1], options.title);
    last = EMBED_RE.lastIndex;
  }
  const rest = source.slice(last);
  if (rest.trim() || !body.children.length) appendMarkdown(body, rest, options);
}
