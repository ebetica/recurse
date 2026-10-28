import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addUpload,
  registerFile,
  removeFile,
} from "../../src/agents/runtime/attachments/publish";
import {
  MAX_FILE_BYTES,
  MAX_UPLOAD_BYTES,
} from "../../src/agents/runtime/attachments/base";
import { publishedFiles } from "../../src/agents/runtime/attachments/published";

async function withCollection(fn: (collection: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "publish-"));
  const collection = join(root, "collection");
  await mkdir(collection);
  try {
    await fn(collection);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("rejects one file above the per-file limit", () =>
  withCollection(async (collection) => {
    await expect(
      addUpload(collection, "owner", new Uint8Array(5), "large.bin", {
        limits: { maxFileBytes: 4 },
      }),
    ).rejects.toThrow("file is too large");
  }));

test("a conversation can hold more than the former 100 MB cap", () =>
  withCollection(async (collection) => {
    const ids = (() => {
      let n = 0;
      return () => (++n).toString(16).padStart(32, "0");
    })();
    const items = [];
    const payload = new Uint8Array(MAX_UPLOAD_BYTES);
    for (let n = 0; n < 5; n++)
      items.push(
        await addUpload(collection, "owner", payload, `f${n}.bin`, {
          ids,
          limits: { maxFileBytes: MAX_FILE_BYTES },
        }),
      );
    expect(items).toHaveLength(5);
    expect(await publishedFiles(collection, "owner")).toHaveLength(5);
    expect(await removeFile(collection, "owner", String(items[0]!.id))).toBe(
      true,
    );
  }));

test("an agent publishes up to 100 MB; uploads stay at 25 MB", () =>
  withCollection(async (collection) => {
    const source = join(collection, "..", "big.bin");
    await writeFile(source, "x");
    await truncate(source, MAX_UPLOAD_BYTES + 1);
    const run = "a".repeat(32);
    const published = await registerFile(
      collection,
      "owner",
      run,
      "call-1",
      source,
      "/",
    );
    expect(published.size).toBe(MAX_UPLOAD_BYTES + 1);
    const second = join(collection, "..", "second.txt");
    await writeFile(second, "second published file");
    const other = await registerFile(
      collection,
      "owner",
      run,
      "call-1",
      second,
      "/",
      { manyPerCall: true },
    );
    for (const [path, id] of [
      [source, published.id],
      [second, other.id],
    ]) {
      const replayed = await registerFile(
        collection,
        "owner",
        run,
        "call-1",
        String(path),
        "/",
        { manyPerCall: true },
      );
      expect(replayed.id).toBe(id);
    }
    expect(await publishedFiles(collection, "owner")).toHaveLength(2);
    const version = await registerFile(
      collection,
      "owner",
      run,
      "new-call",
      second,
      "/",
      { manyPerCall: true },
    );
    expect(version.id).not.toBe(other.id);
    await expect(
      addUpload(
        collection,
        "owner",
        new Uint8Array(MAX_UPLOAD_BYTES + 1),
        "big.bin",
      ),
    ).rejects.toThrow("file is too large (max 25 MB)");
    await truncate(source, MAX_FILE_BYTES + 1);
    await expect(
      registerFile(collection, "owner", run, "call-2", source, "/"),
    ).rejects.toThrow("file is too large (max 100 MB)");
  }));
