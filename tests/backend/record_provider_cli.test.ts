import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("recorder double termination saves private output and leaves no process group", async () => {
  const root = await mkdtemp(
    join(process.env.RECURSE_AGENT_TMPDIR ?? tmpdir(), "recorder-cli-"),
  );
  const model = join(root, "model.json");
  const output = join(root, "output.json");
  const fixture = await Bun.file(
    `${import.meta.dir}/fixtures/provider_replay/openai-codex-auto.json`,
  ).json();
  await writeFile(model, JSON.stringify(fixture.model), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      "tests/dev/record_provider.ts",
      "--upstream",
      "https://chatgpt.com",
      "--model",
      model,
      "--output",
      output,
    ],
    {
      detached: true,
      env: { PATH: process.env.PATH!, HOME: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  try {
    const [data] = await once(child.stdout!, "data");
    expect(String(data).trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    child.kill("SIGTERM");
    child.kill("SIGTERM");
    expect(await exited).toEqual([0, null]);
    const saved = JSON.parse(await readFile(output, "utf8"));
    expect(saved.model).toEqual(fixture.model);
    expect(saved.exchanges).toEqual([]);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const retry = Bun.spawn(
      [
        process.execPath,
        "tests/dev/record_provider.ts",
        "--upstream",
        "https://chatgpt.com",
        "--model",
        model,
        "--output",
        output,
      ],
      {
        env: { PATH: process.env.PATH!, HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = new Response(retry.stderr).text();
    expect(await retry.exited).toBe(1);
    expect(await stderr).toContain("EEXIST");
    expect(await new Response(retry.stdout).text()).toBe("");
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(saved);
    try {
      process.kill(-child.pid!, 0);
      throw new Error("process group survived");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid!, "SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
