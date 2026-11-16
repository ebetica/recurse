import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

export function linkDependencies(checkout: string): void {
  const shared = realpathSync(join(ROOT, "node_modules"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const specs: Record<string, string> = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  const reinstalled = new Set(
    Object.entries(specs)
      .filter(([, spec]) => /^https?:/.test(spec))
      .map(([name]) => name),
  );
  const own = join(checkout, "node_modules");
  mkdirSync(own);
  for (const entry of readdirSync(shared))
    if (entry !== ".bin" && !reinstalled.has(entry))
      symlinkSync(join(shared, entry), join(own, entry), "dir");
}
