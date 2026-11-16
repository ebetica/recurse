// Shared inert Markdown for Artifacts and Files: embeds, images, links, code,
// Mermaid, and math. Published siblings precede local paths; web images require
// a click. Relative links require an in-app policy. Each pane registers the
// desktop double-click image handler.
import { htmlPreviewSrcdoc, URL_ATTRIBUTES } from "./artifacts/model.js";
import { nextArtifactFrameDescriptionId } from "./artifacts/embed.js";
import { loadDecodedArtifactImage } from "./artifacts/image-loading.js";
import { renderMathIn, renderMathPlaceholders } from "./math.js";
import { isMermaidLang, renderMermaidIn } from "./mermaid.js";
import { documentMarkdownFragment } from "./util.js";
import { diffKeys, markDocumentChanges } from "./document-diff.js";
import {
  externalImageButton,
  imageFailure,
  imageHost,
  originalPathImage,
  referenceImageUrl,
  registerDocumentImages,
} from "./image-preview/references.js";

const EMBED_RE = /```html-embed[^\n]*\n([\s\S]*?)```/g;
const FORBIDDEN_DOCUMENT_TAGS =
  "base,embed,form,frame,frameset,iframe,link,math,meta,object,script,style,svg";

function isRelative(value: string | null): boolean {
  return !!value && !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value);
}

