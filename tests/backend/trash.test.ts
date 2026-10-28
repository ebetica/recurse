import { expect, test } from "bun:test";
import {
  retire,
  retireAll,
  retireIntoChild,
  sweep,
} from "../../src/utils/trash";
import fs from "node:fs";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const directoryFlags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0);

function withRoot<T>(body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "recurse-trash-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeVictim(parent: string, missing = false): string {
  const victim = join(parent, "victim");
  if (!missing) {
    mkdirSync(join(victim, "nested"), { recursive: true });
    writeFileSync(join(victim, "nested/payload.txt"), "payload");
  }
  return victim;
}

test("retirement renames the original tree and a bounded sweep deletes it later", () => {
  withRoot((root) => {
    const parent = join(root, "source");
    const trash = join(root, "trash");
    mkdirSync(parent);
    const victim = makeVictim(parent);
    const before = statSync(victim);

    expect(retire(victim, trash)).toBe(true);
    expect(existsSync(victim)).toBe(false);
    const names = readdirSync(trash);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{32}$/u);
    const parked = join(trash, names[0]!);
    const after = statSync(parked);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(readFileSync(join(parked, "nested/payload.txt"), "utf8")).toBe(
      "payload",
    );
    expect(sweep(trash, 1)).toBe(1);
    expect(readdirSync(trash)).toEqual([]);
  });
});

test("sweep is bounded, ignores foreign names, and never follows a retired symlink", () => {
  withRoot((root) => {
    const parent = join(root, "source");
    const trash = join(root, "trash");
    const outside = join(root, "outside");
    mkdirSync(parent);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    mkdirSync(trash);
    writeFileSync(join(trash, "foreign"), "untouched");

    for (let index = 0; index < 3; index += 1) {
      const victim = join(parent, `victim-${index}`);
      mkdirSync(victim);
      writeFileSync(join(victim, "payload.txt"), "payload");
      if (index === 0) symlinkSync(outside, join(victim, "escape"), "dir");
      expect(retire(victim, trash)).toBe(true);
    }

    expect(sweep(trash, 1)).toBe(1);
    expect(readdirSync(trash)).toHaveLength(3);
    expect(sweep(trash, 10)).toBe(2);
    expect(readdirSync(trash)).toEqual(["foreign"]);
    expect(readFileSync(join(trash, "foreign"), "utf8")).toBe("untouched");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });
});

test("configured symlink roots are refused without touching their targets", () => {
  withRoot((root) => {
    const parent = join(root, "source");
    const outside = join(root, "outside");
    const trash = join(parent, ".trash");
    mkdirSync(parent);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, trash, "dir");
    const victim = makeVictim(parent);

    expect(() => retire(victim, trash)).toThrow();
    expect(sweep(trash, 10)).toBe(0);
    expect(lstatSync(trash).isSymbolicLink()).toBe(true);
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });
});

test("root replacement during open rejects and closes the raced descriptor", () => {
  for (const replacement of ["symlink", "directory", "after-open"] as const) {
    withRoot((root) => {
      const trash = join(root, "trash");
      const parkedOriginal = join(root, "original");
      const outside = join(root, "outside");
      const marker = join(outside, "a".repeat(32));
      const victim = join(root, "victim");
      mkdirSync(trash);
      mkdirSync(outside);
      writeFileSync(marker, "outside bytes");
      writeFileSync(victim, "owned bytes");

      const originalOpen = fs.openSync;
      const opened: number[] = [];
      const mutableFs = fs as { openSync: typeof fs.openSync };
      mutableFs.openSync = ((path: string, flags: number, mode?: number) => {
        if (path !== trash) return originalOpen(path, flags, mode);
        let fd: number;
        if (replacement === "after-open") {
          fd = originalOpen(path, flags, mode);
        }
        renameSync(trash, parkedOriginal);
        if (replacement === "directory") mkdirSync(trash);
        else symlinkSync(outside, trash, "dir");
        if (replacement !== "after-open") {
          const noFollow = flags & ~(fsConstants.O_NOFOLLOW ?? 0);
          fd = originalOpen(path, noFollow, mode);
        }
        opened.push(fd!);
        return fd!;
      }) as typeof fs.openSync;
      try {
        expect(() => retire(victim, trash)).toThrow(
          expect.objectContaining({ code: "ESTALE" }),
        );
      } finally {
        mutableFs.openSync = originalOpen;
      }

      expect(opened).toHaveLength(1);
      expect(() => fstatSync(opened[0]!)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(readFileSync(victim, "utf8")).toBe("owned bytes");
      expect(readFileSync(marker, "utf8")).toBe("outside bytes");
    });
  }
});

test("retire-into-child replaces a planted symlink, not its target", () => {
  withRoot((root) => {
    const parent = join(root, "source");
    const outside = join(root, "outside");
    const trash = join(parent, ".trash");
    mkdirSync(parent);
    mkdirSync(outside);
    writeFileSync(join(outside, "a".repeat(32)), "keep");
    symlinkSync(outside, trash, "dir");
    makeVictim(parent);
    const fd = openSync(parent, directoryFlags);
    try {
      expect(retireIntoChild(fd, "victim", ".trash")).toBe(true);
    } finally {
      closeSync(fd);
    }
    expect(lstatSync(trash).isDirectory()).toBe(true);
    expect(lstatSync(trash).isSymbolicLink()).toBe(false);
    expect(readdirSync(trash)).toHaveLength(1);
    expect(readFileSync(join(outside, "a".repeat(32)), "utf8")).toBe("keep");
  });
});

test("same-filesystem rename rejects a cross-device trash root", () => {
  const sharedMemory = "/dev/shm";
  if (!existsSync(sharedMemory)) return;
  let external: string;
  try {
    external = mkdtempSync(join(sharedMemory, "recurse-trash-"));
  } catch {
    return;
  }
  try {
    withRoot((root) => {
      const victim = join(external, "payload");
      writeFileSync(victim, "keep");
      if (statSync(external).dev === statSync(root).dev) return;
      expect(() => retire(victim, join(root, "trash"))).toThrow(
        expect.objectContaining({ code: "EXDEV" }),
      );
      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(readdirSync(join(root, "trash"))).toEqual([]);
    });
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("retireAll reports one filesystem error and still retires later entries", () => {
  const sharedMemory = "/dev/shm";
  if (!existsSync(sharedMemory)) return;
  let external: string;
  try {
    external = mkdtempSync(join(sharedMemory, "recurse-trash-"));
  } catch {
    return;
  }
  try {
    withRoot((root) => {
      const parent = join(root, "source");
      const trash = join(root, "trash");
      mkdirSync(parent);
      const localVictim = makeVictim(parent);
      const externalVictim = join(external, "payload");
      writeFileSync(externalVictim, "keep");
      if (statSync(external).dev === statSync(root).dev) return;
      const failures: { code?: string; path: string }[] = [];
      const count = retireAll(
        [externalVictim, localVictim],
        trash,
        (error, path) =>
          failures.push({ code: (error as { code?: string }).code, path }),
      );
      expect(count).toBe(1);
      expect(failures).toEqual([{ code: "EXDEV", path: externalVictim }]);
      expect(existsSync(externalVictim)).toBe(true);
      expect(existsSync(localVictim)).toBe(false);
    });
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});
