// Native calls and indexes live in this isolated search process. Retain at most
// eight idle conversation bundles; busy bundles stay pinned until calls join.
// Shutdown destroys finders. IPC disconnect exits with native pools.
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

if (!process.send) throw new Error("File search requires parent IPC");
const port = {
  postMessage(reply: SearchReply): void {
    process.send!(reply);
  },
};
process.on("disconnect", () => process.exit(0));
type Bundle = Awaited<ReturnType<typeof loadFffTools>>;
type Connection = {
  cwd: string;
  flags: FffFlags;
  bundle: Promise<Bundle | undefined>;
  users: number;
};
const connections = new Map<number, Connection>();
const idle = new Map<number, Connection>();
const MAX_IDLE_CONNECTIONS = 8;
const closing = new Set<number>();
const calls = new Map<
  number,
  { connection: number; controller: AbortController; done: Promise<void> }
>();
let sealed = false;

/** Release least-recently-used idle indexes without closing logical tools. */
async function retainIdle(connection: number, state: Connection) {
  if (state.users || sealed || closing.has(connection)) return;
  idle.delete(connection);
  idle.set(connection, state);
  while (idle.size > MAX_IDLE_CONNECTIONS) {
    const [oldest, evicted] = idle.entries().next().value!;
    idle.delete(oldest);
    const released = evicted.bundle.then(async (bundle) => {
      await bundle?.close();
      return undefined;
    });
    evicted.bundle = released;
    await released;
  }
}

async function closeConnection(connection: number) {
  closing.add(connection);
  const ownCalls = [...calls.values()].filter(
    (call) => call.connection === connection,
  );
  await Promise.allSettled(ownCalls.map((call) => call.done));
  try {
    await (await connections.get(connection)?.bundle)?.close();
  } finally {
    idle.delete(connection);
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
    connections.set(message.connection, {
      cwd: message.cwd,
      flags: message.flags,
      bundle: opening,
      users: 0,
    });
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
  const state = connections.get(message.connection);
  if (!state) throw new Error("Search connection not found");
  state.users++;
  idle.delete(message.connection);
  try {
    const opening = state.bundle.then(
      (bundle) => bundle ?? loadFffTools(state.cwd, state.flags),
    );
    state.bundle = opening;
    const bundle = await opening;
    const tool = bundle.definitions.find((tool) => tool.name === message.name);
    if (!tool) throw new Error(`Unknown search tool: ${message.name}`);
    const call = calls.get(message.id)!;
    if (call.controller.signal.aborted) throw new Error("Operation aborted");
    return await tool.execute(
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
  } finally {
    state.users--;
    await retainIdle(message.connection, state);
  }
}

process.on("message", (message: SearchMessage) => {
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
