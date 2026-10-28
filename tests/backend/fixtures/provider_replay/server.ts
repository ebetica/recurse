// Recorded provider bytes cross a real loopback HTTP/WebSocket boundary.
// Request validation ignores conversation text, never model/tool/effort fields.
// Fixtures keep public output; echoed prompts, identifiers and signatures are padded.
// JSON provenance records capture date/model/Pi; original chunk sizes/timing remain.
import { isDeepStrictEqual } from "node:util";

export interface Recording {
  provenance: { date: string; model: string; pi: string; scenario: string };
  model: import("@earendil-works/pi-ai").Model<
    import("@earendil-works/pi-ai").Api
  >;
  exchanges: {
    transport: "sse" | "websocket";
    path: string;
    request: Record<string, unknown>;
    requestHeaders: Record<string, string>;
    status: number;
    headers: Record<string, string>;
    chunks: { ms: number; data: string }[];
  }[];
}

/** Allowlist protocol headers; credentials/account/session headers never persist. */
export function protocolHeaders(
  headers: Pick<Headers, "has" | "get">,
): Record<string, string> {
  return Object.fromEntries(
    [
      "content-type",
      "anthropic-version",
      "anthropic-beta",
      "openai-beta",
    ].flatMap((name) =>
      headers.has(name) ? [[name, headers.get(name)!]] : [],
    ),
  );
}

/** Keep provider controls and tool schemas, but no private conversation text. */
export function requestShape(body: Record<string, unknown>) {
  const shape: Record<string, unknown> = {};
  for (const key of [
    "model",
    "stream",
    "store",
    "reasoning",
    "thinking",
    "max_tokens",
    "max_output_tokens",
    "output_config",
    "text",
    "include",
    "tool_choice",
    "parallel_tool_calls",
    "tools",
  ])
    if (key in body)
      shape[key] =
        key === "tools"
          ? JSON.parse(
              JSON.stringify(body[key], (key, value) =>
                ["description", "cache_control"].includes(key)
                  ? undefined
                  : value,
              ),
            )
          : body[key];
  for (const key of ["input", "messages", "instructions", "system"])
    if (key in body)
      shape[key] = Array.isArray(body[key])
        ? body[key].length
          ? "nonempty array"
          : "empty array"
        : typeof body[key];
  return shape;
}

/** Additional Recurse tools are allowed; recorded tools must remain intact. */
export function checkRequest(
  expected: Record<string, unknown>,
  body: Record<string, unknown>,
) {
  const actual = requestShape(body);
  for (const [key, value] of Object.entries(expected)) {
    if (
      key === "tools" &&
      Array.isArray(value) &&
      Array.isArray(actual.tools)
    ) {
      for (const tool of value) {
        const match = actual.tools.find(
          (candidate: any) => candidate.name === tool.name,
        );
        if (!isDeepStrictEqual(tool, match))
          throw new Error(`request mismatch: tool ${tool.name}`);
      }
    } else if (!isDeepStrictEqual(value, actual[key])) {
      throw new Error(`request mismatch: ${key}`);
    }
  }
}

/** Codex compresses HTTP requests, but sends plain JSON WebSocket frames. */
export async function requestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const decoded =
    request.headers.get("content-encoding") === "zstd"
      ? (
          Bun as unknown as {
            zstdDecompressSync(bytes: Uint8Array): Uint8Array;
          }
        ).zstdDecompressSync(bytes)
      : bytes;
  return JSON.parse(new TextDecoder().decode(decoded));
}

/** Parser tests may scale delays to zero; live-state tests keep recorded pacing (default 1). */
export function replayProvider(
  recording: Recording,
  { timeScale = 1 }: { timeScale?: number } = {},
) {
  if (!Number.isFinite(timeScale) || timeScale < 0)
    throw new Error("invalid replay time scale");
  const failures: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const cursors = { sse: 0, websocket: 0 };
  let websocketConnections = 0;
  let resolveWebsocketClosed!: () => void;
  const websocketClosed = new Promise<void>((resolve) => {
    resolveWebsocketClosed = resolve;
  });
  const select = (
    transport: "sse" | "websocket",
    path: string,
    body: Record<string, unknown>,
    headers: Pick<Headers, "has" | "get">,
  ) => {
    const exchange = recording.exchanges.filter(
      (entry) => entry.transport === transport,
    )[cursors[transport]++];
    if (!exchange) throw new Error(`unexpected ${transport} request`);
    if (path !== exchange.path)
      throw new Error(`request mismatch: path ${path}`);
    checkRequest(exchange.request, body);
    const actualHeaders = protocolHeaders(headers);
    for (const [name, value] of Object.entries(exchange.requestHeaders))
      if (actualHeaders[name] !== value)
        throw new Error(`request mismatch: header ${name}`);
    requests.push(body);
    return exchange;
  };
  const send = async (
    chunks: Recording["exchanges"][number]["chunks"],
    emit: (bytes: Uint8Array) => void,
  ) => {
    let previous = 0;
    for (const chunk of chunks) {
      await Bun.sleep(Math.max(0, chunk.ms - previous) * timeScale);
      previous = chunk.ms;
      emit(new Uint8Array(Buffer.from(chunk.data, "base64")));
    }
  };
  const server = Bun.serve<{
    path: string;
    headers: Pick<Headers, "has" | "get">;
  }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      if (request.headers.get("upgrade") === "websocket") {
        if (
          server.upgrade(request, { data: { path, headers: request.headers } })
        )
          return;
        return new Response("upgrade failed", { status: 400 });
      }
      try {
        if (request.method !== "POST")
          throw new Error("request mismatch: method");
        const exchange = select(
          "sse",
          path,
          await requestBody(request),
          request.headers,
        );
        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                await send(exchange.chunks, (bytes) =>
                  controller.enqueue(bytes),
                );
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            },
          }),
          { status: exchange.status, headers: exchange.headers },
        );
      } catch (error) {
        failures.push(String(error));
        return new Response(String(error), { status: 400 });
      }
    },
    websocket: {
      close() {
        resolveWebsocketClosed();
      },
      open() {
        websocketConnections++;
      },
      async message(socket, message) {
        try {
          const body = JSON.parse(String(message));
          if (body.type !== "response.create")
            throw new Error("request mismatch: WebSocket type");
          const exchange = select(
            "websocket",
            socket.data.path,
            body,
            socket.data.headers,
          );
          await send(exchange.chunks, (bytes) =>
            socket.sendText(new TextDecoder().decode(bytes)),
          );
        } catch (error) {
          failures.push(String(error));
          socket.close(1008, "recording mismatch");
        }
      },
    },
  });
  return {
    server,
    baseUrl: server.url.origin,
    requests,
    failures,
    websocketClosed,
    get websocketConnections() {
      return websocketConnections;
    },
    assertComplete() {
      if (failures.length) throw new Error(failures.join("\n"));
      if (requests.length !== recording.exchanges.length)
        throw new Error("unused recorded exchanges");
    },
  };
}
