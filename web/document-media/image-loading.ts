// Browser image load/decode boundary for Artifact placeholders.
export interface ArtifactImageElement {
  src: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  addEventListener(
    type: "load" | "error",
    listener: () => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: "load" | "error", listener: () => void): void;
  removeAttribute(name: string): void;
  decode?(): Promise<void>;
}

export interface DecodedArtifactImage {
  width: number;
  height: number;
}

export async function loadDecodedArtifactImage(
  image: ArtifactImageElement,
  source: string,
  signal?: AbortSignal,
): Promise<DecodedArtifactImage> {
  if (signal?.aborted)
    throw new DOMException("Image load aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | DOMException) => {
      if (settled) return;
      settled = true;
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish();
    const failed = () =>
      finish(new Error("Artifact image could not be loaded"));
    const aborted = () => {
      image.removeAttribute("src");
      finish(new DOMException("Image load aborted", "AbortError"));
    };
    image.addEventListener("load", loaded, { once: true });
    image.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    image.src = source;
    // Invariant: A cached success may complete synchronously without a later
    // load event. complete can remain transiently true with zero dimensions
    // just after src changes, so only positive dimensions settle here; real
    // failures emit error.
    if (image.complete && image.naturalWidth > 0) queueMicrotask(loaded);
  });
  if (signal?.aborted)
    throw new DOMException("Image load aborted", "AbortError");
  if (image.decode)
    try {
      const decoding = image.decode();
      if (!signal) await decoding;
      else
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            image.removeAttribute("src");
            reject(new DOMException("Image load aborted", "AbortError"));
          };
          signal.addEventListener("abort", aborted, { once: true });
          decoding
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", aborted));
        });
    } catch (error) {
      // Invariant: Chromium may reject decode() for a loaded, dimensioned SVG
      // even though it is already renderable in <img>. A load with no
      // dimensions remains broken.
      if (signal?.aborted || image.naturalWidth <= 0) throw error;
    }
  if (signal?.aborted)
    throw new DOMException("Image load aborted", "AbortError");
  if (image.naturalWidth <= 0)
    throw new Error("Artifact image could not be decoded");
  return { width: image.naturalWidth, height: image.naturalHeight };
}
