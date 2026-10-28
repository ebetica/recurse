import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveEnv } from "../../../../src/extensions/core/safety/path-expansion.ts";

const roots: string[] = [];
const original = {
  HOME: process.env.HOME,
  RECURSE_AGENT_TMPDIR: process.env.RECURSE_AGENT_TMPDIR,
  RECURSE_AGENT_ENV_FILE: process.env.RECURSE_AGENT_ENV_FILE,
  RECURSE_MODEL_POLICY: process.env.RECURSE_MODEL_POLICY,
};

afterEach(async () => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("effectiveEnv overlays canonical env.sh values on the process environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-expansion-"));
  roots.push(root);
  await chmod(root, 0o700);
  const file = join(root, "env.sh");
  await writeFile(file, "export ROOT='override'\nexport QUOTE='it'\"'\"'s'\n", {
    mode: 0o600,
  });
  const env = {
    ROOT: "ambient",
    HOME: "/home/agent",
    RECURSE_AGENT_TMPDIR: root,
    RECURSE_AGENT_ENV_FILE: file,
  };
  expect((await effectiveEnv(env)).ROOT).toBe("override");
  expect((await effectiveEnv(env)).QUOTE).toBe("it's");
});
