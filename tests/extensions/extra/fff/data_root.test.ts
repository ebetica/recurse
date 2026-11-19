import { expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, readSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { FffWorker } from "../../../../src/extensions/extra/fff/fff_worker.ts";

// Regression: #3437 broad external roots must not scan Recurse's mutable data directory.
test.skipIf(process.platform !== "linux")(
  "external searches refuse data roots before scanning but allow subdirectories",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fff-data-root-"));
    const workspace = path.join(root, "workspace");
    const data = path.join(root, "state");
    const child = path.join(data, "worktrees");
    const alias = path.join(root, "state-alias");
    const sibling = path.join(root, "state-other");
    await mkdir(workspace);
    await mkdir(child, { recursive: true });
    await mkdir(sibling);
    await symlink(data, alias);
    await writeFile(path.join(workspace, "workspace.txt"), "needle\n");
    await writeFile(path.join(child, "child.txt"), "needle\n");
    await writeFile(path.join(sibling, "sibling.txt"), "needle\n");
    const service = new FffWorker({
      ...process.env,
      CHAT_DATA_DIR: alias,
      PI_CODING_AGENT_DIR: root,
    });
    const libc = dlopen("libc.so.6", {
      inotify_init1: { args: [FFIType.i32], returns: FFIType.i32 },
      inotify_add_watch: {
        args: [FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    let watch = -1;
    try {
      const bundle = await service.open(workspace, {
        "fff-frecency-db": path.join(root, "frecency"),
        "fff-history-db": path.join(root, "history"),
      });
      const find = bundle.definitions.find((tool) => tool.name === "find")!;
      const search = (target?: string) =>
        find.execute(
          "data",
          { pattern: "*.txt", ...(target ? { path: target } : {}) },
          undefined,
          undefined,
          { cwd: workspace } as ExtensionToolContext,
        );
      expect((await search()).details).toMatchObject({ totalFiles: 1 });
      watch = libc.symbols.inotify_init1(constants.O_NONBLOCK);
      expect(watch).toBeGreaterThanOrEqual(0);
      const watched = new TextEncoder().encode(`${data}\0`);
      expect(
        libc.symbols.inotify_add_watch(watch, ptr(watched), 0x20),
      ).toBeGreaterThanOrEqual(0);
      for (const target of [data, alias, root]) {
        await expect(search(target)).rejects.toThrow(
          `contains the Recurse data directory, so it is not indexed. Search a narrower directory such as ${child}, or use rg in bash.`,
        );
      }
      const events = new Uint8Array(4096);
      expect(() => readSync(watch, events, 0, events.length, null)).toThrow(
        "EAGAIN",
      );
      await readdir(data);
      expect(readSync(watch, events, 0, events.length, null)).toBeGreaterThan(
        0,
      );
      expect((await search(child)).details).toMatchObject({ totalFiles: 1 });
      expect((await search(sibling)).details).toMatchObject({ totalFiles: 1 });
    } finally {
      if (watch >= 0) closeSync(watch);
      libc.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
