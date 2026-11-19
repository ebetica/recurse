/** Guard release, bootstrap, build and agent CLIs run outside the server.
 * src/local.ts (including its --help preflight) runs after dependency setup
 * and intentionally loads the server-launch graph; it is not a standalone CLI.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const WORKTREE = [
  "bun:ffi",
  "src/local_dependencies.ts",
  "src/local_roots.ts",
  "src/observability/slow-span/index.ts",
  "src/observability/slow-span/span.ts",
  "src/skill_context.ts",
  "src/utils/dir_fd.ts",
  "src/utils/flock.ts",
  "src/utils/libc.ts",
  "src/utils/trash.ts",
  "src/utils/trash-sweep/client.ts",
  "src/utils/trash-sweep/index.ts",
  "tools/_help.ts",
];

const ENTRIES = new Map<string, readonly string[]>([
  ["src/release.ts", []],
  ["scripts/release.ts", []],
  ["src/build_stamp.cli.ts", []],
  ["src/launcher/frontend_assets.ts", []],
  ["src/launcher/dependencies.ts", ["tools/worktree.ts", ...WORKTREE]],
  [
    "src/launch_cli.ts",
    [
      "bun:ffi",
      "src/build_stamp.cli.ts",
      "src/launcher/build.cli.ts",
      "src/launcher/environment.ts",
      "src/launcher/frontend_assets.ts",
      "src/launcher/system.ts",
      "src/local_dependencies.ts",
      "src/local_roots.ts",
      "src/observability/runtime_logging.ts",
      "src/observability/slow-span/index.ts",
      "src/observability/slow-span/span.ts",
      "src/utils/flock.ts",
      "src/utils/libc.ts",
      "src/utils/trash-sweep/client.ts",
      "src/utils/trash-sweep/index.ts",
    ],
  ],
  ["tools/worktree.ts", WORKTREE],
  [
    "tools/subagent.ts",
    [
      ...WORKTREE,
      "src/agents/durable/message_projection.ts",
      "src/backends/label/index.ts",
      "src/backends/label/label.ts",
      "src/title_text.ts",
      "tools/subagent_args.ts",
      "tools/worktree.ts",
    ],
  ],
]);

const typeSpecifiersOnly = (list: ts.NamedImports | ts.NamedExports) =>
  list.elements.length > 0 && list.elements.every((item) => item.isTypeOnly);
const loadsCreateRequire = (list: ts.NamedImports | ts.NamedExports) =>
  list.elements.some(
    (item) =>
      !item.isTypeOnly &&
      (item.propertyName ?? item.name).text === "createRequire",
  );

type ImportTarget = string | { label: string; reason: string };
const computed = {
  label: "<computed import>",
  reason: "use a literal import target",
};
const createRequire = {
  label: "createRequire",
  reason: "use a direct import or require call",
};
const META_FIELDS = new Set(["dir", "main", "path", "url"]);
const metaObject = {
  label: "import.meta",
  reason:
    "read .dir, .main, .path or .url directly; do not capture the object or access its loader",
};

function importTargets(file: string, text: string): ImportTarget[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const targets = new Set<ImportTarget>();
  const add = (expr: ts.Expression | undefined) =>
    targets.add(expr && ts.isStringLiteralLike(expr) ? expr.text : computed);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const names = clause?.namedBindings;
      if (
        !clause?.isTypeOnly &&
        !(
          !clause?.name &&
          names &&
          ts.isNamedImports(names) &&
          typeSpecifiersOnly(names)
        )
      ) {
        add(node.moduleSpecifier);
        if (names && ts.isNamedImports(names) && loadsCreateRequire(names))
          targets.add(createRequire);
      }
    } else if (ts.isExportDeclaration(node)) {
      const names = node.exportClause;
      if (
        node.moduleSpecifier &&
        !node.isTypeOnly &&
        !(names && ts.isNamedExports(names) && typeSpecifiersOnly(names))
      ) {
        add(node.moduleSpecifier);
        if (names && ts.isNamedExports(names) && loadsCreateRequire(names))
          targets.add(createRequire);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "require" &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "module")
      )
        add(node.arguments[0]);
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      if (member === "createRequire") targets.add(createRequire);
    } else if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      const parent = node.parent;
      if (
        !ts.isPropertyAccessExpression(parent) ||
        parent.expression !== node ||
        !META_FIELDS.has(parent.name.text)
      )
        targets.add(metaObject);
    } else if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
        name.text === "createRequire"
      )
        targets.add(createRequire);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...targets];
}

const [only, ...extra] = process.argv.slice(2);
if (only === "--help") {
  console.log(`Usage: bun tests/checks/standalone_import_check.ts [ENTRYPOINT]
Check standalone CLIs from the current checkout. Node built-ins and explicit
per-entrypoint allowances are permitted; type-only imports are ignored.
Checks static imports, re-exports and direct import()/require() calls with
literal targets. Do not use createRequire. Read import.meta.dir, .main, .path
or .url directly rather than capturing the object or using its loader.
The static gate checks all entrypoints.`);
  process.exit(0);
}
if (extra.length || (only && !ENTRIES.has(only))) {
  console.error(`Unknown standalone entrypoint: ${[only, ...extra].join(" ")}`);
  process.exit(1);
}

const root = realpathSync(process.cwd());
const imports = new Map<string, ImportTarget[]>();
let violations = 0;
for (const [entry, allowed] of ENTRIES) {
  if (only && only !== entry) continue;
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    let targets = imports.get(file);
    if (!targets) {
      targets = importTargets(file, readFileSync(join(root, file), "utf8"));
      imports.set(file, targets);
    }
    const reject = (target: string, reason: string) => {
      violations++;
      console.error(
        `Standalone import boundary: ${[...chain, file, target].join(" -> ")} (${reason})`,
      );
    };
    for (const name of targets) {
      if (typeof name !== "string") {
        reject(name.label, name.reason);
        continue;
      }
      if (isBuiltin(name) && !/^(?:node:)?bun(?::|$)/.test(name)) continue;
      if (name === "bun:ffi" && allowed.includes(name)) continue;
      if (!/^\.\.?\//.test(name)) {
        reject(name, "not an allowed module");
        continue;
      }
      let target: string;
      try {
        target = relative(
          root,
          realpathSync(Bun.resolveSync(name, dirname(join(root, file)))),
        );
      } catch {
        reject(name, "cannot resolve import");
        continue;
      }
      if (target !== entry && !allowed.includes(target)) {
        reject(target, "not an allowed module");
        continue;
      }
      visit(target, [...chain, file]);
    }
  };
  visit(entry, []);
}
console.log(
  `standalone import check: ${only ? "1 entrypoint" : `${ENTRIES.size} entrypoints`}, ${violations} violations`,
);
if (violations) process.exitCode = 1;
