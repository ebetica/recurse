// Server chain: errors/accounting/compression/auth/decode/router.
// Refused callers never decode; trust proxy headers only from configured peers.
// HTTP drain and runtime shutdown start together, before launcher KILL.
// Only native adoption shares TCP with its storeless startup listener.

import type { Server } from "bun";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ServerStoppingError } from "./agents/durable/stopping_error";
import { ModelSelectionError } from "./agents/durable/model_selection";

import { HTTP_DRAIN_SECONDS } from "./shutdown_budget";

import {
  DEFAULT_MAX_ENCODED_BYTES,
  httpAccounting,
  requestDecompression,
  responseCompression,
  type CompressionOptions,
  type DecompressionOptions,
} from "./http_transport";
import type { LoopLag } from "./observability/loop_lag";
import {
  ERROR,
  INFO,
  logEvent,
  logException,
  type RuntimeLogger,
} from "./observability/runtime_logging";
import {
  unquote,
  errorResponse,
  HttpError,
  type Exchange,
  type Handler,
  type Router,
} from "./web/router";

export const IDLE_TIMEOUT_SECONDS = 255;
export const MAX_REQUEST_BODY_BYTES = DEFAULT_MAX_ENCODED_BYTES + 1024 * 1024;

export const GRACEFUL_SHUTDOWN_SECONDS = HTTP_DRAIN_SECONDS;

export type Middleware = (next: Handler) => Handler;

export interface AppOptions {
  readonly router: Router;
  readonly logger: RuntimeLogger;
  /** CSRF/auth/throttling; runs outside decompression. Identity by default. */
  readonly auth?: Middleware;
  readonly compression?: CompressionOptions;
  readonly decompression?: DecompressionOptions;
  /** Accounting clock in monotonic seconds (tests). */
  readonly clock?: () => number;
  readonly summaryInterval?: number;
  readonly heartbeatInterval?: number;
  /** The event-loop lag sampler (loop_lag.ts), told about each request. */
  readonly loopLag?: Pick<LoopLag, "request">;
}

/** Compose the fixed middleware chain around a router. */
export function composeApp(options: AppOptions): Handler {
  const auth = options.auth ?? ((next: Handler) => next);
  const route: Handler = async (ex) => {
    try {
      return await options.router.handle(ex);
    } catch (error) {
      if (error instanceof ModelSelectionError)
        return errorResponse(new HttpError(422, error.message));
      throw error;
    }
  };
  const inner = auth(requestDecompression(route, options.decompression));
  const counted = httpAccounting(
    responseCompression(inner, options.compression),
    {
      logger: options.logger,
      clock: options.clock,
      summaryInterval: options.summaryInterval,
      heartbeatInterval: options.heartbeatInterval,
    },
  );
  return async (ex) => {
    const done = options.loopLag?.request(ex);
    try {
      return await counted(ex);
    } catch (error) {
      if (error instanceof ServerStoppingError) {
        logEvent(options.logger, INFO, "http_server_stopping");
        return errorResponse(
          new HttpError(503, "server is stopping", { "retry-after": "2" }),
        );
      }
      logException(options.logger, "http_unhandled_error", error);
      return new Response("Internal Server Error", {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-length": "21",
        },
      });
    } finally {
      done?.();
    }
  };
}

const PROTOS = new Set(["http", "https", "ws", "wss"]);

function parseHostPort(value: string): { host: string; port: number } {
  const int = (text: string) =>
    /^\s*[+-]?\d+\s*$/.test(text) ? Number(text) : null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return { host: value, port: 0 };
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (!rest) return { host, port: 0 };
    if (!rest.startsWith(":")) return { host: value, port: 0 };
    return { host, port: int(rest.slice(1)) ?? 0 };
  }
  if (value.split(":").length === 2) {
    const [host, port] = value.split(":") as [string, string];
    const parsed = int(port);
    return parsed === null ? { host: value, port: 0 } : { host, port: parsed };
  }
  return { host: value, port: 0 };
}

const normalIp = (host: string) =>
  host.startsWith("::ffff:") && host.includes(".") ? host.slice(7) : host;

