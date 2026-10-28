import { expect, test } from "bun:test";
import { LoopLag } from "../../src/observability/loop_lag";
import { slowSpan } from "../../src/observability/slow_span";
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
  memoryUsage?: () => NodeJS.MemoryUsage,
) {
  const records: RuntimeLogRecord[] = [];
  const loopLag = new LoopLag({
    logger: logger("loop_lag", { write: (record) => records.push(record) }),
    runningCount: () => running.length,
    runningConversations: () => running,
    ...(summaryMs === undefined ? {} : { summaryMs }),
    ...(now === undefined ? {} : { now }),
    ...(memoryUsage === undefined ? {} : { memoryUsage }),
  });
  return { loopLag, records };
}

// Feature: #2640 completed blocking spans must survive until stall sampling. (also Feature #2623 HTTP stall logs include main-thread CPU attribution.; #2631 slow stall diagnostics must not inflate sampled CPU.)
test("a CPU-blocking request logs one stall with bounded completed spans", async () => {
  let preDiagnosticsCpuMs = 0;
  const { loopLag, records } = sampler(["c1"], undefined, undefined, () => {
    const cpu = (
      process as NodeJS.Process & { threadCpuUsage(): NodeJS.CpuUsage }
    ).threadCpuUsage();
    const start = (loopLag as unknown as { mainCpuStart: number }).mainCpuStart;
    preDiagnosticsCpuMs = Math.round((cpu.user + cpu.system - start) / 1000);
    const until = performance.now() + 400;
    while (performance.now() < until) {}
    return process.memoryUsage();
  });
  const router = new Router();
  router.get("/api/block/{name}", async () => {
    slowSpan("blocking_route", "c1", () => {
      for (let i = 0; i < 6; i++)
        slowSpan("view_projection", "abcdef012345", () => {
          const usage = (
            process as NodeJS.Process & {
              threadCpuUsage(): NodeJS.CpuUsage;
            }
          ).threadCpuUsage;
          const start = usage();
          for (;;) {
            const cpu = usage();
            if (cpu.user + cpu.system - start.user - start.system >= 60_000)
              break;
          }
        });
    });
    return jsonResponse({ ok: true });
  });
  const log = logger("http", { write: () => {} });
  const server = startServer({
    logger: log,
    handler: composeApp({ router, logger: log, loopLag }),
    shutdown: async () => {},
  });
  loopLag.start();
  try {
    while ((loopLag as unknown as { samples: number[] }).samples.length === 0)
      await Bun.sleep(5);
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
  const spans = / spans=(\S+)/.exec(stalls[0]!.message)?.[1];
  expect(spans).toMatch(/blocking_route:c1:\d+:\d+/);
  expect(spans?.split(",")).toHaveLength(3);
  expect(spans).toContain("view_projection:abcdef012345:");
  const mainCpu = Number(/ main_cpu_ms=(\d+)/.exec(stalls[0]!.message)?.[1]);
  expect(Number.isInteger(mainCpu)).toBe(true);
  expect(mainCpu).toBeGreaterThan(0);
  const windowMs = Number(/ window_ms=(\d+)/.exec(stalls[0]!.message)?.[1]);
  expect(windowMs).toBeGreaterThan(ms);
  expect(mainCpu).toBeLessThanOrEqual(preDiagnosticsCpuMs);
  const diagnosticsMs = Number(
    / diagnostics_ms=(\d+)/.exec(stalls[0]!.message)?.[1],
  );
  expect(diagnosticsMs).toBeGreaterThan(0);
  const heap = Number(/ heap_mb=(\d+)/.exec(stalls[0]!.message)![1]);
  const rss = Number(/ rss_mb=(\d+)/.exec(stalls[0]!.message)![1]);
  expect(heap).toBeGreaterThan(0);
  expect(rss).toBeGreaterThan(heap);
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
