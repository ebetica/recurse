// An agent's local hooks, then the global ones, each in name order, chained
// file to file; the first block ends a tool_call chain. No hook files: one
// readdir per scope per model request or tool call ("Run hooks" off: none). A
// file runs for events it registered when last loaded; only events load one.
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { HookRunError, runHook } from "./run";

/** The Pi events Recurse runs; other `pi.on` registrations never run. */
const HOOK_EVENTS = [
  "before_agent_start",
  "tool_call",
  "tool_result",
  "agent_before_settle",
  "agent_settled",
  "context",
  "session_before_compact",
];
/** How many `agent_before_settle` continuations may follow in a row. */
const MAX_CONTINUATIONS = 8;
/** How many conversations' current runs are remembered. */
const MAX_RUNS = 256;
/** How many files' registered events are remembered. */
const MAX_LOADED = 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ts$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_SOURCE_BYTES = 256 * 1024;

interface HooksOptions {
  /** `<pi-agent>/hooks`. */
  dir: string;
  /** `$CHAT_DATA_DIR/hooks/agents`, one directory per agent id. */
  agentsDir: string;
  /** The "Run hooks" setting. */
  enabled(): boolean;
  own(proc: Subprocess, cid: string): Promise<void>;
  release(proc: Subprocess): Promise<boolean>;
  log(event: string, fields: Record<string, unknown>): void;
  /** A conversation's running hooks changed. */
  changed(cid: string): void;
  /** Make hook text that becomes a user message unable to claim an origin. */
  quote(text: string): string;
}

export type HookScope = () => Promise<{
  cwd: string;
  env: Record<string, string>;
}>;
type HookFile = {
  name: string;
  path: string;
  version: string;
  scope: "local" | "global";
};
type Content = readonly unknown[];
type ToolCallInput = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  parent?: { callId: string };
};
type ToolResultInput = {
  content: Content;
  details?: unknown;
  isError: boolean;
};
type RequestInput = {
  conversation: string;
  /** Names the run: the input that started it. */
  run: string;
  messages: readonly unknown[];
  /** Aborted when the run is stopped. */
  signal?: AbortSignal;
};
type RunKey = Pick<RequestInput, "conversation" | "run">;
type Failure = { file: HookFile; error: unknown };
type RunState = {
  run: string;
  /** When its first model request or answer with hook files was seen. */
  at: number;
  /** Its last answer's text. */
  answer?: string;
  continued: number;
  /** Run-start text, added ahead of the user message whose timestamp is `at`. */
  start?: { text: string; at?: unknown };
};

