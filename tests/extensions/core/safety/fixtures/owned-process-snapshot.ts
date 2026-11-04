import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ownedProcessSnapshot } from "../../../../../src/extensions/core/safety/process-snapshot.ts";

const trace = process.env.RECURSE_BLOCKING_TRACE!;
const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
await new Promise<void>((resolve, reject) => {
  child.once("spawn", resolve);
  child.once("error", reject);
});
const exited = new Promise<void>((resolve) =>
  child.once("exit", () => resolve()),
);
async function waitFor<T>(read: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + 5000;
  while (true) {
    try {
      return await read();
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await Bun.sleep(5);
    }
  }
}
try {
  const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
  const identity = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)[19]!;
  process.kill(process.pid, "SIGUSR2");
  await waitFor(async () => {
    if ((await readFile(`${trace}.armed`, "utf8")) !== "ready")
      throw new Error("blocking trace is not armed");
  });
  const snapshot = await ownedProcessSnapshot([
    { pid: child.pid!, pgid: child.pid!, identity },
  ]);
  process.kill(process.pid, "SIGUSR2");
  const sites = await waitFor(
    async () =>
      JSON.parse(await readFile(trace, "utf8")) as Array<{
        site: string;
        stack: string;
      }>,
  );
  console.log(
    JSON.stringify({
      pid: child.pid,
      snapshot,
      blocking: sites
        .filter((site) => site.stack.includes("/safety/process-snapshot.ts:"))
        .map((site) => site.site),
    }),
  );
} finally {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {}
  await exited;
}
