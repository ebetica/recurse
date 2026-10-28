// Lazy legacy pdf.js with local worker/assets; scripts and XFA never run.
// Viewport-bounded canvases obey pixel/page caps and release offscreen pages.
// Replacement/removal/failure aborts fetch and destroys the worker document.

import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { CommentBox } from "./artifacts/artifact-state.js";

export const MAX_PAGES = 100;
const MAX_CANVAS_PIXELS = 1 << 23;
const ASSETS = "/static/pdfjs/";

let library: Promise<typeof import("pdfjs-dist")> | null = null;
const views = new Map<HTMLElement, AbortController>();
const documents = new WeakMap<HTMLCanvasElement, PDFDocumentProxy>();

/** Render a selected PDF region at 144 dpi, capped at 2048 px. */
export async function cropPdfPage(
  source: HTMLCanvasElement,
  box: CommentBox,
): Promise<HTMLCanvasElement> {
  const doc = documents.get(source);
  if (!doc) throw new Error("PDF page unavailable");
  const page = await doc.getPage(Number(source.dataset.page));
  const natural = page.getViewport({ scale: 1 });
  const scale = Math.min(
    2,
    2048 / Math.max(natural.width * box.w, natural.height * box.h),
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width * box.w));
  canvas.height = Math.max(1, Math.round(viewport.height * box.h));
  await page.render({
    canvas,
    viewport,
    transform: [1, 0, 0, 1, -viewport.width * box.x, -viewport.height * box.y],
  }).promise;
  return canvas;
}

function pdfjs(): Promise<typeof import("pdfjs-dist")> {
  library ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.js`;
    return mod;
  });
  return library;
}

function note(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "files-preview-note";
  element.textContent = text;
  return element;
}

/** Show the PDF at `url` in `container`, unless it already shows it. */
export function mountPdf(container: HTMLElement, url: string): void {
  if (container.dataset.pdfShown === url && views.has(container)) return;
  views.get(container)?.abort();
  const controller = new AbortController();
  views.set(container, controller);
  container.dataset.pdfShown = url;
  container.replaceChildren(note("Loading PDF…"));
  void show(container, url, controller.signal).catch(() => {
    if (controller.signal.aborted) return;
    container.replaceChildren(
      note("Couldn’t show this PDF. Download it to open it."),
    );
    controller.abort();
  });
}

/** Stop every PDF view inside `root`, and every view no longer on the page. */
export function releasePdfs(root?: Element): void {
  for (const [container, controller] of views) {
    if (container.isConnected && !root?.contains(container)) continue;
    controller.abort();
    views.delete(container);
    delete container.dataset.pdfShown;
  }
}

async function show(
  container: HTMLElement,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  const [lib, response] = await Promise.all([
    pdfjs(),
    fetch(url, { signal, credentials: "same-origin" }),
  ]);
  if (!response.ok) throw new Error(`PDF fetch failed: ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  const task = lib.getDocument({
    data,
    enableXfa: false,
    cMapUrl: `${ASSETS}cmaps/`,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    iccUrl: `${ASSETS}iccs/`,
    wasmUrl: `${ASSETS}wasm/`,
  });
  const drawing = new Map<HTMLCanvasElement, RenderTask>();
  const release = (canvas: HTMLCanvasElement) => {
    drawing.get(canvas)?.cancel();
    drawing.delete(canvas);
    canvas.width = 0;
    canvas.height = 0;
    delete canvas.dataset.drawn;
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const seen of entries) {
        const canvas = seen.target as HTMLCanvasElement;
        if (!seen.isIntersecting) release(canvas);
        else if (!canvas.dataset.drawn) {
          canvas.dataset.drawn = "pending";
          void task.promise
            .then((doc) => drawPage(doc, canvas, container, drawing))
            .catch(() => {
              if (canvas.dataset.drawn === "pending")
                delete canvas.dataset.drawn;
            });
        }
      }
    },
    { rootMargin: "600px 0px" },
  );
  signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      for (const canvas of drawing.keys()) release(canvas);
      void task.destroy();
    },
    { once: true },
  );
  const doc = await task.promise;
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  signal.throwIfAborted();
  const count = Math.min(doc.numPages, MAX_PAGES);
  const pages = Array.from({ length: count }, (_, index) => {
    const canvas = document.createElement("canvas");
    canvas.className = "files-pdf-page";
    documents.set(canvas, doc);
    canvas.dataset.page = String(index + 1);
    canvas.width = 0;
    canvas.height = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Page ${index + 1} of ${doc.numPages}`);
    canvas.style.aspectRatio = `${first.width} / ${first.height}`;
    return canvas;
  });
  container.replaceChildren(
    ...pages.map((canvas) => {
      const frame = document.createElement("div");
      frame.className = "files-pdf-frame report-box-frame";
      frame.dataset.page = canvas.dataset.page;
      frame.append(canvas);
      return frame;
    }),
  );
  if (doc.numPages > count)
    container.append(
      note(
        `Showing the first ${count} of ${doc.numPages} pages. Download the file to see the rest.`,
      ),
    );
  for (const canvas of pages) observer.observe(canvas);
  container.dispatchEvent(new Event("recurse:pdf-pages", { bubbles: true }));
}

async function drawPage(
  doc: PDFDocumentProxy,
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  drawing: Map<HTMLCanvasElement, RenderTask>,
): Promise<void> {
  const page = await doc.getPage(Number(canvas.dataset.page));
  // Invariant: Released while the page loaded: it scrolled away or the view
  // closed.
  if (canvas.dataset.drawn !== "pending") return;
  const natural = page.getViewport({ scale: 1 });
  const width = container.clientWidth || natural.width;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  let scale = (width / natural.width) * ratio;
  const area = natural.width * natural.height * scale * scale;
  if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.aspectRatio = `${natural.width} / ${natural.height}`;
  const task = page.render({ canvas, viewport });
  drawing.set(canvas, task);
  try {
    await task.promise;
    canvas.dataset.drawn = "true";
  } finally {
    if (drawing.get(canvas) === task) drawing.delete(canvas);
    page.cleanup();
  }
}
