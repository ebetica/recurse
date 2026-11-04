/** Idle search CPU with external file churn; every child thread is counted.
 * Usage: hotpath_idle_cpu.ts REPO REPORT [SOURCE_CHECKOUT]
 * Startup and post-churn work must quiesce; the budget remains 120 ticks. */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { counters, delta, quiet } from "./hotpath_cpu";
import { stopPrivateServer } from "./private_server";

const sampling = process.argv[2] === "--sample";
const [repoInput, reportInput, sourceInput] = process.argv.slice(
  sampling ? 3 : 2,
);
if (!repoInput || !reportInput)
  throw new Error("Usage: hotpath_idle_cpu.ts REPO REPORT [SOURCE_CHECKOUT]");
const repo = resolve(repoInput);
const reportPath = resolve(reportInput);
const source = sourceInput ? resolve(sourceInput) : undefined;
const stopping = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => stopping.abort(new Error(signal)));
const timeout = setTimeout(
  () => stopping.abort(new Error("idle CPU driver timed out")),
  90_000,
);
const deadline = stopping.signal;
const ALLOWANCE = 120;

function message(expected: string) {
  return new Promise<void>((accept, reject) => {
    const cleanup = () => {
      process.off("message", receive);
      deadline.removeEventListener("abort", abort);
    };
    const receive = (value: unknown) => {
      if (value !== expected) return;
      cleanup();
      accept();
    };
    const abort = () => {
      cleanup();
      reject(deadline.reason);
    };
    process.on("message", receive);
    deadline.addEventListener("abort", abort, { once: true });
    if (deadline.aborted) abort();
  });
}

async function sample() {
  const module = source
    ? pathToFileURL(
        join(resolve(source), "src/extensions/extra/fff/fff_worker.ts"),
      )
    : new URL("../../src/extensions/extra/fff/fff_worker.ts", import.meta.url);
  const { FffWorker } = (await import(
    module.href
  )) as typeof import("../../src/extensions/extra/fff/fff_worker");
  const worker = new FffWorker(process.env);
  try {
    const startupBefore = await counters();
    await worker.warm();
    const bundle = await worker.open(repo);
    const result = await bundle.definitions
      .find((tool) => tool.name === "find")!
      .execute("idle-warmup", { pattern: "module" }, deadline, undefined, {
        cwd: repo,
      } as ExtensionToolContext);
    if (result.isError || !JSON.stringify(result.content).includes("module"))
      throw new Error(`idle warmup failed: ${JSON.stringify(result)}`);
    const startupQuiet = await quiet(deadline, "idle startup");
    const startup = delta(startupBefore, await counters());
    const start = message("start");
    process.send!("ready");
    await start;
    const before = await counters();
    const stop = message("stop");
    process.send!("measuring");
    await stop;
    const settled = await quiet(deadline, "idle post-churn");
    const idle = delta(before, await counters());
    const report = {
      allowance: ALLOWANCE,
      startup,
      startupQuiet,
      idle,
      settled,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (idle.ticks > ALLOWANCE)
      throw new Error(`idle CPU gate failed: ${idle.ticks} > ${ALLOWANCE}`);
  } finally {
    await worker.close();
    process.disconnect?.();
  }
}

async function drive() {
  const ready = Promise.withResolvers<void>();
  const measuring = Promise.withResolvers<void>();
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      "--sample",
      repo,
      reportPath,
      ...(source ? [source] : []),
    ],
    {
      cwd: repo,
      env: process.env,
      detached: true,
      stdout: "inherit",
      stderr: "pipe",
      ipc(value) {
        if (value === "ready") ready.resolve();
        if (value === "measuring") measuring.resolve();
      },
    },
  );
  const stderr = new Response(child.stderr).text();
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(deadline.reason);
  deadline.addEventListener("abort", abort, { once: true });
  if (deadline.aborted) abort();
  const wait = async (phase: Promise<void>) => {
    await Promise.race([
      phase,
      child.exited.then((code) => {
        throw new Error(
          `idle driver exited (${code}) before measurement: ${reportPath}`,
        );
      }),
      aborted.promise,
    ]);
    deadline.throwIfAborted();
  };
  try {
    await wait(ready.promise);
    child.send("start");
    await wait(measuring.promise);
    const end = Date.now() + 15_000;
    let churn = 0;
    while (Date.now() < end) {
      deadline.throwIfAborted();
      await writeFile(
        join(repo, "src", `idle_churn_${churn++}.ts`),
        "export const churn = true;\n",
      );
      await writeFile(join(repo, ".gitignore"), `absent-idle-${churn}\n`);
      await Bun.sleep(50);
    }
    child.send("stop");
    const code = await Promise.race([child.exited, aborted.promise]);
    if (code) throw new Error(`idle driver exited (${code}): ${await stderr}`);
    const report = await readFile(reportPath, "utf8");
    console.log(`PASS isolated idle CPU: ${report}`);
  } finally {
    deadline.removeEventListener("abort", abort);
    await stopPrivateServer(child.pid, child.exited, 1000);
    await stderr;
  }
}
try {
  if (sampling) await sample();
  else await drive();
} finally {
  clearTimeout(timeout);
}
