// Update a managed holder under the worktree retirement lock.
import { basename } from "node:path";
import {
  addHolder,
  managedRoot,
  removeHolder,
  rootFromEnv,
  withCleanerLock,
} from "../../tools/worktree";

const { dataDir, workdir, cid, action, stamp } = JSON.parse(
  await Bun.stdin.text(),
) as {
  dataDir: string;
  workdir: string;
  cid: string;
  action?: "hold" | "release";
  stamp: number;
};
const root = rootFromEnv(dataDir);
const result =
  action === "release"
    ? await withCleanerLock(
        root,
        () => {
          const checkout = managedRoot(root, workdir);
          if (checkout === null) return "unmanaged";
          if (!removeHolder(root, basename(checkout), cid, stamp))
            throw new Error("could not remove worktree holder");
          return "released";
        },
        5_000,
      )
    : await addHolder(root, workdir, cid, stamp);
process.stdout.write(`${result}\n`);
