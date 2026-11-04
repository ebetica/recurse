// Retire paths, expire partitions and reclaim trees off-thread while
// preserving pinned-descriptor/no-follow safety. One short-lived Worker per
// pass; settle only after termination is requested, including errors and exit.
import type { ExpiryOptions, ExpiryResult } from "./partition_expiry";
import { slowSpan } from "../observability/slow_span";

export type TrashWork =
  | { kind: "sweep"; roots: readonly string[]; limit: number }
  | { kind: "expire"; root: string; trashRoot: string; options: ExpiryOptions }
  | { kind: "retireDirectory"; path: string; trashRoot: string }
  | { kind: "retirePath"; path: string; trashRoot: string }
  | { kind: "retireFileSet"; path: string; companions: readonly string[] }
  | { kind: "retireAll"; paths: readonly string[]; trashRoot: string };

export type TrashFailure = {
  name: string;
  message: string;
  code?: string;
  errno?: number;
};
export type RetireBatchResult = {
  retired: number;
  failures: { error: TrashFailure; path: string }[];
};
export type TrashReply<T> =
  | { ok: true; value: T }
  | { ok: false; error: TrashFailure };

/** Retire any entry without following symlinks; pin its parent off-thread. */
export function retirePath(path: string, trashRoot: string): Promise<boolean> {
  return runWork({ kind: "retirePath", path, trashRoot });
}

/** Retire a batch off-thread, reporting isolated filesystem errors. */
export async function retireAll(
  paths: readonly string[],
  trashRoot: string,
  log?: (error: Error, path: string) => void,
): Promise<number> {
  if (paths.length === 0) return 0;
  const result = await runWork<RetireBatchResult>({
    kind: "retireAll",
    paths,
    trashRoot,
  });
  for (const { error, path } of result.failures)
    log?.(Object.assign(new Error(error.message), error), path);
  return result.retired;
}

/** Retire an entry and plain-file companions under one pinned parent. */
export function retireFileSet(
  path: string,
  companions: readonly string[],
): Promise<boolean> {
  return runWork({ kind: "retireFileSet", path, companions });
}

export function retireDirectory(
  path: string,
  trashRoot: string,
): Promise<boolean> {
  return runWork({ kind: "retireDirectory", path, trashRoot });
}

export function sweepTrash(
  roots: readonly string[],
  limit: number,
): Promise<number[]> {
  return runWork({ kind: "sweep", roots, limit });
}

export function expirePartitions(
  root: string,
  trashRoot: string,
  options: ExpiryOptions,
): Promise<ExpiryResult> {
  return runWork({ kind: "expire", root, trashRoot, options });
}

function runWork<T>(request: TrashWork): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = slowSpan(
      "trash_worker_create",
      undefined,
      () =>
        new Worker(new URL("./trash_sweep.worker.ts", import.meta.url).href),
    );
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    worker.onmessage = (event: MessageEvent<TrashReply<T>>) => {
      const reply = event.data;
      if (reply.ok) finish(undefined, reply.value);
      else finish(Object.assign(new Error(reply.error.message), reply.error));
    };
    worker.onerror = (event) =>
      finish(new Error(`trash worker failed: ${event.message}`));
    worker.addEventListener("close", () =>
      finish(new Error("trash worker exited before completing")),
    );
    try {
      worker.postMessage(request);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
