import { expect } from "bun:test";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";

export async function groupMembers(pgid: number): Promise<number[]> {
  const members: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) members.push(Number(name));
    } catch {}
  }
  return members;
}

export async function expectGroupGone(pgid: number): Promise<void> {
  expect(pgid).toBeGreaterThan(1);
  expect(await groupMembers(pgid)).toEqual([]);
  let code = "";
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    code = String((error as NodeJS.ErrnoException).code);
  }
  expect(code).toBe("ESRCH");
}
