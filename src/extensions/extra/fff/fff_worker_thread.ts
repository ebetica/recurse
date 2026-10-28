// All native calls/bundles live on this shared search thread. Connection close
// drains its calls/finders; shutdown drains all. Never terminate healthy native
// calls before their watchers are destroyed.
import { parentPort } from "node:worker_threads";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  importFff,
  loadFffTools,
  type FffDefinition,
  type FffFlags,
  type FffResult,
  type FffToolInfo,
} from "./fff_tools.ts";

export type SearchRequest =
  | { op: "open"; connection: number; cwd: string; flags: FffFlags }
  | {
      op: "execute";
      connection: number;
      cwd: string;
      name: string;
      args: Parameters<FffDefinition["execute"]>[1];
    }
  | { op: "close"; connection: number }
  | { op: "warm" }
  | { op: "shutdown" };
export type SearchMessage =
  | (SearchRequest & { id: number })
  | { op: "abort"; id: number };
export type SearchValue = FffToolInfo[] | FffResult | undefined;
export type SearchReply =
  | { id: number; update: FffResult }
  | { id: number; value: SearchValue }
  | { id: number; error: string };

if (!parentPort) throw new Error("Search thread requires a parent port");
const port = parentPort;
const connections = new Map<
  number,
  Promise<Awaited<ReturnType<typeof loadFffTools>>>
>();
const closing = new Set<number>();
const calls = new Map<
  number,
  { connection: number; controller: AbortController; done: Promise<void> }
>();
let sealed = false;

async function closeConnection(connection: number) {
  closing.add(connection);
  const ownCalls = [...calls.values()].filter(
    (call) => call.connection === connection,
  );
  await Promise.allSettled(ownCalls.map((call) => call.done));
  try {
    await (await connections.get(connection))?.close();
  } finally {
    connections.delete(connection);
    closing.delete(connection);
  }
}

async function request(
  message: SearchRequest & { id: number },
): Promise<SearchValue> {
  if (message.op === "shutdown") {
    sealed = true;
    for (const call of calls.values()) call.controller.abort();
    await Promise.allSettled([...calls.values()].map((call) => call.done));
    const results = await Promise.allSettled(
      [...connections.keys()].map(closeConnection),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return;
  }
  if (sealed) throw new Error("Search worker closed");
  if (message.op === "warm") {
    await importFff();
    return;
  }
  if (message.op === "open") {
    const opening = loadFffTools(message.cwd, message.flags);
    connections.set(message.connection, opening);
    try {
      const bundle = await opening;
      return bundle.definitions.map(
        ({ name, label, description, parameters }) => ({
          name,
          label,
          description,
          parameters,
        }),
      );
    } catch (error) {
      connections.delete(message.connection);
      throw error;
    }
  }
  if (message.op === "close") {
    await closeConnection(message.connection);
    return;
  }
  if (closing.has(message.connection))
    throw new Error("Search connection closed");
  const bundle = await connections.get(message.connection);
  if (!bundle) throw new Error("Search connection not found");
  const tool = bundle.definitions.find((tool) => tool.name === message.name);
  if (!tool) throw new Error(`Unknown search tool: ${message.name}`);
  const call = calls.get(message.id)!;
  if (call.controller.signal.aborted) throw new Error("Operation aborted");
  const result = await tool.execute(
    String(message.id),
    message.args,
    call.controller.signal,
    (partial) =>
      port.postMessage({
        id: message.id,
        update: partial,
      } satisfies SearchReply),
    { cwd: message.cwd } as ExtensionToolContext,
  );
  return result;
}

port.on("message", (message: SearchMessage) => {
  if (message.op === "abort") {
    calls.get(message.id)?.controller.abort();
    return;
  }
  const done = request(message)
    .then(
      (value) =>
        port.postMessage({ id: message.id, value } satisfies SearchReply),
      (error: unknown) =>
        port.postMessage({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        } satisfies SearchReply),
    )
    .finally(() => {
      calls.delete(message.id);
    });
  if (message.op === "execute")
    calls.set(message.id, {
      connection: message.connection,
      controller: new AbortController(),
      done,
    });
});
