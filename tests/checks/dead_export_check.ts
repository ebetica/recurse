#!/usr/bin/env bun
// Reject exports with no cross-file consumer using TypeScript resolution.
// Count type imports and re-exports. Opaque namespaces may use any export.
import { dirname, resolve } from "node:path";
import ts from "typescript";

const JS_SOURCE = /\.[cm]?jsx?$/;

type Module = {
  source: ts.SourceFile;
  exports: Map<string, ts.Symbol>;
  used: Set<string>;
  implementation?: Module;
};

/** Runtime entry names: launcher exec probe, rotation preload and sidebar loader. */
const entryExports: Readonly<Record<string, ReadonlySet<string>>> = {
  "src/local.ts": new Set(["serveOnce"]),
  "tests/dev/rotation_record.ts": new Set([
    "tla",
    "tlaId",
    "tlaWorker",
    "tlaHold",
    "tlaConn",
    "tlaNative",
    "tlaRead",
    "tlaDeleted",
    "tlaMove",
  ]),
  "web/sidebar/default_sidebar.js": new Set(["default"]),
};

export async function checkDeadExports(
  parsed: ReadonlyMap<string, ts.SourceFile> = new Map(),
): Promise<boolean> {
  const root = process.cwd();
  const listed = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    ":(glob,exclude)web/vendor/**",
    ":(glob,exclude)web/dist/**",
    ":(glob,exclude)" + ["play", "ground"].join("") + "/**",
  ]);
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  const candidates = new Set(
    listed.stdout
      .toString()
      .split("\0")
      .filter(
        (file) =>
          /\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)package\.json$/.test(file),
      )
      .map((file) => resolve(root, file)),
  );
  const texts = new Map<string, string>();
  await Promise.all(
    [...candidates].map(async (file) => {
      try {
        texts.set(
          file,
          parsed.get(file)?.text ?? (await Bun.file(file).text()),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }),
  );
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    allowJs: true,
    noLib: true,
    noResolve: true,
    types: [],
  };
  function project(
    file: string,
    fallback: ts.CompilerOptions,
  ): ts.CompilerOptions {
    const path = resolve(root, file);
    if (!ts.sys.fileExists(path)) return fallback;
    const read = ts.readConfigFile(path, ts.sys.readFile);
    if (read.error)
      throw new Error(
        ts.flattenDiagnosticMessageText(read.error.messageText, "\n"),
      );
    const { options: configured } = ts.parseJsonConfigFileContent(
      { ...read.config, include: [], files: [] },
      ts.sys,
      root,
    );
    return { ...configured, ...options };
  }
  const web = project("tsconfig.json", options);
  const backend = project("tsconfig.backend.json", web);
  const host = ts.createCompilerHost(options);
  const dirs = new Set<string>();
  for (const file of texts.keys())
    for (
      let dir = dirname(file);
      dir.startsWith(root) && !dirs.has(dir);
      dir = dirname(dir)
    )
      dirs.add(dir);
  host.directoryExists = (dir) => dirs.has(dir);
  host.fileExists = (file) => texts.has(file);
  host.readFile = (file) => texts.get(file);
  const caches = new Map(
    [web, backend].map((options) => [
      options,
      ts.createModuleResolutionCache(root, host.getCanonicalFileName, options),
    ]),
  );
  const projectFor = (file: string) =>
    /^(?:tests\/)?web\//.test(file.slice(root.length + 1)) ? web : backend;
  const packageNames = new Set(
    [...texts].flatMap(([file, text]) => {
      if (!file.endsWith("/package.json")) return [];
      const { name } = JSON.parse(text);
      return typeof name === "string" ? [name] : [];
    }),
  );
  function resolveImport(
    file: string,
    specifier: string,
    mode?: ts.ResolutionMode,
  ): ts.ResolvedModuleWithFailedLookupLocations {
    const options = projectFor(file);
    const [first, second] = specifier.split("/", 2);
    const packageName = specifier.startsWith("@")
      ? `${first}/${second}`
      : first!;
    if (
      !/^[.#/]/.test(specifier) &&
      !options.paths &&
      !options.baseUrl &&
      !packageNames.has(packageName)
    )
      return { resolvedModule: undefined };
    return ts.resolveModuleName(
      specifier,
      file,
      options,
      host,
      caches.get(options),
      undefined,
      mode,
    );
  }
  const customResolution = [web, backend].some(
    (project) =>
      project.paths ||
      project.baseUrl ||
      project.customConditions ||
      project.moduleSuffixes ||
      project.resolvePackageJsonExports !== undefined ||
      project.resolvePackageJsonImports !== undefined,
  );
  if (customResolution)
    host.resolveModuleNameLiterals = (
      literals,
      file,
      _redirect,
      _options,
      source,
    ) =>
      literals.map((literal) =>
        resolveImport(
          file,
          literal.text,
          ts.getModeForUsageLocation(source, literal, projectFor(file)),
        ),
      );
  const sources = [...texts]
    .filter(([file]) => !file.endsWith("/package.json"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, text]) => {
      const js = JS_SOURCE.test(file);
      return (
        (!js && parsed.get(file)) ||
        ts.createSourceFile(file, text, {
          languageVersion: ts.ScriptTarget.Latest,
          jsDocParsingMode: js
            ? ts.JSDocParsingMode.ParseAll
            : ts.JSDocParsingMode.ParseNone,
        })
      );
    });
  const bindingSources = new Map(
    sources.filter(needsBinding).map((source) => [source.fileName, source]),
  );
  host.getSourceFile = (file) => bindingSources.get(file);
  const program = ts.createProgram([...bindingSources.keys()], options, host);
  const checker = program.getTypeChecker();
  const modules = new Map<string, Module>();
  for (const source of program.getSourceFiles()) {
    const symbol = checker.getSymbolAtLocation(source);
    if (!symbol) continue;
    modules.set(source.fileName, {
      source,
      exports: new Map(
        checker.getExportsOfModule(symbol).map((item) => [item.name, item]),
      ),
      used: new Set(),
    });
  }
  for (const [file, module] of modules) {
    if (module.source.isDeclarationFile)
      module.implementation = modules.get(
        file.replace(/\.d\.([cm]?)ts$/, ".$1js"),
      );
  }
  for (const source of sources) {
    const bound = bindingSources.has(source.fileName);
    collectUses(
      checker,
      source,
      modules.get(source.fileName),
      (specifier, requireMode) => {
        const declaration =
          bound && !requireMode
            ? checker.getSymbolAtLocation(specifier)?.valueDeclaration
            : undefined;
        const resolved =
          declaration && ts.isSourceFile(declaration)
            ? declaration.fileName
            : resolveImport(
                source.fileName,
                specifier.text,
                requireMode
                  ? ts.ModuleKind.CommonJS
                  : bound
                    ? ts.getModeForUsageLocation(
                        source,
                        specifier,
                        projectFor(source.fileName),
                      )
                    : undefined,
              ).resolvedModule?.resolvedFileName;
        return resolved && resolved !== source.fileName
          ? modules.get(resolved)
          : undefined;
      },
    );
  }
  const icons = modules.get(resolve(root, "web/icons.ts"));
  if (icons) {
    const shell = await Bun.file(resolve(root, "web/index.html")).text();
    for (const [, name] of shell.matchAll(/<svg data-icon="(\w+)"><\/svg>/g))
      icons.used.add(name!);
  }
  const findings: string[] = [];
  for (const { source, exports, used } of modules.values()) {
    if (source.isDeclarationFile) continue;
    const file = source.fileName.slice(root.length + 1);
    for (const [name, symbol] of exports) {
      if (used.has(name) || entryExports[file]?.has(name)) continue;
      const declaration = symbol.declarations?.find(
        (node) => node.getSourceFile() === source,
      );
      const line = declaration
        ? source.getLineAndCharacterOfPosition(declaration.getStart(source))
            .line + 1
        : 1;
      findings.push(
        `${file}:${line}: export ${JSON.stringify(name)} has no importer; remove the export or delete the unused code`,
      );
    }
  }
  if (findings.length) console.error(findings.join("\n"));
  console.log(
    `dead exports: ${findings.length} unused across ${modules.size} modules`,
  );
  return findings.length === 0;
}

