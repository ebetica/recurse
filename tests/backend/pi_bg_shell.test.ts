import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { procIds, procText } from "../../src/utils/process_table";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function groupMembers(pgid: number): Promise<number[]> {
  const members: number[] = [];
  for (const name of await procIds()) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const raw = await procText(name, "stat");
      const fields = raw
        .slice(raw.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u);
      if (fields[0] !== "Z" && Number(fields[2]) === pgid)
        members.push(Number(name));
    } catch {
      continue;
    }
  }
  return members;
}

test("a real detached group stays live after its leader exits, then is not", async () => {
  const leader = spawn("sh", ["-c", "sleep 30 </dev/null & echo $!; read x"], {
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pgid = leader.pid!;
  let memberText = "";
  leader.stdout!.on("data", (chunk) => (memberText += String(chunk)));
  const exited = new Promise((resolve) => leader.on("exit", resolve));
  while (!memberText.includes("\n")) await Bun.sleep(5);
  const raw = await procText(pgid, "stat");
  const start = raw
    .slice(raw.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/u)[19]!;
  leader.stdin!.end("\n");
  await exited;
  const member = Number(memberText.trim());
  const root = mkdtempSync(join(tmpdir(), "bg-shell-live-"));
  roots.push(root);
  mkdirSync(join(root, "sess"));
  writeFileSync(
    join(root, "sess", "g.json"),
    JSON.stringify({
      id: "g",
      status: "running",
      pid: pgid,
      pgid,
      identity: start,
      mode: "background",
      command: "sleep 30",
      startedAt: Date.now() - 1000,
    }),
  );
  const registry = new ShellRegistry({
    enabled: true,
    stateDir: root,
    processStartedMs: Date.now(),
  });
  try {
    while (!(await groupMembers(pgid)).includes(member)) await Bun.sleep(5);
    expect(await groupMembers(pgid)).toEqual([member]);
    expect(await registry.hasLiveShell("sess")).toBe(true);
  } finally {
    process.kill(-pgid, "SIGKILL");
  }
  for (let i = 0; i < 100 && (await groupMembers(pgid)).length; i++)
    await Bun.sleep(20);
  expect(await groupMembers(pgid)).toEqual([]);
  registry.invalidateCaches();
  expect(await registry.hasLiveShell("sess")).toBe(false);
});
