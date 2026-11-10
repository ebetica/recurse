// Host-shared search child with per-bundle native connections. Native crashes
// reject outstanding work; the next request rebuilds connections lazily. Close
// fences admissions, drains finders, and stops the owned process group.
import { fileURLToPath } from "node:url";
import { abortable, Cancelled } from "../../../utils/tasks.ts";
import { slowSpan } from "../../../observability/slow_span";
import type { OwnedProcess } from "../../../process_lifecycle.ts";
import type { FffDefinition, FffFlags } from "./fff_tools.ts";
import type {
  SearchMessage,
  SearchReply,
  SearchRequest,
  SearchValue,
} from "./fff_thread.worker.ts";

type Child = ReturnType<typeof Bun.spawn>;
type Update = Parameters<FffDefinition["execute"]>[3];
type Waiting = PromiseWithResolvers<SearchValue> & {
  cleanup(): void;
  onUpdate: Update;
};
type Connection = {
  cwd: string;
  owner?: string;
  flags: FffFlags;
  child?: Child;
  opening?: Promise<SearchValue>;
  find?: string;
  users: number;
  retiring?: boolean;
  drained?: PromiseWithResolvers<void>;
};
export interface FileNameSearch {
  paths: string[];
}
type Ownership = {
  own(proc: OwnedProcess): Promise<void>;
  release(proc: OwnedProcess): Promise<boolean>;
  log(fields: Record<string, unknown>): void;
};

/** Cancel only the caller\'s wait; shared startup/reopening stays owned. */
function waitForSearch<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  return signal
    ? abortable(work, signal).catch((error: unknown) => {
        if (error instanceof Cancelled) throw new Error("Operation aborted");
        throw error;
      })
    : work;
}

