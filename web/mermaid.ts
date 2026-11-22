// On-the-fly mermaid rendering. `mermaid` is a large dependency, so it loads
// through a dynamic import — the main bundle never pays for it, and the
// diagram module is only fetched when a ```mermaid fence first appears.
// Connected staging stays outside the app's flex layout and is always removed.
import { CLOSE_ICON } from "./icons.js";
import { installFrameZoom } from "./image-preview/index.js";
import { viewerHistoryDismiss } from "./phone-nav.js";

// Recognizes bare and MIME-style Mermaid fence language names.
const LANG_RE =
  /^(?:mermaid|text-mermaid|application-mermaid|text\/mermaid|application\/mermaid)$/i;

export const isMermaidLang = (className: string | undefined): boolean => {
  const lang = (className || "")
    .split(/\s+/)
    .find((c) => c.startsWith("language-"))
    ?.slice("language-".length);
  return LANG_RE.test(lang || "");
};

type Mermaid = (typeof import("mermaid"))["default"];

let library: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  library ??= import("mermaid").then((mod) => mod.default);
  return library;
}

// Serializes Mermaid renders to protect shared IDs and DOM measurements.
let queue: Promise<unknown> = Promise.resolve();

// Short one-line summary of a mermaid render failure for the error note.
function mermaidErrorMessage(err: unknown): string {
  const first = String((err as Error)?.message || err)
    .split("\n", 1)[0]
    .trim();
  return first.length > 160 ? first.slice(0, 157) + "\u2026" : first;
}

function renderOne(host: HTMLElement, code: string): Promise<void> {
  const id = "mmd-" + Math.random().toString(36).slice(2);
  host.dataset.renderId = id;
  const chain = queue
    .then(() => loadMermaid())
    .then(async (m) => {
      const style = getComputedStyle(document.documentElement);
      const token = (name: string) =>
        style.getPropertyValue(`--${name}`).trim();
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // Invariant: Parse failures must not append broken SVGs to body.
        suppressErrorRendering: true,
        theme: "base",
        themeVariables: {
          darkMode: style.colorScheme === "dark",
          background: token("bg"),
          primaryColor: token("panel-2"),
          primaryTextColor: token("text"),
          primaryBorderColor: token("border-strong"),
          secondaryColor: token("user-bubble"),
          tertiaryColor: token("panel"),
          lineColor: token("muted"),
          textColor: token("text"),
        },
      });
      const staging = document.createElement("div");
      staging.inert = true;
      staging.style.cssText =
        "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none";
      staging.style.width = `${host.clientWidth || document.documentElement.clientWidth}px`;
      document.body.append(staging);
      try {
        return await m.render(id, code, staging);
      } finally {
        staging.remove();
      }
    });
  queue = chain.catch(() => {});
  return chain
    .then(({ svg }) => {
      if (host.dataset.renderId !== id) return;
      host.querySelector(".mermaid-render")!.innerHTML = svg;
      host.classList.remove("mermaid-error");
      host.classList.add("mermaid-done");
    })
    .catch((err) => {
      if (host.dataset.renderId !== id) return;
      host.classList.remove("mermaid-done");
      host.classList.add("mermaid-error");
      const note = document.createElement("code");
      note.textContent = mermaidErrorMessage(err);
      // Invariant: Keep the diagram source readable inside the host so the
      // content survives a syntax error (textContent keeps it injection-safe).
      const pre = document.createElement("pre");
      const src = document.createElement("code");
      src.textContent = code;
      pre.appendChild(src);
      host.querySelector(".mermaid-render")!.replaceChildren(note, pre);
    });
}

function repaintDiagrams(): void {
  for (const host of document.querySelectorAll<HTMLElement>(
    ".mermaid-host[data-mermaid-source]",
  ))
    void renderOne(host, host.dataset.mermaidSource!);
}

if (typeof window !== "undefined") {
  window.addEventListener("recurse:theme-changed", repaintDiagrams);
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", repaintDiagrams);
}

function openDiagram(svg: SVGSVGElement, opener: HTMLButtonElement): void {
  const { width, height } = svg.viewBox.baseVal;
  const box = svg.getBoundingClientRect();
  const diagramWidth = width || box.width;
  const diagramHeight = height || box.height;
  const dialog = document.createElement("dialog");
  dialog.className = "image-popout mermaid-viewer";
  dialog.setAttribute("aria-label", "Diagram viewer");
  dialog.innerHTML = `<div class="image-popout-body">
    <header class="viewer-topbar image-popout-bar">
      <span class="files-name">Diagram</span>
      <button type="button" class="icon-btn lg" aria-label="Zoom out" title="Zoom out">−</button>
      <button type="button" class="icon-btn lg" aria-label="Zoom in" title="Zoom in">+</button>
      <button type="button" class="btn sm" aria-label="Fit diagram">Fit</button>
      <button type="button" class="icon-btn lg" aria-label="Close diagram" title="Close diagram" autofocus>${CLOSE_ICON}</button>
    </header>
    <div class="image-zoom-viewport" tabindex="0" role="region" aria-label="Diagram canvas">
      <div class="files-image-frame"></div>
    </div>
  </div>`;
  const frame = dialog.querySelector<HTMLElement>(".files-image-frame")!;
  frame.style.setProperty(
    "--image-aspect",
    String(diagramWidth / diagramHeight),
  );
  frame.style.maxWidth = `min(100%, ${diagramWidth}px)`;
  // Move the SVG rather than duplicate Mermaid's IDs and fragment references.
  const placeholder = document.createElement("div");
  placeholder.style.height = `${box.height}px`;
  svg.replaceWith(placeholder);
  frame.append(svg);
  installFrameZoom(frame, {
    zoomIn: dialog.querySelector('[aria-label="Zoom in"]')!,
    zoomOut: dialog.querySelector('[aria-label="Zoom out"]')!,
    fit: dialog.querySelector('[aria-label="Fit diagram"]')!,
    maxScale: () => Math.max(8, diagramWidth / (frame.offsetWidth || 1)),
  });
  const dismiss = viewerHistoryDismiss(() => dialog.close());
  dialog
    .querySelector('[aria-label="Close diagram"]')!
    .addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("close", () => {
    placeholder.replaceWith(svg);
    dialog.remove();
    opener.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
}

/** Replace every `language-mermaid` code block under `root` with a diagram. */
export function renderMermaidIn(root: ParentNode): void {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code")].filter(
    (el) =>
      isMermaidLang([...el.classList].find((c) => c.startsWith("language-"))),
  );
  for (const el of blocks) {
    const pre = el.parentElement!;
    const code = (el.textContent || "").trim();
    if (!code) continue;
    const host = document.createElement("div");
    host.className = "mermaid-host";
    host.dataset.mermaidSource = code;
    const drawing = document.createElement("div");
    drawing.className = "mermaid-render";
    drawing.textContent = "Diagram…";
    const actions = document.createElement("div");
    actions.className = "mermaid-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn sm mermaid-open";
    open.textContent = "Open diagram";
    open.onclick = () => {
      const svg = drawing.querySelector("svg");
      if (svg) openDiagram(svg, open);
    };
    actions.append(open);
    const copy = pre.nextElementSibling;
    if (copy?.matches(".copy-btn") && pre.parentElement?.matches(".code-wrap"))
      actions.append(copy);
    host.append(actions, drawing);
    pre.replaceWith(host);
    void renderOne(host, code);
  }
}