type HookListing = {
  name: string;
  path: string;
  scope: HookFile["scope"];
  source?: string;
  events?: string[];
  unsupported?: string[];
  failure?: { at: number; error: string };
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class Hooks {
  // By path: the events a file registered when it last loaded.
  private readonly loaded = new Map<
    string,
    { version: string; events: string[] }
  >();
  private readonly live = new Map<string, Map<symbol, RunningHook>>();
  // By path: each file's last failure.
  private readonly failures = new Map<string, { at: number; error: string }>();
  // By agent and Durable conversation: its current run, until a restart.
  private readonly runs = new Map<string, RunState>();
  // By agent and conversation: local files its current run's model was told failed.
  private readonly told = new Map<
    string,
    { run: string; files: Set<string> }
  >();

  constructor(private readonly options: HooksOptions) {}

  /** The hooks running for `cid` now, oldest first. */
  running(cid: string): RunningHook[] {
    return [...(this.live.get(cid)?.values() ?? [])];
  }

  /** An agent's local hook directory. */
  private localDir(cid: string): string {
    if (!AGENT.test(cid)) throw new HookSettingsError("No such agent.");
    return join(this.options.agentsDir, cid);
  }

  /** The hook files that run for `cid`, in run order; none when "Run hooks"
   * is off. */
  async files(cid: string): Promise<HookFile[]> {
    if (!this.options.enabled()) return [];
    return [
      ...(AGENT.test(cid) ? await this.scan(this.localDir(cid), "local") : []),
      ...(await this.scan(this.options.dir, "global")),
    ];
  }

  private async scan(
    dir: string,
    scope: HookFile["scope"],
  ): Promise<HookFile[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      names = [];
    }
    const files: HookFile[] = [];
    for (const name of names.filter((name) => NAME.test(name)).sort()) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile())
        files.push({
          name,
          path,
          scope,
          version: `${info.size}:${info.mtimeMs}`,
        });
    }
    for (const map of [this.loaded, this.failures])
      for (const path of map.keys())
        if (dirname(path) === dir && !files.some((file) => file.path === path))
          map.delete(path);
    return files;
  }

  /** Run the `tool_call` handlers; the first block wins. */
  async toolCall(
    cid: string,
    scope: HookScope,
    call: ToolCallInput,
    key: () => Promise<RunKey>,
    signal?: AbortSignal,
  ): Promise<{
    input?: Record<string, unknown>;
    block?: string;
    notes: string[];
  }> {
    const failures: Failure[] = [];
    let input = call.arguments;
    let block: string | undefined;
    for (const file of await this.handling(cid, "tool_call")) {
      try {
        const result = await this.run(
          file,
          cid,
          scope,
          "tool_call",
          {
            toolCallId: call.id,
            toolName: call.name,
            input,
            ...(call.parent && { parentToolCallId: call.parent.callId }),
          },
          signal,
        );
        if (!object(result)) throw new Error("returned an invalid result");
        if (result.block === true) {
          block = `Hook "${file.name}" (${file.scope}): ${typeof result.reason === "string" && result.reason ? result.reason : "blocked"}`;
          break;
        }
        if (!object(result.input))
          throw new Error("left event.input not an object");
        input = result.input;
      } catch (error) {
        failures.push({ file, error });
      }
    }
    const notes = await this.tell(cid, key, failures, "call ran unchanged");
    if (block !== undefined) return { block, notes };
    return input === call.arguments ? { notes } : { input, notes };
  }

  /** Run the `tool_result` handlers, each patching the result it is given. */
  async toolResult(
    cid: string,
    scope: HookScope,
    call: ToolCallInput,
    result: ToolResultInput,
    key: () => Promise<RunKey>,
    signal?: AbortSignal,
  ): Promise<{ result?: ToolResultInput; notes: string[] }> {
    const failures: Failure[] = [];
    let current = result;
    for (const file of await this.handling(cid, "tool_result")) {
      try {
        const patch = await this.run(
          file,
          cid,
          scope,
          "tool_result",
          {
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments,
            ...current,
            ...(call.parent && { parentToolCallId: call.parent.callId }),
          },
          signal,
        );
        if (
          !object(patch) ||
          !Array.isArray(patch.content) ||
          !patch.content.every(
            (part) =>
              object(part) && (part.type === "text" || part.type === "image"),
          ) ||
          typeof patch.isError !== "boolean"
        )
          throw new Error("returned an invalid result");
        current = {
          content: patch.content as Content,
          details: patch.details,
          isError: patch.isError,
        };
      } catch (error) {
        failures.push({ file, error });
      }
    }
    const notes = await this.tell(cid, key, failures, "result unchanged");
    return current === result ? { notes } : { result: current, notes };
  }

  /** One model request's messages as the hooks leave them, or undefined
   * when unchanged: the first request of each run runs `before_agent_start`
   * on the input that started it, and its text goes ahead of that input in
   * every request of the run; then the `context` handlers run. */
  async beforeRequest(
    cid: string,
    scope: HookScope,
    request: RequestInput,
  ): Promise<readonly unknown[] | undefined> {
    const files = await this.files(cid);
    if (!files.length) return undefined;
    const { messages, signal } = request;
    const state = this.state(cid, request.conversation, request.run);
    if (!state.start) {
      const input = runInput(messages);
      const text = input
        ? await this.beforeAgentStart(cid, scope, files, input, request)
        : "";
      if (signal?.aborted) return undefined;
      state.start = { text, at: input?.at };
    }
    const { text, at } = state.start;
    const index = text
      ? messages.findIndex(
          (message) =>
            object(message) &&
            message.role === "user" &&
            message.timestamp === at,
        )
      : -1;
    const started =
      index < 0
        ? messages
        : [
            ...messages.slice(0, index),
            { role: "user", content: text, timestamp: at },
            ...messages.slice(index),
          ];
    return (
      (await this.context(cid, scope, files, started, request)) ??
      (started === messages ? undefined : started)
    );
  }

  /** Agent `cid`'s state for `run` in `conversation`, started over for a
   * new run. Durable numbers conversations per agent, so `cid` is part of
   * the key. */
  private state(cid: string, conversation: string, run: string): RunState {
    return current(this.runs, `${cid}\0${conversation}`, run, () => ({
      run,
      at: Date.now(),
      continued: 0,
    }));
  }

  /** The model's lines for `failures`: local files only, each file once per
   * run; global failures reach only the operator log and Settings. */
  private async tell(
    cid: string,
    key: () => Promise<RunKey>,
    failures: Failure[],
    outcome: string,
  ): Promise<string[]> {
    const local = failures.filter(({ file }) => file.scope === "local");
    if (!local.length) return [];
    const { conversation, run } = await key();
    const told = current(this.told, `${cid}\0${conversation}`, run, () => ({
      run,
      files: new Set<string>(),
    }));
    return local.flatMap(({ file, error }) => {
      if (told.files.has(file.path)) return [];
      told.files.add(file.path);
      return [
        `Hook "${file.name}" (local) failed: ${message(error)}; ${outcome}.`,
      ];
    });
  }

  /** Run the `before_agent_start` handlers; each hook's message, then
   * failures, quoted. */
  private async beforeAgentStart(
    cid: string,
    scope: HookScope,
    files: HookFile[],
    input: { prompt: string; images: unknown[] },
    request: Omit<RequestInput, "messages">,
  ): Promise<string> {
    const added: string[] = [];
    const failures: Failure[] = [];
    for (const file of this.handlers(files, "before_agent_start")) {
      try {
        const result = await this.run(
          file,
          cid,
          scope,
          "before_agent_start",
          {
            messageType: "user",
            prompt: input.prompt,
            images: input.images,
            runId: request.run,
          },
          request.signal,
        );
        if (!object(result) || !Array.isArray(result.messages))
          throw new Error("returned an invalid result");
        for (const message of result.messages) {
          const content = object(message) ? text(message.content) : undefined;
          if (content === undefined)
            throw new Error("returned a message without text content");
          added.push(`Hook "${file.name}" (${file.scope}): ${content}`);
        }
      } catch (error) {
        failures.push({ file, error });
      }
    }
    const notes = await this.tell(
      cid,
      async () => request,
      failures,
      "ran without it",
    );
    return [...added, ...notes].map(this.options.quote).join("\n\n");
  }

  /** Run the `context` handlers on one request's messages; Pi's prompt (the
   * system messages) is left out and, if they change, goes first. */
  private async context(
    cid: string,
    scope: HookScope,
    files: HookFile[],
    messages: readonly unknown[],
    request: Omit<RequestInput, "messages">,
  ): Promise<unknown[] | undefined> {
    const prompt = (message: unknown) =>
      object(message) && message.role === "system";
    const before = messages.filter((message) => !prompt(message));
    let current = before;
    for (const file of this.handlers(files, "context")) {
      const result = await this.run(
        file,
        cid,
        scope,
        "context",
        { messages: current, runId: request.run },
        request.signal,
      ).catch(() => undefined);
      if (
        object(result) &&
        Array.isArray(result.messages) &&
        result.messages.every(
          (message) =>
            object(message) &&
            typeof message.role === "string" &&
            !prompt(message),
        )
      )
        current = result.messages;
    }
    return current === before
      ? undefined
      : [...messages.filter(prompt), ...current];
  }

  /** Run the `agent_before_settle` handlers on `conversation`'s answer,
   * whose text `agent_settled` also gets; the text to continue the run with,
   * if they asked and the limit allows. */
  async beforeSettle(
    cid: string,
    scope: HookScope,
    request: Omit<RequestInput, "messages"> & { answer: string },
  ): Promise<string | undefined> {
    const files = await this.files(cid);
    if (!files.length) return undefined;
    const state = this.state(cid, request.conversation, request.run);
    state.answer = request.answer;
    let entries: unknown[] = [];
    let go = false;
    const labels = new Map<string, string>();
    const failures: Failure[] = [];
    for (const file of this.handlers(files, "agent_before_settle")) {
      try {
        const result = await this.run(
          file,
          cid,
          scope,
          "agent_before_settle",
          {
            entries,
            continue: go,
            outcome: "completed",
            answer: request.answer,
            runId: request.run,
          },
          request.signal,
        );
        if (
          !object(result) ||
          !Array.isArray(result.entries) ||
          typeof result.continue !== "boolean"
        )
          throw new Error("returned an invalid result");
        entries = result.entries;
        go = result.continue;
        for (const entry of entries) {
          const key = JSON.stringify(entry);
          if (!labels.has(key))
            labels.set(key, `"${file.name}" (${file.scope})`);
        }
      } catch (error) {
        failures.push({ file, error });
      }
    }
    const added = entries.flatMap((entry) => {
      const content =
        object(entry) && entry.type === "custom_message"
          ? text(entry.content)
          : undefined;
      return content === undefined
        ? []
        : [`Hook ${labels.get(JSON.stringify(entry))}: ${content}`];
    });
    if (!go || !added.length || request.signal?.aborted) return undefined;
    if (state.continued >= MAX_CONTINUATIONS) {
      this.options.log("hook_continuation_limit", {
        cid,
        conversation: request.conversation,
      });
      return undefined;
    }
    // Counted before Durable takes it, so a replay only makes the limit stricter.
    state.continued += 1;
    const notes = await this.tell(
      cid,
      async () => request,
      failures,
      "ran without it",
    );
    return this.options.quote([...added, ...notes].join("\n\n"));
  }

  /** Run the `agent_settled` handlers once `end.run` has ended; observe
   * only. Its last answer and duration are known when hook files saw it. */
  async settled(
    cid: string,
    scope: HookScope,
    end: { aborted: boolean; conversation: string; run?: string },
  ) {
    const files = await this.handling(cid, "agent_settled");
    if (!files.length) return;
    const known = this.runs.get(`${cid}\0${end.conversation}`);
    const state = end.run && known?.run === end.run ? known : undefined;
    const payload = {
      aborted: end.aborted,
      ...(end.run && { runId: end.run }),
      ...(state && { durationMs: Date.now() - state.at }),
      ...(state?.answer !== undefined && { answer: state.answer }),
    };
    for (const file of files)
      await this.run(file, cid, scope, "agent_settled", payload).catch(
        () => undefined,
      );
  }

  /** Run the `session_before_compact` handlers; the first file to cancel or
   * give a summary decides. A compaction a too-long request needs can't be
   * cancelled, since every later request would be too long again. */
  async beforeCompact(
    cid: string,
    scope: HookScope,
    event: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ decline: true } | { summary: string } | undefined> {
    for (const file of await this.handling(cid, "session_before_compact")) {
      const result = await this.run(
        file,
        cid,
        scope,
        "session_before_compact",
        event,
        signal,
      ).catch(() => undefined);
      if (!object(result)) continue;
      if (result.cancel === true && event.reason !== "overflow")
        return { decline: true };
      const summary = object(result.compaction)
        ? result.compaction.summary
        : undefined;
      if (typeof summary === "string" && summary) return { summary };
    }
    return undefined;
  }

  /** The prompt section naming the files that run for `cid`, in run order;
   * empty when none run. */
  async section(cid: string): Promise<string> {
    const files = await this.files(cid);
    if (!files.length || !AGENT.test(cid)) return "";
    const names = files.map((file) => `${file.scope} ${file.name}`);
    return `Hooks (as of session start; \`tools/hooks.ts list\` shows the current list): ${names.join("; ")}.`;
  }

  /** The global hook files with their code and events as last loaded; none
   * load, so a new or changed file has no events until an event runs it. */
  async list(): Promise<HookListing[]> {
    return Promise.all(
      (await this.scan(this.options.dir, "global")).map(async (file) => ({
        ...this.describe(file),
        source: await readFile(file.path, "utf8").catch(() => ""),
      })),
    );
  }

  /** Every hook file for `cid`, in run order, as last loaded; none load. */
  async listFor(cid: string): Promise<HookListing[]> {
    return [
      ...(await this.scan(this.localDir(cid), "local")),
      ...(await this.scan(this.options.dir, "global")),
    ].map((file) => this.describe(file));
  }

  private describe(file: HookFile): HookListing {
    const known = this.loaded.get(file.path);
    const events = known?.version === file.version ? known.events : undefined;
    const failure = this.failures.get(file.path);
    return {
      name: file.name,
      path: file.path,
      scope: file.scope,
      ...(events && {
        events: events.filter((name) => HOOK_EVENTS.includes(name)),
        unsupported: events.filter((name) => !HOOK_EVENTS.includes(name)),
      }),
      ...(failure && { failure }),
    };
  }

  /** Create or replace one hook file. */
  async save(name: unknown, source: unknown): Promise<void> {
    if (typeof name !== "string" || !NAME.test(name))
      throw new HookSettingsError(
        "Use a file name of letters, digits, dots, dashes or underscores ending in .ts.",
      );
    if (
      typeof source !== "string" ||
      Buffer.byteLength(source) > MAX_SOURCE_BYTES
    )
      throw new HookSettingsError("The code must be text of at most 256 KB.");
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const path = join(this.options.dir, name);
    const temporary = join(this.options.dir, `.${name}.${process.pid}.tmp`);
    await writeFile(temporary, source, { mode: 0o600 });
    await rename(temporary, path);
    this.failures.delete(path);
  }

  /** Delete one global hook file. */
  async remove(name: unknown): Promise<void> {
    if (typeof name !== "string" || !NAME.test(name))
      throw new HookSettingsError("No such hook.");
    const path = join(this.options.dir, name);
    await unlink(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    this.failures.delete(path);
  }

  private async handling(cid: string, event: string): Promise<HookFile[]> {
    return this.handlers(await this.files(cid), event);
  }

  private handlers(files: HookFile[], event: string): HookFile[] {
    return files.filter((file) => {
      const known = this.loaded.get(file.path);
      return known?.version !== file.version || known.events.includes(event);
    });
  }

  private remember(file: HookFile, events: string[]) {
    this.loaded.delete(file.path);
    if (this.loaded.size >= MAX_LOADED)
      this.loaded.delete(this.loaded.keys().next().value!);
    this.loaded.set(file.path, { version: file.version, events });
  }

  private async run(
    file: HookFile,
    cid: string,
    scope: HookScope,
    event: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = Symbol();
    const live = this.live.get(cid) ?? new Map<symbol, RunningHook>();
    this.live.set(
      cid,
      live.set(token, {
        label: `${file.name} (${file.scope})`,
        at: Date.now(),
      }),
    );
    this.options.changed(cid);
    try {
      const { cwd, env } = await scope();
      const { events, result } = await runHook({
        file: file.path,
        event,
        payload,
        cwd,
        env,
        agentId: cid,
        signal,
        own: (proc) => this.options.own(proc, cid),
        release: (proc) => this.options.release(proc),
      });
      if (this.loaded.get(file.path)?.version !== file.version) {
        const unsupported = events.filter(
          (name) => !HOOK_EVENTS.includes(name),
        );
        if (unsupported.length)
          this.options.log("hook_unsupported_events", {
            hook: file.name,
            scope: file.scope,
            events: unsupported.join(","),
          });
      }
      this.remember(file, events);
      return result;
    } catch (error) {
      // A file whose load threw is remembered with no events, so it is
      // skipped until it changes; a timed-out or killed load is tried again.
      if (error instanceof HookRunError && (error.events || error.broken))
        this.remember(file, error.events ?? []);
      if (!signal?.aborted) {
        this.failures.delete(file.path);
        if (this.failures.size >= 256)
          this.failures.delete(this.failures.keys().next().value!);
        this.failures.set(file.path, { at: Date.now(), error: message(error) });
        this.options.log("hook_failed", {
          cid,
          hook: file.name,
          scope: file.scope,
          event,
          error: message(error),
        });
      }
      throw error;
    } finally {
      live.delete(token);
      if (!live.size) this.live.delete(cid);
      this.options.changed(cid);
    }
  }
}

