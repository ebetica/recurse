// One hook event in a fresh Bun process (run.ts): load a Pi extension file
// with a stub `pi`, run its handlers for the event as Pi does, and report over
// IPC; if the server goes away first, stop the whole group. Only `pi.on`,
// `pi.exec` and the IGNORED calls work; other `pi.*` and `ctx.*` throw.
import { pathToFileURL } from "node:url";

type Input = {
  file: string;
  event?: string;
  payload?: Record<string, unknown>;
  agentId: string;
  timeouts: { fallback: number; max: number };
};
type Handler = (event: unknown, ctx: unknown) => unknown;
type Message = Record<string, unknown>;

const send = (message: Message) => process.send!(message);
// Exit only once the last message is written; an early exit can lose it.
const finish = (message: Message, code = 0): void =>
  void process.send!(message, undefined, undefined, () => process.exit(code));
/** The error's message, with the line and column of a load error. */
const describe = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  const at = (error as { position?: { line?: number; column?: number } })
    .position;
  return at?.line
    ? `${error.message} at ${at.line}:${at.column}`
    : error.message;
};
const fail = (error: unknown) => finish({ error: describe(error) }, 1);
/** No-op Pi calls, reported as `pi.<name>` events so listings flag them. */
const IGNORED = [
  "registerCommand",
  "registerTool",
  "registerShortcut",
  "registerFlag",
  "registerMessageRenderer",
];
const unsupported = (name: string) => () => {
  throw new Error(`${name} is not supported in Recurse hooks`);
};
const object = (value: unknown): value is Message =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function exec(
  command: string,
  args: string[] = [],
  options: { signal?: AbortSignal; timeout?: number; cwd?: string } = {},
) {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd ?? process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
    timeout: options.timeout,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, killed: proc.signalCode !== null };
}

async function run(input: Input): Promise<void> {
  const handlers = new Map<string, Handler[]>();
  const ignored = new Set<string>();
  const api: Message = {
    ...Object.fromEntries(
      IGNORED.map((name) => [name, () => void ignored.add(`pi.${name}`)]),
    ),
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      handlers.set(name, [...list, handler]);
      return () => {
        const current = handlers.get(name) ?? [];
        handlers.set(
          name,
          current.filter((item) => item !== handler),
        );
      };
    },
    exec,
  };
  const pi = new Proxy(api, {
    get: (target, key) =>
      typeof key === "symbol" || key === "then"
        ? undefined
        : (target[key] ?? unsupported(`pi.${key}`)),
  });
  const module = (await import(pathToFileURL(input.file).href)) as Message;
  if (typeof module.default !== "function")
    throw new Error("the file has no default export function");
  const timeout =
    typeof module.timeout === "number" && module.timeout > 0
      ? Math.min(module.timeout, input.timeouts.max)
      : input.timeouts.fallback;
  if (typeof module.timeout === "number" && module.timeout > timeout)
    ignored.add(
      `timeout ${module.timeout / 1000} s (uses ${timeout / 1000} s)`,
    );
  await (module.default as (pi: unknown) => unknown)(pi);
  const loaded = { events: [...handlers.keys(), ...ignored], timeout };
  if (!input.event) return finish(loaded);
  send(loaded);
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
    fail(new Error(`timed out after ${timeout / 1000} s`));
  }, timeout);
  const ui = new Proxy({}, { get: () => () => undefined });
  const fields: Message = {
    cwd: process.cwd(),
    signal: controller.signal,
    hasUI: false,
    agentId: input.agentId,
    ui,
  };
  const ctx = new Proxy(fields, {
    get: (target, key) => {
      if (typeof key === "symbol" || key === "then" || key === "toJSON")
        return undefined;
      if (key in target) return target[key];
      throw new Error(`ctx.${key} is not supported in Recurse hooks`);
    },
  });
  const event: Message = { type: input.event, ...input.payload };
  const messages: unknown[] = [];
  const replaced = new Set<string>();
  for (const handler of handlers.get(input.event) ?? []) {
    const result = await handler(event, ctx);
    if (!object(result)) continue;
    if (input.event === "tool_call" && result.block) {
      return finish({ result: { block: true, reason: result.reason } });
    }
    if (input.event === "tool_call" && object(result.input))
      event.input = result.input;
    if (
      input.event === "session_before_compact" &&
      (result.cancel === true || result.compaction !== undefined)
    )
      return finish({ result });
    if (input.event === "before_agent_start" && result.message !== undefined)
      messages.push(result.message);
    const keys = {
      tool_result: ["content", "details", "isError"],
      agent_before_settle: ["entries", "continue"],
      context: ["messages"],
    }[input.event];
    for (const key of keys ?? [])
      if (result[key] !== undefined) {
        event[key] = result[key];
        replaced.add(key);
      }
  }
  const { input: args, content, details, isError, entries } = event;
  finish({
    result: {
      tool_call: { input: args },
      tool_result: { content, details, isError },
      before_agent_start: { messages },
      agent_before_settle: { entries, continue: event.continue },
      context: replaced.has("messages") ? { messages: event.messages } : {},
      session_before_compact: {},
    }[input.event],
  });
}

process.on("disconnect", () => process.kill(-process.pid, "SIGKILL"));
process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);
process.once("message", (input) => run(input as Input).catch(fail));
