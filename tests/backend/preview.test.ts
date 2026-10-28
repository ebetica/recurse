import { expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/preview/cases.json";
import { applyCase, type Spec } from "./fixtures/attachments_common";
import {
  describe,
  openFile,
  readDownload,
} from "../../src/agents/runtime/attachments/preview";
import { AttachmentNotFound } from "../../src/agents/runtime/attachments/base";

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "attachment-preview-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("previews verify downloads and reject blob symlinks", async () => {
  for (const row of fixture.cases)
    await withRoot(async (root) => {
      expect(await applyCase(root, row.spec as Spec)).toEqual(row.out);
    });
  await withRoot(async (root) => {
    const spec = fixture.cases[0]!.spec as Spec;
    await applyCase(root, spec);
    const coll = join(root, "collection"),
      id = "a".repeat(32);
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "hello");
    unlinkSync(join(coll, `${id}.blob`));
    symlinkSync(secret, join(coll, `${id}.blob`));
    expect(await describe(coll, "owner", id)).toBeNull();
    expect(await openFile(coll, "owner", id)).toBeNull();
    await expect(readDownload(coll, "owner", id)).rejects.toBeInstanceOf(
      AttachmentNotFound,
    );
  });
});
test("manifest symlink to outside cannot describe or serve bytes", async () =>
  withRoot(async (root) => {
    const spec = fixture.cases[0]!.spec as Spec;
    await applyCase(root, spec);
    const coll = join(root, "collection"),
      id = "a".repeat(32);
    const secret = join(root, "secret.json");
    const manifest = join(coll, `${id}.json`);
    writeFileSync(secret, await Bun.file(manifest).text());
    unlinkSync(manifest);
    symlinkSync(secret, manifest);
    expect(await describe(coll, "owner", id)).toBeNull();
    await expect(readDownload(coll, "owner", id)).rejects.toBeInstanceOf(
      AttachmentNotFound,
    );
  }));
