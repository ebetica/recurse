#!/usr/bin/env bun
/**
 * Benchmark search on private copies; the manifest and source stores stay read-only.
 * Usage: bun tests/dev/search_bench.ts --manifest FILE [--runs 20] [--out FILE]
 * FILE contains {items:[{cid,path,archived?}]} pointing to closed copied SQLite
 * stores. Never pass live stores. SQLite/WAL are cloned to agent scratch first.
 * Reports rebuild MB/s and agents/s, optional product sync phase profiles,
 * cold/warm p50/p95/max, append/catch-up, and 10/50/100 concurrent searches
 * of same/different targets while 1,000 commits/s stream across 20 stores.
 * --stream-seconds (default 3) sets minimum stream duration; writes start 200ms
 * before searches and continue until completion, capped at 30s to avoid flush
 * starvation. Reports the actual overlap and whether this cap was reached.
 * --rebuild-concurrency (default 1, max 16) counts pending requests, not Workers;
 * product execution remains bounded by its Worker pool.
 * --rebuild-only reports projection rates/phases without query/load cases.
 * --scoped-only skips streaming writes and concurrent reader waves.
 * Scoped queries report catch-up/ripgrep phases; append/catch-up report Worker
 * phase percentiles and individual numeric samples for diagnosing outliers.
 * --stress-runs (default 1) repeats each concurrency wave. Actual child rg
 * processes are sampled with ps every 20ms (a lower bound); search_rg logging,
 * when available, also reports exact peak. Existing loop_lag events and RSS
 * are recorded per phase. A scratch Worker owns the 20 streaming SQLite writers
 * (WAL, synchronous=NORMAL); main-loop lag excludes synthetic SQLite blocking.
 * Append/catch-up samples still insert fixture rows synchronously outside streams.
 * Stream drain checks the last transcript header's commit sequence; the legacy
 * TSV fallback keeps before/after measurements comparable on the same corpus.
 * --out writes JSON. Failed p95 budgets or unexpected search errors exit 1.
 * Busy rejections are reported separately from completed queries.
 * Rebuild rates exclude the production backfill's checkpoint/yield delays.
 */
import { Database } from "bun:sqlite";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  MessageSearch,
  SearchBusyError,
  type SearchTarget,
  type SyncStats,
} from "../../src/search";
import { SEARCH_FILE } from "../../src/search/sync.worker";
import { LoopLag } from "../../src/observability/loop_lag";
import { logger } from "../../src/observability/runtime_logging";
import { toolHelp } from "../../tools/_help.ts";
import { retire } from "../../src/utils/trash";
import type { CommitPublication } from "@earendil-works/pi-durable";

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    runs: { type: "string", default: "20" },
    "stress-runs": { type: "string", default: "1" },
    "stream-seconds": { type: "string", default: "3" },
    "rebuild-concurrency": { type: "string", default: "1" },
    "rebuild-only": { type: "boolean" },
    "scoped-only": { type: "boolean" },
    out: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(toolHelp(import.meta.url));
  process.exit(0);
}
if (!values.manifest) throw new Error("--manifest must name copied stores");
const manifest = values.manifest;
const runs = Number(values.runs);
const stressRuns = Number(values["stress-runs"]);
const streamSeconds = Number(values["stream-seconds"]);
const rebuildConcurrency = Number(values["rebuild-concurrency"]);
if (
  !Number.isInteger(rebuildConcurrency) ||
  rebuildConcurrency < 1 ||
  rebuildConcurrency > 16
)
  throw new Error("--rebuild-concurrency must be 1–16");
if (!Number.isInteger(runs) || runs < 5 || runs > 100)
  throw new Error("--runs must be 5–100");
if (!Number.isInteger(stressRuns) || stressRuns < 1 || stressRuns > 20)
  throw new Error("--stress-runs must be 1–20");
if (!Number.isFinite(streamSeconds) || streamSeconds < 1 || streamSeconds > 30)
  throw new Error("--stream-seconds must be 1–30");
