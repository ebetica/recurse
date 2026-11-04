import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deposit, expire, type DeletedBinPaths } from "../../src/deleted_bin";
import { expire as expirePartitions } from "../../src/utils/partition_expiry";

const NOW = 1_787_572_800.25;

async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "recurse-deleted-bin-"));
  try {
    return await body(root);
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

test("EXDEV refuses to move a deleted tree across filesystems", async () => {
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
    const policy = { ...paths(local), trashDir: join(external, "trash") };
    const partition = join(policy.deletedDir, "20260701");
    makeTree(partition, "retained after EXDEV");
    expect(
      await expirePartitions(policy.deletedDir, policy.trashDir, {
        retentionDays: policy.retentionDays,
        limit: 2,
        now: NOW,
      }),
    ).toEqual({
      examined: 2,
      retired: 0,
      recent: 1,
      malformed: 0,
      unreadable: 1,
      deferred: 0,
      cursor: "20260701",
    });
    expect(lstatSync(partition).isDirectory()).toBe(true);
    expect(readdirSync(policy.trashDir)).toEqual([]);
  } finally {
    rmSync(external, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});

test("deleted partitions drain only to the expiry limit per pass", async () => {
  await withRoot(async (root) => {
    const policy = paths(root);
    for (const date of [
      "20260701",
      "20260702",
      "20260703",
      "20260817",
      "20260230",
    ])
      mkdirSync(join(policy.deletedDir, date, "entry"), { recursive: true });
    const outside = join(root, "outside");
    makeTree(outside, "untouched");
    symlinkSync(outside, join(policy.deletedDir, "20260705"), "dir");
    writeFileSync(join(policy.deletedDir, "20260704"), "not a directory");
    writeFileSync(join(policy.deletedDir, "not-a-day"), "malformed");
    const inode = statSync(join(policy.deletedDir, "20260701")).ino;
    expect(
      await expirePartitions(policy.deletedDir, policy.trashDir, {
        retentionDays: policy.retentionDays,
        limit: 2,
        now: NOW,
      }),
    ).toEqual({
      examined: 8,
      retired: 2,
      recent: 1,
      malformed: 2,
      unreadable: 2,
      deferred: 1,
      cursor: "20260703",
    });
    expect(await expire(policy, { now: NOW, limit: 2 })).toBe(1);
    expect(readdirSync(policy.deletedDir).sort()).toEqual([
      "20260230",
      "20260704",
      "20260705",
      "20260817",
      "not-a-day",
    ]);
    const retired = readdirSync(policy.trashDir);
    expect(retired).toHaveLength(3);
    expect(
      retired.map((name) => statSync(join(policy.trashDir, name)).ino),
    ).toContain(inode);
    expect(
      lstatSync(join(policy.deletedDir, "20260705")).isSymbolicLink(),
    ).toBe(true);
    expect(readdirSync(outside)).toEqual(["nested"]);
  });
});
