import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedHost } from "./fixtures/provider_replay/host.ts";
import { until } from "./fixtures/durable_host/host.ts";

test("recorded provider turn resumes after restart mid-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-recovery-"));
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/provider_replay/kill_child.ts"),
      root,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  let host: Awaited<ReturnType<typeof recordedHost>> | undefined;
  try {
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("PROVIDER_REQUEST_ACCEPTED")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`child exited before provider request: ${out}`);
      out += new TextDecoder().decode(value);
    }
    child.kill("SIGKILL");
    await child.exited;
    let exitCode: string | undefined;
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      exitCode = (error as NodeJS.ErrnoException).code;
    }
    expect(exitCode).toBe("ESRCH");
    host = await recordedHost(root);
    await host.host.openLive();
    await until(async () => {
      const view = await host!.host.view("c1");
      return (
        view.turn_status === "idle" &&
        JSON.stringify(view.blocks).includes("RECORDED_PROVIDER_OK")
      );
    });
    const view = await host.host.view("c1");
    expect(
      (view.blocks as { role: string; text: string }[])
        .filter((b) => b.role === "user")
        .map((b) => b.text),
    ).toEqual(["Public restart message."]);
    expect(
      (view.blocks as { role: string; text: string }[])
        .filter((b) => b.role === "assistant")
        .map((b) => b.text),
    ).toEqual(["RECORDED_PROVIDER_OK"]);
    expect(host.replay.failures).toEqual([]);
    expect(host.replay.requests).toHaveLength(1);
    host.replay.assertComplete();
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
