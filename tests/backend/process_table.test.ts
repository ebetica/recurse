import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { basename } from "node:path";
import {
  bootId,
  groupSnapshot,
  identityFor,
  procStat,
  sessionMemberState,
} from "../../src/utils/proc_stat";
import { procIds, procText } from "../../src/utils/process_table";

// Feature: #2741 process identity reads the host process table on Linux and macOS.
test("a detached group's leader has a stable identity, environment and group", async () => {
  const marker = `RECURSE_PROCESS_TABLE_TEST=${process.pid}`;
  const leader = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 30000)"],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, RECURSE_PROCESS_TABLE_TEST: String(process.pid) },
    },
  );
  const pid = leader.pid!;
  let identity: Awaited<ReturnType<typeof identityFor>> | undefined;
  try {
    const first = await procStat(pid);
    expect(first.state).toBe("ok");
    const stat = first.stat!;
    expect([stat.pid, stat.pgrp, stat.session]).toEqual([pid, pid, pid]);
    expect(stat.startTime).toMatch(/^\d+$/u);
    const again = await procStat(pid);
    expect(again.stat?.startTime).toBe(stat.startTime);
    const self = await procStat(process.pid);
    expect(self.stat?.startTime).not.toBe(stat.startTime);

    expect(await procIds()).toContain(String(pid));
    expect((await procText(pid, "comm")).trim()).toBe(
      basename(process.execPath).slice(0, 15),
    );
    expect((await procText(pid, "environ")).split("\0")).toContain(marker);

    const groups = await groupSnapshot(new Set([pid]));
    expect(groups.get(pid)).toEqual({
      count: 1,
      leaderStart: stat.startTime,
      uncertain: false,
    });
    expect(await bootId()).toMatch(/^[0-9a-f-]{8,64}$/iu);
    identity = await identityFor(pid);
    expect(await sessionMemberState(identity)).toBe("present");
    expect(
      await sessionMemberState(identity, undefined, undefined, false, marker),
    ).toBe("absent");
  } finally {
    process.kill(-pid, "SIGKILL");
    await once(leader, "exit");
  }
  expect((await procStat(pid)).state).toBe("dead");
  expect(await sessionMemberState(identity!)).toBe("absent");
});