function collectUses(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  own: Module | undefined,
  resolve: (
    specifier: ts.StringLiteralLike,
    requireMode?: boolean,
  ) => Module | undefined,
): void {
  const bindings = new Map<ts.Symbol, Set<Module>>();
  const js = JS_SOURCE.test(source.fileName);
  const nestedImports = js || hasNestedImports(source);
  let identifiers: Map<string, ts.Identifier[]> | undefined;
  function visitDocs(node: ts.Node, visitor: (child: ts.Node) => void): void {
    if (js)
      for (const child of node.getChildren(source))
        if (ts.isJSDoc(child)) visitor(child);
  }
  function reference(
    specifier: ts.Expression,
    requireMode?: boolean,
  ): Module | undefined {
    if (!ts.isStringLiteralLike(specifier)) return;
    return resolve(specifier, requireMode);
  }
  function mark(target: Module, name?: string): void {
    if (name === undefined)
      for (const name of target.exports.keys()) target.used.add(name);
    else target.used.add(name);
    if (target.implementation) mark(target.implementation, name);
  }
  function constantKey(expression: ts.Expression): string | undefined {
    if (ts.isStringLiteralLike(expression)) return expression.text;
    const type = checker.getTypeAtLocation(expression);
    return type.isStringLiteral() ? type.value : undefined;
  }
  function consume(target: Module, node: ts.Node): void {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
      mark(target, parent.name.text);
    else if (ts.isQualifiedName(parent) && parent.left === node)
      mark(target, parent.right.text);
    else if (ts.isElementAccessExpression(parent) && parent.expression === node)
      mark(target, constantKey(parent.argumentExpression));
    else if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      const statement = parent.parent.parent;
      if (
        ts.isIdentifier(parent.name) &&
        ts.isVariableStatement(statement) &&
        ts
          .getModifiers(statement)
          ?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)
      )
        mark(target);
      else bind(target, parent.name);
    } else if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent)
    )
      consume(target, parent);
    else if (!ts.isExpressionStatement(parent) && !ts.isVoidExpression(parent))
      mark(target);
  }
  function bind(target: Module, name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      const binding = checker.getSymbolAtLocation(name);
      if (!binding) return mark(target);
      let targets = bindings.get(binding);
      if (!targets) bindings.set(binding, (targets = new Set()));
      if (targets.has(target)) return;
      targets.add(target);
      identifiers ??= identifiersByName(source, visitDocs);
      for (const node of identifiers.get(name.text) ?? []) {
        if (
          binding.declarations?.some(
            (decl) => "name" in decl && decl.name === node,
          )
        )
          continue;
        const symbol =
          ts.isShorthandPropertyAssignment(node.parent) &&
          node.parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : ts.isExportSpecifier(node.parent)
              ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
              : checker.getSymbolAtLocation(node);
        if (symbol === binding) consume(target, node);
      }
    } else if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        const key = element.propertyName ?? element.name;
        if (element.dotDotDotToken) return mark(target);
        if (ts.isComputedPropertyName(key))
          mark(target, constantKey(key.expression));
        else if (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
          mark(target, key.text);
        else mark(target);
      }
    } else mark(target);
  }
  function visit(node: ts.Node): void {
    visitDocs(node, visit);
    if (ts.isImportDeclaration(node) || ts.isJSDocImportTag(node)) {
      const target = reference(node.moduleSpecifier);
      const clause = node.importClause;
      if (!target || !clause) return;
      if (clause.name) mark(target, "default");
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings))
          bind(target, clause.namedBindings.name);
        else
          for (const item of clause.namedBindings.elements)
            mark(target, (item.propertyName ?? item.name).text);
      }
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const target = reference(node.moduleSpecifier);
      if (!target) return;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements)
          mark(target, (item.propertyName ?? item.name).text);
      } else if (node.exportClause) mark(target);
      else
        for (const [name, symbol] of target.exports)
          if (name !== "default" && own?.exports.get(name) === symbol)
            mark(target, name);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const target =
        node.moduleReference.expression &&
        reference(node.moduleReference.expression);
      if (target) bind(target, node.name);
      return;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const target = reference(node.argument.literal);
      let name = node.qualifier;
      while (name && ts.isQualifiedName(name)) name = name.left;
      const parent = node.parent;
      if (
        target &&
        !name &&
        ts.isIndexedAccessTypeNode(parent) &&
        parent.objectType === node &&
        ts.isLiteralTypeNode(parent.indexType) &&
        ts.isStringLiteralLike(parent.indexType.literal)
      )
        mark(target, parent.indexType.literal.text);
      else if (target) mark(target, name?.text);
    }
    if (ts.isCallExpression(node) && node.arguments[0]) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const target = reference(node.arguments[0]);
        if (target) {
          const parent = node.parent;
          if (ts.isAwaitExpression(parent)) consume(target, parent);
          else if (
            ts.isPropertyAccessExpression(parent) &&
            parent.name.text === "then" &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent
          ) {
            const fn = parent.parent.arguments[0];
            if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
              if (fn.parameters[0]) bind(target, fn.parameters[0].name);
            } else mark(target);
          } else if (
            !ts.isExpressionStatement(parent) &&
            !ts.isVoidExpression(parent)
          )
            mark(target);
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        !checker
          .getSymbolAtLocation(node.expression)
          ?.declarations?.some(
            (declaration) => declaration.getSourceFile() === source,
          )
      ) {
        const target = reference(node.arguments[0], true);
        if (target) consume(target, node);
      }
    }
    if (nestedImports) ts.forEachChild(node, visit);
  }
  ts.forEachChild(source, visit);
}