// Resolve trusted proxy headers only: rightmost untrusted hop, or leftmost
// when all are trusted. Loopback-token authorization relies on this boundary.
export function resolvePeer(
  peer: { host: string; port: number } | null,
  headers: { get(name: string): string | null },
  trusted: readonly string[] = ["127.0.0.1"],
): { client: { host: string; port: number } | null; scheme: string } {
  const always = trusted.includes("*");
  const isTrusted = (host: string) =>
    always || (!!host && trusted.includes(normalIp(host)));
  let scheme = "http";
  if (peer === null || !isTrusted(peer.host)) return { client: peer, scheme };
  const proto = headers.get("x-forwarded-proto");
  if (proto !== null && PROTOS.has(proto.trim())) scheme = proto.trim();
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded === null) return { client: peer, scheme };
  const hosts = forwarded.split(",").map((item) => item.trim());
  let chosen = parseHostPort(hosts[0]!);
  if (!always)
    for (const item of [...hosts].reverse()) {
      const candidate = parseHostPort(item);
      if (!isTrusted(candidate.host)) {
        chosen = candidate;
        break;
      }
    }
  return { client: chosen.host ? chosen : peer, scheme };
}

/** Protect the socket with a private directory before listening. */
export async function tailscaleSocket(dataDir: string): Promise<string> {
  const directory = join(dataDir, "tailscale");
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error(
      "Tailscale socket directory must belong to the server user",
    );
  await chmod(directory, 0o700);
  const socket = join(directory, "serve.sock");
  const entry = await lstat(socket).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (entry) {
    if (!entry.isSocket() || entry.uid !== process.getuid?.())
      throw new Error(
        "Tailscale socket path must be a socket owned by the server user",
      );
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socket);
      probe.once("connect", () => {
        probe.destroy();
        reject(new Error("Tailscale socket is already listening"));
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") resolve();
        else reject(error);
      });
      probe.setTimeout(1000, () => {
        probe.destroy();
        reject(new Error("Tailscale socket did not answer the startup probe"));
      });
    });
    await unlink(socket);
  }
  return socket;
}

export interface ServerOptions {
  readonly handler: Handler;
  readonly logger: RuntimeLogger;
  readonly host?: string;
  readonly port?: number;
  readonly forwardedAllowIps?: readonly string[];
  /** Must be inside an owner-only directory prepared by tailscaleSocket. */
  readonly tailscaleSocket?: string;
  // Run once beside drain; drained settles when no request remains.
  readonly shutdown?: (drained: Promise<void>) => Promise<void>;
  readonly installSignals?: boolean;
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  /** Drain (bounded) while shutdown runs once; resolves when both end. */
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): RunningServer {
  const inflight = new Map<number, Exchange>();
  let nextId = 0;
  let unixServer: Server | undefined;
  const serveOptions = {
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    development: false,
    async fetch(request: Request, srv: Server) {
      const url = new URL(request.url);
      const address = srv.requestIP(request);
      const peer = address
        ? { host: normalIp(address.address), port: address.port }
        : null;
      const { client, scheme } = resolvePeer(
        peer,
        request.headers as unknown as { get(name: string): string | null },
        options.forwardedAllowIps,
      );
      const ex: Exchange = {
        request,
        url,
        path: unquote(url.pathname),
        client,
        tailscaleSocket: srv === unixServer,
        scheme,
        route: null,
        params: {},
        query: {},
        bodyLimit: null,
        state: {},
        disableTimeout: () => srv.timeout(request, 0),
      };
      const id = nextId++;
      inflight.set(id, ex);
      try {
        const response = await options.handler(ex);
        if (request.method.toUpperCase() !== "HEAD") return response;
        // Invariant: Starlette produced (and accounting counted) the GET body
        // for HEAD; uvicorn dropped it on the wire. Drain it the same way.
        await response.arrayBuffer().catch(() => {});
        // Invariant: Without a declared length Bun would claim `content-length:
        // 0`; an empty stream makes it frame the (absent) body as chunked
        // instead.
        const sized = response.headers.has("content-length");
        return new Response(
          sized ? null : new ReadableStream({ pull: (c) => c.close() }),
          { status: response.status, headers: response.headers },
        );
      } finally {
        inflight.delete(id);
      }
    },
  };
  const server = Bun.serve(serveOptions);
  try {
    if (options.tailscaleSocket) {
      const { hostname: _hostname, port: _port, ...shared } = serveOptions;
      unixServer = Bun.serve({ ...shared, unix: options.tailscaleSocket });
    }
  } catch (error) {
    void server.stop(true);
    throw error;
  }
  const servers = unixServer ? [server, unixServer] : [server];

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = (async () => {
        await Promise.race([
          Promise.all(servers.map((listener) => listener.stop(false))),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, GRACEFUL_SHUTDOWN_SECONDS * 1000);
          }),
        ]);
        clearTimeout(timer);
        await Promise.all(servers.map((listener) => listener.stop(true)));
      })();
      // Invariant: Shutdown starts with the drain, not after it: runs never
      // wait on HTTP, and an open request must not use up the launcher's grace
      // before the agent runtimes (and their process groups) are closed. It
      // receives the drain so writes by late requests can be flushed.
      const shutdown = options.shutdown?.(drained) ?? Promise.resolve();
      const failed = (await Promise.allSettled([drained, shutdown])).find(
        (result) => result.status === "rejected",
      );
      if (failed) throw (failed as PromiseRejectedResult).reason;
    })());

  if (options.installSignals) {
    const onSignal = (signal: string) => {
      if (closing !== null) return;
      logEvent(options.logger, INFO, "server_signal", { fields: { signal } });
      close().catch((error) =>
        logException(options.logger, "server_shutdown_failed", error, {
          level: ERROR,
        }),
      );
    };
    // Invariant: signal-exit counts listeners after dispatch. A once listener
    // vanishes before that count and lets Pi's auth-storage dependency re-raise
    // it.
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGUSR1", () =>
      logEvent(options.logger, INFO, "server_inflight", {
        fields: {
          count: inflight.size,
          routes: [...inflight.values()].map((ex) => ex.route ?? ":unknown"),
        },
      }),
    );
  }

  return {
    server,
    port: server.port!,
    url: `http://${server.hostname}:${server.port}`,
    close,
  };
}

