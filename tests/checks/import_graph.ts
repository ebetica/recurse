#!/usr/bin/env bun
// Ratchet file/module SCCs and entry debt; omit type/lazy edges by default.
// Nearest folder owns each file; nested folders are separate modules. Root
// src/web files stand alone. Folder index.ts files use only named re-exports.
// Passing checks shrink the tracked baselines and ask you to commit them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

export async function checkImportGraph(
  args: string[] = [],
  sources?: Map<string, ts.SourceFile>,
): Promise<boolean> {
  if (args.includes("--help")) {
    console.log(`bun tests/checks/import_graph.ts [--root DIR] [--baseline FILE] [--module-baseline FILE]
Default: fail on regressions; after a passing check, shrink improved baselines and print which files to commit.
--modules prints module debt JSON; --dot [--modules | --dirs] prints DOT.
--cycles [--modules] prints SCCs; --height prints one longest module chain.
--dynamic includes literal import() edges and never writes baselines; type-only imports stay omitted.`);
    return true;
  }
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1]!.startsWith("--"))
      throw new Error(`${name} requires a path`);
    return args[index + 1]!;
  };
  const root = resolve(option("--root", process.cwd()));
  const baselinePath = resolve(
    root,
    option("--baseline", "tests/checks/import_graph_baseline.json"),
  );
  const moduleBaselinePath = resolve(
    root,
    option("--module-baseline", "tests/checks/import_modules_baseline.json"),
  );
  const dynamic = args.includes("--dynamic");
  const optional = ["scripts", ["play", "ground"].join("")];
  const files = ["src", "web", ...optional]
    .flatMap((dir) =>
      existsSync(resolve(root, dir))
        ? [
            ...new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").scanSync({
              cwd: resolve(root, dir),
            }),
          ]
            .map((file) => `${dir}/${file}`)
            .filter(
              (file) =>
                !/(?:^|\/)(?:node_modules|dist|vendor|tests|__tests__|fixtures)\/|\.(?:test|spec)\.|\.d\.[cm]?ts$/.test(
                  file,
                ),
            )
        : [],
    )
    .sort();
  const known = new Set(files.map((file) => resolve(root, file)));
  const backendConfig = existsSync(resolve(root, "tsconfig.backend.json"));
  const configs = new Map<string, ts.CompilerOptions>();
  const configPaths = new Map<string, string | undefined>();
  const resolutionCache = ts.createModuleResolutionCache(root, (file) => file);
  const directories = new Set<string>();
  for (const file of known)
    for (
      let dir = dirname(file);
      dir.startsWith(root) && !directories.has(dir);
      dir = dirname(dir)
    )
      directories.add(dir);
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: (file) =>
      known.has(file) || (file.endsWith("/package.json") && existsSync(file)),
    directoryExists: (dir) => directories.has(dir),
    readFile: ts.sys.readFile,
  };

  function findConfig(dir: string): string | undefined {
    if (configPaths.has(dir)) return configPaths.get(dir);
    const path = resolve(dir, "tsconfig.json");
    const found = existsSync(path)
      ? path
      : dir === root || dirname(dir) === dir
        ? undefined
        : findConfig(dirname(dir));
    configPaths.set(dir, found);
    return found;
  }
  const graph = new Map<string, Set<string>>();
  let dynamicEdges = 0;

  function compilerOptions(file: string): ts.CompilerOptions {
    let config =
      findConfig(dirname(resolve(root, file))) ??
      resolve(root, "tsconfig.json");
    if (
      config === resolve(root, "tsconfig.json") &&
      !file.startsWith("web/") &&
      backendConfig
    )
      config = resolve(root, "tsconfig.backend.json");
    if (!configs.has(config)) {
      let options: ts.CompilerOptions = {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      };
      if (existsSync(config)) {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        if (read.error)
          throw new Error(
            ts.flattenDiagnosticMessageText(read.error.messageText, "\n"),
          );
        const parsed = ts.parseJsonConfigFileContent(
          { ...read.config, files: [], include: [] },
          ts.sys,
          dirname(config),
        );
        const errors = parsed.errors.filter(
          (error) => error.code !== 18002 && error.code !== 18003,
        );
        if (errors.length)
          throw new Error(
            ts.flattenDiagnosticMessageText(errors[0]!.messageText, "\n"),
          );
        options = parsed.options;
      }
      configs.set(config, options);
    }
    return configs.get(config)!;
  }

  const texts = await Promise.all(
    files.map((file) => readFile(resolve(root, file), "utf8")),
  );
  for (const [index, file] of files.entries()) {
    const absolute = resolve(root, file);
    const source = ts.createSourceFile(absolute, texts[index]!, {
      languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
    });
    sources?.set(absolute, source);
    const edges = new Set<string>();
    graph.set(file, edges);
    const options = compilerOptions(file);
    const add = (specifier: ts.Expression | undefined, lazy = false) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      const name = specifier.text;
      if (!name.startsWith(".") && !options.paths && !options.baseUrl) return;
      const target = ts.resolveModuleName(
        name,
        absolute,
        options,
        resolutionHost,
        resolutionCache,
      ).resolvedModule?.resolvedFileName;
      if (!target || !known.has(target)) return;
      if (lazy) dynamicEdges++;
      if (!lazy || dynamic) edges.add(relative(root, target));
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        if (
          clause?.isTypeOnly ||
          (!clause?.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((item) => item.isTypeOnly))
        )
          continue;
        add(statement.moduleSpecifier);
      } else if (ts.isExportDeclaration(statement)) {
        const clause = statement.exportClause;
        if (
          statement.isTypeOnly ||
          (clause &&
            ts.isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((item) => item.isTypeOnly))
        )
          continue;
        add(statement.moduleSpecifier);
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        !statement.isTypeOnly &&
        ts.isExternalModuleReference(statement.moduleReference)
      ) {
        add(statement.moduleReference.expression);
      }
    }
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        add(node.arguments[0], true);
      ts.forEachChild(node, visit);
    };
    if (dynamic) visit(source);
  }

  const reachesSource = new Set(
    files.filter((file) => file.startsWith("src/")),
  );
  const reverse = new Map<string, string[]>();
  for (const [file, edges] of graph)
    for (const edge of edges)
      reverse.set(edge, [...(reverse.get(edge) ?? []), file]);
  const queue = [...reachesSource];
  for (const file of queue)
    for (const importer of reverse.get(file) ?? [])
      if (!reachesSource.has(importer)) {
        reachesSource.add(importer);
        queue.push(importer);
      }
  for (const file of files)
    if (
      optional.some((dir) => file.startsWith(`${dir}/`)) &&
      !reachesSource.has(file)
    )
      graph.delete(file);
  for (const edges of graph.values())
    for (const edge of edges) if (!graph.has(edge)) edges.delete(edge);

  function components(graph: Map<string, Set<string>>): string[][] {
    const indices = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const active = new Set<string>();
    const cycles: string[][] = [];
    function connect(file: string) {
      indices.set(file, indices.size);
      low.set(file, indices.get(file)!);
      stack.push(file);
      active.add(file);
      for (const edge of graph.get(file)!) {
        if (!indices.has(edge)) {
          connect(edge);
          low.set(file, Math.min(low.get(file)!, low.get(edge)!));
        } else if (active.has(edge))
          low.set(file, Math.min(low.get(file)!, indices.get(edge)!));
      }
      if (low.get(file) !== indices.get(file)) return;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        active.delete(member);
        component.push(member);
      } while (member !== file);
      if (component.length > 1 || graph.get(file)!.has(file))
        cycles.push(component.sort());
    }
    for (const file of graph.keys()) if (!indices.has(file)) connect(file);
    return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
  }
  const cycles = components(graph);
  const moduleOf = (file: string) =>
    ["src", "web"].includes(dirname(file)) ? file : dirname(file);
  const modules = new Map<string, Set<string>>();
  const bypasses: string[] = [];
  const entries: Record<string, number> = {};
  for (const file of graph.keys()) modules.set(moduleOf(file), new Set());
  for (const [file, edges] of graph)
    for (const edge of edges) {
      const from = moduleOf(file),
        to = moduleOf(edge);
      if (from === to) continue;
      modules.get(from)!.add(to);
      if (to !== edge && edge !== `${to}/index.ts`)
        bypasses.push(`${file} → ${edge}`);
    }
  for (const name of modules.keys()) {
    if (graph.has(name)) continue;
    const entry = `${name}/index.ts`;
    if (!graph.has(entry)) entries[name] = -1;
    else {
      const source = ts.createSourceFile(
        entry,
        texts[files.indexOf(entry)]!,
        ts.ScriptTarget.Latest,
      );
      const count = source.statements.filter(
        (statement) =>
          !ts.isExportDeclaration(statement) ||
          !statement.moduleSpecifier ||
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause),
      ).length;
      if (count) entries[name] = count;
    }
  }
  const moduleCycles = components(modules);
  const debt = { cycles: moduleCycles, bypasses: bypasses.sort(), entries };
  const representatives = new Map(
    [...modules.keys()].map((name) => [name, name]),
  );
  for (const cycle of moduleCycles)
    for (const name of cycle)
      representatives.set(name, `[${cycle.join(", ")}]`);
  const chains = new Map<string, string[]>();
  function chain(name: string): string[] {
    const node = representatives.get(name)!;
    if (chains.has(node)) return chains.get(node)!;
    let tail: string[] = [];
    for (const [member, edges] of modules)
      if (representatives.get(member) === node)
        for (const edge of edges)
          if (representatives.get(edge) !== node) {
            const next = chain(edge);
            if (next.length > tail.length) tail = next;
          }
    const result = [node, ...tail];
    chains.set(node, result);
    return result;
  }
  const longest =
    [...modules.keys()].map(chain).sort((a, b) => b.length - a.length)[0] ?? [];

  function cyclePath(
    component: string[],
    graph: Map<string, Set<string>>,
  ): string[] {
    const allowed = new Set(component);
    const path: string[] = [];
    const visited = new Set<string>();
    const search = (file: string): string[] | undefined => {
      const start = path.indexOf(file);
      if (start >= 0) return [...path.slice(start), file];
      if (visited.has(file)) return;
      visited.add(file);
      path.push(file);
      for (const edge of graph.get(file)!) {
        if (!allowed.has(edge)) continue;
        const found = search(edge);
        if (found) return found;
      }
      path.pop();
      return;
    };
    return search(component[0]!)!;
  }

  let failures = 0;
  const selected = args.includes("--modules") ? modules : graph;
  if (args.includes("--height")) {
    console.log(`module height: ${longest.length}\n${longest.join(" → ")}`);
  } else if (args.includes("--dot") || args.includes("--dirs")) {
    const label = (file: string) =>
      JSON.stringify(args.includes("--dirs") ? dirname(file) : file);
    const lines = new Set<string>();
    for (const [file, edges] of selected) {
      lines.add(`  ${label(file)};`);
      for (const edge of edges)
        if (!args.includes("--dirs") || label(file) !== label(edge))
          lines.add(`  ${label(file)} -> ${label(edge)};`);
    }
    console.log(`digraph imports {\n${[...lines].sort().join("\n")}\n}`);
  } else if (args.includes("--cycles")) {
    console.log(
      JSON.stringify(
        args.includes("--modules") ? moduleCycles : cycles,
        null,
        2,
      ),
    );
  } else if (args.includes("--modules")) {
    console.log(JSON.stringify(debt, null, 2));
  } else {
    const baseline: string[][] = JSON.parse(readFileSync(baselinePath, "utf8"));
    const covered = (cycle: string[], expected: string[][]) =>
      expected.some((entry) => cycle.every((member) => entry.includes(member)));
    const cyclesChanged = (actual: string[][], expected: string[][]) =>
      actual.length !== expected.length ||
      expected.some((entry) => !covered(entry, actual));
    for (const cycle of cycles)
      if (!covered(cycle, baseline)) {
        const path = cyclePath(cycle, graph);
        console.error(
          path.length === cycle.length + 1
            ? `Unbaselined import cycle: ${path.join(" → ")}`
            : `Unbaselined import cycle component: ${cycle.join(", ")}\nExample cycle: ${path.join(" → ")}`,
        );
        console.error(
          "move the shared code into a lower module or pass a callback",
        );
        failures++;
      }
    const moduleBaseline: typeof debt = JSON.parse(
      readFileSync(moduleBaselinePath, "utf8"),
    );
    const fail = (message: string) => {
      console.error(`Unbaselined ${message}`);
      failures++;
    };
    for (const cycle of moduleCycles)
      if (!covered(cycle, moduleBaseline.cycles))
        fail(`module cycle: ${cycle.join(", ")}`);
    const priorBypasses = new Set(moduleBaseline.bypasses);
    for (const bypass of bypasses)
      if (!priorBypasses.has(bypass)) fail(`module entry bypass: ${bypass}`);
    for (const [name, count] of Object.entries(entries)) {
      const cap = moduleBaseline.entries[name];
      if (cap === -1 || (count !== -1 && count <= (cap ?? 0))) continue;
      const reason =
        count === -1
          ? "missing index.ts"
          : `${count} statements other than named re-exports`;
      fail(`module entry: ${name}: ${reason}`);
    }
    if (!failures && !dynamic) {
      const shrink = (file: string, next: unknown) => {
        writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
        console.log(
          `Shrank ${relative(root, file)}; commit the updated baseline.`,
        );
      };
      if (cyclesChanged(cycles, baseline)) shrink(baselinePath, cycles);
      if (
        cyclesChanged(moduleCycles, moduleBaseline.cycles) ||
        bypasses.length !== priorBypasses.size ||
        Object.entries(moduleBaseline.entries).some(
          ([name, cap]) => entries[name] !== cap,
        )
      )
        shrink(moduleBaselinePath, debt);
    }
    console.log(
      `module graph: ${modules.size} modules, ${moduleCycles.length} cycles (${moduleCycles.reduce((sum, cycle) => sum + cycle.length, 0)} modules), ${bypasses.length} entry bypasses, ${Object.keys(entries).length} missing/non-thin entries; height ${longest.length}`,
    );
    console.log(
      `import graph: ${graph.size} files, ${[...graph.values()].reduce((sum, edges) => sum + edges.size, 0)} edges, ${cycles.length} cycles (${cycles.reduce((sum, cycle) => sum + cycle.length, 0)} files); ${dynamic ? `${dynamicEdges} literal dynamic imports included` : "dynamic imports omitted"}`,
    );
  }
  return failures === 0;
}

if (import.meta.main && !(await checkImportGraph(process.argv.slice(2))))
  process.exitCode = 1;