function hasNestedImports(source: ts.SourceFile): boolean {
  return /\bimport\s*[(\/]|\brequire\b|\\u/.test(source.text);
}

/** Files with only named imports need module resolution, not lexical binding. */
function needsBinding(source: ts.SourceFile): boolean {
  return (
    source.isDeclarationFile ||
    JS_SOURCE.test(source.fileName) ||
    hasNestedImports(source) ||
    source.statements.some(
      (node) =>
        ts.isExportAssignment(node) ||
        ts.isExportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        (ts.canHaveModifiers(node) &&
          ts
            .getModifiers(node)
            ?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) ||
        (ts.isImportDeclaration(node) &&
          node.importClause?.namedBindings &&
          ts.isNamespaceImport(node.importClause.namedBindings)),
    )
  );
}

function identifiersByName(
  source: ts.SourceFile,
  visitDocs: (node: ts.Node, visit: (child: ts.Node) => void) => void,
): Map<string, ts.Identifier[]> {
  const byName = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const same = byName.get(node.text);
      if (same) same.push(node);
      else byName.set(node.text, [node]);
    }
    visitDocs(node, visit);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return byName;
}

if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log(
      "bun tests/checks/dead_export_check.ts\nChecks the current Git checkout for exports without a cross-file importer.",
    );
  else if (!(await checkDeadExports())) process.exitCode = 1;
}
