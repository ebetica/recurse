import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { retire } from "../../src/utils/trash";

// Feature: #3519 reject unused exports without confusing same-named declarations or shadowed namespace bindings.
test("dead export CLI resolves the file and binding behind each import", async () => {
  const root = await mkdtemp(join(tmpdir(), "dead-export-check-"));
  const checker = resolve(import.meta.dir, "../checks/dead_export_check.ts");
  const write = (path: string, text: string) =>
    Bun.write(join(root, path), text);
  const run = async () => {
    const child = Bun.spawn([process.execPath, checker], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    const init = Bun.spawn(["git", "init", "-q"], { cwd: root });
    expect(await init.exited).toBe(0);
    await write(
      "tsconfig.backend.json",
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    );
    await write(
      "item.ts",
      [
        "export const item = 'item';",
        "export const unused = 'item-unused';",
        "export const lazy = 'lazy';",
        "export interface Item { name: string }",
        "export const required = 'required';",
      ].join("\n"),
    );
    await write("other.ts", "export const unused = 'other';");
    await write("runtime.js", 'export const runtime = "runtime";');
    await write("runtime.d.ts", "export const runtime: string;");
    await write(
      "forward.ts",
      'export const ns = await import("./forwarded"); export const { chosen } = await import("./destructured");',
    );
    await write("forwarded.ts", 'export const live = "live";');
    await write(
      "destructured.ts",
      'export const chosen = "chosen";\nexport const spare = "spare";',
    );
    await write(
      "schema.ts",
      "export type Schema = { name: string };\nexport type Imported = { title: string };",
    );
    await write(
      "jsdoc.js",
      [
        '/** @type {import("./schema.ts").Schema} */',
        'const example = { name: "loaded" };',
        '/** @import { Imported } from "./schema.js" */',
        "/** @type {Imported} */",
        'const row = { title: "example" };',
        "console.log(example, row);",
      ].join("\n"),
    );
    await write(
      "consumer.cjs",
      'const { required } = require("./item"); console.log(required);',
    );
    await write("barrel-target.ts", 'export const target = "barrel";');
    await write(
      "barrel.ts",
      'export { target as renamed } from "@/barrel-target";',
    );
    await write(
      "src/local.ts",
      'export function serveOnce() {}\nexport const unusedEntry = "not a runtime entry";',
    );
    await write(
      "consumer.ts",
      [
        'import { renamed } from "./barrel.js";',
        'import { unused } from "./other";',
        'import { runtime } from "./runtime.js";',
        'import { ns, chosen } from "./forward";',
        'type Local = import("@/item").Item;',
        'const key = "item" as const;',
        "const use = () => namespace[key];",
        'import * as namespace from "@/item";',
        "const shadow = (namespace: Local & {unused: string}) => namespace.unused;",
        'const read = async () => { const { lazy } = await import("@/item"); return lazy; };',
        'console.log(use(), renamed, unused, shadow({ name: "name", unused }), await read(), runtime, ns.live, chosen);',
      ].join("\n"),
    );
    const rejected = await run();
    expect(rejected.code).toBe(1);
    expect(rejected.stderr.trim().split("\n")).toEqual([
      'destructured.ts:2: export "spare" has no importer; remove the export or delete the unused code',
      'item.ts:2: export "unused" has no importer; remove the export or delete the unused code',
      'src/local.ts:2: export "unusedEntry" has no importer; remove the export or delete the unused code',
    ]);
    await write("src/local.ts", "export function serveOnce() {}\n");
    await write(
      "consumer-fix.ts",
      'import { unused as itemUnused } from "@/item"; import { spare } from "./destructured"; console.log(itemUnused, spare);',
    );
    const passed = await run();
    expect(passed.code).toBe(0);
    expect(passed.stdout).toContain("dead exports: 0 unused");
  } finally {
    await retire(root, join(tmpdir(), "dead-export-check-trash"));
  }
});
