// Settings-only MCP bridge. Pi owns connections, discovery, reconnects and
// OAuth token use/refresh from mcp-auth.json beside mcp.json; Recurse owns
// transport groups, agent-env resolution and safe status reporting.
// loadToolsOnDemand defers a server's schemas, never its codemode access.
import { defineTool } from "@earendil-works/pi-durable";
import {
  StdioTransport,
  StreamableHttpTransport,
  McpError,
  McpAbortError,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type { ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { OwnedProcess } from "../../../process_lifecycle.ts";
import {
  McpOAuthCredentialStore,
  McpServerConnection,
} from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js";
import { FileAuthStorageBackend } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import type { McpServerEntry } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import {
  createMcpToolDefinition,
  createMcpToolName,
} from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
import { mcpNamespace } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js";
import {
  getConfigValueEnvVarNames,
  isCommandConfigValue,
  resolveConfigValueUncached,
} from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";
import { renderServersSection } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js";
import {
  mcpConfig,
  mcpStatuses,
  mcpStatusVersion,
  recordMcpStatus,
} from "./status.ts";

type Env = Record<string, string>;
type Host = {
  configPath: string;
  checkServer?: string;
  scope(): Promise<{ cwd: string; env: Env }>;
  own(proc: OwnedProcess): Promise<void>;
  release(proc: OwnedProcess): Promise<boolean>;
  report(error: unknown): void;
  status?(server: string, state: string, reason?: string): void;
  /** A Settings provider login's token, for `"auth": { "provider" }`. */
  providerToken?(provider: string): Promise<string | undefined>;
};
type Slot = { connection?: McpServerConnection; ready: Promise<void> };
type Session = {
  procs: Set<OwnedProcess>;
  connections: Map<string, Slot>;
  abort: AbortController;
};
export const MCP_AUTH_FILE_NAME = "mcp-auth.json";
/** Pi OAuth credentials for servers in `configPath`'s mcp.json. */
export const mcpCredentials = (configPath: string) =>
  new McpOAuthCredentialStore(
    new FileAuthStorageBackend(join(dirname(configPath), MCP_AUTH_FILE_NAME)),
    dirname(configPath),
  );
/** Pi OAuth: HTTP servers without `auth` or an Authorization header. */
export const signsIn = (
  config: McpServerEntry["config"],
): config is Extract<McpServerEntry["config"], { url: string }> =>
  "url" in config &&
  !config.auth &&
  !Object.keys(config.headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization",
  );
const enabled = async (path: string) =>
  (await mcpConfig(path)).filter(({ config }) => config.enabled !== false);
const GATED = 'read -r _; exec "$@"';
const BASE_ENV = "HOME LOGNAME PATH SHELL TERM USER TMPDIR LANG".split(" ");

const scriptNeedsServer = (code: string, server: string) =>
  code.includes(mcpNamespace(server)) ||
  /searchTools|describeTool|describeNamespace|ALL_TOOLS|tools\s*\[/.test(code);
const home = (value: string, env: Env) =>
  env.HOME && (value === "~" || value.startsWith("~/"))
    ? join(env.HOME, value.slice(1))
    : value;

class OwnedStdio extends StdioTransport {
  proc?: OwnedProcess;
  constructor(
    options: ConstructorParameters<typeof StdioTransport>[0],
    private host: Host,
    private procs: Set<OwnedProcess>,
    private signal: AbortSignal,
    private previous?: OwnedStdio,
  ) {
    super({
      ...options,
      command: "/bin/sh",
      args: ["-c", GATED, "sh", options.command, ...(options.args ?? [])],
      inheritEnv: false,
    });
  }
  override async start() {
    await this.previous?.close();
    this.signal.throwIfAborted();
    await super.start();
    const child = (this as unknown as { child: ChildProcess }).child;
    const exited = new Promise<number>((done) =>
      child.exitCode !== null || child.signalCode !== null
        ? done(child.exitCode ?? 1)
        : child.once("exit", (code) => done(code ?? 1)),
    );
    this.proc = Object.assign(child, { exited }) as OwnedProcess;
    this.procs.add(this.proc);
    try {
      await this.host.own(this.proc);
      this.signal.throwIfAborted();
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
    child.stdin!.write("\n");
  }
  override async close() {
    try {
      await super.close();
    } finally {
      if (this.proc) {
        if (!(await this.host.release(this.proc)))
          throw new Error("MCP server process groups survived");
        this.procs.delete(this.proc);
      }
    }
  }
}

export class McpServers {
  private session = this.fresh();
  private transports = new WeakMap<McpServerConnection, OwnedStdio>();
  private rejectedTokens = new WeakMap<
    McpServerConnection,
    string | undefined
  >();
  private credentials: McpOAuthCredentialStore;
  private readonly survivors = new Set<OwnedProcess>();
  private closing: Promise<unknown> = Promise.resolve();
  private version?: string;
  constructor(private host: Host) {
    this.credentials = mcpCredentials(host.configPath);
  }
  private fresh(): Session {
    return {
      procs: new Set(),
      connections: new Map(),
      abort: new AbortController(),
    };
  }

  async section() {
    try {
      return [
        renderServersSection(
          (await enabled(this.host.configPath)).map((entry) => ({ entry })),
        ),
        await this.unavailable(),
      ]
        .filter(Boolean)
        .join("\n");
    } catch {
      return "MCP configuration unavailable";
    }
  }
  async unavailable() {
    try {
      return (await mcpStatuses(this.host.configPath))
        .filter(
          (status) =>
            status.state === "failed" || status.state === "needs-sign-in",
        )
        .map((status) =>
          status.state === "failed"
            ? `MCP server ${status.name} unavailable: ${status.reason}.`
            : `MCP server ${status.name} needs sign-in; the operator signs in under Settings > MCPs.`,
        )
        .join("\n");
    } catch {
      return "MCP configuration unavailable";
    }
  }
  /** `value` resolved like a header value: Pi's references, and commands as
   * owned processes in the host's scope. */
  async resolve(value: string) {
    const { cwd, env } = await this.host.scope();
    const { procs, abort } = this.session;
    return (await this.values({ value }, cwd, env, procs, abort.signal)).value!;
  }
  private async values(
    record: Env | undefined,
    cwd: string,
    env: Env,
    procs: Set<OwnedProcess>,
    signal: AbortSignal,
  ) {
    const out: Env = {};
    for (const [key, raw] of Object.entries(record ?? {})) {
      let value: string | undefined;
      if (isCommandConfigValue(raw)) {
        const proc = Bun.spawn(
          ["/bin/sh", "-c", GATED, "sh", "/bin/sh", "-c", raw.slice(1)],
          {
            cwd,
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
            detached: true,
          },
        );
        procs.add(proc);
        try {
          await this.host.own(proc);
          signal.throwIfAborted();
        } catch (error) {
          proc.kill("SIGKILL");
          throw error;
        }
        proc.stdin.write("\n");
        void proc.stdin.end();
        const release = () => {
          void this.host.release(proc).catch(this.host.report);
        };
        signal.addEventListener("abort", release, { once: true });
        const timer = setTimeout(release, 10_000);
        try {
          const [text, code] = await Promise.all([
            new Response(proc.stdout).text(),
            proc.exited,
          ]);
          if (code === 0) value = text.trim() || undefined;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", release);
          if (await this.host.release(proc)) procs.delete(proc);
        }
      } else if (getConfigValueEnvVarNames(raw).every((name) => env[name])) {
        value = resolveConfigValueUncached(raw, env);
      }
      if (value === undefined)
        throw new Error("configuration value could not be resolved");
      out[key] = value;
    }
    return out;
  }
  private async connect(
    entry: McpServerEntry,
    session: Session,
    slot: Slot,
    version: string | undefined,
  ) {
    const { name, config } = entry;
    const { procs, abort } = session;
    let connection: McpServerConnection;
    try {
      const { cwd, env } = await this.host.scope();
      const values = await this.values(
        "url" in config ? config.headers : config.env,
        cwd,
        env,
        procs,
        abort.signal,
      );
      const oauth = "url" in config ? config.oauth : undefined;
      let clientSecret: string | undefined;
      abort.signal.throwIfAborted();
      connection = new McpServerConnection({
        // Invariant: Pass configured OAuth settings, not loopback callbacks;
        // refreshes use the redirect URI stored at sign-in.
        entry:
          "url" in config
            ? ({
                ...entry,
                config: {
                  ...config,
                  oauth: oauth
                    ? {
                        ...oauth,
                        callbackPort: undefined,
                        callbackUrl: undefined,
                        // Spec: Pi reads this when refreshing; the value set
                        // below, quoted so Pi never resolves it again.
                        get clientSecret() {
                          return clientSecret
                            ?.replaceAll("$", () => "$$")
                            .replace(/^!/, () => "$!");
                        },
                      }
                    : undefined,
                },
              } as McpServerEntry)
            : entry,
        cwd,
        credentials: this.credentials,
        providerToken: async (provider) => this.host.providerToken?.(provider),
        onTools: () => {},
        createTransport: (_entry, _cwd, authProvider) => {
          if ("url" in config)
            return new StreamableHttpTransport({
              url: config.url,
              headers: values,
              authProvider:
                oauth && signsIn(config) && authProvider
                  ? {
                      // Invariant: Refresh only on 401; never follow redirects.
                      token: async () =>
                        this.credentials.tokens(name, config.url)?.access_token,
                      onUnauthorized: async (context) => {
                        // Invariant: Resolve the secret only to refresh, as Pi
                        // does, with commands as owned processes.
                        if (oauth.clientSecret !== undefined)
                          ({ clientSecret } = await this.values(
                            { clientSecret: oauth.clientSecret },
                            cwd,
                            env,
                            procs,
                            abort.signal,
                          ));
                        return authProvider.onUnauthorized?.({
                          ...context,
                          fetch: (input, init) =>
                            context.fetch(input, {
                              ...init,
                              redirect: "error",
                            }),
                        });
                      },
                    }
                  : authProvider,
            });
          const transport = new OwnedStdio(
            {
              command: home(config.command, env),
              args: config.args?.map((arg) => home(arg, env)),
              cwd: resolve(cwd, home(config.cwd ?? ".", env)),
              env: {
                ...Object.fromEntries(
                  BASE_ENV.filter(
                    (key) =>
                      env[key] !== undefined && !env[key].startsWith("()"),
                  ).map((key) => [key, env[key]]),
                ),
                ...values,
              },
            },
            this.host,
            procs,
            abort.signal,
            this.transports.get(connection),
          );
          this.transports.set(connection, transport);
          return transport;
        },
      });
      slot.connection = connection;
      try {
        await connection.getClient();
      } catch {}
      if (!abort.signal.aborted)
        await this.record(connection, version).catch(this.host.report);
    } catch (error) {
      if (abort.signal.aborted) return;
      await recordMcpStatus(
        this.host.configPath,
        name,
        { reason: mcpFailure(error, config.timeout ?? 60) },
        this.host.status ?? (() => {}),
        version,
      ).catch(this.host.report);
      return undefined;
    }
  }
  private async storedToken(connection: McpServerConnection) {
    const { config } = connection.entry;
    if (!("url" in config)) return undefined;
    return config.auth
      ? this.host.providerToken?.(config.auth.provider)
      : this.credentials.tokens(connection.name, config.url)?.access_token;
  }
  private async record(
    connection: McpServerConnection,
    version = this.version,
  ) {
    if (connection.state === "connecting") return;
    const { config } = connection.entry;
    const provider = "url" in config ? config.auth?.provider : undefined;
    if (connection.state === "needs-auth")
      this.rejectedTokens.set(connection, await this.storedToken(connection));
    return recordMcpStatus(
      this.host.configPath,
      connection.name,
      connection.state === "connected"
        ? { toolCount: connection.tools.length }
        : connection.state === "needs-auth"
          ? provider
            ? { reason: `needs a ${provider} sign-in in Settings` }
            : { needsSignIn: true }
          : {
              reason: mcpFailure(
                connection.error,
                connection.timeoutMs / 1000,
                this.transports.get(connection)?.proc,
              ),
            },
      this.host.status ?? (() => {}),
      version,
    );
  }
  async tools(code?: string) {
    let session = this.session;
    const configured = await enabled(this.host.configPath);
    session.abort.signal.throwIfAborted();
    const version = mcpStatusVersion(this.host.configPath);
    this.version ??= version;
    if (version !== this.version) {
      const closing = this.close();
      session = this.session;
      if (!(await closing))
        throw new Error("MCP server process groups survived");
      session.abort.signal.throwIfAborted();
      this.version = version;
    }
    const selected = configured.filter(
      (entry) =>
        (!this.host.checkServer || entry.name === this.host.checkServer) &&
        (code === undefined || scriptNeedsServer(code, entry.name)),
    );
    for (const entry of selected) {
      const stale = session.connections.get(entry.name)?.connection;
      // Invariant: Reconnect signed-out connections after storing tokens.
      const token =
        stale?.state === "needs-auth"
          ? await this.storedToken(stale)
          : undefined;
      if (
        stale &&
        token !== undefined &&
        token !== this.rejectedTokens.get(stale)
      ) {
        session.connections.delete(entry.name);
        await stale.close();
      }
      if (session.connections.has(entry.name)) continue;
      const slot: Slot = { ready: Promise.resolve() };
      slot.ready = this.connect(entry, session, slot, version);
      session.connections.set(entry.name, slot);
    }
    await Promise.all(
      selected.map((entry) => session.connections.get(entry.name)!.ready),
    );
    const connections = [...session.connections.values()].map(
      (slot) => slot.connection,
    );
    const deferredServers = new Set(
      configured
        .filter(
          ({ config }) =>
            "loadToolsOnDemand" in config && config.loadToolsOnDemand === true,
        )
        .map(({ name }) => name),
    );
    const taken = new Set<string>();
    return connections.flatMap((connection) =>
      !connection || connection.state === "failed"
        ? []
        : connection.tools.map((tool) => {
            const name = createMcpToolName(connection.name, tool.name, (name) =>
              taken.has(name),
            );
            taken.add(name);
            const definition = createMcpToolDefinition({
              server: connection.name,
              tool,
              name,
              exposure: "codemode",
              namespace: {
                name: mcpNamespace(connection.name),
                ...(connection.instructions
                  ? { instructions: connection.instructions }
                  : {}),
              },
              timeoutMs: connection.timeoutMs,
              getClient: async () => connection,
            });
            return {
              ...defineTool({
                name,
                description: definition.description,
                parameters: definition.parameters,
                callers: ["tools"],
                ...(deferredServers.has(connection.name)
                  ? { deferred: true }
                  : {}),
                structuredOutputSchema: definition.outputSchema,
                execute: async (args, _api, context) => {
                  const reconnecting = connection.state !== "connected";
                  try {
                    if (connection.state === "failed") throw connection.error;
                    const result = await connection.callTool(
                      tool.name,
                      args as Record<string, unknown>,
                      { signal: context.abortSignal },
                    );
                    if (reconnecting && !session.abort.signal.aborted)
                      await this.record(connection, version);
                    const { _meta, ...structured } = result;
                    return {
                      output: toLlmContent(result),
                      isError: result.isError,
                      structuredOutput: structured as never,
                    };
                  } catch (error) {
                    if (
                      !session.abort.signal.aborted &&
                      connection.state !== "connected"
                    )
                      await this.record(connection, version).catch(
                        this.host.report,
                      );
                    if (
                      context.abortSignal?.aborted ||
                      error instanceof McpAbortError
                    )
                      throw new Error("MCP request cancelled");
                    if (error instanceof McpError)
                      throw new Error("MCP request failed");
                    throw new Error(
                      `MCP server ${connection.name} unavailable: ${mcpFailure(error, connection.timeoutMs / 1000, this.transports.get(connection)?.proc)}`,
                    );
                  }
                },
              }),
              server: connection.name,
              namespace: definition.namespace,
            };
          }),
    );
  }
  close(): Promise<boolean> {
    const session = this.session;
    this.session = this.fresh();
    session.abort.abort();
    const closing = [...session.connections.values()].map((slot) =>
      slot.connection?.close(),
    );
    const pass = this.closing.then(async () => {
      await Promise.allSettled(closing);
      await Promise.all(
        [...session.connections.values()].map((slot) =>
          slot.ready.catch(this.host.report),
        ),
      );
      for (const proc of session.procs) this.survivors.add(proc);
      await Promise.all(
        [...this.survivors].map(async (proc) => {
          if (await this.host.release(proc)) this.survivors.delete(proc);
        }),
      );
      if (this.survivors.size)
        this.host.report(new Error("MCP server process groups survived"));
      return this.survivors.size === 0;
    });
    this.closing = pass.catch(() => false);
    return pass;
  }
}

/** Hide raw diagnostics, stderr, URLs and resolved config values. */
export function mcpFailure(
  error: unknown,
  timeout: number,
  proc?: Pick<OwnedProcess, "exitCode" | "signalCode">,
): string {
  const text = String(error instanceof Error ? error.message : error).split(
    "\n",
  )[0]!;
  if (/timed? ?out|timeout/i.test(text)) return `timed out after ${timeout} s`;
  if (proc?.exitCode !== null && proc?.exitCode !== undefined)
    return `exited with code ${proc.exitCode}`;
  if (proc?.signalCode && /^SIG[A-Z0-9]+$/.test(proc.signalCode))
    return `terminated by ${proc.signalCode}`;
  if (/ECONNREFUSED|connection refused|Unable to connect/i.test(text))
    return "connection refused";
  if (/requires sign-in/.test(text)) return "needs sign-in in Settings";
  if (/MCP server requires authentication/.test(text)) return "HTTP 401";
  const status = /\bHTTP request failed with status (\d{3})\b/i.exec(text)?.[1];
  if (status) return `HTTP ${status}`;
  if (/resolve/i.test(text)) return "configuration value unavailable";
  return "invalid response";
}
