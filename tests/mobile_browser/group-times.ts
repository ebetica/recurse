import { parseArgs } from "node:util";
import { groups } from "./index";
import recorded from "./group-times.json";

const usage =
  "Usage: bun tests/mobile_browser/group-times.ts LOG [TABLE CODE_HEAD] [--weights FILE]";
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { weights: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    `${usage}\nWithout TABLE and CODE_HEAD, report missing weights and worker imbalance only.\n--weights selects the recorded table to diagnose. Writing TABLE requires a successful full eight-worker run and replaces previous-timing notices.`,
  );
  process.exit(0);
}
if (![1, 3].includes(positionals.length)) throw Error(usage);
const [logPath, outputPath, codeHead] = positionals;
const log = await Bun.file(logPath!).text();
const weights: {
  seconds: Record<string, number>;
  unmeasured?: Record<string, string>;
} = values.weights ? await Bun.file(values.weights).json() : recorded;
const missing = groups
  .map(([name]) => name)
  .filter(
    (name) =>
      !(Number.isFinite(weights.seconds[name]) && weights.seconds[name]! > 0),
  )
  .sort();
console.log(
  `Missing recorded weights: ${missing.length}${missing.length ? ` (${missing.join(", ")})` : ""}`,
);
for (const [name, reason] of Object.entries(weights.unmeasured ?? {}))
  console.log(`Previous timing retained: ${name}: ${reason}`);
const seconds: Record<string, number> = {};
const workers = new Map<number, number>();
for (const [, worker, json] of log.matchAll(
  /^(?:\[worker (\d+)\] )?Group timing: (\{.*\})$/gm,
)) {
  const row = JSON.parse(json!) as { name: string; seconds: number };
  if (
    typeof row.name !== "string" ||
    seconds[row.name] !== undefined ||
    !Number.isFinite(row.seconds) ||
    row.seconds <= 0
  )
    throw Error(`Invalid or duplicate group timing: ${row.name}`);
  seconds[row.name] = row.seconds;
  const id = Number(worker ?? 1);
  workers.set(id, (workers.get(id) ?? 0) + row.seconds);
}
if (!workers.size) throw Error("No group timings found in the log");
console.log(
  `Worker group work (seconds): ${[...workers]
    .sort(([a], [b]) => a - b)
    .map(([id, elapsed]) => `${id}=${elapsed.toFixed(2)}`)
    .join(", ")}`,
);
const loads = [...workers.values()];
const maximum = Math.max(...loads);
const mean = loads.reduce((sum, value) => sum + value, 0) / loads.length;
console.log(
  `Worker imbalance: ${(maximum / mean).toFixed(2)}x mean (max ${maximum.toFixed(2)}s, mean ${mean.toFixed(2)}s; ${Object.keys(seconds).length} timed groups)`,
);
if (outputPath) {
  const summary =
    /^Browser summary: (\d+)\/(\d+) passed; (\d+) failures$/m.exec(log);
  const total = groups.reduce((sum, [, tests]) => sum + tests.length, 0);
  if (
    !summary ||
    Number(summary[1]) !== total ||
    Number(summary[2]) !== total ||
    Number(summary[3]) !== 0
  )
    throw Error("Timing refresh requires a successful full browser run");
  if (workers.size !== 8) throw Error("Timing refresh requires eight workers");
  if (
    JSON.stringify(Object.keys(seconds).sort()) !==
    JSON.stringify(groups.map(([name]) => name).sort())
  )
    throw Error("Timing refresh must contain every current group exactly once");
  await Bun.write(
    outputPath,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        codeHead,
        workers: 8,
        seconds: Object.fromEntries(
          Object.entries(seconds).sort(([a], [b]) => a.localeCompare(b)),
        ),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Wrote ${Object.keys(seconds).length} measured groups to ${outputPath}`,
  );
}
