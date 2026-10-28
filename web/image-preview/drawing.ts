// The Files pane's Draw action. It opens the drawing editor (./editor.ts) over
// a loaded image and attaches the result to the composer; it is available only
// while the image has loaded and an attachment destination is ready.
import { openDrawingEditor } from "./editor.js";

let captureUpload: () => ((file: File) => void) | null = () => null;
export function setDrawingUploadCapture(capture: typeof captureUpload): void {
  captureUpload = capture;
}

export function canDraw(image: HTMLImageElement | null): boolean {
  return !!image?.complete && !!image.naturalWidth && !!captureUpload();
}

export function drawOn(
  image: HTMLImageElement | null,
  onDone?: () => void,
): void {
  const upload = captureUpload();
  if (image && upload && canDraw(image))
    openDrawingEditor(
      image,
      image.closest("dialog") ?? document.body,
      upload,
      onDone,
    );
}
