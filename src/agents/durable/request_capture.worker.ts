// Serialize detached model requests, never credentials or provider calls.
import { parentPort } from "node:worker_threads";

const port = parentPort!;
port.on("message", ({ id, request }: { id: number; request: unknown }) => {
  try {
    port.postMessage({ id, json: JSON.stringify(request) });
  } catch {
    port.postMessage({ id, error: true });
  }
});
