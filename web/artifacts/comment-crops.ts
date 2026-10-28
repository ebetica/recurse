// Box comments use the same owner-scoped uploads and image Markdown as the
// composer. Raster crops use source pixels; PDF crops render independently of
// the viewport canvas, which may already have released its offscreen pixels.
import {
  backendFor,
  parseConversationId,
  resolveUrl,
} from "../backends/backend.js";
import { cropPdfPage } from "../pdf-view.js";
import type { CommentBox } from "./artifact-state.js";

function boxFrame(pane: HTMLElement, box: CommentBox): Element | null {
  return pane.querySelector(
    `.report-box-frame${box.page ? `[data-page="${box.page}"]` : ""}`,
  );
}

export function commentBoxCoordinates(
  pane: HTMLElement,
  box: CommentBox,
): string {
  const image = boxFrame(pane, box)?.querySelector("img");
  if (image?.naturalWidth && image.naturalHeight) {
    const { naturalWidth: width, naturalHeight: height } = image;
    return `x=${Math.round(box.x * width)} y=${Math.round(box.y * height)} w=${Math.round(box.w * width)} h=${Math.round(box.h * height)} px in the ${width}×${height} original (x,y = top-left)`;
  }
  const at = (value: number) => value.toFixed(2);
  return `x=${at(box.x)} y=${at(box.y)} w=${at(box.w)} h=${at(box.h)} (fractions of width and height; x,y = top-left)`;
}

export async function uploadCommentCrop(
  pane: HTMLElement,
  box: CommentBox,
  filename: string,
  recipient: string,
): Promise<string> {
  const frame = boxFrame(pane, box);
  const image = frame?.querySelector("img");
  const page = frame?.querySelector("canvas");
  let canvas: HTMLCanvasElement;
  if (page) canvas = await cropPdfPage(page, box);
  else if (image) {
    const response = await fetch(image.currentSrc || image.src, {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Image unavailable");
    const blob = await response.blob();
    if (blob.type.includes("svg")) throw new Error("SVG crop unavailable");
    const source = await createImageBitmap(blob);
    try {
      const width = source.width * box.w,
        height = source.height * box.h;
      const scale = Math.min(1, 2048 / Math.max(width, height));
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(
        source,
        source.width * box.x,
        source.height * box.y,
        width,
        height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    } finally {
      source.close();
    }
  } else throw new Error("Box source unavailable");
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) =>
        result ? resolve(result) : reject(new Error("PNG encoding failed")),
      "image/png",
    ),
  );
  if (blob.size > 25 * 1024 * 1024)
    throw new Error("Crop exceeds upload limit");
  const body = new FormData();
  body.append("file", blob, filename);
  body.append("owner", parseConversationId(recipient).cid);
  const response = await backendFor(recipient).api("/api/attachments", {
    method: "POST",
    body,
  });
  if (!response.ok) throw new Error("Crop upload failed");
  const uploaded = (await response.json()) as { url: string };
  resolveUrl(backendFor(recipient), uploaded.url);
  return uploaded.url;
}
