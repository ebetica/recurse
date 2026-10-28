import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import zlib from "node:zlib";

import { concatBytes, gunzipBounded } from "../../src/http_transport";
import {
  logger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import {
  composeApp,
  resolvePeer,
  startServer,
  type RunningServer,
} from "../../src/server";
import { jsonResponse, Router } from "../../src/web/router";
import { scriptedApp } from "./fixtures/http_transport/app";
import fixture from "./fixtures/http_transport/cases.json";
import {
  exchange,
  normalise,
  requestBytes,
  type CorpusCase,
  type NormalisedResponse,
} from "./http_corpus";

type TransportCase = Omit<CorpusCase, "response" | "events"> & {
  current: NormalisedResponse;
  log: { route: string; cid: string; stream_events: number | null };
  wire_headers?: Record<string, string | null>;
};
const CASES = fixture.cases as unknown as TransportCase[];
const records: RuntimeLogRecord[] = [];
let running: RunningServer;

beforeAll(() => {
  const { log, handler } = scriptedApp({
    write(record: RuntimeLogRecord) {
      if (!record.message.startsWith("event=http_unhandled_error"))
        records.push(record);
    },
  });
  running = startServer({ logger: log, handler });
});
afterAll(() => running.close());

describe("http_transport corpus", () => {
  test("current transport responses and redacted accounting follow policy", async () => {
    for (const item of CASES) {
      const start = records.length;
      const raw = await exchange(running.port, requestBytes(item.request));
      expect(normalise(raw, item.request.method), item.name).toEqual(
        item.current,
      );
      if (item.wire_headers) {
        const headers = Buffer.from(raw)
          .toString("latin1")
          .split("\r\n\r\n", 1)[0]!
          .split("\r\n")
          .slice(1)
          .map((line) => {
            const at = line.indexOf(":");
            return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
          });
        for (const [header, value] of Object.entries(item.wire_headers))
          expect(
            headers.filter(([name]) => name === header).map(([, v]) => v),
            `${item.name}: ${header}`,
          ).toEqual(value === null ? [] : [value]);
      }
      const events = records
        .slice(start)
        .filter(({ message }) =>
          /^event=(http_response|sse_stream|http_summary)(?: |$)/.test(message),
        )
        .map(({ message, conversation_id }): Record<string, string> => {
          const fields = Object.fromEntries(
            message.split(" ").map((field) => {
              const at = field.indexOf("=");
              return [field.slice(0, at), field.slice(at + 1)];
            }),
          );
          for (const key of [
            "bytes_in",
            "bytes_out",
            "ms",
            "seconds",
            "window_s",
            "bytes_0",
            "p50_ms_0",
            "p95_ms_0",
          ])
            if (key in fields) {
              expect(fields[key], `${item.name}: ${key}`).toMatch(
                /^\d+(?:\.\d+)?$/,
              );
              delete fields[key];
            }
          return { ...fields, cid: conversation_id };
        });
      const method = item.request.method;
      const { route, cid, stream_events } = item.log;
      const encoding = item.current.headers["content-encoding"] ?? "identity";
      expect(events, item.name).toEqual([
        {
          event: "http_response",
          method,
          route,
          status: String(item.current.status),
          encoding,
          cid,
        },
        ...(stream_events === null
          ? []
          : [
              {
                event: "sse_stream",
                route,
                events: String(stream_events),
                cid: "-",
              },
            ]),
        {
          event: "http_summary",
          route_0: `${method}@${route}`,
          count_0: "1",
          cid: "-",
        },
      ]);
    }
  }, 120_000);
});

describe("pieces one loopback client cannot record", () => {
  test("proxy headers are ignored from an untrusted peer", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
    });
    const peer = { host: "10.0.0.5", port: 4000 };
    expect(resolvePeer(peer, headers)).toEqual({
      client: peer,
      scheme: "http",
    });
    expect(resolvePeer({ host: "::ffff:127.0.0.1", port: 1 }, headers)).toEqual(
      { client: { host: "1.2.3.4", port: 0 }, scheme: "https" },
    );
    expect(resolvePeer(peer, headers, ["*"]).client).toEqual({
      host: "1.2.3.4",
      port: 0,
    });
  });

  test("gzip framing: header flags, CRC, length and trailing bytes", async () => {
    const raw = new TextEncoder().encode("hello world ".repeat(100));
    const good = new Uint8Array(zlib.gzipSync(raw));
    expect(await gunzipBounded(good, raw.length)).toEqual(raw);
    await expect(gunzipBounded(good, raw.length - 1)).rejects.toThrow(
      "request body is too large",
    );
    const badCrc = good.slice();
    badCrc[badCrc.length - 8]! ^= 1;
    await expect(gunzipBounded(badCrc, 1 << 20)).rejects.toThrow("invalid");
    const named = concatBytes([
      good.subarray(0, 3),
      Uint8Array.of(good[3]! | 8),
      good.subarray(4, 10),
      new TextEncoder().encode("name\0"),
      good.subarray(10),
    ]);
    expect(await gunzipBounded(named, 1 << 20)).toEqual(raw);
    const reserved = good.slice();
    reserved[3] = 0x20;
    await expect(gunzipBounded(reserved, 1 << 20)).rejects.toThrow("invalid");
  });

  test("close waits for in-flight requests, then runs shutdown once", async () => {
    const router = new Router();
    let release!: () => void;
    const entered = Promise.withResolvers<void>();
    const gate = new Promise<void>((resolve) => (release = resolve));
    router.get("/slow/{cid}", async () => {
      entered.resolve();
      await gate;
      return jsonResponse({ ok: true });
    });
    const records: RuntimeLogRecord[] = [];
    const trace = "1234567890abcdef1234567890abcdef";
    const log = logger("http", {
      write: (record) => records.push(record),
    });
    let shutdowns = 0;
    const server = startServer({
      logger: log,
      handler: composeApp({ router, logger: log }),
      shutdown: async () => {
        shutdowns += 1;
      },
    });
    const pending = fetch(`${server.url}/slow/agent-1`, {
      headers: { "x-recurse-trace": trace },
    });
    await entered.promise;
    const closed = server.close();
    void server.close();
    release();
    const response = await pending;
    expect(await response.json()).toEqual({ ok: true });
    await closed;
    expect(shutdowns).toBe(1);
    const responseLog = records.find((record) =>
      record.message.startsWith("event=http_response"),
    );
    expect(responseLog?.message).toContain(`trace_id=${trace}`);
    expect(responseLog?.conversation_id).toBe("agent-1");
  });

  test("shutdown starts while a request is still open, and sees the drain", async () => {
    const router = new Router();
    let release!: () => void;
    const entered = Promise.withResolvers<void>();
    const shutdownStarted = Promise.withResolvers<void>();
    const gate = new Promise<void>((resolve) => (release = resolve));
    router.get("/slow", async () => {
      entered.resolve();
      await gate;
      return jsonResponse({ ok: true });
    });
    const log = logger("http", { write: () => {} });
    const order: string[] = [];
    const server = startServer({
      logger: log,
      handler: composeApp({ router, logger: log }),
      shutdown: async (drained) => {
        order.push("shutdown-start");
        shutdownStarted.resolve();
        await drained;
        order.push("drained");
      },
    });
    const pending = fetch(`${server.url}/slow`);
    await entered.promise;
    const closed = server.close();
    await shutdownStarted.promise;
    expect(order).toEqual(["shutdown-start"]);
    release();
    expect(await (await pending).json()).toEqual({ ok: true });
    await closed;
    expect(order).toEqual(["shutdown-start", "drained"]);
  });
});
