// Settings checks are instance-owned background work, never conversations.
// Admission and the disposable cwd remain owned until every group is gone.
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { McpServers, mcpFailure } from "./extensions/extra/mcp/mcp";
import {
  mcpConfig,
  mcpStatuses,
  mcpStatusVersion,
  recordMcpStatus,
} from "./extensions/extra/mcp/status";
import { McpConfigError } from "./mcp_config";
import type { ProcessLifecycle } from "./process_lifecycle";
import { AbortScope, type TaskSet } from "./utils/tasks";
import { retire } from "./utils/trash";

interface CheckOptions {
  configPath: string;
  temporaryRoot: string;
  trashDir: string;
  env: Record<string, string>;
  processes: ProcessLifecycle;
  tasks: TaskSet;
  signal: AbortSignal;
  providerToken?(provider: string): Promise<string | undefined>;
}

export class McpCheckBusy extends Error {}

export class McpChecks {
  private running?: string;
  private version?: string;
  private cleanupIncomplete = false;
  constructor(private readonly options: CheckOptions) {}

  async statuses() {
    return (await mcpStatuses(this.options.configPath)).map((status) => ({
      ...status,
      ...(this.running === status.name &&
      this.version === mcpStatusVersion(this.options.configPath)
        ? {
            checking: true,
            ...(this.cleanupIncomplete
              ? {
                  state: "failed" as const,
                  reason: "process cleanup incomplete",
                }
              : {}),
          }
        : {}),
    }));
  }

  async start(name: string) {
    const entry = (await mcpConfig(this.options.configPath)).find(
      (each) => each.name === name,
    );
    if (!entry) throw new McpConfigError("Unknown MCP server");
    if (entry.config.enabled === false)
      throw new McpConfigError("MCP server is disabled");
    if (this.options.signal.aborted)
      throw new McpConfigError("MCP checks unavailable");
    if (this.running) throw new McpCheckBusy();
    this.running = name;
    this.version = mcpStatusVersion(this.options.configPath);
    const task = this.options.tasks.spawn(
      "mcp-check",
      (signal) => this.run(name, entry.config.timeout ?? 60, signal),
      this.options.signal,
    );
    const finished = () => {
      this.running = undefined;
      this.cleanupIncomplete = false;
    };
    void task.then(finished, finished);
  }

  /** `value` resolved as a check would (Pi's references and owned commands),
   * for OAuth client secrets during Settings sign-in. */
  async resolve(value: string): Promise<string> {
    const cwd = await mkdtemp(join(this.options.temporaryRoot, "mcp-check-"));
    const servers = this.servers(cwd, this.options.signal);
    try {
      return await servers.resolve(value);
    } finally {
      while (!(await servers.close().catch(() => false))) await Bun.sleep(1000);
      retire(cwd, this.options.trashDir);
    }
  }

  private servers(cwd: string, signal: AbortSignal, checkServer?: string) {
    const { options } = this;
    return new McpServers({
      configPath: options.configPath,
      checkServer,
      scope: async () => {
        signal.throwIfAborted();
        return { cwd, env: options.env };
      },
      own: async (proc) => {
        await options.processes.registerProcess(proc, "mcp-check");
        signal.throwIfAborted();
      },
      release: async (proc) =>
        (await options.processes.cleanupProcessObject(proc)) !== false,
      report: () => {},
      providerToken: options.providerToken,
    });
  }

  private async run(name: string, timeout: number, parent: AbortSignal) {
    const { options } = this;
    const version = this.version;
    const cwd = await mkdtemp(join(options.temporaryRoot, "mcp-check-"));
    const scope = new AbortScope(parent);
    const { signal } = scope;
    const timer = setTimeout(
      () => scope.abort(new Error("timeout")),
      timeout * 1000,
    );
    const servers = this.servers(cwd, signal, name);
    const abort = () => {
      void servers.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await servers.tools();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted && !parent.aborted)
        await recordMcpStatus(
          options.configPath,
          name,
          { reason: mcpFailure(signal.reason, timeout) },
          () => {},
          version,
        ).catch(() => {});
      scope.dispose();
      while (!(await servers.close().catch(() => false))) {
        this.cleanupIncomplete = true;
        await Bun.sleep(1000);
      }
      retire(cwd, options.trashDir);
    }
  }
}
