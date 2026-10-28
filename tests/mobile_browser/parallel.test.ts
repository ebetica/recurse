import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism, tmpdir } from "node:os";
import { expect as browserExpect } from "playwright/test";
import { retire } from "../../src/utils/trash";
import { groups } from "./index";
import { browserArguments, partitionGroups } from "./parallel";

const entry = join(import.meta.dir, "parallel_fixture.ts");
function launch(args: string[], env = process.env) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env,
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  let text = "";
  const capture = async (stream: typeof child.stdout) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      text += decoder.decode(chunk, { stream: true });
  };
  const output = Promise.all([
    capture(child.stdout),
    capture(child.stderr),
  ]).then(() => text);
  return { child, output, text: () => text };
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("every real browser group is assigned exactly once", () => {
  for (const workers of [1, 2, 3, 4, 8, groups.length + 1]) {
    const actual = partitionGroups(groups, workers).flat();
    expect(actual.length).toBe(groups.length);
    expect(new Set(actual)).toEqual(new Set(groups));
  }
  const subset = groups.filter(([name]) =>
    ["live-tools", "settings", "mobile-layout", "header"].includes(name),
  );
  for (const workers of [4, 8])
    expect(partitionGroups(subset, workers).length).toBe(subset.length);
  expect(browserArguments(["themes", "--workers", "1"])).toEqual({
    names: ["themes"],
    workers: 1,
  });
  expect(() => browserArguments(["--workers", "0"])).toThrow();
});

// Feature: #2452 the default CLI cap and each real group's result remain visible.
test("a failing real group exits nonzero and names its test", async () => {
  const { child, output } = launch(["pass", "fail"]);
  expect(await child.exited).not.toBe(0);
  const text = await output;
  expect(text).toContain(
    `Browser worker cap: ${Math.min(8, availableParallelism())}`,
  );
  expect(text.match(/PASS: pass\/test_pass/g)?.length).toBe(1);
  expect(text.match(/FAIL: fail\/test_failure/g)?.length).toBe(1);
  expect(text).toContain("fail/test_failure");
  expect(text).toContain("Browser summary: 1/2 passed");
}, 30_000);

for (const blocked of [false, true])
  // Regression: #2591 stalled browser workers must fail and remove their real processes.
  test(`an ${blocked ? "event-loop-blocked" : "idle"} worker fails with its active step and cleans up`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-idle-"));
    const { child, output } = launch(["--workers", "2", "hold-a", "hold-b"], {
      ...process.env,
      BROWSER_PROBE_DIR: dir,
      BROWSER_PROBE_IDLE_MS: "10000",
      ...(blocked ? { BROWSER_PROBE_BLOCK: "1" } : {}),
    });
    try {
      expect(await child.exited).not.toBe(0);
      const text = await output;
      expect(text).toContain("made no progress for 10000ms");
      expect(text).toContain("waiting for Browser progress: group=hold-");
      expect(text).toContain("step=test:test_hold server_pid=");
      const records = (await readdir(dir)).filter((name) =>
        name.endsWith(".json"),
      );
      expect(records.length).toBe(2);
      for (const name of records) {
        const { worker, server, chrome } = await Bun.file(
          join(dir, name),
        ).json();
        await browserExpect
          .poll(() => [worker, server, -server, chrome, -chrome].some(alive), {
            timeout: 5_000,
          })
          .toBe(false);
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      retire(dir, join(tmpdir(), ".trash"));
    }
  }, 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  // Regression: #2591 worker progress must be visible before the worker exits.
  test(`${signal} removes worker, server and Chromium process groups`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-signal-"));
    const { child, output, text } = launch(
      ["--workers", "2", "hold-a", "hold-b"],
      {
        ...process.env,
        BROWSER_PROBE_DIR: dir,
      },
    );
    let pids: Array<{ worker: number; server: number; chrome: number }> = [];
    try {
      await browserExpect
        .poll(
          async () =>
            (await readdir(dir)).filter((name) => name.endsWith(".json"))
              .length,
          { timeout: 20_000 },
        )
        .toBe(2);
      pids = await Promise.all(
        (await readdir(dir))
          .filter((name) => name.endsWith(".json"))
          .map((name) => Bun.file(join(dir, name)).json()),
      );
      for (const record of pids)
        for (const pid of Object.values(record)) expect(alive(pid)).toBe(true);
      expect(text()).toContain("step=test:test_hold server_pid=");
      process.kill(-child.pid, signal);
      expect(await child.exited).not.toBe(0);
      await output;
      await browserExpect
        .poll(
          () =>
            [
              child.pid,
              -child.pid,
              ...pids.flatMap(({ worker, server, chrome }) => [
                worker,
                server,
                -server,
                chrome,
                -chrome,
              ]),
            ].some(alive),
          { timeout: 5_000 },
        )
        .toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      for (const { server, chrome } of pids)
        for (const pid of [server, chrome])
          if (alive(pid)) process.kill(-pid, "SIGKILL");
      retire(dir, join(tmpdir(), ".trash"));
    }
  }, 30_000);
