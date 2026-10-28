// Managed Recurse checkouts own separate local dependency directories.
// Bun keeps its default cache hardlinks. Separate trees isolate bun add,
// but in-place package edits can affect other cache-linked installs.
// Entry restores missing links; detached sweep reclaims retired installs.
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const inputs = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "patchedDependencies",
  "trustedDependencies",
  "workspaces",
];

/** Local install and trash paths, independent of an agent's lifetime. */
export function dependencyPaths(dataDir: string, checkout: string) {
  const root = join(
    "/tmp/recurse",
    `recurse-${hash(resolve(dataDir)).slice(0, 12)}`,
    "dependencies",
  );
  const key = hash(resolve(checkout));
  return {
    root,
    install: join(root, key),
    staging: join(root, `.install-${key}`),
    lock: join(root, `.${key}.lock`),
    trash: join(root, ".trash"),
  };
}

/** Recognize marked Recurse checkouts, never arbitrary projects. */
export async function managedDependencyRoot(
  checkout: string,
): Promise<string | null> {
  checkout = resolve(checkout);
  if (basename(dirname(checkout)) !== "worktrees") return null;
  const dataDir = dirname(dirname(checkout));
  try {
    if ((await lstat(checkout)).isSymbolicLink()) return null;
    const marker = JSON.parse(
      await readFile(
        join(dataDir, "worktrees", ".markers", `${basename(checkout)}.json`),
        "utf8",
      ),
    );
    if (marker.path !== checkout) return null;
    for (const file of [
      "AGENTS.md",
      "src/local.ts",
      "src/agents/instance.ts",
      "src/web/app.ts",
      "package.json",
      "bun.lock",
    ])
      if (!(await stat(join(checkout, file))).isFile()) return null;
    return dataDir;
  } catch {
    return null;
  }
}

async function dependencyInputs(checkout: string) {
  const manifest = JSON.parse(
    await readFile(join(checkout, "package.json"), "utf8"),
  );
  const lock = new Uint8Array(await readFile(join(checkout, "bun.lock")));
  const patches: { path: string; contents: Uint8Array }[] = [];
  for (const path of Object.values(manifest.patchedDependencies ?? {})) {
    if (typeof path !== "string" || isAbsolute(path))
      throw new Error("dependency patch must be checkout-relative");
    const absolute = await realpath(resolve(checkout, path));
    if (!absolute.startsWith(`${await realpath(checkout)}${sep}`))
      throw new Error("dependency patch must stay inside the checkout");
    patches.push({ path, contents: new Uint8Array(await readFile(absolute)) });
  }
  const digest = createHash("sha256");
  digest.update(JSON.stringify(inputs.map((key) => [key, manifest[key]])));
  digest.update(lock);
  for (const patch of patches) {
    digest.update(patch.path);
    digest.update(patch.contents);
  }
  digest.update(`${Bun.version}\0${process.platform}\0${process.arch}`);
  return { manifest, lock, patches, fingerprint: digest.digest("hex") };
}

/** Reuse a local warm Bun cache, never a volume-backed cache. */
async function localCache(): Promise<string> {
  const usual = join(homedir(), ".bun", "install", "cache");
  const localDevice = (await stat("/tmp")).dev;
  try {
    if ((await stat(usual)).dev === localDevice) return usual;
  } catch {}
  return "/tmp/recurse/bun-cache";
}

/** Ordinary checkouts retain Bun's existing install behaviour. */
export async function installDependencies(checkout: string): Promise<void> {
  const dataDir = await managedDependencyRoot(checkout);
  if (dataDir === null) {
    const child = Bun.spawn(
      [process.execPath, "install", "--frozen-lockfile"],
      {
        cwd: checkout,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await child.exited) !== 0) throw new Error("frozen install failed");
    return;
  }
  await prepareManagedDependencies(checkout, dataDir);
}

/** Prepare/reuse one private install; never hold a worktree retirement lock. */
export async function prepareManagedDependencies(
  checkout: string,
  dataDir: string,
): Promise<void> {
  if ((await managedDependencyRoot(checkout)) !== resolve(dataDir))
    throw new Error("managed dependency checkout is missing or unmarked");
  const paths = dependencyPaths(dataDir, checkout);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const fd = await open(paths.lock, "a", 0o600);
  const { flockExclusive } = await import("./utils/flock");
  let unlock: (() => void) | undefined;
  try {
    unlock = await flockExclusive(fd.fd, paths.lock, {
      timeoutMs: 300_000,
      log: ({ waitMs }) => {
        if (waitMs >= 100)
          process.stderr.write(
            `dependencies: waited ${Math.round(waitMs)}ms\n`,
          );
      },
    });
    const expected = await dependencyInputs(checkout);
    let ready = false;
    try {
      ready =
        (await readFile(join(paths.install, ".ready"), "utf8")) ===
          expected.fingerprint &&
        (await stat(join(paths.install, "node_modules"))).isDirectory();
    } catch {}
    if (!ready) {
      process.stderr.write(`dependencies: preparing ${basename(checkout)}\n`);
      const staging = paths.staging;
      const { retire } = await import("./utils/trash");
      retire(staging, paths.trash);
      await mkdir(staging, { mode: 0o700 });
      try {
        await writeFile(
          join(staging, "package.json"),
          JSON.stringify({ ...expected.manifest, scripts: undefined }),
        );
        await writeFile(join(staging, "bun.lock"), expected.lock);
        for (const patch of expected.patches) {
          const target = join(staging, patch.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, patch.contents);
        }
        const child = Bun.spawn(
          [
            process.execPath,
            "install",
            "--frozen-lockfile",
            `--cache-dir=${await localCache()}`,
          ],
          { cwd: staging, stdout: "inherit", stderr: "inherit" },
        );
        if ((await child.exited) !== 0)
          throw new Error("frozen install failed");
        if (
          (await dependencyInputs(checkout)).fingerprint !==
          expected.fingerprint
        )
          throw new Error("dependency inputs changed during install; retry");
        if ((await managedDependencyRoot(checkout)) !== resolve(dataDir))
          throw new Error("checkout retired during dependency install");
        await writeFile(join(staging, ".ready"), expected.fingerprint);
        retire(paths.install, paths.trash);
        await rename(staging, paths.install);
      } catch (error) {
        retire(staging, paths.trash);
        throw error;
      }
    }
    const link = join(checkout, "node_modules");
    try {
      if (!(await lstat(link)).isSymbolicLink()) {
        const { retire } = await import("./utils/trash");
        retire(link, join(dataDir, "worktrees", ".trash"));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(checkout, `.node_modules-${randomUUID()}`);
    try {
      await symlink(join(paths.install, "node_modules"), temporary);
      await rename(temporary, link);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  } finally {
    unlock?.();
    await fd.close();
  }
}
