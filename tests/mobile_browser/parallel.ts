import { availableParallelism } from "node:os";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { runBrowserTests, type BrowserTest } from "./common";
import recorded from "./group-times.json";

type Group = [string, BrowserTest[]];

async function processTree(pid: number, kill: boolean): Promise<void> {
  const probe = Bun.spawn(
    ["ps", "-eo", "pid=,ppid=,pgid=,stat=,wchan:24=,comm="],
    { stdout: "pipe", stderr: "ignore" },
  );
  const deadline = setTimeout(() => probe.kill("SIGKILL"), 1000);
  let output: string;
  try {
    output = await new Response(probe.stdout).text();
    await probe.exited;
  } finally {
    clearTimeout(deadline);
  }
  const rows = output
    .trim()
    .split("\n")
    .map((line) => ({ line, fields: line.trim().split(/\s+/) }));
  const owned = new Set([pid]);
  for (let size = 0; size !== owned.size; ) {
    size = owned.size;
    for (const { fields } of rows)
      if (owned.has(Number(fields[1]))) owned.add(Number(fields[0]));
  }
  for (const { line, fields } of rows.reverse()) {
    const child = Number(fields[0]);
    if (!owned.has(child)) continue;
    console.error(`Browser worker process: ${line.trim()}`);
    if (kill)
      try {
        process.kill(child, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
  }
}

export function browserArguments(args: string[]) {
  let workers = Math.min(8, availableParallelism());
  const names: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--workers") {
      workers = Number(args[++index]);
      if (!Number.isSafeInteger(workers) || workers < 1)
        throw Error("--workers requires a positive integer");
    } else names.push(args[index]!);
  }
  return { workers, names };
}

export function partitionGroups(
  groups: Group[],
  count: number,
  groupSeconds: Readonly<Record<string, number>> = recorded.seconds,
): Group[][] {
  const buckets: Group[][] = Array.from(
    { length: Math.min(count, groups.length) },
    () => [],
  );
  const values = Object.values(groupSeconds).sort((a, b) => a - b);
  const median = values.length
    ? (values[Math.floor((values.length - 1) / 2)]! +
        values[Math.floor(values.length / 2)]!) /
      2
    : 1;
  const weight = ([name]: Group) => groupSeconds[name] ?? median;
  const loads = buckets.map(() => 0);
  for (const group of [...groups].sort((a, b) => weight(b) - weight(a))) {
    const index = loads.indexOf(Math.min(...loads));
    buckets[index]!.push(group);
    loads[index]! += weight(group);
  }
  const assigned = buckets.flat();
  if (
    assigned.length !== groups.length ||
    new Set(assigned).size !== groups.length ||
    new Set(groups.map(([name]) => name)).size !== groups.length
  )
    throw Error("Browser partition must assign every group exactly once");
  return buckets.filter((bucket) => bucket.length);
}

export async function runBrowserGroups(
  groups: Group[],
  count: number,
  entry: string,
  groupSeconds: Readonly<Record<string, number>> = recorded.seconds,
  idleMs = 180_000,
): Promise<void> {
  if (count === 1 || groups.length < 2) return runBrowserTests(groups);
  const failures: string[] = [];
  const launch = (bucket: Group[], index: number) => {
    let last = `launch groups=${bucket.map(([name]) => name).join(",")}`;
    let timer: ReturnType<typeof setTimeout>;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const progress = () => {
      if (timedOut) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        const failure = `worker ${index + 1} pid=${child.pid} made no progress for ${idleMs}ms; waiting for ${last}`;
        failures.push(failure);
        console.error(failure);
        void processTree(child.pid, false).catch(console.error);
        child.kill("SIGTERM");
        escalation = setTimeout(() => {
          if (child.exitCode !== null) return;
          const kill = () => {
            if (child.exitCode === null) child.kill("SIGKILL");
          };
          const deadline = setTimeout(kill, 1500);
          void processTree(child.pid, true)
            .catch(console.error)
            .finally(() => {
              clearTimeout(deadline);
              kill();
            });
        }, 30_000);
      }, idleMs);
    };
    const child = Bun.spawn(
      [
        process.execPath,
        entry,
        "--workers",
        "1",
        ...bucket.map(([name]) => name),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    console.log(`[worker ${index + 1}] pid=${child.pid} ${last}`);
    progress();
    const capture = async (stream: typeof child.stdout) => {
      const statuses: Array<{ result: string; name: string }> = [];
      for await (const line of createInterface({
        input: Readable.fromWeb(stream as any),
      })) {
        if (
          /^(Browser progress:|Server startup:|PASS:|FAIL:|Group timing:)/.test(
            line,
          )
        ) {
          last = line;
          progress();
        }
        console.log(`[worker ${index + 1}] ${line}`);
        const match = line.match(/^(PASS|FAIL): ([a-z0-9-]+\/\w+)$/);
        if (match) statuses.push({ result: match[1]!, name: match[2]! });
      }
      return statuses;
    };
    return {
      child,
      bucket,
      output: Promise.all([capture(child.stdout), capture(child.stderr)]),
      stopTimer: () => {
        clearTimeout(timer);
        clearTimeout(escalation);
      },
    };
  };
  const workers: ReturnType<typeof launch>[] = [];
  let interrupted = "";
  const signal = (name: "SIGINT" | "SIGTERM") => {
    interrupted = name;
    for (const worker of workers)
      if (worker.child.exitCode === null) worker.child.kill(name);
  };
  const interrupt = () => signal("SIGINT");
  const terminate = () => signal("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let passed = 0;
  try {
    for (const bucket of partitionGroups(groups, count, groupSeconds))
      workers.push(launch(bucket, workers.length));
    await Promise.all(
      workers.map(async (worker, index) => {
        const exit = await worker.child.exited;
        const statuses = (await worker.output).flat();
        worker.stopTimer();
        for (const [label, tests] of worker.bucket)
          for (const test of tests) {
            const name = `${label}/${test.name}`;
            const found = statuses.findIndex((status) => status.name === name);
            if (found < 0) failures.push(`missing test: ${name}`);
            else if (statuses.splice(found, 1)[0]!.result === "FAIL")
              failures.push(name);
            else passed++;
          }
        failures.push(
          ...statuses.map((status) => `unexpected test: ${status.name}`),
        );
        if (exit) failures.push(`worker ${index + 1} exited ${exit}`);
      }),
    );
  } finally {
    for (const worker of workers)
      if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
    await Promise.all(workers.map(({ child }) => child.exited));
    for (const worker of workers) worker.stopTimer();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
  const total = groups.reduce((sum, [, tests]) => sum + tests.length, 0);
  if (interrupted) failures.push(`interrupted by ${interrupted}`);
  console.log(
    `Browser summary: ${passed}/${total} passed; ${failures.length} failures`,
  );
  if (failures.length) throw Error(`BROWSER FAILURES\n${failures.join("\n")}`);
}
