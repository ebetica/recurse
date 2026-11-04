import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: #2928 overlapping wildcard and loopback listeners must not shadow one another.
test("server refuses a port served on an overlapping address", async () => {
  for (const [existingHost, serverHost] of [
    ["0.0.0.0", "127.0.0.1"],
    ["127.0.0.1", "0.0.0.0"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "port-guard-"));
    mkdirSync(join(root, "target"));
    mkdirSync(join(root, "data"));
    const listener = Bun.serve({
      hostname: existingHost,
      port: 0,
      fetch: () => new Response("original listener"),
    });
    const port = listener.port!;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHAT_DATA_DIR: join(root, "data"),
      RECURSE_HOME: join(root, "settings"),
      HOME: join(root, "home"),
      CHAT_REPO_URL: join(root, "target"),
    };
    delete env.RECURSE_TEMP_ROOT;
    delete env.RECURSE_TEMP_IN_DATA_DIR;
    delete env.RECURSE_SELF_DEPLOY;
    delete env.PI_CODING_AGENT_DIR;
    const child = Bun.spawn(
      [
        process.execPath,
        "src/server.ts",
        "--host",
        serverHost!,
        "--port",
        String(port),
      ],
      { env, stdout: "pipe", stderr: "pipe", detached: true },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      const code = await Promise.race([
        child.exited,
        Bun.sleep(10_000).then(() => null),
      ]);
      expect(code, `server stayed alive on port ${port}`).not.toBeNull();
      expect(code).not.toBe(0);
      expect(await stderr).toContain(
        `port ${port} is already in use by another server`,
      );
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
        "original listener",
      );
    } finally {
      if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
      await child.exited;
      await Promise.all([stdout, stderr]);
      await listener.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 40_000);
