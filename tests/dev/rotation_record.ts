// Test-only synchronous append order linearizes rotation events.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { openSync, writeSync } from "node:fs";
import { join } from "node:path";

const file = process.env.RECURSE_ROTATION_TRACE;
if (!file) throw new Error("RECURSE_ROTATION_TRACE is required");
const fd = openSync(file, "a", 0o600);
const prefix = randomUUID();
const objects = new WeakMap<object, string>();
const context = new AsyncLocalStorage<Record<string, string>>();
let next = 0;

export function tlaId(object: object, suffix = ""): string {
  let value = objects.get(object);
  if (!value) objects.set(object, (value = `${prefix}:${next++}`));
  return `${value}/${suffix}`;
}

export const tlaConn = (thread: any, connection: number) => ({
  p: thread.path,
  id: tlaId(thread.worker, String(connection)),
  s: tlaId(thread.worker),
  k: "connection",
});
export const tlaNative = (target: any, profile: object, owner: unknown) => ({
  p: target.path,
  id: tlaId(profile),
  k: "connection",
  enabled: !owner,
});
export const tlaRead = (request: any) => ({
  p: request.target.path,
  id: tlaId(request),
  k: "search",
});
export const tlaDeleted = (host: any, cid: string) => ({
  p: host.storagePath(cid),
  k: "page",
  enabled: host.deleting(cid),
});
export const tlaMove = (from: string, to?: string) => ({
  paths: [
    join(from, "session.sqlite"),
    ...(to ? [join(to, "session.sqlite")] : []),
  ],
});

function emit(a: string, data: Record<string, unknown>): void {
  const event = { a, p: "", id: "", k: "", s: "", op: "", ...data };
  const line = `${JSON.stringify(event)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > 4096 || writeSync(fd, line) !== bytes)
    throw new Error("incomplete rotation trace append");
}

export function tla(a: string, data: any): void {
  if (data.enabled === false) return;
  if (a === "dispatch") {
    const request = data.request;
    request.__rotation = {
      id: tlaId(data.scope, String(data.id)),
      s: tlaId(data.scope),
      op: request.op,
      p: data.path ?? request.target?.path ?? "",
    };
    if (["sync", "syncSearch", "prepare"].includes(request.op))
      emit(a, request.__rotation);
    return;
  }
  if (a === "receive" || a === "reply") {
    const value = data.__rotation;
    if (!value) throw new Error("worker request without trace correlation");
    if (a === "receive") context.enterWith(value);
    if (["sync", "syncSearch", "prepare"].includes(value.op)) emit(a, value);
    return;
  }
  if (data.paths) {
    for (const p of data.paths) emit(a, { p, k: data.k ?? "" });
    return;
  }
  const value = context.getStore();
  emit(a, { s: value?.s ?? "", ...data });
}

export function tlaWorker(url: string): Worker {
  const worker = new Worker(url, {
    preload: new URL("./rotation_preload.ts", import.meta.url).pathname,
  });
  worker.addEventListener("close", () =>
    emit("close-scope", { s: tlaId(worker) }),
  );
  return worker;
}

export async function tlaHold<T>(
  data: Record<string, string>,
  operation: () => Promise<T>,
): Promise<T> {
  tla("admit", data);
  try {
    return await operation();
  } finally {
    tla("close", data);
  }
}