export class FffWorker {
  private child: Child | undefined;
  private starting: Promise<Child> | undefined;
  private waiting = new Map<number, Waiting>();
  private connections = new Map<number, Connection>();
  private nextId = 0;
  private nextConnection = 0;
  private shutdown: Promise<void> | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly ownership?: Ownership,
  ) {}

  private exited(child: Child, code: number | null, signal: string | null) {
    if (this.child !== child) return;
    const pending = this.waiting.size;
    this.child = undefined;
    this.starting = undefined;
    for (const waiter of this.waiting.values()) {
      waiter.cleanup();
      waiter.reject(new Error("File search crashed; retry"));
    }
    this.waiting.clear();
    if (!this.shutdown) {
      const fields = { pid: child.pid, code, signal, pending };
      if (this.ownership) this.ownership.log(fields);
      else console.warn("file_search_crashed", fields);
      void this.ownership
        ?.release(child)
        .catch((error: unknown) =>
          this.ownership?.log({ pid: child.pid, cleanupError: String(error) }),
        );
    }
  }

  private start(): Promise<Child> {
    if (
      this.child &&
      (this.child.exitCode !== null || this.child.signalCode !== null)
    )
      this.exited(this.child, this.child.exitCode, this.child.signalCode);
    if (!this.starting) {
      const starting = this.spawn();
      this.starting = starting;
      void starting.catch(() => {
        if (this.starting === starting) this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async spawn(): Promise<Child> {
    const child: Child = slowSpan("file_search_spawn", undefined, () =>
      Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("./fff_thread.worker.ts", import.meta.url)),
        ],
        {
          env: { ...this.env, PI_FFF_MULTIGREP: "0" },
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          ipc: (reply: SearchReply) => this.reply(reply),
          onExit: (_proc, code) => {
            this.exited(child, code, child.signalCode);
          },
        },
      ),
    );
    this.child = child;
    try {
      await this.ownership?.own(child);
    } catch (error) {
      await this.kill(child);
      throw error;
    }
    return child;
  }

  private reply(reply: SearchReply) {
    const waiter = this.waiting.get(reply.id);
    if (!waiter) return;
    if ("update" in reply) {
      try {
        waiter.onUpdate?.(reply.update);
      } catch (error) {
        this.waiting.delete(reply.id);
        waiter.cleanup();
        waiter.reject(error);
        this.abort(reply.id);
      }
      return;
    }
    this.waiting.delete(reply.id);
    waiter.cleanup();
    if ("error" in reply) waiter.reject(new Error(reply.error));
    else waiter.resolve(reply.value);
  }

  private abort(id: number) {
    try {
      this.child?.send({ op: "abort", id } satisfies SearchMessage);
    } catch {
      // Invariant: Exit already rejects outstanding calls.
    }
  }

  private send(
    child: Child,
    request: SearchRequest,
    signal?: AbortSignal,
    onUpdate?: Update,
  ): Promise<SearchValue> {
    if (
      this.child !== child ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return Promise.reject(new Error("File search crashed; retry"));
    if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
    const id = this.nextId++;
    const waiter = Promise.withResolvers<SearchValue>();
    const abort = () => {
      this.waiting.delete(id);
      cleanup();
      this.abort(id);
      waiter.reject(new Error("Operation aborted"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    this.waiting.set(id, { ...waiter, cleanup, onUpdate });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child.send({ ...request, id } satisfies SearchMessage);
    } catch {
      this.waiting.delete(id);
      cleanup();
      waiter.reject(new Error("File search crashed; retry"));
    }
    return waiter.promise;
  }

  private async request(
    request: SearchRequest,
    signal?: AbortSignal,
    onUpdate?: Update,
  ): Promise<SearchValue> {
    if (this.shutdown && request.op !== "shutdown")
      throw new Error("Search worker closed");
    if (signal?.aborted) throw new Error("Operation aborted");
    const child = await waitForSearch(this.start(), signal);
    if (request.op === "execute") {
      const connection = this.connections.get(request.connection);
      if (!connection) throw new Error("Search connection closed");
      if (connection.child !== child) {
        connection.child = child;
        connection.opening = this.send(child, {
          op: "open",
          connection: request.connection,
          cwd: connection.cwd,
          flags: connection.flags,
        });
      }
      if (connection.opening) await waitForSearch(connection.opening, signal);
    }
    return this.send(child, request, signal, onUpdate);
  }

  async open(cwd: string, flags: FffFlags = {}, owner?: string) {
    const connection = this.nextConnection++;
    const tools = await this.request({ op: "open", connection, cwd, flags });
    if (!Array.isArray(tools))
      throw new Error("Search worker returned invalid tool definitions");
    this.connections.set(connection, {
      cwd,
      owner,
      flags,
      child: this.child,
      users: 0,
      find: tools.find(
        (tool) => tool.name === "find" || tool.name === "fff_find",
      )?.name,
    });
    let closing: Promise<void> | undefined;
    const thisWorker = this;
    const definitions: FffDefinition[] = tools.map((tool) => ({
      ...tool,
      async execute(_id, args, signal, onUpdate, ctx) {
        if (closing) throw new Error("Search connection closed");
        const result = await thisWorker.request(
          { op: "execute", connection, cwd: ctx.cwd, name: tool.name, args },
          signal,
          onUpdate,
        );
        if (!result || Array.isArray(result))
          throw new Error("Search worker returned an invalid result");
        return result;
      },
    }));
    return {
      definitions,
      connection,
      close: () =>
        (closing ??= (async () => {
          const state = this.connections.get(connection);
          if (state) {
            state.retiring = true;
            if (state.users)
              await (state.drained ??= Promise.withResolvers<void>()).promise;
          }
          this.connections.delete(connection);
          if (this.shutdown) return this.shutdown;
          if (state?.child && state.child === this.child)
            await this.request({ op: "close", connection });
        })()),
    };
  }

  /** Run find unchanged, borrowing the conversation's existing connection. */
  async fileNames(
    owner: string,
    cwd: string,
    query: string,
    signal: AbortSignal,
  ): Promise<FileNameSearch> {
    if (!query.trim()) return { paths: [] };
    let selected = [...this.connections.entries()].find(
      ([, state]) => state.owner === owner && state.find && !state.retiring,
    )?.[0];
    const temporary = selected === undefined ? await this.open(cwd) : undefined;
    selected ??= temporary!.connection;
    const connection = this.connections.get(selected);
    if (!connection?.find || connection.retiring) {
      await temporary?.close();
      throw new Error("Search connection closed");
    }
    connection.users++;
    try {
      const value = await this.request(
        {
          op: "execute",
          connection: selected,
          cwd,
          name: connection.find,
          args: { pattern: query, limit: 50 },
        },
        signal,
      );
      if (!value || Array.isArray(value))
        throw new Error("Invalid file search response");
      const details = value.details as Record<string, unknown> | undefined;
      if (!Array.isArray(details?.paths))
        throw new Error("Invalid file search paths");
      return {
        paths: details.paths.filter(
          (path): path is string => typeof path === "string",
        ),
      };
    } finally {
      if (--connection.users === 0) connection.drained?.resolve();
      await temporary?.close();
    }
  }

  /** Spawn the child and import pi-fff without loading its native library. */
  async warm(): Promise<void> {
    try {
      await this.request({ op: "warm" });
    } catch (error) {
      if (!this.shutdown) throw error;
    }
  }

  private async stop(child: Child) {
    if (this.ownership) {
      if (!(await this.ownership.release(child)))
        throw new Error("File search process group survived shutdown");
    } else {
      await this.kill(child);
    }
  }

  private async kill(child: Child) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await child.exited;
  }

  close(): Promise<void> {
    return (this.shutdown ??= (async () => {
      if (!this.starting) {
        this.connections.clear();
        return;
      }
      const child = await this.starting;
      try {
        if (
          this.child === child &&
          child.exitCode === null &&
          child.signalCode === null
        )
          await this.send(child, { op: "shutdown" });
      } finally {
        this.connections.clear();
        await this.stop(child);
      }
    })());
  }
}
