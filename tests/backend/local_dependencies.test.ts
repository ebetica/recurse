import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  dependencyPaths,
  managedDependencyRoot,
  prepareManagedDependencies,
} from "../../src/local_dependencies";
import { retire, sweep } from "../../src/utils/trash";
import { reapOne, rootFromEnv } from "../../tools/worktree";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recurse-local-dependencies-"));
  roots.push(root);
  const packages: Record<string, string> = {};
  for (const name of ["picocolors", "left-pad"]) {
    const source = join(root, name);
    mkdirSync(source);
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
    const tarball = join(root, `${name}.tgz`);
    const pack = Bun.spawn(
      [
        process.execPath,
        "pm",
        "pack",
        "--filename",
        tarball,
        "--ignore-scripts",
      ],
      { cwd: source, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(pack.stderr).text();
    expect(await pack.exited, stderr).toBe(0);
    packages[name] = `file:${tarball}`;
  }
  const seed = join(root, "seed");
  mkdirSync(seed);
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({
      name: "local-dependency-fixture",
      private: true,
      dependencies: { picocolors: packages.picocolors },
    }),
  );
  const child = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
    cwd: seed,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  expect(exitCode, `bun install exited ${exitCode}\n${stderr}`).toBe(0);
  const checkout = (name: string) => {
    const path = join(root, "worktrees", name);
    for (const file of [
      "AGENTS.md",
      "src/local.ts",
      "src/agents/instance.ts",
      "src/web/app.ts",
    ]) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), "");
    }
    for (const file of ["package.json", "bun.lock"])
      writeFileSync(join(path, file), readFileSync(join(seed, file), "utf8"));
    const markers = join(root, "worktrees", ".markers");
    mkdirSync(markers, { recursive: true });
    writeFileSync(
      join(markers, `${name}.json`),
      JSON.stringify({ version: 1, name, path, holders: { owner: 1 } }),
    );
    roots.push(dependencyPaths(root, path).root);
    return path;
  };
  return { root, checkout, addedDependency: packages["left-pad"]! };
}

test("separate managed installs reuse without relinking package trees", async () => {
  const { root, checkout, addedDependency } = await fixture();
  const a = checkout("a");
  const b = checkout("b");
  await Promise.all([
    prepareManagedDependencies(a, root),
    prepareManagedDependencies(b, root),
  ]);
  const first = realpathSync(join(a, "node_modules"));
  expect(first).not.toBe(realpathSync(join(b, "node_modules")));
  const paths = dependencyPaths(root, a);
  expect(first).toBe(join(paths.install, "node_modules"));
  const ready = readFileSync(join(paths.install, ".ready"), "utf8");
  await prepareManagedDependencies(a, root);
  expect(readFileSync(join(paths.install, ".ready"), "utf8")).toBe(ready);
  expect(realpathSync(join(a, "node_modules"))).toBe(first);
  expect(existsSync(paths.trash)).toBe(false);
  const added = Bun.spawn(
    [process.execPath, "add", "--dev", "--ignore-scripts", addedDependency],
    { cwd: a, stdout: "pipe", stderr: "pipe" },
  );
  expect(await added.exited).toBe(0);
  expect(existsSync(join(a, "node_modules/left-pad/package.json"))).toBe(true);
  expect(existsSync(join(b, "node_modules/left-pad"))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(b, "package.json"), "utf8")),
  ).not.toHaveProperty("devDependencies");
});

test("missing local disk is rebuilt and same-checkout preparations serialize", async () => {
  const { root, checkout } = await fixture();
  const path = checkout("restart");
  const paths = dependencyPaths(root, path);
  await prepareManagedDependencies(path, root);
  retire(paths.install, paths.trash);
  expect(existsSync(join(path, "node_modules"))).toBe(false);
  await Promise.all([
    prepareManagedDependencies(path, root),
    prepareManagedDependencies(path, root),
  ]);
  expect(existsSync(join(path, "node_modules/picocolors/package.json"))).toBe(
    true,
  );
  expect(existsSync(paths.staging)).toBe(false);
  expect(realpathSync(join(path, "node_modules"))).toBe(
    join(paths.install, "node_modules"),
  );
});

