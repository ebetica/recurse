// Encode image-box crops off the browser's main thread. This function has no
// external bindings because its bundled source is loaded into a Blob worker.
/** Install the worker's crop encoder. */
export function cropWorkerMain(): void {
  const worker = self as unknown as {
    addEventListener(
      type: "message",
      listener: (
        event: MessageEvent<{ id: number; bitmap: ImageBitmap }>,
      ) => void,
    ): void;
    postMessage(message: { id: number; blob?: Blob; error?: string }): void;
  };
  worker.addEventListener("message", (event) => {
    const { id, bitmap } = event.data;
    void (async () => {
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({
          type: "image/jpeg",
          quality: 0.85,
        });
        worker.postMessage({ id, blob });
      } catch {
        worker.postMessage({ id, error: "Crop encoding failed" });
      } finally {
        bitmap.close();
      }
    })();
  });
}
