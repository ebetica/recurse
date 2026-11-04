import { writeFile } from "node:fs/promises";
import { counters, delta, quiet } from "./hotpath_cpu";
import { FffWorker } from "../../src/extensions/extra/fff/fff_worker";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const [repo, reportPath, refreshMs] = process.argv.slice(2);
if (!repo || !reportPath)
  throw new Error("Usage: hotpath_search_cpu.ts REPO REPORT [REFRESH_MS]");
const deadline = AbortSignal.timeout(120_000);
const worker = new FffWorker(process.env);
const context = { cwd: repo } as ExtensionToolContext;

try {
  await worker.warm();
  const bundle = await worker.open(
    repo,
    refreshMs ? { "fff-refresh-interval-ms": refreshMs } : {},
  );
  const search = async (name: string) => {
    const result = await bundle.definitions
      .find((tool) => tool.name === name)!
      .execute(
        name,
        { pattern: name === "find" ? "module" : "idle_gate_value" },
        deadline,
        undefined,
        context,
      );
    const expected = name === "find" ? "module" : "idle_gate_value";
    if (result.isError || !JSON.stringify(result.content).includes(expected))
      throw new Error(`search failed: ${JSON.stringify(result)}`);
  };
  await quiet(deadline, "search driver");
  const coldBefore = await counters();
  await search("find");
  await quiet(deadline, "search driver");
  const cold = delta(coldBefore, await counters());
  const burstBefore = await counters();
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1100);
    await search(i % 2 ? "grep" : "find");
  }
  await quiet(deadline, "search driver");
  const burst = delta(burstBefore, await counters());
  const burstAllowance = 8 * cold.ticks + 50;
  const report = {
    singleTicks: cold.ticks,
    burstTicks: burst.ticks,
    burstAllowance,
    cold,
    burst,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (burst.ticks > burstAllowance) throw new Error("search CPU gate failed");
} finally {
  await worker.close();
}
