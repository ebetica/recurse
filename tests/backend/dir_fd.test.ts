import { afterAll, expect, test } from "bun:test";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  entriesAt,
  lstatAt,
  lstatAtSync,
  mkdirAt,
  openAt,
  openAtSync,
  readdirAt,
  readdirAtSync,
  renameAt,
  rmdirAtSync,
  unlinkAt,
} from "../../src/utils/dir_fd";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dir-fd-"));
const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Feature: #2739 descriptor-relative operations follow the pinned directory.
test("operations resolve through a pinned directory after its path moves", async () => {
  const before = join(root, "before");
  const after = join(root, "after");
  const other = join(root, "other");
  for (const path of [before, other]) await Bun.write(join(path, ".keep"), "");
  const fd = openSync(before, DIRECTORY);
  const otherFd = openSync(other, DIRECTORY);
  try {
    renameSync(before, after);
    await Bun.write(join(before, "file"), "decoy");
    const created = await openAt(
      fd,
      "file",
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await created.write("pinned");
    await created.close();
    expect(readFileSync(join(after, "file"), "utf8")).toBe("pinned");
    expect(lstatSync(join(after, "file")).mode & 0o777).toBe(0o600);
    const real = lstatSync(join(after, "file"), { bigint: true });
    const viaFd = await lstatAt(fd, "file", { bigint: true });
    expect([viaFd.dev, viaFd.ino, viaFd.size, viaFd.mtimeNs]).toEqual([
      real.dev,
      real.ino,
      real.size,
      real.mtimeNs,
    ]);
    expect(viaFd.isFile()).toBe(true);
    const plain = lstatAtSync(fd, "file");
    expect([plain.dev, plain.ino, plain.isFile()]).toEqual([
      lstatSync(join(after, "file")).dev,
      lstatSync(join(after, "file")).ino,
      true,
    ]);

    symlinkSync(join(after, "file"), join(after, "link"));
    expect((await lstatAt(fd, "link")).isSymbolicLink()).toBe(true);
    await expect(
      openAt(fd, "link", constants.O_RDONLY | constants.O_NOFOLLOW),
    ).rejects.toMatchObject({ code: "ELOOP" });
    await expect(lstatAt(fd, "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await mkdirAt(fd, "child", 0o700);
    expect(lstatSync(join(after, "child")).mode & 0o777).toBe(0o700);
    await expect(mkdirAt(fd, "child", 0o700)).rejects.toMatchObject({
      code: "EEXIST",
    });
    const childFd = openAtSync(fd, "child", DIRECTORY);
    try {
      expect(fstatSync(childFd).ino).toBe(lstatSync(join(after, "child")).ino);
    } finally {
      closeSync(childFd);
    }

    expect((await readdirAt(fd)).sort()).toEqual([
      ".keep",
      "child",
      "file",
      "link",
    ]);
    const lazy: string[] = [];
    for await (const name of await entriesAt(fd)) lazy.push(name);
    expect(lazy.sort()).toEqual(readdirAtSync(fd).sort());

    await renameAt(fd, "file", otherFd, "moved");
    expect(readFileSync(join(other, "moved"), "utf8")).toBe("pinned");
    await unlinkAt(fd, "link");
    rmdirAtSync(fd, "child");
    expect(readdirAtSync(fd)).toEqual([".keep"]);
    writeFileSync(join(after, "plain"), "");
    expect(readdirAtSync(fd).sort()).toEqual([".keep", "plain"]);
    expect(readFileSync(join(before, "file"), "utf8")).toBe("decoy");
  } finally {
    closeSync(fd);
    closeSync(otherFd);
  }
});
