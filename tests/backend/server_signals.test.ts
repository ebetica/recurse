import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

for (const signal of ["SIGINT"] as const) {
  // Regression: #2122 Durable auth imports must not bypass SIGINT shutdown
  test(`Durable models do not bypass server shutdown on ${signal}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "server-signals-"));
    await mkdir(join(root, "target"));
    await mkdir(join(root, "data"));
    const output = join(root, "server.log");
    const preload = join(root, "load-models.ts");
    await writeFile(
      preload,
      `const timer = setInterval(async () => {
        if (process.listenerCount("SIGTERM") < 2) return;
        clearInterval(timer);
        await import(${JSON.stringify(join(REPO, "src/agents/durable/models.ts"))});
        console.log("durable models loaded");
      }, 25);`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(REPO, "src/server.ts"),
        "--port",
        "0",
      ],
      {
        cwd: REPO,
        env: {
          PATH: process.env.PATH!,
          HOME: join(root, "home"),
          RECURSE_HOME: join(root, "settings"),
          CHAT_DATA_DIR: join(root, "data"),
          CHAT_REPO_URL: join(root, "target"),
        },
        stdout: Bun.file(output),
        stderr: Bun.file(output),
        detached: true,
      },
    );
    try {
      const deadline = performance.now() + 15_000;
      let log = "";
      while (
        !log.includes("recurse server listening on") ||
        !log.includes("durable models loaded")
      ) {
        log = await Bun.file(output).text();
        if (child.exitCode !== null || performance.now() > deadline)
          throw new Error(`Server did not start: ${log}`);
        await Bun.sleep(25);
      }
      child.kill(signal);
      const code = await Promise.race([
        child.exited,
        Bun.sleep(10_000).then(() => {
          throw new Error("Server did not finish shutdown");
        }),
      ]);
      expect(code).toBe(0);
      expect(
        await Bun.file(join(root, "data/logs/recurse.log")).text(),
      ).toContain("server_signal");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
