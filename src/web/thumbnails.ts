// Thread-sized previews: Bun's off-thread codec re-encodes PNG, JPEG and WebP
// as WebP with the long side at most THUMBNAIL_LONG_SIDE (2x a thread image).
// GIFs, animated PNGs, sizes outside THUMBNAIL_MIN/MAX_BYTES, oversized
// decodes and results that are not smaller keep the original bytes.
/** 2x the thread's widest inline image; full-screen views use the original. */
export const THUMBNAIL_LONG_SIDE = 1024;
/** Smaller originals are sent as they are. */
export const THUMBNAIL_MIN_BYTES = 128 * 1024;
/** Larger originals are sent as they are (read memory bound per slot). */
export const THUMBNAIL_MAX_BYTES = 25 * 1024 * 1024;
/** Decoded pixels above this are never thumbnailed (decode memory bound). */
export const THUMBNAIL_MAX_PIXELS = 50_000_000;
const QUALITY = 80;
const RESIZABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

interface BunImage {
  metadata(): Promise<{ width: number; height: number }>;
  resize(width: number, height: number): BunImage;
  webp(options: { quality: number }): BunImage;
  bytes(): Promise<Uint8Array>;
}
const Image = (Bun as unknown as { Image: new (data: Uint8Array) => BunImage })
  .Image;
/** Resizes running at once; each holds one original and its decode. */
export const THUMBNAIL_SLOTS = 2;
/** Requests waiting for a slot; later ones get the original at once. */
export const THUMBNAIL_QUEUE = 16;
/** Chunks scanned for PNG animation before the original is kept instead. */
const PNG_SCAN_CHUNKS = 64;
let free = THUMBNAIL_SLOTS;
const queue = new Set<() => void>();

/** True when an original of this media type and size is worth resizing. */
export function resizable(media: string, size: number): boolean {
  return (
    RESIZABLE.has(media) &&
    size > THUMBNAIL_MIN_BYTES &&
    size <= THUMBNAIL_MAX_BYTES
  );
}

/**
 * Reads an original only once admitted to a resize slot; returns its WebP
 * thumbnail, "busy" when cancelled or the queue is full, else null.
 */
export async function thumbnail(
  read: () => Promise<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array | "busy" | null> {
  if (!(await admitted(signal))) return "busy";
  try {
    const data = await read();
    if (animatedPng(data) !== false) return null;
    const { width, height } = await new Image(data).metadata();
    if (!width || !height || width * height > THUMBNAIL_MAX_PIXELS) return null;
    const scale = Math.min(1, THUMBNAIL_LONG_SIDE / Math.max(width, height));
    const out = await new Image(data)
      .resize(
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)),
      )
      .webp({ quality: QUALITY })
      .bytes();
    return out.byteLength < data.byteLength ? out : null;
  } catch {
    // Invariant: An image the codec cannot read still shows its original.
    return null;
  } finally {
    const next = queue.values().next().value;
    if (next) next();
    else free += 1;
  }
}

/** Waits for a resize slot; false when cancelled or the queue is full. */
function admitted(signal: AbortSignal): Promise<boolean> | boolean {
  if (signal.aborted) return false;
  if (free > 0) return ((free -= 1), true);
  if (queue.size >= THUMBNAIL_QUEUE) return false;
  return new Promise((resolve) => {
    const settle = (granted: boolean) => {
      queue.delete(admit);
      signal.removeEventListener("abort", cancel);
      resolve(granted);
    };
    const admit = () => settle(true);
    const cancel = () => settle(false);
    queue.add(admit);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/**
 * True for a PNG with an animation chunk before its image data; null (keep
 * the original) when the first PNG_SCAN_CHUNKS chunks hold no image data.
 */
function animatedPng(data: Uint8Array): boolean | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const png = [0x89, 0x50, 0x4e, 0x47];
  if (!png.every((byte, index) => data[index] === byte)) return false;
  let at = 8;
  for (
    let chunk = 0;
    chunk < PNG_SCAN_CHUNKS && at + 8 <= data.length;
    chunk++
  ) {
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    at += 12 + view.getUint32(at);
  }
  return null;
}
