import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { retire } from "../../src/utils/trash";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "import-graph-"));
  const checker = resolve(import.meta.dir, "../checks/import_graph.ts");
  const write = (file: string, text: string) =>
    Bun.write(join(root, file), text);
  const baseline = async (cycles: string[][]) => {
    await write("baseline.json", JSON.stringify(cycles));
    const snapshot = await run("--modules");
    expect(snapshot.code).toBe(0);
    await write("modules.json", snapshot.out);
  };
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        checker,
        "--root",
        root,
        "--baseline",
        "baseline.json",
        "--module-baseline",
        "modules.json",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out, error };
  };
  return {
    write,
    baseline,
    run,
    read: (file: string) => Bun.file(join(root, file)).text(),
    snapshot: () =>
      Promise.all(
        ["baseline.json", "modules.json"].map((file) =>
          Bun.file(join(root, file)).bytes(),
        ),
      ),
    reject: async (...messages: string[]) => {
      const result = await run();
      expect(result.code).toBe(1);
      for (const message of messages) expect(result.error).toContain(message);
    },
    dispose: () => retire(root, join(tmpdir(), "import-graph-trash")),
  };
}

// Feature: #3404 enforce a shrinking runtime import-cycle baseline through the CLI.
test("import graph CLI rejects new or enlarged cycles and commits no stale debt", async () => {
  const { write, baseline, run, read, snapshot, dispose } = await fixture();
  try {
    await write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          moduleResolution: "bundler",
          paths: { "@/*": ["./src/*"] },
        },
      }),
    );
    await write(
      "src/a.ts",
      [
        'import type { T } from "./types.js";',
        'import { type T as Other } from "./types.js";',
        'export type { T } from "./types.js";',
        'export { type T as Again } from "./types.js";',
        'const quoted = /"/; const template = `part${1}tail`;',
        'export { b } from /*shared*/ "./nest\\u0065d";',
        "export const a = 1;",
      ].join("\n"),
    );
    await write("src/types.ts", 'import "./a.js"; export type T = string;');
    await write(
      "src/nested/index.ts",
      'import { a } from "@/a"; export const b = a;',
    );
    await write("web/entry.ts", 'import "../src/a.js";');
    await baseline([]);
    const beforeNew = await snapshot();
    const rejected = await run();
    expect(rejected.code).toBe(1);
    expect(rejected.error).toContain(
      "src/a.ts → src/nested/index.ts → src/a.ts",
    );
    expect(rejected.error).toContain(
      "move the shared code into a lower module or pass a callback",
    );
    expect(await snapshot()).toEqual(beforeNew);
    await baseline([["src/a.ts", "src/nested/index.ts"]]);
    expect((await run()).code).toBe(0);
    const dot = await run("--dot");
    expect(dot.code).toBe(0);
    expect(dot.out).toContain('"web/entry.ts" -> "src/a.ts";');
    expect(dot.out).not.toContain('"src/a.ts" -> "src/types.ts";');
    expect((await run("--dot", "--dirs")).out).toContain('"web" -> "src";');
    await write(
      "src/nested/index.ts",
      'import { a, type T } from "../third.js"; export const b = a;',
    );
    await write("src/third.ts", 'export { a } from "./a.js";');
    const before = await snapshot();
    const enlarged = await run();
    expect(enlarged.code).toBe(1);
    expect(enlarged.error).toContain(
      "src/a.ts → src/nested/index.ts → src/third.ts → src/a.ts",
    );
    expect(await snapshot()).toEqual(before);
    await baseline([["src/a.ts", "src/nested/index.ts", "src/third.ts"]]);
    await write(
      "src/nested/index.ts",
      'import { a } from "@/a"; export const b = a;',
    );
    const shrunk = await run();
    expect(shrunk.code).toBe(0);
    expect(shrunk.out).toContain(
      "Shrank baseline.json; commit the updated baseline.",
    );
    expect(shrunk.out).toContain(
      "Shrank modules.json; commit the updated baseline.",
    );
    expect(JSON.parse(await read("baseline.json"))).toEqual([
      ["src/a.ts", "src/nested/index.ts"],
    ]);
    expect(JSON.parse(await read("modules.json")).cycles).toEqual([
      ["src/a.ts", "src/nested"],
    ]);
    await write("src/nested/index.ts", "export const b = 1;");
    const removable = await snapshot();
    for (const flag of [
      "--dynamic",
      "--modules",
      "--dot",
      "--dirs",
      "--cycles",
      "--height",
    ]) {
      const diagnostic = await run(flag);
      expect(diagnostic.code).toBe(0);
      expect(diagnostic.out).not.toContain("Shrank");
      expect(await snapshot()).toEqual(removable);
    }
    expect((await run()).code).toBe(0);
    expect(JSON.parse(await read("baseline.json"))).toEqual([]);
    const current = await snapshot();
    const unchanged = await run();
    expect(unchanged.code).toBe(0);
    expect(unchanged.out).not.toContain("Shrank");
    expect(await snapshot()).toEqual(current);
    await write(
      "src/nested/index.ts",
      'export const b = () => import("../a.js");',
    );
    expect((await run()).code).toBe(0);
    const lazy = await run("--dynamic");
    expect(lazy.code).toBe(1);
    expect(lazy.error).toContain("src/a.ts → src/nested/index.ts → src/a.ts");
    await write(
      "src/nested/index.ts",
      'import "./index.js"; export const b = 1;',
    );
    const self = await run();
    expect(self.code).toBe(1);
    expect(self.error).toContain("src/nested/index.ts → src/nested/index.ts");
    await write("src/nested/index.ts", 'export { b } from "./b.js";');
    await write("src/nested/a.ts", 'import "./b.js";');
    await write("src/nested/b.ts", 'import "./a.js"; export const b = 1;');
    await baseline([["src/nested/a.ts", "src/nested/b.ts"]]);
    await write(
      "src/nested/b.ts",
      'import "./a.js"; import "./c.js"; export const b = 1;',
    );
    await write("src/nested/c.ts", 'import "./b.js";');
    const sameModule = await run();
    expect(sameModule.code).toBe(1);
    expect(sameModule.error).toContain(
      "Unbaselined import cycle component: src/nested/a.ts, src/nested/b.ts, src/nested/c.ts",
    );
    await write("src/nested/c.ts", 'import "./b.js"; import "./d.js";');
    await write("src/nested/d.ts", 'import "./c.js";');
    const halves = [
      ["src/nested/a.ts", "src/nested/b.ts"],
      ["src/nested/c.ts", "src/nested/d.ts"],
    ];
    const joined = [halves.flat()];
    expect(JSON.parse((await run("--cycles")).out)).toEqual(joined);
    await baseline(joined);
    await write("src/nested/b.ts", 'import "./a.js"; export const b = 1;');
    await write("src/nested/c.ts", 'import "./d.js";');
    expect((await run()).code).toBe(0);
    expect(JSON.parse(await read("baseline.json"))).toEqual(halves);
  } finally {
    dispose();
  }
});

