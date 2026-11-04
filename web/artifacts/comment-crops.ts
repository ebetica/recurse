// Box crops use owner-scoped uploads. Work starts when the box is drawn;
// prepared sources and crops survive the viewer and failed upload attempts.
import {
  backendFor,
  parseConversationId,
  resolveUrl,
} from "../backends/backend.js";
import { holdPdfPage } from "../pdf-view.js";
import { encodeRasterCrop } from "./crop-encoder.js";
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
interface ImageSource {
  bitmap: Promise<ImageBitmap>;
  refs: number;
}
const images = new WeakMap<HTMLImageElement, ImageSource>();
export interface PreparedCrop {
  prepare(): Promise<Blob>;
  release(): void;
}
/** Snapshot and start a crop while its viewer is still mounted. */
export function prepareCommentCrop(
  pane: HTMLElement,
  box: CommentBox,
): PreparedCrop {
  const frame = boxFrame(pane, box);
  const image = frame?.querySelector("img");
  const page = frame?.querySelector("canvas");
  let pdf: ReturnType<typeof holdPdfPage> | null = null;
  try {
    if (page) pdf = holdPdfPage(page);
  } catch {}
  let source = image ? images.get(image) : undefined;
  if (image && !source) {
    source = { bitmap: createImageBitmap(image), refs: 0 };
    images.set(image, source);
    void source.bitmap.catch(() => {});
  }
  if (source) source.refs++;
  let preparing: Promise<Blob> | null = null;
  let released = false;
  const prepare = (): Promise<Blob> => {
    if (preparing) return preparing;
    preparing = (async () => {
      if (source) {
        return encodeRasterCrop(await source.bitmap, box);
      }
      if (pdf) {
        const canvas = await pdf.crop(box);
        const bitmap = await createImageBitmap(canvas);
        try {
          return await encodeRasterCrop(bitmap, { x: 0, y: 0, w: 1, h: 1 });
        } finally {
          bitmap.close();
        }
      }
      throw new Error("Box source unavailable");
    })().catch((error) => {
      preparing = null;
      throw error;
    });
    return preparing;
  };
  const crop: PreparedCrop = {
    prepare,
    release: () => {
      if (released) return;
      released = true;
      const done = preparing?.catch(() => {}) ?? Promise.resolve();
      void done.then(() => {
        pdf?.release();
        if (source && --source.refs === 0) {
          if (image) images.delete(image);
          void source.bitmap.then((bitmap) => bitmap.close()).catch(() => {});
        }
      });
    },
  };
  void prepare().catch(() => {});
  return crop;
}

/** Upload an encoded crop to the recipient's attachment collection. */
export async function uploadBlob(
  blob: Blob,
  filename: string,
  recipient: string,
  key: string,
  expires: number,
): Promise<string> {
  if (blob.size > 25 * 1024 * 1024)
    throw new Error("Crop exceeds upload limit");
  const body = new FormData();
  body.append("file", blob, filename);
  body.append("owner", parseConversationId(recipient).cid);
  body.append("crop_key", key);
  body.append("crop_expires", String(expires));
  const response = await backendFor(recipient).api("/api/attachments", {
    method: "POST",
    body,
  });
  if (!response.ok) throw new Error("Crop upload failed");
  const uploaded = (await response.json()) as { url: string };
  resolveUrl(backendFor(recipient), uploaded.url);
  return uploaded.url;
}
