// Preserve pinned-descriptor and same-filesystem safety off-thread.
import { expireInWorker } from "./partition_expiry.worker";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  statSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { retire, retireAll, retireWithinParent, sweep } from "./trash";
import type {
  RetireBatchResult,
  TrashFailure,
  TrashReply,
  TrashWork,
} from "./trash_sweep";

declare const self: Worker;

self.onmessage = (event: MessageEvent<TrashWork>) => {
  let reply: TrashReply<unknown>;
  try {
    reply = { ok: true, value: execute(event.data) };
  } catch (error) {
    reply = { ok: false, error: serializeFailure(error) };
  }
  self.postMessage(reply);
};

function execute(request: TrashWork): unknown {
  if (request.kind === "expire")
    return expireInWorker(request.root, request.trashRoot, request.options);
  if (request.kind === "retireDirectory")
    return retireDirectory(request.path, request.trashRoot);
  if (request.kind === "retirePath")
    return retire(request.path, request.trashRoot);
  if (request.kind === "retireFileSet")
    return retireFileSet(request.path, request.companions);
  if (request.kind === "retireAll") {
    const failures: RetireBatchResult["failures"] = [];
    const retired = retireAll(request.paths, request.trashRoot, (error, path) =>
      failures.push({ error: serializeFailure(error), path }),
    );
    return { retired, failures } satisfies RetireBatchResult;
  }
  return request.roots.map((root) => sweep(root, request.limit));
}

function serializeFailure(error: unknown): TrashFailure {
  const failure = error as Error & { code?: string; errno?: number };
  return {
    name: failure.name ?? "Error",
    message: String(failure.message ?? error),
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.errno === undefined ? {} : { errno: failure.errno }),
  };
}

function retireFileSet(path: string, companions: readonly string[]): boolean {
  const parent = dirname(path);
  if (companions.some((entry) => dirname(entry) !== parent))
    throw new Error("retirement entries must share one parent");
  let fd: number;
  try {
    fd = openSync(
      parent,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        ((constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0),
    );
  } catch {
    return false;
  }
  try {
    const paths = [path];
    for (const entry of companions) {
      try {
        if (statSync(entry).isFile()) paths.push(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let retired = true;
    for (const entry of paths) {
      try {
        if (!retireWithinParent(fd, basename(entry), ".trash")) {
          // Invariant: The caller fences recreation until retirement returns.
          if (existsSync(entry) && statSync(entry).isFile()) retired = false;
        }
      } catch {
        retired = false;
      }
    }
    return retired;
  } finally {
    closeSync(fd);
  }
}

function retireDirectory(path: string, trashRoot: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
  } catch {
    return false;
  }
  return retire(path, trashRoot);
}
