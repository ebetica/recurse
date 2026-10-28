import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retire } from "../../src/utils/trash";
import { expect as browserExpect } from "playwright/test";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
for (const mode of ["pass", "fail"]) {
  // Regression: #2635 a failed test with a held Route must not strand the worker's remaining tests.
  test(`server log is ${mode === "pass" ? "retired on success" : "retained on failure"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-log-probe-"));
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "logging_fixture.ts"), mode],
      {
        env: {
          ...process.env,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
        },
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      expect(await child.exited).toBe(mode === "pass" ? 0 : 1);
      const output = `${await stdout}\n${await stderr}`;
      const probe = await Bun.file(join(directory, "probe.json")).json();
      await browserExpect
        .poll(
          () =>
            [
              child.pid,
              -child.pid,
              probe.server,
              -probe.server,
              probe.chrome,
              -probe.chrome,
            ].some(alive),
          { timeout: 5_000 },
        )
        .toBe(false);
      expect(await Bun.file(probe.log).exists()).toBe(mode === "fail");
      let logPath = probe.log;
      expect(output).toContain("PASS: logging/afterCleanup");
      if (mode === "fail") {
        expect(output).toContain(`Browser server log: ${probe.log}`);
        expect(output).toContain("deliberate logging failure with held route");
        expect(output).toContain("cleanup route-drain exceeded");
        expect(output).toContain("cleanup-route-drain elapsed_ms=");
        expect(output).toContain("pages=http://");
      } else {
        expect(output).not.toContain("Browser server log:");
        const retired = await readdir(join(directory, ".trash"));
        expect(retired.length).toBe(1);
        logPath = join(directory, ".trash", retired[0]!, "logging.log");
      }
      const log = await Bun.file(logPath).text();
      for (const stream of ["stdout", "stderr"])
        expect(log).toMatch(
          new RegExp(
            `^\\d{4}-\\d\\d-\\d\\dT[^ ]+ ${probe.server} ${stream}: browser server ${stream} probe$`,
            "m",
          ),
        );
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
      retire(directory, join(tmpdir(), ".trash"));
    }
  }, 60_000);
}
