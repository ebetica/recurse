// Full-screen image editor; lazy-load Excalidraw/React/styles on first Draw.
// Fonts stay in /static/excalidraw/; CSP blocks the CDN fallback.
// Cancel discards; unused Escape confirms unsaved marks. Done attaches the
// export before notifying the preview to close.
import { restoreFocus } from "../focus_trap.js";
import { recordUiTiming } from "../interaction-timing.js";
import type { DrawingCanvas } from "./excalidraw.js";

interface Session {
  host: HTMLElement;
  actions: HTMLElement;
  ask: HTMLElement;
  canvas: DrawingCanvas | null;
  pending: (() => void) | null;
  inert: HTMLElement[];
  opener: HTMLElement | null;
}

let session: Session | null = null;
let stylesheet: Promise<void> | null = null;
let fontsFiltered = false;

/**
 * Drops off-origin sources from new FontFaces, so Excalidraw never lists its
 * CDN fallback (index.html's CSP would block it, logging one error per font).
 */
function filterFontSources(): void {
  if (fontsFiltered) return;
  fontsFiltered = true;
  const Native = window.FontFace;
  const local = (source: string) =>
    !/^url\(\s*["']?https?:/i.test(source) ||
    source.includes(`url(${location.origin}/`);
  window.FontFace = class extends Native {
    constructor(
      family: string,
      source: string | BufferSource,
      descriptors?: FontFaceDescriptors,
    ) {
      super(
        family,
        typeof source === "string"
          ? source
              .split(/,\s*(?=url\()/)
              .filter(local)
              .join(", ")
          : source,
        descriptors,
      );
    }
  };
}

function loadStylesheet(): Promise<void> {
  return (stylesheet ??= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/static/excalidraw/index.css";
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      stylesheet = null;
      reject(new Error("stylesheet"));
    };
    document.head.append(link);
  }));
}

export function openDrawingEditor(
  image: HTMLImageElement,
  modal: HTMLElement,
  upload: (file: File) => void,
  onDone?: () => void,
): void {
  closeDrawingEditor();
  const started = performance.now();
  const opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const host = document.createElement("div");
  host.className = "drawing-editor";
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "Draw on image");
  host.innerHTML = `<div class="drawing-editor-bar">
      <span role="status">Loading…</span>
      <span class="drawing-editor-actions">
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="button" class="btn primary" data-action="done" disabled>Done</button>
      </span>
      <span class="drawing-editor-actions" hidden>
        <button type="button" class="btn" data-action="keep">Keep editing</button>
        <button type="button" class="btn primary" data-action="discard">Discard</button>
      </span>
    </div>
    <div class="drawing-editor-stage"></div>`;
  const [actions, ask] = host.querySelectorAll<HTMLElement>(
    ".drawing-editor-actions",
  );
  const status = host.querySelector<HTMLElement>("[role=status]")!;
  const button = (action: string) =>
    host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
  const done = button("done");
  const inert = [...modal.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.inert,
  );
  for (const element of inert) element.inert = true;
  host.tabIndex = -1;
  modal.append(host);
  host.focus();
  const s: Session = {
    host,
    actions,
    ask,
    canvas: null,
    pending: null,
    inert,
    opener,
  };
  session = s;
  const keepEditing = () => {
    s.pending = null;
    ask.hidden = true;
    actions.hidden = false;
    status.textContent = "";
    host.querySelector<HTMLElement>(".excalidraw")?.focus();
  };
  host.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || ask.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      keepEditing();
    },
    true,
  );
  button("cancel").onclick = () => closeDrawingEditor();
  button("keep").onclick = keepEditing;
  button("discard").onclick = () => {
    const next = s.pending;
    closeDrawingEditor();
    next?.();
  };
  done.onclick = async () => {
    if (!s.canvas) return;
    done.disabled = true;
    status.textContent = "Saving…";
    let png: Blob;
    try {
      png = await s.canvas.exportPng();
    } catch {
      if (session === s) {
        status.textContent = "Could not save drawing. Try again.";
        done.disabled = false;
      }
      return;
    }
    if (session !== s) return;
    try {
      upload(new File([png], "drawing.png", { type: "image/png" }));
    } catch {
      status.textContent =
        "Return to the original conversation to add this drawing.";
      done.disabled = false;
      return;
    }
    closeDrawingEditor();
    onDone?.();
  };
  (window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
    "/static/excalidraw/";
  filterFontSources();
  void Promise.all([import("./excalidraw.js"), loadStylesheet()])
    .then(([module]) =>
      module.mountDrawingCanvas(
        host.querySelector(".drawing-editor-stage")!,
        image,
      ),
    )
    .then(
      (canvas) => {
        if (session !== s) return canvas.unmount();
        s.canvas = canvas;
        done.disabled = false;
        if (document.activeElement === host)
          host.querySelector<HTMLElement>(".excalidraw")?.focus();
        if (status.textContent === "Loading…") status.textContent = "";
        recordUiTiming("drawing-editor-open", performance.now() - started);
      },
      () => {
        if (session === s)
          status.textContent = "Could not open the drawing editor. Try again.";
      },
    );
}

/** Discards the open drawing, if any. */
export function closeDrawingEditor(): void {
  const s = session;
  if (!s) return;
  session = null;
  const focused = s.host.contains(document.activeElement);
  s.canvas?.unmount();
  s.host.remove();
  for (const element of s.inert) element.inert = false;
  // Invariant: Focus returns to Draw.
  if (focused) restoreFocus(s.opener);
}

/**
 * Escape outside Excalidraw: closes the editor, asking first when it has
 * unsaved marks. Returns false when no editor is open.
 */
export function closeDrawingFromKeyboard(): boolean {
  const s = session;
  if (!s) return false;
  if (!s.canvas?.hasEdits()) {
    closeDrawingEditor();
    return true;
  }
  s.pending = () => {};
  s.ask.hidden = false;
  s.actions.hidden = true;
  s.host.querySelector("[role=status]")!.textContent = "Discard your drawing?";
  s.host.querySelector<HTMLElement>('[data-action="keep"]')!.focus();
  return true;
}

export function drawingEditorOpen(): boolean {
  return !!session;
}

/** Keep editor keys, except Escape while Excalidraw is idle. */
export function drawingEditorOwnsKey(event: KeyboardEvent): boolean {
  if (!session?.host.contains(event.target as Node | null)) return false;
  if (event.key !== "Escape") return true;
  return !session.ask.hidden || !!session.canvas?.busy();
}
