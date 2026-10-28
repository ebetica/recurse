// Reclaim retired trees off-thread with the existing no-follow sweep.
// One short-lived Worker per drain; settle only after termination is requested.

export function sweepTrash(
  roots: readonly string[],
  limit: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./trash_sweep_worker.ts", import.meta.url).href,
    );
    let settled = false;
    const finish = (error?: Error, removed?: number[]) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (error) reject(error);
      else resolve(removed!);
    };
    worker.onmessage = (event: MessageEvent<number[]>) =>
      finish(undefined, event.data);
    worker.onerror = (event) =>
      finish(new Error(`trash sweep worker failed: ${event.message}`));
    worker.addEventListener("close", () =>
      finish(new Error("trash sweep worker exited before completing")),
    );
    try {
      worker.postMessage({ roots, limit });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