const { items: sources } = JSON.parse(await readFile(manifest, "utf8")) as {
  items: SearchTarget[];
};
if (!sources.length) throw new Error("Corpus is empty");
const temp = process.env.RECURSE_AGENT_TMPDIR ?? process.env.TMPDIR;
if (!temp) throw new Error("RECURSE_AGENT_TMPDIR or TMPDIR is required");
const scratch = await mkdtemp(join(temp, "search-bench-"));
const percentile = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
};
function phases(samples: Record<string, number | undefined>[]) {
  return Object.fromEntries(
    [...new Set(samples.flatMap(Object.keys))].map((key) => [
      key,
      percentile(samples.map((sample) => sample[key] ?? 0)),
    ]),
  );
}
const budgets = {
  append: 2,
  catchup: 50,
  one: 50,
  tree: 100,
  all: 300,
  all_deleted: 1000,
};
const measurements: Record<
  string,
  ReturnType<typeof percentile> & { budget: number; pass: boolean }
> = {};
const record = (name: keyof typeof budgets, samples: number[]) => {
  const result = percentile(samples);
  measurements[name] = {
    ...result,
    budget: budgets[name],
    pass: result.p95 < budgets[name],
  };
};
let observed: ((stats: SyncStats) => void) | undefined;
let appendRejected: ((error: Error) => void) | undefined;
let activeMetrics:
  | {
      rgPeak: number;
      syncEntries: number;
      syncMs: number;
      failed: number;
      queries: Record<string, number>[];
    }
  | undefined;
const search = new MessageSearch((event, fields) => {
  if (event === "search_sync") {
    observed?.(fields as unknown as SyncStats);
    if (activeMetrics) {
      activeMetrics.syncEntries += Number(fields.entries);
      activeMetrics.syncMs += Number(fields.ms);
    }
  }
  if (event === "search_sync_failed") {
    appendRejected?.(new Error("Scheduled append failed"));
    if (activeMetrics) activeMetrics.failed++;
  }
  if (activeMetrics && event === "search_query")
    activeMetrics.queries.push(
      Object.fromEntries(
        ["catchup_ms", "rg_ms", "total_ms"].map((key) => [
          key,
          Number(fields[key]),
        ]),
      ),
    );
  if (activeMetrics && event === "search_rg")
    activeMetrics.rgPeak = Math.max(
      activeMetrics.rgPeak,
      Number(fields.active) || 0,
    );
});

async function measure<T>(name: string, work: () => Promise<T>) {
  const logs: string[] = [];
  const metrics = {
    rgPeak: 0,
    syncEntries: 0,
    syncMs: 0,
    failed: 0,
    queries: [] as Record<string, number>[],
  };
  activeMetrics = metrics;
  let rssPeak = process.memoryUsage().rss;
  let psPeak = 0;
  let rgRssPeak = 0;
  let combinedRssPeak = rssPeak;
  let psSamples = 0;
  let stopped = false;
  const sampler = (async () => {
    while (!stopped) {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      const ps = Bun.spawn(["ps", "-eo", "ppid=,comm=,rss="], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, error, code] = await Promise.all([
        new Response(ps.stdout).text(),
        new Response(ps.stderr).text(),
        ps.exited,
      ]);
      if (code !== 0) throw new Error(`ps failed: ${error}`);
      let count = 0;
      let rgRss = 0;
      for (const line of output.split("\n")) {
        const [ppid, command, rss] = line.trim().split(/\s+/);
        if (Number(ppid) === process.pid && command === "rg") {
          count++;
          rgRss += Number(rss) * 1024;
        }
      }
      psPeak = Math.max(psPeak, count);
      rgRssPeak = Math.max(rgRssPeak, rgRss);
      combinedRssPeak = Math.max(
        combinedRssPeak,
        process.memoryUsage().rss + rgRss,
      );
      psSamples++;
      if (!stopped) await Bun.sleep(20);
    }
  })();
  const lag = new LoopLag({
    logger: logger("loop_lag", {
      write: (record) => logs.push(record.message),
    }),
    runningCount: () => 1,
    runningConversations: () => [],
    summaryMs: 100,
  });
  const start = performance.now();
  lag.start();
  try {
    const value = await work();
    const ms = performance.now() - start;
    await Bun.sleep(120);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    console.error(
      `${name}: ${ms.toFixed(1)}ms; rg peak ps=${psPeak} log=${metrics.rgPeak}; RSS ${(rssPeak / 1048576).toFixed(1)}MiB`,
    );
    return {
      value,
      ms,
      rss_peak_bytes: rssPeak,
      rg_rss_peak_observed_bytes: rgRssPeak,
      combined_rss_peak_observed_bytes: combinedRssPeak,
      rg_peak_observed_ps: psPeak,
      rg_ps_samples: psSamples,
      rg_ps_interval_ms: 20,
      rg_peak_logged: metrics.rgPeak || null,
      sync_entries: metrics.syncEntries,
      sync_worker_ms: metrics.syncMs,
      sync_failures: metrics.failed,
      query_phases_ms: phases(metrics.queries),
      query_samples_ms: metrics.queries,
      loop_lag_events: logs,
      loop_lag_max_ms: Math.max(
        0,
        ...logs.map((line) => Number(/ max_ms=(\S+)/.exec(line)?.[1]) || 0),
      ),
      event_loop_stalls: logs.filter((line) =>
        line.startsWith("event=event_loop_stall "),
      ).length,
    };
  } finally {
    stopped = true;
    lag.stop();
    activeMetrics = undefined;
    await sampler;
  }
}

