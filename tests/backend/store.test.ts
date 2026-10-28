import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectionIdentityMatches,
  openCollection,
  readManifest,
  withLockedCollection,
} from "../../src/agents/runtime/attachments/store";
import { TreeLifecycleBusy } from "../../src/utils/flock";
import { readdirSync, readlinkSync } from "node:fs";

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "attachment-store-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("renamed collection is rejected after lock acquisition", async () =>
  withRoot(async (root) => {
    const coll = join(root, "collection");
    mkdirSync(coll);
    const fd = await openCollection(coll);
    renameSync(coll, `${coll}.old`);
    mkdirSync(coll);
    expect(await collectionIdentityMatches(coll, fd)).toBe(false);
    await fd.close();
    const oldFd = await openCollection(`${coll}.old`);
    await oldFd.close();
  }));
test("renaming collection while TS waits on an external flock fails identity recheck", async () =>
  withRoot(async (root) => {
    const coll = join(root, "collection");
    mkdirSync(coll);
    const py = Bun.spawn(
      ["flock", "-x", coll, "sh", "-c", "echo ready; read release"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      if ((await py.stdout.getReader().read()).done)
        throw new Error("flock holder exited before readiness");
      const deadline = performance.now() + 2000;
      const attempting = withLockedCollection(coll, async () => true, {
        timeoutMs: 2000,
        log: () => {},
      });
      while (
        !readdirSync("/proc/self/fd").some((fd) => {
          try {
            return readlinkSync(`/proc/self/fd/${fd}`) === coll;
          } catch {
            return false;
          }
        })
      ) {
        if (performance.now() >= deadline)
          throw new Error("collection contender did not open its pinned fd");
        await Bun.sleep(5);
      }
      renameSync(coll, `${coll}.old`);
      mkdirSync(coll);
      py.stdin.write("release\n");
      py.stdin.end();
      await expect(attempting).rejects.toThrow(
        "attachment collection was retired",
      );
    } finally {
      if (py.exitCode === null) py.stdin.end();
      await py.exited;
    }
  }));
test("an external flock holder excludes a TS collection contender", async () =>
  withRoot(async (root) => {
    const coll = join(root, "collection");
    mkdirSync(coll);
    const py = Bun.spawn(
      ["flock", "-x", coll, "sh", "-c", "echo ready; read release"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      if ((await py.stdout.getReader().read()).done)
        throw new Error("flock holder exited before readiness");
      await expect(
        withLockedCollection(coll, async () => true, {
          timeoutMs: 60,
          log: () => {},
        }),
      ).rejects.toBeInstanceOf(TreeLifecycleBusy);
    } finally {
      py.stdin.write("release\n");
      py.stdin.end();
      await py.exited;
    }
    expect(await withLockedCollection(coll, async () => true)).toBe(true);
  }));
test("manifest symlink swap is never read outside pinned collection", async () =>
  withRoot(async (root) => {
    const coll = join(root, "collection");
    mkdirSync(coll);
    const id = "a".repeat(32),
      secret = join(root, "secret.json");
    writeFileSync(secret, JSON.stringify({ secret: true }));
    symlinkSync(secret, join(coll, `${id}.json`));
    const fd = await openCollection(coll);
    try {
      expect(await readManifest(fd, "owner", id)).toBeNull();
    } finally {
      await fd.close();
    }
    unlinkSync(join(coll, `${id}.json`));
    const currentFd = await openCollection(coll);
    await currentFd.close();
  }));
