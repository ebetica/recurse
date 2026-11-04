// Record real regressions and replay rotation safety in TLC.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [java, jar, scratch] = process.argv.slice(2);
if (!java || !jar || !scratch)
  throw new Error("expected java, TLC jar, scratch");
const root = resolve(import.meta.dir, "../..");
const dir = join(scratch, "rotation");
mkdirSync(dir, { recursive: true });
const sites: [string, number][] = [
  ["src/agents/durable/sqlite_worker.ts", 6],
  ["src/agents/durable/sqlite_thread.worker.ts", 2],
  ["src/agents/durable/host/view.ts", 2],
  ["src/agents/durable/host.ts", 2],
  ["src/agents/durable/host/delete.ts", 2],
  ["src/agents/durable/host/clear.ts", 1],
  ["src/agents/durable/archive.ts", 2],
  ["src/search/index.ts", 6],
  ["src/search/search.worker.ts", 3],
  ["src/search/sync.worker.ts", 3],
];
for (const [file, count] of sites) {
  const found = readFileSync(join(root, file), "utf8").match(
    /Spec: @tla/g,
  )?.length;
  if (found !== count)
    throw new Error(`rotation marker count: ${file}: ${found} != ${count}`);
}

async function record(name: string, args: string[]): Promise<string> {
  const path = join(dir, `${name}.ndjson`);
  writeFileSync(path, "", { mode: 0o600 });
  const child = Bun.spawn(
    [
      "timeout",
      "25",
      process.execPath,
      ...(args[0] === "test" ? [args.shift()!] : []),
      "--preload",
      join(import.meta.dir, "rotation_preload.ts"),
      ...args,
    ],
    {
      cwd: root,
      env: { ...process.env, RECURSE_ROTATION_TRACE: path },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const status = await child.exited;
  if (status)
    throw new Error(
      `rotation recording failed: ${name}: exit=${status}, signal=${child.signalCode}`,
    );
  return path;
}

type Event = Record<"a" | "p" | "id" | "k" | "s" | "op", string>;
function events(path: string): Event[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const value = JSON.parse(line);
      const result = {} as Event;
      for (const key of ["a", "p", "id", "k", "s", "op"] as const) {
        if (typeof value[key] !== "string")
          throw new Error(`invalid trace field: ${line}`);
        result[key] = value[key];
      }
      if (result.p) result.p = resolve(result.p);
      return result;
    });
}

async function check(
  name: string,
  trace: Event[],
  expected?: string,
): Promise<void> {
  const model = join(dir, name);
  mkdirSync(model);
  writeFileSync(
    join(model, "RotationTrace.tla"),
    readFileSync(join(root, "specs/tla/RotationTrace.tla"), "utf8"),
  );
  const literal = trace
    .map(
      (event) =>
        `[${Object.entries(event)
          .map(([key, value]) => `${key} |-> ${JSON.stringify(value)}`)
          .join(",")} ]`,
    )
    .join(",\n");
  writeFileSync(
    join(model, "Recorded.tla"),
    `---- MODULE Recorded ----\nEXTENDS RotationTrace\nRecordedEvents == <<${literal}>>\n====\n`,
  );
  writeFileSync(
    join(model, "Recorded.cfg"),
    "SPECIFICATION Spec\nCONSTANT Events <- RecordedEvents\nINVARIANTS RenameClosed NoAdmissionAfterFence CorrelatedProtocol TraceClosed\nCHECK_DEADLOCK FALSE\n",
  );
  const log = Bun.file(join(model, "tlc.log"));
  const child = Bun.spawn(
    [
      "timeout",
      "15",
      java!,
      "-Xmx1g",
      "-XX:+UseParallelGC",
      `-Djava.io.tmpdir=${model}`,
      "-cp",
      jar!,
      "tlc2.TLC",
      "-workers",
      "1",
      "-seed",
      "1",
      "-fp",
      "0",
      "-noGenerateSpecTE",
      "-metadir",
      join(model, "states"),
      "Recorded.tla",
    ],
    { cwd: model, stdout: log, stderr: log },
  );
  const status = await child.exited;
  const output = await log.text();
  const valid = expected
    ? status === 12 &&
      output.includes(`Error: Invariant ${expected} is violated.`)
    : status === 0 &&
      output.includes("Model checking completed. No error has been found.");
  if (!valid)
    throw new Error(
      `unexpected rotation replay ${name} (${status}):\n${output}`,
    );
  console.log(
    `rotation ${name}: ${trace.length} events, ${expected ?? "PASS"}; ${model}/tlc.log`,
  );
}

const started = performance.now();
const trace = events(
  await record("real", [
    "test",
    "--timeout",
    "20000",
    "tests/backend/durable_deliver.test.ts",
    "tests/backend/agent_archive.test.ts",
    "tests/backend/message_search_fuzz.test.ts",
    "-t",
    "view session identity follows|a failed archive|drains cold readers before deletion|archive expiry waits|message search catches missed commits",
  ]),
);
for (const [file] of sites)
  if (
    !trace.some((event) => event.a === "module" && event.p === join(root, file))
  )
    throw new Error(`marker module was not loaded: ${file}`);
for (const kind of ["page", "search", "connection"])
  if (!trace.some((event) => event.a === "admit" && event.k === kind))
    throw new Error(`missing real-path admission: ${kind}`);
for (const op of ["sync", "syncSearch"])
  if (!trace.some((event) => event.a === "receive" && event.op === op))
    throw new Error(`missing worker sync coverage: ${op}`);
if (
  !trace.some(
    (event) => event.a === "rename" && event.p.includes("agent-archive"),
  )
)
  throw new Error("archive rename was not recorded");
await check("real", trace);
const bug = events(
  await record("bug", ["tests/dev/rotation_bug.ts", join(dir, "bug-store")]),
);
if (!bug.some((event) => event.a === "receive" && event.op === "sync"))
  throw new Error("missing standalone worker sync coverage");
await check("bug", bug, "RenameClosed");
console.log(
  `rotation trace check: ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
