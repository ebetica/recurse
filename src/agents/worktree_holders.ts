// Claim managed cwd ownership off-thread before create/chdir admission.
// No cleanup or scheduling runs in the server; detached CLI sweeps own that.
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Cancelled, checkAbort } from "../utils/tasks";

export class WorktreeHolders {
  constructor(private readonly dataDir: string) {}

  /** Serialize checkout validation/claim with retirement in the tool. */
  async hold(
    workdir: string,
    cid: string,
    signal = new AbortController().signal,
    mustExist = false,
  ): Promise<void> {
    const path = await realpath(workdir).catch((error) => {
      if (mustExist) throw error;
      return resolve(workdir);
    });
    const parent = await realpath(join(this.dataDir, "worktrees")).catch(() =>
      resolve(this.dataDir, "worktrees"),
    );
    const rel = relative(parent, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return;
    checkAbort(signal);
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./worktree_hold.ts", import.meta.url)),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(
      JSON.stringify({ dataDir: this.dataDir, workdir: path, cid }),
    );
    child.stdin.end();
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 60_000);
    try {
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (signal.aborted) throw new Cancelled();
      if (code !== 0)
        throw new Error(`worktree claim failed (${code}): ${error}`);
      const result = output.trim();
      if (result === "missing")
        throw new Error(
          "worktree was retired; enter another checkout and retry",
        );
      if (result !== "held" && result !== "unmanaged")
        throw new Error(
          `worktree claim failed: ${result || "empty response"}; retry`,
        );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
