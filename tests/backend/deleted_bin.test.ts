import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deposit, expire, type DeletedBinPaths } from "../../src/deleted_bin";

const NOW = 1_787_572_800.25;

function withRoot<T>(body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "recurse-deleted-bin-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function paths(root: string): DeletedBinPaths {
  return {
    deletedDir: join(root, "deleted"),
    trashDir: join(root, "trash"),
    retentionDays: 7,
    expiryLimit: 4,
  };
}

function makeTree(path: string, payload: string): void {
  mkdirSync(join(path, "nested"), { recursive: true });
  writeFileSync(join(path, "nested", "weights.bin"), payload);
}

test("EXDEV refuses to move a deleted tree across filesystems", () => {
  const sharedMemory = "/dev/shm";
  if (!existsSync(sharedMemory)) return;
  let external: string;
  try {
    external = mkdtempSync(join(sharedMemory, "recurse-deleted-bin-"));
  } catch {
    return;
  }
  const local = mkdtempSync(join(tmpdir(), "recurse-deleted-bin-local-"));
  try {
    if (statSync(external).dev === statSync(local).dev) return;
    const source = join(external, "source");
    mkdirSync(source);
    const victim = join(source, "victim");
    makeTree(victim, "payload");
    expect(() =>
      deposit(
        victim,
        { kind: "worktree", key: "victim", manifest: {}, now: NOW },
        paths(local),
      ),
    ).toThrow(expect.objectContaining({ code: "EXDEV" }));
    expect(lstatSync(victim).isDirectory()).toBe(true);
  } finally {
    rmSync(external, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});

test("deleted partitions drain only to the expiry limit per pass", () => {
  withRoot((root) => {
    const policy = paths(root);
    for (const date of ["20260701", "20260702", "20260703"])
      mkdirSync(join(policy.deletedDir, date, "entry"), { recursive: true });
    expect(expire(policy, { now: NOW, limit: 2 })).toBe(2);
    expect(expire(policy, { now: NOW, limit: 2 })).toBe(1);
    expect(readdirSync(policy.deletedDir)).toEqual([]);
    expect(readdirSync(policy.trashDir)).toHaveLength(3);
  });
});
