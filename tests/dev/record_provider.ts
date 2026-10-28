#!/usr/bin/env bun
/**
 * Opt-in loopback recorder for test provider captures; see --help.
 * Output is private (0600): inspect and scrub it before committing.
 */
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  requestBody,
  requestShape,
  protocolHeaders,
  type Recording,
} from "../backend/fixtures/provider_replay/server";

/** Scrub echoed prompts, descriptions and ids without moving wire bounds. */
export function scrubRecording(source: Recording): Recording {
  const recording = structuredClone(source);
  delete recording.model.headers;
  const ids = new Map<string, string>();
  for (const exchange of recording.exchanges) {
    const bytes = Buffer.concat(
      exchange.chunks.map(
        (chunk) => new Uint8Array(Buffer.from(chunk.data, "base64")),
      ),
    );
    const publicText =
      exchange.transport === "websocket"
        ? exchange.chunks
            .map((chunk) => {
              const frame = Buffer.from(chunk.data, "base64").toString("utf8");
              const event = JSON.parse(frame);
              if (event.type !== "codex.rate_limits") return frame;
              const neutral = JSON.stringify({ type: event.type });
              return (
                neutral +
                " ".repeat(
                  Buffer.byteLength(frame) - Buffer.byteLength(neutral),
                )
              );
            })
            .join("")
        : bytes.toString("utf8");
    const text = publicText
      .replace(
        /\b(?:resp|msg|toolu|call|fc|rs)_[A-Za-z0-9_-]+/g,
        (id, at, wire) => {
          if (/^"\s*:/.test(wire.slice(at + id.length))) return id;
          if (!ids.has(id)) {
            const prefix = id.slice(0, id.indexOf("_") + 1);
            ids.set(
              id,
              prefix +
                String(ids.size + 1).padStart(id.length - prefix.length, "0"),
            );
          }
          return ids.get(id)!;
        },
      )
      .replace(
        /("(?:instructions|system|prompt|description|prompt_cache_key|safety_identifier|user|user_id|account_id|chatgpt_account_id|session_id|signature|encrypted_content|x-codex-turn-state|x-models-etag)"\s*:\s*")((?:\\.|[^"\\])*)(")/g,
        (_, prefix, value, suffix) =>
          prefix + "x".repeat(Buffer.byteLength(value)) + suffix,
      )
      .replace(
        /("type"\s*:\s*"(?:response\.reasoning_summary_text\.(?:delta|done)|summary_text)"[^{}]*?"(?:delta|text)"\s*:\s*")((?:\\.|[^"\\])*)(")/g,
        (_, prefix, value, suffix) =>
          prefix + "x".repeat(Buffer.byteLength(value)) + suffix,
      );
    const scrubbed = Buffer.from(text);
    if (scrubbed.byteLength !== bytes.byteLength)
      throw new Error("scrub changed wire byte length");
    let offset = 0;
    for (const chunk of exchange.chunks) {
      const size = Buffer.from(chunk.data, "base64").byteLength;
      chunk.data = scrubbed.subarray(offset, offset + size).toString("base64");
      offset += size;
    }
  }
  return recording;
}

