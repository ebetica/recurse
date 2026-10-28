#!/usr/bin/env bun
/**
 * Install pinned dependencies; managed checkouts keep them on local disk.
 * --managed-only skips ordinary checkouts before an already-built launch.
 */
import { resolve } from "node:path";
import {
  installDependencies,
  managedDependencyRoot,
} from "../local_dependencies";
import { rootFromEnv, startSweep } from "../../tools/worktree";

const checkout = resolve(import.meta.dir, "../..");
try {
  if (
    !process.argv.includes("--managed-only") ||
    (await managedDependencyRoot(checkout)) !== null
  )
    await installDependencies(checkout);
} finally {
  const root = await managedDependencyRoot(checkout);
  if (root !== null) startSweep(rootFromEnv(root));
}
