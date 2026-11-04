// Raster box encoding runs in a worker; browsers without one use a canvas.
import type { CommentBox } from "./artifact-state.js";
import { cropWorkerMain } from "./crop-worker.js";
let encoder: Worker | null = null;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (blob: Blob) => void; reject: (error: Error) => void }
>();
function worker(): Worker {
  if (encoder) return encoder;
  const script = new Blob([`(${cropWorkerMain.toString()})()`], {
    type: "text/javascript",
  });
  const url = URL.createObjectURL(script);
  let instance: Worker;
  try {
    instance = new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  instance.onmessage = (event: MessageEvent<{ id: number; blob?: Blob }>) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    pending.delete(event.data.id);
    if (event.data.blob) job.resolve(event.data.blob);
    else job.reject(new Error("Crop encoding failed"));
  };
  instance.onerror = () => {
    for (const job of pending.values())
      job.reject(new Error("Crop worker unavailable"));
    pending.clear();
    instance.terminate();
    if (encoder === instance) encoder = null;
  };
  encoder = instance;
  return instance;
}
/** Crop and encode a decoded image without blocking the viewer's thread. */
export async function encodeRasterCrop(
  source: ImageBitmap,
  box: CommentBox,
): Promise<Blob> {
  const width = source.width * box.w,
    height = source.height * box.h;
  const scale = Math.min(1, 1568 / Math.max(width, height));
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    try {
      const bitmap = await createImageBitmap(
        source,
        Math.round(source.width * box.x),
        Math.round(source.height * box.y),
        Math.max(1, Math.round(width)),
        Math.max(1, Math.round(height)),
        {
          resizeWidth: outputWidth,
          resizeHeight: outputHeight,
          resizeQuality: "high",
        },
      );
      const instance = worker();
      const id = ++sequence;
      return await new Promise<Blob>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          instance.postMessage({ id, bitmap }, [bitmap]);
        } catch (error) {
          pending.delete(id);
          bitmap.close();
          reject(error);
        }
      });
    } catch {}
  }
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
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
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Crop encoding failed")),
      "image/jpeg",
      0.85,
    ),
  );
}
