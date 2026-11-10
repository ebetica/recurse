import { expect, test } from "bun:test";
import { LoopLag } from "../../src/observability/loop_lag";
import { slowSpan, startSlowSpan } from "../../src/observability/slow_span";
import {
  logger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { composeApp, startServer } from "../../src/server";
import { jsonResponse, Router } from "../../src/web/router";

function sampler(
  running: string[],
  summaryMs?: number,
  now?: () => number,
  conversations?: () => readonly string[],
) {
  const records: RuntimeLogRecord[] = [];
  const loopLag = new LoopLag({
    logger: logger("loop_lag", { write: (record) => records.push(record) }),
    runningCount: () => running.length,
    runningConversations: conversations ?? (() => running),
    ...(summaryMs === undefined ? {} : { summaryMs }),
    ...(now === undefined ? {} : { now }),
  });
  return { loopLag, records };
}

// Regression: #3018 stall logs omit native accounting and exclude diagnostics from lag windows. (also Feature #2640 bounded completed spans; #2631 diagnostics stay outside sampling.)
test("a CPU-blocking request logs one stall with bounded completed spans", async () => {
  let preDiagnosticsWindowMs = 0;
  const { loopLag, records } = sampler(["c1"], undefined, undefined, () => {
    const state = loopLag as unknown as {
      expected: number;
      intervalMs: number;
    };
    preDiagnosticsWindowMs = Math.round(
      performance.now() - state.expected + state.intervalMs,
    );
    const until = performance.now() + 400;
    while (performance.now() < until) {}
    return ["c1"];
  });
  let publishedDuringBlock = false;
  const router = new Router();
  router.get("/api/block/{name}", async () => {
    const state = (loopLag as unknown as { observer: { state: BigInt64Array } })
      .observer.state;
    const version = Atomics.load(state, 1);
    slowSpan("blocking_route", "c1", () => {
      for (let i = 0; i < 6; i++)
        slowSpan("view_projection", "abcdef012345", () => {
          const until = performance.now() + 60;
          while (performance.now() < until) {}
        });
      const finish = startSlowSpan("paired_route", "c1");
      const until = performance.now() + 100;
      while (performance.now() < until) {}
      finish();
      finish();
    });
    slowSpan("later_short_work", "c1", () => {
      const until = performance.now() + 51;
      while (performance.now() < until) {}
    });
    publishedDuringBlock = Atomics.load(state, 1) > version;
    return jsonResponse({ ok: true });
  });
  const log = logger("http", { write: () => {} });
  const server = startServer({
    logger: log,
    port: 0,
    handler: composeApp({ router, logger: log, loopLag }),
    shutdown: async () => {},
  });
  loopLag.start();
  try {
    const observer = (
      loopLag as unknown as {
        observer: { state: BigInt64Array };
      }
    ).observer;
    while (Atomics.load(observer.state, 3) === 0n) await Bun.sleep(5);
    const response = await fetch(`${server.url}/api/block/x`);
    expect(await response.json()).toEqual({ ok: true });
    while (
      !records.some((r) => r.message.startsWith("event=event_loop_stall "))
    )
      await Bun.sleep(5);
  } finally {
    loopLag.stop();
    await server.close();
  }
  const stalls = records.filter((r) =>
    r.message.startsWith("event=event_loop_stall "),
  );
  expect(stalls.length).toBe(1);
  expect(stalls[0]!.level).toBe(30);
  const ms = Number(/ ms=(\d+)/.exec(stalls[0]!.message)![1]);
  console.log(stalls[0]!.message);
  expect(stalls[0]!.message).toContain(" routes=/api/block/:name");
  expect(stalls[0]!.message).toContain(" conversations=c1");
  expect(publishedDuringBlock).toBe(true);
  expect(stalls[0]!.message).toMatch(/ observer_late_ms=\d+(?: |$)/);
  expect(stalls[0]!.message).not.toMatch(
    / (?:cpu_ms|main_cpu_ms|heap_mb|rss_mb)=/,
  );
  const spans = / spans=(\S+)/.exec(stalls[0]!.message)?.[1];
  expect(spans).toMatch(/(?:^|,)blocking_route:c1:\d+(?:,|$)/);
  expect(spans?.split(",")).toHaveLength(3);
  expect(spans).not.toContain("later_short_work:");
  expect(
    spans?.split(",").filter((span) => span.startsWith("paired_route:c1:")),
  ).toHaveLength(1);
  const windowMs = Number(/ window_ms=(\d+)/.exec(stalls[0]!.message)?.[1]);
  expect(windowMs).toBeGreaterThan(ms);
  expect(windowMs).toBeLessThanOrEqual(preDiagnosticsWindowMs);
  const diagnosticsMs = Number(
    / diagnostics_ms=(\d+)/.exec(stalls[0]!.message)?.[1],
  );
  expect(diagnosticsMs).toBeGreaterThanOrEqual(400);
});

// Feature: #2502 summary windows use an injected clock independent of scheduler contention.
test("the summary is logged for an active window and not for an idle one", async () => {
  const running: string[] = [];
  let now = 0;
  const { loopLag, records } = sampler(running, 300, () => (now += 10));
  loopLag.start();
  try {
    const state = loopLag as unknown as { windowStart: number };
    for (let i = 0; i < 2; i++) {
      const previous = state.windowStart;
      while (state.windowStart === previous) await Bun.sleep(5);
    }
    expect(records).toEqual([]);
    running.push("c1");
    while (!records.some((r) => r.message.startsWith("event=event_loop_lag ")))
      await Bun.sleep(5);
  } finally {
    loopLag.stop();
  }
  const summaries = records.filter((r) =>
    r.message.startsWith("event=event_loop_lag "),
  );
  expect(summaries.length).toBeGreaterThanOrEqual(1);
  expect(summaries[0]!.level).toBe(20);
  expect(summaries[0]!.message).toMatch(
    /^event=event_loop_lag max_ms=\S+ p50_ms=\S+ p99_ms=\S+ samples=\d+$/,
  );
});
