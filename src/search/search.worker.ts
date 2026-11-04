// Query Workers decode ripgrep and reap aborted children without importing
// SQLite. Standalone projection callers load their fallback writer lazily.
import { runRipgrep } from "./query.worker";
import type { SearchFile, SearchOptions, SearchTarget } from "./index";

export type Work =
  | { op: "sync"; target: SearchTarget }
  | {
      op: "query";
      files: SearchFile[];
      options: Omit<SearchOptions, "signal">;
    };
export type Request = (Work & { id: number }) | { op: "cancel"; id: number };

const controllers = new Map<number, AbortController>();
declare const self: Worker;
self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.op === "cancel") {
    controllers.get(request.id)?.abort();
    return;
  }
  // Spec: @tla receive request
  const controller = new AbortController();
  controllers.set(request.id, controller);
  try {
    const value =
      request.op === "query"
        ? await runRipgrep(
            request.files,
            request.options,
            controller.signal,
            (event, fields) => self.postMessage({ log: { event, fields } }),
          )
        : (await import("./sync.worker")).sync(request.target);
    // Spec: @tla reply request
    self.postMessage({ id: request.id, value });
  } catch (error) {
    // Spec: @tla reply request
    self.postMessage({ id: request.id, error: (error as Error).message });
  } finally {
    controllers.delete(request.id);
  }
};