const fixtures: {
  target: SearchTarget;
  db: Database;
  insert: ReturnType<Database["query"]>;
  id: number;
}[] = [];
function commit(index: number) {
  const fixture = fixtures[index % fixtures.length]!;
  const value = {
    id: ++fixture.id,
    conversationId: 1,
    kind: "pi.user",
    model: [
      {
        role: "user",
        timestamp: Date.now(),
        content: "Generated benchmark message ".repeat(40),
      },
    ],
  };
  fixture.insert.run(value.id, value.id, JSON.stringify(value));
  return {
    target: fixture.target,
    publication: {
      seq: value.id,
      changes: [{ type: "entry", value }],
    } as unknown as CommitPublication,
  };
}
const producerPath = join(scratch, "producer.mjs");
let producerWritten = false;
async function stream<T>(work: () => Promise<T>) {
  if (!producerWritten) {
    await writeFile(
      producerPath,
      `
import { Database } from "bun:sqlite";
let finished = false;
self.onmessage = async ({ data }) => {
  if (data.stop) { finished = true; return; }
  const stores = [];
  let result;
  try {
    for (const target of data.stores) {
      const db = new Database(target.path);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
      stores.push({ ...target, db, insert: db.query("INSERT INTO entries VALUES(?,1,?,?)") });
    }
    self.postMessage({ ready: true });
    const start = performance.now(), samples = [], committedAt = [];
    let commits = 0;
    while ((!finished || performance.now() - start < data.seconds * 1000) && performance.now() - start < 30000) {
      const count = Math.min(100, Math.max(0, Math.floor(performance.now() - start) - commits));
      const batch = [];
      for (let n = 0; n < count; n++) {
        const at = performance.now(), store = stores[commits % stores.length];
        const value = { id: ++store.id, conversationId: 1, kind: "pi.user", model: [{ role: "user", timestamp: Date.now(), content: "Generated benchmark message ".repeat(40) }] };
        store.insert.run(value.id, value.id, JSON.stringify(value));
        batch.push({ index: commits % stores.length, committed_at: Date.now(), publication: { seq: value.id, changes: [{ type: "entry", value }] } });
        samples.push(performance.now() - at); committedAt.push(Date.now()); commits++;
      }
      if (batch.length) self.postMessage({ batch });
      await Bun.sleep(10);
    }
    result = { done: true, commits, ms: performance.now() - start, samples, committedAt, ids: stores.map(s => s.id), capped: !finished };
  } catch (error) { result = { error: String(error) }; }
  finally { for (const store of stores) store.db.close(); self.postMessage(result); }
};
`,
    );
    producerWritten = true;
  }
  const started = performance.now();
  const worker = new Worker(producerPath);
  const ready = Promise.withResolvers<void>();
  const producer = Promise.withResolvers<{
    commits: number;
    ms: number;
    samples: number[];
    committedAt: number[];
    ids: number[];
    capped: boolean;
  }>();
  const failed = Promise.withResolvers<never>();
  void producer.promise.catch(() => {});
  void failed.promise.catch(() => {});
  const dispatchSamples: number[] = [],
    ipcSamples: number[] = [];
  const fail = (error: Error) => {
    ready.reject(error);
    producer.reject(error);
    failed.reject(error);
  };
  worker.onerror = () => fail(new Error("Commit producer worker failed"));
  worker.onmessage = ({ data }) => {
    if (data.ready) ready.resolve();
    if (data.batch)
      for (const item of data.batch) {
        const start = performance.now();
        search.schedule(fixtures[item.index]!.target, item.publication);
        dispatchSamples.push(performance.now() - start);
        ipcSamples.push(Date.now() - item.committed_at);
      }
    if (data.done) {
      clearTimeout(timeout);
      producer.resolve(data);
    }
    if (data.error) {
      clearTimeout(timeout);
      fail(new Error(data.error));
    }
  };
  const timeout = setTimeout(
    () => fail(new Error("Commit producer exceeded 40s")),
    40_000,
  );
  worker.postMessage({
    stores: fixtures.map(({ target, id }) => ({ path: target.path, id })),
    seconds: streamSeconds,
  });
  let value: T;
  let workStart = 0,
    workEnd = 0,
    wallStart = 0,
    wallEnd = 0;
  let production: Awaited<typeof producer.promise>;
  try {
    await ready.promise;
    await Bun.sleep(200);
    workStart = performance.now();
    wallStart = Date.now();
    try {
      value = await Promise.race([work(), failed.promise]);
    } finally {
      workEnd = performance.now();
      wallEnd = Date.now();
      worker.postMessage({ stop: true });
      production = await producer.promise;
    }
  } finally {
    if (!workEnd) worker.postMessage({ stop: true });
    clearTimeout(timeout);
    worker.terminate();
  }
  const { commits, ms: productionMs, samples: insertTimes } = production;
  const overlapCommits = production.committedAt.filter(
    (at) => at > wallStart && at <= wallEnd,
  ).length;
  fixtures.forEach((fixture, i) => {
    fixture.id = production.ids[i]!;
  });
  const drainStart = performance.now();
  await search.drain();
  const drainMs = performance.now() - drainStart;
  const totalMs = performance.now() - started;
  for (const fixture of fixtures) {
    const file = await readFile(
      join(dirname(fixture.target.path), SEARCH_FILE),
      "utf8",
    );
    const header = [...file.matchAll(/^--- #(\d+) /gm)].at(-1);
    const sequence = Number(
      header?.[1] ?? file.trimEnd().split("\n").at(-1)?.split("\t").at(-1),
    );
    if (sequence !== fixture.id)
      throw new Error(
        `Append sequence mismatch for ${fixture.target.cid}: ${sequence} != ${fixture.id}`,
      );
  }
  return {
    value,
    commits,
    target_commits_per_second: 1000,
    stores: fixtures.length,
    production_ms: productionMs,
    stream_capped: production.capped,
    search_load_valid: overlapCommits > 0 && !production.capped,
    search_window_ms: workEnd - workStart,
    search_window_commits: overlapCommits,
    search_window_commits_per_second:
      (overlapCommits * 1000) / (workEnd - workStart),
    achieved_commits_per_second: (commits * 1000) / productionMs,
    drain_ms: drainMs,
    total_ms: totalMs,
    drained_commits_per_second: (commits * 1000) / totalMs,
    sqlite_commit_ms: percentile(insertTimes),
    publication_schedule_ms: percentile(dispatchSamples),
    commit_to_schedule_ms: percentile(ipcSamples),
  };
}

async function output(report: unknown) {
  console.log(
    JSON.stringify(
      report,
      (key, value) =>
        key === "agents_detail" || key === "loop_lag_events"
          ? undefined
          : value,
      2,
    ),
  );
  if (values.out)
    await writeFile(values.out, JSON.stringify(report, null, 2), {
      flag: "wx",
    });
}

async function benchmark() {
  const targets: SearchTarget[] = [];
  const liveRoots = process.env.CHAT_DATA_DIR
    ? await Promise.all(
        ["conversations", "agent-archive"].map((name) =>
          realpath(join(process.env.CHAT_DATA_DIR!, name)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return resolve(process.env.CHAT_DATA_DIR!, name);
          }),
        ),
      )
    : [];
  if (values.out) {
    const output = join(
      await realpath(dirname(resolve(values.out))),
      values.out.split("/").at(-1)!,
    );
    if (liveRoots.some((root) => output.startsWith(`${root}/`)))
      throw new Error("Report must be outside live data directories");
    if (
      await stat(output).then(
        () => true,
        (error) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        },
      )
    )
      throw new Error("--out must name a new file");
  }
  for (const [index, source] of sources.entries()) {
    const sourcePath = await realpath(resolve(dirname(manifest), source.path));
    if (liveRoots.some((root) => sourcePath.startsWith(`${root}/`)))
      throw new Error("Copy live stores to scratch before benchmarking");
    const path = join(scratch, "corpus", String(index), "session.sqlite");
    await mkdir(dirname(path), { recursive: true });
    await copyFile(sourcePath, path);
    await copyFile(`${sourcePath}-wal`, `${path}-wal`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    targets.push({ ...source, path });
  }
  const agents: {
    agent: string;
    entries: number;
    bytes: number;
    db_bytes: number;
    ms: number;
    profile?: Record<string, number>;
  }[] = [];
  let dbBytes = 0;
  const backfill = await measure("rebuild", async () => {
    for (
      let offset = 0;
      offset < targets.length;
      offset += rebuildConcurrency
    ) {
      await Promise.all(
        targets
          .slice(offset, offset + rebuildConcurrency)
          .map(async (target, index) => {
            const dbSize = (await stat(target.path)).size;
            dbBytes += dbSize;
            const stats = await search.sync(target);
            agents[offset + index] = {
              agent: target.agent ?? target.cid,
              db_bytes: dbSize,
              ...stats,
            };
          }),
      );
    }
  });
  const textBytes = agents.reduce((sum, row) => sum + row.bytes, 0);
  const profile: Record<string, number> = {};
  for (const row of agents)
    for (const [key, value] of Object.entries(row.profile ?? {}))
      profile[key] = (profile[key] ?? 0) + value;
  const live = targets.filter((target) => !target.archived);
  const rebuildReport = {
    manifest: resolve(manifest),
    created: new Date().toISOString(),
    agents: targets.length,
    live: live.length,
    archived: targets.length - live.length,
    db_bytes: dbBytes,
    text_bytes: textBytes,
    text_db_ratio: textBytes / dbBytes,
    rebuild_concurrency: rebuildConcurrency,
    largest_database_agent: agents.reduce((best, agent) =>
      agent.db_bytes > best.db_bytes ? agent : best,
    ),
    backfill_ms: backfill.ms,
    backfill_db_mb_per_second: dbBytes / 1e6 / (backfill.ms / 1000),
    backfill_text_mb_per_second: textBytes / 1e6 / (backfill.ms / 1000),
    backfill_agents_per_second: targets.length / (backfill.ms / 1000),
    rebuild_profile_ms: Object.keys(profile).length ? profile : null,
    per_agent: percentile(agents.map((agent) => agent.ms)),
    backfill,
    agents_detail: agents,
  };
  console.error(
    JSON.stringify({
      rebuild_ms: backfill.ms,
      profile,
      largest: rebuildReport.largest_database_agent,
      per_agent: rebuildReport.per_agent,
    }),
  );
  if (values["rebuild-only"]) {
    await output(rebuildReport);
    return;
  }
  if (!live.length) throw new Error("Corpus needs a live store");
  const largest = live.reduce((best, target) =>
    agents[targets.indexOf(target)]!.bytes >
    agents[targets.indexOf(best)]!.bytes
      ? target
      : best,
  );
  const scopes = {
    one: [largest],
    tree: [largest, ...live.filter((target) => target !== largest).slice(0, 3)],
    all: live,
    all_deleted: targets,
  };
  const cold: Record<string, number> = {};
  const warm: Record<string, unknown> = {};
  const absent = "search-bench-absent-codeword-157319";
  for (const [name, selected] of Object.entries(scopes)) {
    warm[name] = await measure(`warm_${name}`, async () => {
      const start = performance.now();
      await search.search(selected, { query: absent, scope: name });
      cold[name] = performance.now() - start;
      if (activeMetrics) activeMetrics.queries.length = 0;
      const samples = [];
      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        await search.search(selected, { query: absent, scope: name });
        samples.push(performance.now() - start);
      }
      record(name as keyof typeof budgets, samples);
    });
  }
  for (let i = 0; i < 20; i++) {
    const target = {
      cid: `append-bench-${i}`,
      path: join(scratch, `generated-${i}`, "session.sqlite"),
    };
    await mkdir(dirname(target.path), { recursive: true });
    const db = new Database(target.path, { create: true });
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE entries(id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL,commit_seq INTEGER NOT NULL,record TEXT NOT NULL)",
    );
    fixtures.push({
      target,
      db,
      insert: db.query("INSERT INTO entries VALUES(?,1,?,?)"),
      id: 0,
    });
    await search.sync(target);
  }
  const appendSamples: number[] = [],
    appendWall: number[] = [],
    catchupSamples: number[] = [];
  const appendProfiles: Record<string, number | undefined>[] = [];
  const catchupProfiles: Record<string, number | undefined>[] = [];
  const append = await measure("append_catchup", async () => {
    for (let i = 0; i < runs; i++) {
      const event = commit(0);
      const start = performance.now();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const stats = await new Promise<SyncStats>((resolve, reject) => {
        observed = resolve;
        appendRejected = reject;
        timeout = setTimeout(
          () => reject(new Error("Scheduled append exceeded 10s")),
          10_000,
        );
        search.schedule(event.target, event.publication);
      }).finally(() => {
        clearTimeout(timeout);
        observed = undefined;
        appendRejected = undefined;
      });
      appendSamples.push(stats.ms);
      appendWall.push(performance.now() - start);
      appendProfiles.push({ ms: stats.ms, ...stats.profile });
      for (let n = 0; n < 100; n++) commit(0);
      const catchupStart = performance.now();
      const caught = await search.sync(event.target);
      catchupSamples.push(performance.now() - catchupStart);
      catchupProfiles.push({ ms: caught.ms, ...caught.profile });
    }
  });
  record("append", appendSamples);
  record("catchup", catchupSamples);
  const throughput = values["scoped-only"]
    ? null
    : await measure("append_1000_per_second", () => stream(async () => {}));
  const stress: Record<string, unknown> = {};
  let searchFailures = 0;
  for (const concurrency of values["scoped-only"] ? [] : [10, 50, 100]) {
    for (const mode of ["same", "different"] as const) {
      const name = `${mode}_${concurrency}`;
      stress[name] = await measure(name, () =>
        stream(async () => {
          const latencies: number[] = [];
          const busyLatencies: number[] = [];
          const errors: string[] = [];
          for (let wave = 0; wave < stressRuns; wave++) {
            await Promise.all(
              Array.from({ length: concurrency }, async (_, i) => {
                const selected =
                  mode === "same"
                    ? [...targets, ...fixtures.map((fixture) => fixture.target)]
                    : [
                        targets[i % targets.length]!,
                        fixtures[i % fixtures.length]!.target,
                      ];
                const start = performance.now();
                try {
                  await search.search(selected, {
                    query: absent,
                    scope: `bench_${name}`,
                  });
                  latencies.push(performance.now() - start);
                } catch (error) {
                  if (error instanceof SearchBusyError) {
                    busyLatencies.push(performance.now() - start);
                    if (concurrency <= 10) searchFailures++;
                  } else {
                    errors.push(String(error));
                    searchFailures++;
                  }
                }
              }),
            );
          }
          return {
            concurrency,
            mode,
            waves: stressRuns,
            targets_per_search:
              mode === "same" ? targets.length + fixtures.length : 2,
            latency_ms: percentile(latencies),
            busy_rejections: busyLatencies.length,
            busy_latency_ms: percentile(busyLatencies),
            errors,
          };
        }),
      );
    }
  }
  const report = {
    ...rebuildReport,
    generator_execution: "sqlite_worker",
    generator_loop_lag_warning:
      "Streaming SQLite writes run off-main; append/catch-up phases still include synchronous fixture insertion.",
    scoped_only: Boolean(values["scoped-only"]),
    cold_ms: cold,
    append_dispatch_ms: percentile(appendWall),
    append_phases_ms: phases(appendProfiles),
    append_samples_ms: appendProfiles,
    catchup_phases_ms: phases(catchupProfiles),
    catchup_samples_ms: catchupProfiles,
    measurements,
    backfill,
    warm,
    append,
    throughput,
    stress,
    search_failures: searchFailures,
    agents_detail: agents,
  };
  await output(report);
  if (
    searchFailures ||
    Object.values(measurements).some((measurement) => !measurement.pass)
  )
    process.exitCode = 1;
}
try {
  await benchmark();
} finally {
  await search.close();
  for (const fixture of fixtures) fixture.db.close();
  retire(scratch, join(temp, ".trash"));
}
