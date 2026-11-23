// Claim managed cwd ownership off-thread and release failed create claims.
// No cleanup or scheduling runs in the server; detached CLI sweeps own that.
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Cancelled, checkAbort } from "../utils/tasks";
import { slowSpan } from "../observability/slow-span";

export class WorktreeHolders {
  constructor(private readonly dataDir: string) {}

  /**
   * Serialize checkout validation/claim with retirement in the tool. Returns
   * the hold's stamp, which `release` needs, or null for an unmanaged cwd.
   */
  async hold(
    workdir: string,
    cid: string,
    signal = new AbortController().signal,
    mustExist = false,
  ): Promise<number | null> {
    const stamp = Date.now() / 1000;
    const held = await this.update(
      "hold",
      workdir,
      cid,
      stamp,
      signal,
      mustExist,
    );
    return held ? stamp : null;
  }

  /** Remove `cid`'s hold only while it still carries `stamp`. */
  async release(workdir: string, cid: string, stamp: number): Promise<void> {
    await this.update(
      "release",
      workdir,
      cid,
      stamp,
      new AbortController().signal,
      false,
    );
  }

  private async update(
    action: "hold" | "release",
    workdir: string,
    cid: string,
    stamp: number,
    signal: AbortSignal,
    mustExist: boolean,
  ): Promise<boolean> {
    const operation = action === "hold" ? "claim" : "release";
    const path = await realpath(workdir).catch((error) => {
      if (mustExist) throw error;
      return resolve(workdir);
    });
    const parent = await realpath(join(this.dataDir, "worktrees")).catch(() =>
      resolve(this.dataDir, "worktrees"),
    );
    const rel = relative(parent, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return false;
    checkAbort(signal);
    const child = slowSpan("worktree_holder_spawn", cid, () =>
      Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("./worktree_hold.ts", import.meta.url)),
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      ),
    );
    child.stdin.write(
      JSON.stringify({
        dataDir: this.dataDir,
        workdir: path,
        cid,
        action,
        stamp,
      }),
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
        throw new Error(`worktree ${operation} failed (${code}): ${error}`);
      const result = output.trim();
      if (result === "missing")
        throw new Error(
          "worktree was retired; enter another checkout and retry",
        );
      if (
        result !== (action === "hold" ? "held" : "released") &&
        result !== "unmanaged"
      )
        throw new Error(
          `worktree ${operation} failed: ${result || "empty response"}; retry`,
        );
      return result !== "unmanaged";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