/** The input that started a run: the user messages at the end of its first
 * request, as text and images; undefined when it ends otherwise. */
function runInput(messages: readonly unknown[]) {
  const users: Record<string, unknown>[] = [];
  for (const message of [...messages].reverse()) {
    if (
      !object(message) ||
      (message.role !== "user" && message.role !== "system")
    )
      break;
    if (message.role === "user") users.unshift(message);
  }
  if (!users.length) return undefined;
  const parts = users.flatMap((message) =>
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? message.content.filter(object)
        : [],
  );
  return {
    at: users[0]!.timestamp,
    prompt: parts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text))
      .join("\n\n"),
    images: parts.filter((part) => part.type === "image"),
  };
}

export type RunningHook = { label: string; at: number };

/** A refused Settings change, with a message safe to show. */
export class HookSettingsError extends Error {}

/** A Pi message's content as text: a string, or its text parts joined. */
const text = (content: unknown): string | undefined =>
  typeof content === "string"
    ? content
    : Array.isArray(content) &&
        content.every((part) => object(part) && part.type === "text")
      ? content.map((part) => String(part.text)).join("\n")
      : undefined;

/** `map`'s entry for `key` while it names `run`, else a `fresh` one; the
 * least recently used of MAX_RUNS entries goes first. */
function current<T extends { run: string }>(
  map: Map<string, T>,
  key: string,
  run: string,
  fresh: () => T,
): T {
  const known = map.get(key);
  map.delete(key);
  const state = known?.run === run ? known : fresh();
  if (map.size >= MAX_RUNS) map.delete(map.keys().next().value!);
  map.set(key, state);
  return state;
}