/** `bun src/server.ts --host H --port P [--check]`, as src/local.ts runs it. */
export function parseArgs(argv: readonly string[]): {
  host: string;
  port: number;
  check: boolean;
} {
  const out = { host: "127.0.0.1", port: 8000, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [name, inline] = arg.includes("=") ? arg.split("=", 2) : [arg, null];
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };
    if (name === "--check") out.check = true;
    else if (name === "--host") out.host = value();
    else if (name === "--port") {
      const text = value();
      if (!/^\d{1,5}$/.test(text) || Number(text) > 65535)
        throw new Error(`invalid --port: ${text}`);
      out.port = Number(text);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

// Compose --check without listening or writing live server state.
// Use private temp CHAT_DATA_DIR/RECURSE_HOME/HOME; drop PI_CODING_AGENT_DIR
// so Settings follows that root. Remove it afterward; other env stays caller's.
async function checkCompose(
  buildApp: typeof import("./web/app").buildApp,
): Promise<void> {
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const scratch = await mkdtemp(join(tmpdir(), "recurse-check-"));
  try {
    const env = {
      ...process.env,
      CHAT_DATA_DIR: join(scratch, "data"),
      RECURSE_HOME: join(scratch, "settings"),
      HOME: join(scratch, "home"),
    } as Record<string, string | undefined>;
    await mkdir(env.CHAT_DATA_DIR!, { recursive: true });
    delete env.PI_CODING_AGENT_DIR;
    const { WebLogSink } = await import("./web/app");
    const app = await buildApp({ env, sink: new WebLogSink() });
    await app.instance.shutdown();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { buildApp } = await import("./web/app");
  if (args.check) {
    await checkCompose(buildApp);
    process.exit(0);
  }
  const app = await buildApp({ env: process.env });
  const running = await app.serve({
    host: args.host,
    port: args.port,
    installSignals: true,
  });
  console.log(`recurse server listening on ${running.url}`);
  // Invariant: The signal handlers close the server; exit once shutdown has
  // finished.
  await new Promise<void>((resolve) => {
    let stopping = false;
    const done = () => {
      if (stopping) return;
      stopping = true;
      running.close().then(resolve, resolve);
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
  process.exit(0);
}

if (import.meta.main)
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