test("changed dependency declarations replace only their private install", async () => {
  const { root, checkout, addedDependency } = await fixture();
  const path = checkout("changed");
  const paths = dependencyPaths(root, path);
  await prepareManagedDependencies(path, root);
  const before = readFileSync(join(paths.install, ".ready"), "utf8");
  const manifestPath = join(path, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.devDependencies = { "left-pad": addedDependency };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const update = Bun.spawn([process.execPath, "install", "--lockfile-only"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await update.exited).toBe(0);
  await prepareManagedDependencies(path, root);
  expect(readFileSync(join(paths.install, ".ready"), "utf8")).not.toBe(before);
  expect(existsSync(join(path, "node_modules/left-pad/package.json"))).toBe(
    true,
  );
  expect(existsSync(paths.trash)).toBe(true);
});

test("failed frozen install preserves the prior complete tree and can resume", async () => {
  const { root, checkout, addedDependency } = await fixture();
  const path = checkout("failure");
  const paths = dependencyPaths(root, path);
  await prepareManagedDependencies(path, root);
  const manifestPath = join(path, "package.json");
  const original = readFileSync(manifestPath, "utf8");
  const before = readFileSync(join(paths.install, ".ready"), "utf8");
  const manifest = JSON.parse(original);
  manifest.dependencies["left-pad"] = addedDependency;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await expect(prepareManagedDependencies(path, root)).rejects.toThrow(
    "frozen install failed",
  );
  expect(readFileSync(join(paths.install, ".ready"), "utf8")).toBe(before);
  expect(existsSync(join(path, "node_modules/picocolors/package.json"))).toBe(
    true,
  );
  writeFileSync(manifestPath, original);
  await prepareManagedDependencies(path, root);
  expect(existsSync(paths.staging)).toBe(false);
});

test("retirement moves both checkout and local tree; reclamation is later", async () => {
  const { root, checkout } = await fixture();
  const path = checkout("retire");
  const paths = dependencyPaths(root, path);
  await prepareManagedDependencies(path, root);
  expect(reapOne(rootFromEnv(root), "retire", new Set())).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(paths.install)).toBe(false);
  expect(existsSync(paths.trash)).toBe(true);
  expect(sweep(paths.trash, 1)).toBe(1);
});

test("script-only changes reuse dependencies without another install", async () => {
  const { root, checkout } = await fixture();
  const path = checkout("scripts");
  const paths = dependencyPaths(root, path);
  await prepareManagedDependencies(path, root);
  const before = readFileSync(join(paths.install, ".ready"), "utf8");
  const manifestPath = join(path, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.scripts = { check: "bun --version" };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await prepareManagedDependencies(path, root);
  expect(readFileSync(join(paths.install, ".ready"), "utf8")).toBe(before);
  expect(existsSync(paths.trash)).toBe(false);
});

test("abandoned staging and legacy dependencies are renamed for later reclamation", async () => {
  const { root, checkout } = await fixture();
  const path = checkout("legacy");
  const paths = dependencyPaths(root, path);
  mkdirSync(paths.staging, { recursive: true });
  writeFileSync(join(paths.staging, "partial-install"), "interrupted");
  mkdirSync(join(path, "node_modules"));
  writeFileSync(join(path, "node_modules", "legacy-package"), "preserved");
  await prepareManagedDependencies(path, root);
  expect(existsSync(paths.staging)).toBe(false);
  expect(realpathSync(join(path, "node_modules"))).toBe(
    join(paths.install, "node_modules"),
  );
  const localRetired = readdirSync(paths.trash);
  expect(localRetired).toHaveLength(1);
  expect(
    readFileSync(
      join(paths.trash, localRetired[0]!, "partial-install"),
      "utf8",
    ),
  ).toBe("interrupted");
  const checkoutTrash = join(root, "worktrees", ".trash");
  const legacyRetired = readdirSync(checkoutTrash);
  expect(legacyRetired).toHaveLength(1);
  expect(
    readFileSync(
      join(checkoutTrash, legacyRetired[0]!, "legacy-package"),
      "utf8",
    ),
  ).toBe("preserved");
});

test("ordinary projects and unmarked directories are not redirected", async () => {
  const { root, checkout } = await fixture();
  const path = checkout("unmarked");
  rmSync(join(root, "worktrees/.markers/unmarked.json"));
  expect(await managedDependencyRoot(path)).toBeNull();
  await expect(prepareManagedDependencies(path, root)).rejects.toThrow(
    "missing or unmarked",
  );
  expect(existsSync(join(path, "node_modules"))).toBe(false);
});
