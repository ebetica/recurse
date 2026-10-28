import { expect, test } from "bun:test";
import fixture from "./fixtures/fs_utils/cases.json";
import {
  openPinnedDirectory,
  openPinnedLockFile,
  openPinnedRegularFile,
  readJson,
} from "../../src/agents/fs_utils";

import {
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Case = (typeof fixture.cases)[number];
async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "fs-utils-ts-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function createLeaf(root: string, c: Case): string {
  const leaf = join(root, "parent", "leaf.json");
  mkdirSync(join(root, "parent"), { mode: 0o700 });
  if ("data_hex" in c && typeof c.data_hex === "string") {
    writeFileSync(leaf, new Uint8Array(Buffer.from(c.data_hex, "hex")));
    if (c.kind === "file") chmodSync(leaf, 0o640);
  } else if (c.kind === "link") {
    writeFileSync(join(root, "outside"), '{"secret":true}');
    symlinkSync(join(root, "outside"), leaf);
  } else if (c.kind === "directory") mkdirSync(leaf);
  return leaf;
}

async function replay(c: Case): Promise<unknown> {
  return withRoot(async (root) => {
    const path = createLeaf(root, c);
    const parent = await open(
      join(root, "parent"),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      let result: unknown = null;
      let error: string | null = null;
      try {
        switch (c.op) {
          case "read_json":
            result = await readJson(
              path,
              "max_bytes" in c && c.max_bytes !== null
                ? c.max_bytes
                : undefined,
            );
            break;
          case "open_pinned_lock_file": {
            const file = await openPinnedLockFile("leaf.json", parent);
            result = (await file.stat()).mode & 0o777;
            await file.close();
            break;
          }
          case "open_pinned_regular_file": {
            const { handle, stat } = await openPinnedRegularFile(
              "leaf.json",
              parent,
            );
            result = { mode: stat.mode & 0o777, size: stat.size };
            await handle.close();
            break;
          }
          case "open_pinned_directory": {
            const dir = await openPinnedDirectory("leaf.json", parent);
            result = "directory";
            await dir.close();
            break;
          }
        }
      } catch (cause) {
        const message = String(cause);
        error = message.includes("unsafe")
          ? "unsafe"
          : message.includes("ENOENT")
            ? "missing"
            : "error";
      }
      if (c.kind === "link")
        expect(readFileSync(join(root, "outside"), "utf8")).toBe(
          '{"secret":true}',
        );
      return { result, error };
    } finally {
      await parent.close();
    }
  });
}

test("pinned opens refuse unsafe leaves and accept directories and private locks", async () => {
  for (const c of fixture.cases.filter((c) => c.kind !== "quoted_tokens")) {
    const got = (await replay(c)) as { result: unknown; error: string | null };
    if (c.op === "read_json") expect(got.result).toBeNull();
    else if (c.op === "open_pinned_directory" && c.kind === "directory")
      expect(got.error).toBeNull();
    else if (
      c.op === "open_pinned_lock_file" &&
      (c.kind === "file" || c.kind === "missing")
    ) {
      expect(got.error).toBeNull();
      expect(got.result).toBe(0o600);
    } else expect(got.error).toBe("unsafe");
  }
});

test("non-finite JSON numeric tokens survive a pinned read", async () => {
  await withRoot(async (root) => {
    const path = join(root, "numbers.json");
    writeFileSync(path, '{"n":NaN,"p":Infinity,"m":-Infinity}');
    const value = await readJson(path);
    expect(Number.isNaN(value?.n)).toBe(true);
    expect(value?.p).toBe(Infinity);
    expect(value?.m).toBe(-Infinity);
    const quoted = fixture.cases.find((c) => c.kind === "quoted_tokens")!;
    writeFileSync(path, new Uint8Array(Buffer.from(quoted.data_hex!, "hex")));
    const parsed = await readJson(path);
    expect(parsed?.text).toBe("NaN Infinity -Infinity");
    expect(Number.isNaN(parsed?.number)).toBe(true);
  });
});

test("a pinned parent cannot be redirected by replacing its pathname", async () => {
  await withRoot(async (root) => {
    const parent = join(root, "parent");
    mkdirSync(parent);
    writeFileSync(join(parent, "leaf.json"), "original");
    const handle = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      const fs = await import("node:fs/promises");
      await fs.rename(parent, join(root, "parked"));
      mkdirSync(parent);
      writeFileSync(join(parent, "leaf.json"), "replacement");
      const { handle: leaf } = await openPinnedRegularFile("leaf.json", handle);
      try {
        expect((await leaf.readFile()).toString()).toBe("original");
      } finally {
        await leaf.close();
      }
    } finally {
      await handle.close();
    }
  });
});
