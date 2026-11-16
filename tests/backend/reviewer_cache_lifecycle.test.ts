import { expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { retire } from "../../src/utils/trash.ts";
import { privateEnv, stopPrivateServer } from "../dev/private_server.ts";
import { until } from "./fixtures/durable_host/host.ts";

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Regression: #3386 terminating the live cache check must remove its credential-bearing server and scratch state.
test.skipIf(process.platform !== "linux")(
  "reviewer cache check cleans its detached server on SIGTERM",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewer-cache-lifecycle-"));
    const signIns = join(root, "sign-ins");
    const runs = join(root, "runs");
    await mkdir(signIns);
    await mkdir(runs);
    await writeFile(
      join(signIns, "auth.json"),
      JSON.stringify({ faux: { type: "api_key", key: "fixture" } }),
    );
    const check = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../live/reviewer_cache.ts"),
        "faux/fixture",
      ],
      {
        env: privateEnv(root, join(root, "outer-data"), {
          PI_CODING_AGENT_DIR: signIns,
          RECURSE_AGENT_TMPDIR: runs,
        }),
        detached: true,
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    const children = async () =>
      (
        await readFile(
          `/proc/${check.pid}/task/${check.pid}/children`,
          "utf8",
        ).catch(() => "")
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    const servers = new Set<number>();
    let runRoot = "";
    try {
      await until(async () => {
        for (const pid of await children()) servers.add(pid);
        const name = (await readdir(runs)).find((entry) =>
          entry.startsWith("reviewer-cache-"),
        );
        if (name) runRoot = join(runs, name);
        return servers.size > 0 && !!runRoot;
      });
      await until(async () =>
        (
          await readFile(join(runRoot, "server.log"), "utf8").catch(() => "")
        ).includes("listening on http://127.0.0.1:"),
      );
      process.kill(check.pid, "SIGTERM");
      await check.exited;
      for (const pid of servers) expect(groupAlive(pid)).toBe(false);
      expect(
        await access(runRoot).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      for (const pid of await children()) servers.add(pid);
      try {
        process.kill(-check.pid, "SIGKILL");
      } catch {}
      await check.exited;
      for (const pid of servers)
        await stopPrivateServer(pid, Promise.resolve(0), 0);
      retire(root, join(tmpdir(), ".trash"));
    }
  },
);