/** Fixed upstreams keep the recorder from becoming a credential proxy. */
export function recordProvider(upstream: string, recording: Recording) {
  if (
    ![
      "https://chatgpt.com",
      "https://api.openai.com",
      "https://api.anthropic.com",
    ].includes(new URL(upstream).origin)
  )
    throw new Error("unsupported recording upstream");
  if (new URL(upstream).username || new URL(upstream).password)
    throw new Error("unsupported recording upstream");
  const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const sockets = new Set<WebSocket>();
  const server = Bun.serve<{
    upstream: WebSocket;
    exchange?: Recording["exchanges"][number];
    started: number;
    requestHeaders: Record<string, string>;
  }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      const target = new URL(upstream);
      target.pathname = url.pathname;
      target.search = url.search;
      const headers = new Headers(request.headers);
      headers.delete("host");
      if (request.headers.get("upgrade") === "websocket") {
        target.protocol = "wss:";
        for (const name of [
          "connection",
          "upgrade",
          "sec-websocket-key",
          "sec-websocket-version",
          "sec-websocket-extensions",
        ])
          headers.delete(name);
        const remote = new WebSocket(target, {
          headers: Object.fromEntries(headers),
        });
        sockets.add(remote);
        await new Promise<void>((resolve, reject) => {
          remote.addEventListener("open", () => resolve(), { once: true });
          remote.addEventListener(
            "error",
            () => reject(new Error("upstream WebSocket failed")),
            { once: true },
          );
        });
        if (
          server.upgrade(request, {
            data: {
              upstream: remote,
              started: 0,
              requestHeaders: protocolHeaders(request.headers),
            },
          })
        )
          return;
        remote.close();
        return new Response("upgrade failed", { status: 400 });
      }
      const body = await requestBody(request);
      headers.delete("content-encoding");
      headers.delete("content-length");
      const started = performance.now();
      const abort = new AbortController();
      controllers.add(abort);
      const response = await fetch(target.href, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: abort.signal,
      });
      const exchange: Recording["exchanges"][number] = {
        transport: "sse",
        path,
        request: requestShape(body),
        requestHeaders: protocolHeaders(request.headers),
        status: response.status,
        headers: Object.fromEntries(
          ["content-type", "retry-after"].flatMap((name) =>
            response.headers.has(name)
              ? [[name, response.headers.get(name)!]]
              : [],
          ),
        ),
        chunks: [],
      };
      recording.exchanges.push(exchange);
      return new Response(
        new ReadableStream({
          start(controller) {
            const done = (async () => {
              try {
                if (response.body)
                  for await (const bytes of response.body) {
                    exchange.chunks.push({
                      ms: Math.round(performance.now() - started),
                      data: Buffer.from(bytes).toString("base64"),
                    });
                    controller.enqueue(bytes);
                  }
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            })();
            active.add(done);
            void done.then(
              () => {
                active.delete(done);
                controllers.delete(abort);
              },
              () => {
                active.delete(done);
                controllers.delete(abort);
              },
            );
          },
        }),
        { status: response.status, headers: exchange.headers },
      );
    },
    websocket: {
      open(socket) {
        socket.data.upstream.addEventListener("message", (event) => {
          if (typeof event.data !== "string")
            throw new Error("non-text provider frame");
          socket.data.exchange?.chunks.push({
            ms: Math.round(performance.now() - socket.data.started),
            data: Buffer.from(event.data).toString("base64"),
          });
          socket.sendText(event.data);
        });
        socket.data.upstream.addEventListener("close", () => socket.close());
      },
      message(socket, message) {
        const body = JSON.parse(String(message));
        const exchange: Recording["exchanges"][number] = {
          transport: "websocket",
          path:
            new URL(socket.data.upstream.url).pathname +
            new URL(socket.data.upstream.url).search,
          request: requestShape(body),
          requestHeaders: socket.data.requestHeaders,
          status: 101,
          headers: {},
          chunks: [],
        };
        recording.exchanges.push(exchange);
        socket.data.exchange = exchange;
        socket.data.started = performance.now();
        socket.data.upstream.send(String(message));
      },
      close(socket) {
        socket.data.upstream.close();
        sockets.delete(socket.data.upstream);
      },
    },
  });
  return {
    baseUrl: server.url.origin,
    async close() {
      for (const socket of sockets) socket.close();
      for (const abort of controllers) abort.abort();
      await Promise.allSettled(active);
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: bun tests/dev/record_provider.ts --upstream URL --model FILE --output FILE\nOpt-in loopback capture of built-in Pi SSE/WebSocket. Model FILE is a catalog model JSON.\nOnly ChatGPT/OpenAI/Anthropic HTTPS origins are allowed. Output must not already exist.\nUse one fresh private credential; no refresh. Inspect scrubbed output before committing.",
    );
    process.exit(0);
  }
  const { values } = parseArgs({
    options: {
      upstream: { type: "string" },
      model: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.upstream || !values.model || !values.output)
    throw new Error("required: --upstream URL --model FILE --output FILE");
  const model = await Bun.file(values.model).json();
  const recording: Recording = {
    provenance: {
      date: new Date().toISOString().slice(0, 10),
      model: model.id,
      pi: "1.1.0",
      scenario: "plain reply",
    },
    model,
    exchanges: [],
  };
  const output = await open(values.output, "wx", 0o600);
  const recorder = recordProvider(values.upstream, recording);
  let finishing: Promise<void> | undefined;
  const finish = () =>
    (finishing ??= (async () => {
      try {
        await recorder.close();
        await output.writeFile(
          JSON.stringify(scrubRecording(recording), null, 2),
        );
      } finally {
        await output.close();
      }
    })());
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void finish().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  console.log(recorder.baseUrl);
}
