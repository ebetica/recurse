// Lazy drawing-editor canvas: locked photo fits at zoom 1 (screen-pixel ink).
// Export marks at natural photo scale, including those outside the image.
// The editor owns its decoded source; Files preview reloads cannot change it.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  exportToCanvas,
  getCommonBounds,
} from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";

const FILE_ID = "drawing-source" as FileId;
/** Scene units around the marks, so stroke width past their points survives. */
const PADDING = 64;
const INK = "#e03131"; // color-check: allow ink is image content

export interface DrawingCanvas {
  /** True while Escape belongs to Excalidraw (text, lines, menus, dialogs). */
  busy(): boolean;
  hasEdits(): boolean;
  exportPng(): Promise<Blob>;
  unmount(): void;
}

function readDataUrl(blob: Blob): Promise<DataURL> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function mountDrawingCanvas(
  stage: HTMLElement,
  image: HTMLImageElement,
): Promise<DrawingCanvas> {
  const source = await fetch(image.currentSrc || image.src, {
    cache: "force-cache",
  });
  if (!source.ok) throw new Error(`image ${source.status}`);
  const blob = await source.blob();
  const dataURL = await readDataUrl(blob);
  const photo = new Image();
  photo.src = dataURL;
  await photo.decode();
  const width = photo.naturalWidth;
  const height = photo.naturalHeight;
  const rect = stage.getBoundingClientRect();
  // Invariant: Leave room for Excalidraw's toolbars above and below the photo.
  const fit = Math.max(
    0.01,
    Math.min(1, (rect.width - 32) / width, (rect.height - 160) / height),
  );
  const file: BinaryFileData = {
    id: FILE_ID,
    mimeType: blob.type as BinaryFileData["mimeType"],
    dataURL,
    created: Date.now(),
  };
  const elements = convertToExcalidrawElements([
    {
      type: "image",
      fileId: FILE_ID,
      x: 0,
      y: 0,
      width: width * fit,
      height: height * fit,
      locked: true,
    },
  ]);
  const root = createRoot(stage);
  const api = await new Promise<ExcalidrawImperativeAPI>((resolve) =>
    root.render(
      createElement(
        Excalidraw,
        {
          excalidrawAPI: resolve,
          theme: "light",
          autoFocus: true,
          aiEnabled: false,
          validateEmbeddable: false,
          initialData: {
            elements,
            files: { [FILE_ID]: file },
            appState: {
              currentItemStrokeColor: INK,
              activeTool: {
                type: "freedraw",
                customType: null,
                locked: false,
                lastActiveTool: null,
              },
            },
            scrollToContent: true,
          },
          UIOptions: {
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              export: false,
              loadScene: false,
              saveAsImage: false,
              saveToActiveFile: false,
              toggleTheme: null,
            },
            tools: { image: false },
          },
        },
        createElement(
          MainMenu,
          null,
          createElement(MainMenu.DefaultItems.Help),
        ),
      ),
    ),
  );
  const marks = () =>
    api.getSceneElements().filter((element) => element.id !== elements[0].id);
  return {
    busy() {
      const state = api.getAppState();
      return !!(
        state.editingTextElement ||
        state.newElement ||
        state.multiElement ||
        state.editingLinearElement ||
        state.openMenu ||
        state.openPopup ||
        state.openDialog ||
        state.openSidebar ||
        state.contextMenu ||
        state.isCropping
      );
    },
    hasEdits: () => marks().length > 0,
    async exportPng() {
      const output = document.createElement("canvas");
      const drawn = marks();
      const scale = 1 / fit;
      const [minX, minY, maxX, maxY] = drawn.length
        ? getCommonBounds(drawn)
        : [0, 0, 0, 0];
      const stroke = Math.max(
        0,
        ...drawn.map((mark) =>
          mark.type === "freedraw"
            ? mark.strokeWidth * 4.25
            : mark.strokeWidth / 2,
        ),
      );
      const left = Math.min(0, Math.floor((minX - stroke) * scale));
      const top = Math.min(0, Math.floor((minY - stroke) * scale));
      output.width = Math.max(width, Math.ceil((maxX + stroke) * scale)) - left;
      output.height =
        Math.max(height, Math.ceil((maxY + stroke) * scale)) - top;
      const context = output.getContext("2d")!;
      if (output.width !== width || output.height !== height) {
        context.fillStyle = api.getAppState().viewBackgroundColor;
        context.fillRect(0, 0, output.width, output.height);
      }
      context.drawImage(photo, -left, -top, width, height);
      if (drawn.length) {
        const layer = await exportToCanvas({
          elements: drawn,
          files: api.getFiles(),
          appState: { exportBackground: false, exportWithDarkMode: false },
          exportPadding: PADDING,
          getDimensions: (w: number, h: number) => ({
            width: Math.ceil(w * scale),
            height: Math.ceil(h * scale),
            scale,
          }),
        });
        context.drawImage(
          layer,
          (minX - PADDING) * scale - left,
          (minY - PADDING) * scale - top,
        );
      }
      return await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (png) => (png ? resolve(png) : reject(new Error("toBlob failed"))),
          "image/png",
        ),
      );
    },
    unmount: () => root.unmount(),
  };
}
