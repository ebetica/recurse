import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { captureFixture } from "./fixture_subprocess";

const checkout = join(import.meta.dir, "../..");

test("launch CLI prepares roots with shell output", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "launch-cli-"));
  try {
    const env = {
      ...process.env,
      HOME: join(root, "home"),
      RECURSE_HOME: join(root, "state"),
      PI_CODING_AGENT_DIR: join(root, "state", "pi-agent"),
    };
    const result = await captureFixture(
      [
        process.execPath,
        "src/launch_cli.ts",
        "local-roots",
        "--shell",
        "--validate-launch-environment",
      ],
      { cwd: checkout, env },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      `export RECURSE_HOME=${env.RECURSE_HOME}\n`,
    );
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch CLI reports a missing build stamp with status one", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "launch-cli-"));
  try {
    const result = await captureFixture(
      [process.execPath, "src/launch_cli.ts", "build-stamp", "check", root],
      { cwd: checkout, env: process.env },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch CLI build refuses a missing root with usage status two", async () => {
  const result = await captureFixture(
    [process.execPath, "src/launch_cli.ts", "build"],
    { cwd: checkout, env: process.env },
  );
  expect(result.exitCode).toBe(2);
});

test("launch CLI build fails with status one outside a checkout", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "launch-cli-"));
  try {
    const result = await captureFixture(
      [process.execPath, "src/launch_cli.ts", "build", root],
      { cwd: checkout, env: process.env },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString() + result.stderr.toString()).toContain(
      "cannot identify the checkout generation",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
