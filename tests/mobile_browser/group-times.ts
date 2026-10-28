import { groups } from "./index";

const [logPath, outputPath, codeHead] = process.argv.slice(2);
if (!logPath || !outputPath || !codeHead)
  throw Error("Usage: group-times.ts LOG TABLE CODE_HEAD");
const log = await Bun.file(logPath).text();
const summary = /Browser summary: (\d+)\/(\d+) passed; (\d+) failures/.exec(
  log,
);
const total = groups.reduce((sum, [, tests]) => sum + tests.length, 0);
if (
  !summary ||
  Number(summary[1]) !== total ||
  Number(summary[2]) !== total ||
  Number(summary[3]) !== 0
)
  throw Error("Timing refresh requires a successful full browser run");
const timings = [
  ...log.matchAll(/^\[worker (\d+)\] Group timing: (\{.*\})$/gm),
];
if (new Set(timings.map((match) => match[1])).size !== 8)
  throw Error("Timing refresh requires eight workers");
const seconds: Record<string, number> = {};
for (const [, , json] of timings) {
  const row = JSON.parse(json!) as { name: string; seconds: number };
  if (
    seconds[row.name] !== undefined ||
    !Number.isFinite(row.seconds) ||
    row.seconds <= 0
  )
    throw Error(`Invalid or duplicate group timing: ${row.name}`);
  seconds[row.name] = row.seconds;
}
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
console.log(`Wrote ${timings.length} measured groups to ${outputPath}`);
