// Shared, bounded models.json loader; no file values enter Pi's resolvers.
import { Worker } from "node:worker_threads";
import { lstat } from "node:fs/promises";
import type { PiModelConfigSnapshot } from "./pi_model_config.worker";
export type { PiModelConfigSnapshot } from "./pi_model_config.worker";

const MAX_BYTES = 1024 * 1024;
const LOAD_DEADLINE_MS = 2000;
const warned = new Set<string>();

/** Warn once per invalid config path, without its contents. */
export function reportPiModelConfigError(
  message: string,
  warn: (message: string) => void,
  scope = "",
): void {
  const key = `${scope}:${message}`;
  if (warned.has(key)) return;
  warned.add(key);
  if (warned.size > 1024) warned.delete(warned.values().next().value!);
  warn(message);
}

/** Inspect revisions and load restricted data, falling back on any failure. */
export async function readPiModelConfig(
  path: string,
  builtins: [string, string[]][],
  previousRevision?: string,
  reserved: string[] = [],
): Promise<{ revision?: string; snapshot: PiModelConfigSnapshot } | undefined> {
  const invalid = (): { snapshot: PiModelConfigSnapshot } => ({
    snapshot: { providers: [], headers: [], invalid: true, restricted: false },
  });
  let worker: Worker | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const load = async () => {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (finished) return invalid();
      const revision = info
        ? `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.mode}`
        : "missing";
      if (revision === previousRevision) return undefined;
      if (!info)
        return {
          revision,
          snapshot: {
            providers: [],
            headers: [],
            invalid: false,
            restricted: false,
          },
        };
      if (!info.isFile() || info.size > MAX_BYTES)
        return { ...invalid(), revision };
      worker = new Worker(
        new URL("./pi_model_config.worker.ts", import.meta.url),
      );
      const snapshot = await new Promise<PiModelConfigSnapshot>(
        (resolve, reject) => {
          worker!.once("message", resolve);
          const failed = () =>
            reject(new Error("Model configuration worker failed"));
          worker!.once("error", failed);
          worker!.once("exit", failed);
          worker!.postMessage({
            path,
            builtins,
            reserved,
            maxBytes: MAX_BYTES,
          });
        },
      );
      return { revision, snapshot };
    };
    return await Promise.race([
      load(),
      new Promise<ReturnType<typeof invalid>>((resolve) => {
        timer = setTimeout(() => {
          finished = true;
          resolve(invalid());
        }, LOAD_DEADLINE_MS);
      }),
    ]);
  } catch {
    return invalid();
  } finally {
    finished = true;
    clearTimeout(timer);
    if (worker) {
      void worker.terminate().catch(() => {});
      worker.unref();
    }
  }
}