/** Label URL-like captions that claim a different destination host. */
function misleadingLinkHost(link: HTMLAnchorElement, host: string): boolean {
  const text = (link.textContent || "").trim();
  if (
    !/^(?:https?:\/\/|\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}(?=[:/?#]|$))/i.test(text)
  )
    return false;
  try {
    const visible = new URL(
      text.startsWith("//")
        ? `https:${text}`
        : /^https?:\/\//i.test(text)
          ? text
          : `https://${text}`,
    );
    return visible.hostname !== host;
  } catch {
    return false;
  }
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
        name.endsWith(":href") ||
        [
          "data-external-image",
          "data-image-alt",
          "data-path-image",
          "data-image-path",
        ].includes(name)
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
    // Invariant: A failed thumbnail (a connected backend without the route)
    // retries once as the original preview.
    const dimensions = await loadDecodedArtifactImage(
      image,
      source,
      signal,
    ).catch((error) => {
      if (signal.aborted || !source.endsWith("/thumbnail")) throw error;
      const original = source.replace(/\/thumbnail$/, "/preview");
      return loadDecodedArtifactImage(image, original, signal);
    });
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
  openRelative: (path: string, fragment: string) => boolean;
  signal: AbortSignal;
  title: string;
  agentId: string;
  documentPath?: string;
  artifactId?: string;
  /** An earlier version's text: highlight what is new since it. */
  previous?: string | null;
}

function markdownFragment(
  source: string,
  options: DocumentMarkdownOptions,
): DocumentFragment {
  // Invariant: A template is inert: remote images, srcset candidates, CSS URLs,
  // SVG refs, and media cannot issue a request in the gap before this policy
  // runs.
  const template = document.createElement("template");
  template.content.append(documentMarkdownFragment(source));
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
    diffKeys.set(image, source || "");
    if (imageHost(source)) {
      const button = externalImageButton(source!, image.alt);
      diffKeys.set(button, source!);
      image.replaceWith(button);
      continue;
    }
    const fallback = referenceImageUrl(
      source,
      options.agentId,
      options.documentPath,
      options.artifactId,
    );
    const resolved =
      (isRelative(source) ? options.resolveRelative(source!, true) : null) ||
      fallback;
    if (resolved) {
      if (!(image.alt || "").trim()) image.alt = "Image without a description";
      image.classList.add("artifact-image");
      const frame = imagePlaceholder(image);
      image.replaceWith(frame);
      frame.appendChild(image);
      const reveal = async () => {
        let loaded = await revealArtifactImage(
          frame,
          image,
          resolved,
          options.signal,
        );
        let used = resolved;
        if (
          !loaded &&
          fallback &&
          fallback !== resolved &&
          !options.signal.aborted
        ) {
          loaded = await revealArtifactImage(
            frame,
            image,
            fallback,
            options.signal,
          );
          used = fallback;
        }
        if (loaded) {
          const original = originalPathImage(used);
          if (original) image.dataset.pathImage = original;
        } else if (!options.signal.aborted && frame.parentNode)
          frame.replaceWith(imageFailure(source || ""));
      };
      void reveal();
      continue;
    }
    image.replaceWith(imageFailure(source || ""));
  }
  for (const { link, href } of links) {
    if (!link.isConnected && !template.content.contains(link)) continue;
    if (!href?.trim()) continue;
    const relative = isRelative(href);
    const separator = href.indexOf("#");
    const path = separator < 0 ? href : href.slice(0, separator);
    const fragment = separator < 0 ? "" : href.slice(separator);
    const resolved = relative ? options.resolveRelative(path, false) : null;
    if (resolved) {
      link.href = resolved + fragment;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.addEventListener("click", (event) => {
        if (
          !event.defaultPrevented &&
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          options.openRelative(path, fragment)
        )
          event.preventDefault();
      });
      continue;
    }
    if (href.startsWith("#")) {
      link.href = href;
      continue;
    }
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    let host = "";
    try {
      const destination = new URL(href, location.href);
      if (/^https?:$/.test(destination.protocol)) host = destination.hostname;
    } catch {}
    if (host && misleadingLinkHost(link, host)) {
      const visible = document.createElement("span");
      visible.className = "artifact-link-host";
      visible.textContent = ` (${host})`;
      link.after(visible);
    }
  }
  // Invariant: Mermaid replaces the code element inside its <pre>, so it
  // happens after the fragment is attached and the sanitizer's done with it.
  queueMicrotask(() => {
    for (const el of mermaidBlocks) {
      if (!el.parentElement?.isConnected) continue;
      renderMermaidIn(el.parentElement.parentElement ?? template.content);
    }
  });
  return template.content;
}

/** Scroll only the opened document, without navigating the app fragment. */
export function scrollDocumentFragment(
  root: HTMLElement,
  fragment: string,
): boolean {
  if (!fragment) return false;
  let name: string;
  try {
    name = decodeURIComponent(fragment.replace(/^#/, ""));
  } catch {
    return false;
  }
  const target = [
    ...root.querySelectorAll<HTMLElement>(
      "[id], a[name], h1, h2, h3, h4, h5, h6",
    ),
  ].find(
    (element) =>
      element.id === name ||
      element.getAttribute("name") === name ||
      (/^H[1-6]$/.test(element.tagName) &&
        (element.textContent || "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_\s-]/gu, "")
          .trim()
          .replace(/\s/g, "-") === name),
  );
  if (!target) return false;
  requestAnimationFrame(() => {
    if (target.isConnected) target.scrollIntoView({ block: "start" });
  });
  return true;
}

function appendMarkdown(
  body: HTMLElement,
  source: string,
  options: DocumentMarkdownOptions,
): void {
  const section = document.createElement("section");
  section.className = "content artifact-markdown";
  registerDocumentImages(section, options.agentId, options.signal);
  section.appendChild(markdownFragment(source, options));
  body.appendChild(section);
  queueMicrotask(() => renderMathIn(section));
}

function embedNodes(source: string, title: string): HTMLElement[] {
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
  return [description, frame];
}

function documentParts(
  source: string,
): { markdown?: string; embed?: string }[] {
  const parts: { markdown?: string; embed?: string }[] = [];
  let last = 0,
    match: RegExpExecArray | null;
  EMBED_RE.lastIndex = 0;
  while ((match = EMBED_RE.exec(source)) !== null) {
    const before = source.slice(last, match.index);
    if (before.trim()) parts.push({ markdown: before });
    parts.push({ embed: match[1] });
    last = EMBED_RE.lastIndex;
  }
  const rest = source.slice(last);
  if (rest.trim() || !parts.length) parts.push({ markdown: rest });
  return parts;
}

export function renderDocumentMarkdown(
  body: HTMLElement,
  source: string,
  options: DocumentMarkdownOptions,
): void {
  if (typeof options.previous === "string")
    return renderChanges(body, options.previous, source, options);
  for (const part of documentParts(source))
    if (part.embed !== undefined)
      body.append(...embedNodes(part.embed, options.title));
    else appendMarkdown(body, part.markdown!, options);
}

function flatDocument(
  source: string,
  options: DocumentMarkdownOptions,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of documentParts(source)) {
    if (part.embed === undefined) {
      fragment.append(markdownFragment(part.markdown!, options));
      continue;
    }
    const holder = document.createElement("div");
    holder.className = "doc-diff-embed";
    holder.append(...embedNodes(part.embed, options.title));
    diffKeys.set(holder, `EMBED|${part.embed}`);
    fragment.append(holder);
  }
  return fragment;
}

function renderChanges(
  body: HTMLElement,
  previous: string,
  source: string,
  options: DocumentMarkdownOptions,
): void {
  const section = document.createElement("section");
  section.className = "content artifact-markdown";
  registerDocumentImages(section, options.agentId, options.signal);
  const current = flatDocument(source, options);
  // Invariant: The earlier version is only compared, never shown: its image
  // loads start aborted and its embeds are never attached.
  const signal = AbortSignal.abort();
  markDocumentChanges(flatDocument(previous, { ...options, signal }), current);
  section.append(current);
  body.appendChild(section);
  queueMicrotask(() => renderMathIn(section));
}
