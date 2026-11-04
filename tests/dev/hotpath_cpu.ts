/** Linux CPU counters include live descendants and reaped child CPU.
 * Normalize child thread IDs to process leaders before summing. */
import { readFile, readdir } from "node:fs/promises";

function ticks(stat: string, includeReaped = false) {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (
    Number(fields[11]) +
    Number(fields[12]) +
    (includeReaped ? Number(fields[13]) + Number(fields[14]) : 0)
  );
}
async function processTree(root: number | "self") {
  const pids = new Set<number>([root === "self" ? process.pid : root]);
  for (const pid of pids) {
    try {
      const children = await readFile(
        `/proc/${pid}/task/${pid}/children`,
        "utf8",
      );
      for (const child of children.trim().split(/\s+/).filter(Boolean)) {
        try {
          const status = await readFile(`/proc/${child}/status`, "utf8");
          pids.add(Number(status.match(/^Tgid:\s+(\d+)/m)![1]));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return pids;
}
export async function processTicks(pid: number | "self" = "self") {
  let total = 0;
  for (const child of await processTree(pid)) {
    try {
      total += ticks(await readFile(`/proc/${child}/stat`, "utf8"), true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}
export async function counters(pid: number | "self" = "self") {
  let total = 0;
  const threads: Record<string, { name: string; ticks: number }> = {};
  for (const child of await processTree(pid)) {
    try {
      total += ticks(await readFile(`/proc/${child}/stat`, "utf8"), true);
      for (const tid of await readdir(`/proc/${child}/task`)) {
        try {
          const stat = await readFile(
            `/proc/${child}/task/${tid}/stat`,
            "utf8",
          );
          threads[tid] = {
            name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
            ticks: ticks(stat),
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { total, threads };
}
export function delta(
  before: Awaited<ReturnType<typeof counters>>,
  after: Awaited<ReturnType<typeof counters>>,
) {
  return {
    ticks: after.total - before.total,
    threads: Object.entries(after.threads)
      .map(([tid, thread]) => ({
        tid,
        name: thread.name,
        ticks: thread.ticks - (before.threads[tid]?.ticks ?? 0),
      }))
      .filter((thread) => thread.ticks > 0)
      .sort((a, b) => b.ticks - a.ticks),
  };
}
export async function quiet(
  signal: AbortSignal,
  label: string,
  pid: number | "self" = "self",
) {
  const started = Date.now();
  const end = started + 15_000;
  let before = await processTicks(pid);
  let consecutive = 0;
  const samples: number[] = [];
  while (consecutive < 3) {
    signal.throwIfAborted();
    await Bun.sleep(500);
    const after = await processTicks(pid);
    const used = after - before;
    samples.push(used);
    consecutive = used <= 2 ? consecutive + 1 : 0;
    if (Date.now() >= end)
      throw new Error(
        `${label} did not quiesce: 500ms tick samples ${JSON.stringify(samples)}`,
      );
    before = after;
  }
  return { waitedMs: Date.now() - started, samples };
}