// Feature: #3416 enforce folder entries, module-cycle debt and module height through the CLI.
test("import graph CLI ratchets module boundaries and reports height", async () => {
  const { write, baseline, run, read, reject, dispose } = await fixture();
  try {
    await write("src/a.ts", 'export { b } from "./nested/index.js";');
    await write("web/entry.ts", 'import "../src/a.js";');
    await write("src/nested/index.ts", 'export { b } from "./value.js";');
    await write("src/nested/value.ts", "export const b = 1;");
    await baseline([]);
    const clean = JSON.parse((await run("--modules")).out);
    expect(clean).toEqual({ cycles: [], bypasses: [], entries: {} });
    await write("src/nested/other.ts", 'import "../a.js";');
    await reject("Unbaselined module cycle");
    expect(JSON.parse((await run("--cycles")).out)).toEqual([]);
    await baseline([]);
    expect((await run()).code).toBe(0);
    await write("src/nested/other.ts", "export const other = 1;");
    expect((await run()).code).toBe(0);
    expect(JSON.parse(await read("modules.json")).cycles).toEqual([]);
    await write("src/consumer.ts", 'export { b } from "./nested/value.js";');
    await reject(
      "Unbaselined module entry bypass: src/consumer.ts → src/nested/value.ts",
    );
    await baseline([]);
    expect((await run()).code).toBe(0);
    await write("src/consumer.ts", 'export { b } from "./nested/index.js";');
    expect((await run()).code).toBe(0);
    expect(JSON.parse(await read("modules.json")).bypasses).toEqual([]);
    await write(
      "src/nested/deeper/index.ts",
      'export { b } from "./value.js";',
    );
    await write("src/nested/deeper/value.ts", "export const b = 1;");
    await write(
      "src/nested/value.ts",
      'export { b } from "./deeper/value.js";',
    );
    await reject("src/nested/value.ts → src/nested/deeper/value.ts");
    await write(
      "src/nested/value.ts",
      'export { b } from "./deeper/index.js";',
    );
    expect((await run()).code).toBe(0);
    expect((await run("--height")).out).toContain("module height: 4");
    expect((await run("--dot", "--modules")).out).toContain(
      '"src/nested" -> "src/nested/deeper";',
    );
    const thicker = 'export * from "./value.js"; export const extra = 1;';
    await write("src/nested/index.ts", thicker);
    await write("src/no-entry/private.ts", "export const value = 1;");
    await reject(
      "src/nested: 2 statements other than named re-exports",
      "src/no-entry: missing index.ts",
    );
    await baseline([]);
    expect((await run()).code).toBe(0);
    await write("src/nested/index.ts", 'export * from "./value.js";');
    await write("src/no-entry/index.ts", 'export * from "./private.js";');
    expect((await run()).code).toBe(0);
    expect(JSON.parse(await read("modules.json")).entries).toEqual({
      "src/nested": 1,
      "src/no-entry": 1,
    });
    await write("src/nested/index.ts", thicker);
    await write(
      "src/no-entry/index.ts",
      'export { value } from "./private.js";',
    );
    const before = await read("modules.json");
    await reject("src/nested: 2 statements other than named re-exports");
    expect(await read("modules.json")).toBe(before);
    await write("src/nested/index.ts", 'export { b } from "./value.js";');
    expect((await run()).code).toBe(0);
    expect(JSON.parse(await read("modules.json")).entries).toEqual({});
  } finally {
    dispose();
  }
});
