import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Durable safety cases in a hermetic reviewer environment", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-safety-parity-")));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CHAT_|RECURSE_|PI_|NOPE$)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    CHAT_DATA_DIR: join(root, "data"),
    HOME: join(root, "workspace"),
    RECURSE_WORKSPACE_ROOT: join(root, "workspace"),
    RECURSE_WORKTREES_ROOT: join(root, "worktrees"),
    RECURSE_AGENT_TMPDIR: join(root, "scratch"),
    RECURSE_AGENT_ENV_FILE: join(root, "scratch", "env.sh"),
    RECURSE_SAFETY_DIR: join(root, "safety"),
    PI_CODING_AGENT_DIR: join(root, "pi-agent"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
  });
  for (const name of [
    "data",
    "workspace",
    "worktrees",
    "scratch",
    "safety",
    "pi-agent",
  ])
    mkdirSync(join(root, name), { mode: 0o700 });
  writeFileSync(env.RECURSE_AGENT_ENV_FILE!, "", { mode: 0o600 });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        new URL("./durable-cases.ts", import.meta.url).pathname,
        "--timeout",
        "30000",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const deadline = setTimeout(() => child.kill(), 45_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      console.log(stdout);
      console.error(stderr);
      expect(code).toBe(0);
    } finally {
      clearTimeout(deadline);
      child.kill();
      await child.exited;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
