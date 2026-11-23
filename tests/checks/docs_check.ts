#!/usr/bin/env bun
// Check core links, Markdown sweep sizes and README indexes.
// Check inline code and prose outside links in non-root READMEs. Repetition
// counts can only fall; a passing check shrinks the baseline for you to commit.
import { existsSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { marked, type Token } from "marked";
import type { BindingName, Node } from "typescript";
import { readSweepLedger, sweepProblem } from "./size_check.ts";

const ROOTS = /^(?:src|web|docs|tools|scripts|tests)\//;
const BUILT = /^web\/dist(?:\/|$)/;
const OPTIONAL = ["play", "ground"].join("");
const ROUTERS = new Set([
  "docs/README.md",
  "tests/README.md",
  `${OPTIONAL}/README.md`,
]);
const ROUTER_LIMIT = 4_000;
const BASELINE = "docs/readme_repetition_baseline.json";
const HISTORY =
  /\bsince\s+#\d*|(?<![\w/#])#\d+\b|\b(?:no\s+longer|previously|used\s+to)\b/gi;
const CLI_TOKEN =
  /(?<![\w./-])(?:--[\w-]*\w|RECURSE_[A-Z0-9_]+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![\w-])/g;
const CODE_NAME = /^([\w$]+(?:\.[\w$]+)*)(?:\(.*\))?$/s;

async function tracked(...specs: string[]): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "-z", "--", ...specs], {
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("git ls-files failed");
  return out.split("\0").filter(Boolean);
}

async function codeNames(files: string[]): Promise<Set<string>> {
  const { default: ts } = await import("typescript");
  const names = new Set<string>();
  function binding(name: BindingName): void {
    if (ts.isIdentifier(name)) names.add(name.text);
    else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) binding(element.name);
  }
  function visit(node: Node): void {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const)
      for (const declaration of node.declarations) binding(declaration.name);
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
    }
    if (ts.isClassLike(node)) {
      for (const member of node.members) {
        const functionField =
          ts.isPropertyDeclaration(member) &&
          member.initializer &&
          (ts.isArrowFunction(member.initializer) ||
            ts.isFunctionExpression(member.initializer));
        if (
          !(ts.isMethodDeclaration(member) || functionField) ||
          !ts.isIdentifier(member.name)
        )
          continue;
        names.add(member.name.text);
        if (node.name) names.add(`${node.name.text}.${member.name.text}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  const scripts = files.filter((file) =>
    /\.(?:[cm]?[jt]sx?|py|sh)$/.test(file),
  );
  const batchSize = 64;
  for (let start = 0; start < scripts.length; start += batchSize) {
    await Promise.all(
      scripts.slice(start, start + batchSize).map(async (file) => {
        const source = await readFile(file, "utf8");
        if (/\.[cm]?[jt]sx?$/.test(file)) {
          visit(
            ts.createSourceFile(file, source, {
              languageVersion: ts.ScriptTarget.Latest,
              jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
            }),
          );
        } else {
          for (const [, name] of source.matchAll(
            file.endsWith(".py")
              ? /^[ \t]*(?:(?:async[ \t]+)?def|class)[ \t]+(\w+)/gm
              : /^[ \t]*(?:function[ \t]+)?(\w+)[ \t]*\(\s*\)\s*\{/gm,
          ))
            names.add(name!);
        }
      }),
    );
  }
  return names;
}

function* repetitions(
  file: string,
  tokens: Token[],
  names: Set<string> | undefined,
  htmlLink = { open: false },
): Generator<string> {
  for (const token of tokens) {
    if (token.type === "html" && !token.block) {
      if (/^<a\s[^>]*\bhref\s*=/i.test(token.raw)) htmlLink.open = true;
      if (/^<\/a\s*>/i.test(token.raw)) htmlLink.open = false;
    }
    if (token.type === "link" || token.type === "image") continue;
    if (token.type === "table") {
      for (const cell of token.header.concat(token.rows.flat()))
        yield* repetitions(file, cell.tokens, names, htmlLink);
    } else if (token.type === "list") {
      yield* repetitions(file, token.items, names, htmlLink);
    } else if ("tokens" in token && token.tokens) {
      yield* repetitions(file, token.tokens, names, htmlLink);
    } else if (htmlLink.open) {
      continue;
    } else if (token.type === "codespan") {
      const code = token.text;
      if (
        /^[\w./-]+$/.test(code) &&
        (existsSync(join(dirname(file), code)) ||
          (ROOTS.test(code) && existsSync(code)))
      )
        continue;
      const name = CODE_NAME.exec(code)?.[1];
      const cli = [...code.matchAll(CLI_TOKEN)];
      if (cli.length) {
        for (const [value] of cli) yield value;
      } else if (name && names?.has(name)) {
        yield code;
      }
      for (const [value] of code.matchAll(HISTORY)) yield value;
    } else if (token.type === "text") {
      for (const [value] of token.raw.matchAll(HISTORY)) yield value;
    }
  }
}

const problems: string[] = [];
const docs = (
  await tracked(
    "AGENTS.md",
    "README.md",
    ":(glob)docs/**/*.md",
    ":(glob)**/README.md",
    `:(glob,exclude)${OPTIONAL}/**`,
  )
).filter((file) => !file.startsWith("node_modules/"));
for (const file of docs) {
  const text = await readFile(file, "utf8");
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(?:[a-z]+:|#)/i.test(target!)) continue;
    const path = join(dirname(file), target!.replace(/#.*$/, ""));
    if (
      file === "README.md" &&
      (target!.endsWith("/") || path.endsWith("/README.md")) &&
      !ROOTS.test(path)
    )
      continue;
    if (!existsSync(path)) problems.push(`${file}: broken link ${target}`);
  }
  for (const [, path] of text.matchAll(/`([^`\s]+)`/g)) {
    if (!ROOTS.test(path!) || BUILT.test(path!) || /[<>*{}$]/.test(path!))
      continue;
    if (!existsSync(path!)) problems.push(`${file}: missing path ${path}`);
  }
}

const markdown = (await tracked(".")).filter(
  (file) =>
    file.endsWith("/README.md") ||
    (file.endsWith(".md") && !file.startsWith(`${OPTIONAL}/`)),
);
const ledger = readSweepLedger();
const baseline: Record<string, number> = JSON.parse(
  await readFile(BASELINE, "utf8"),
);
const remaining: Record<string, number> = {};
let names: Set<string> | undefined;
for (const file of markdown) {
  if ((await lstat(file)).isSymbolicLink()) continue;
  const text = await readFile(file, "utf8");
  const count = Array.from(text).length;
  const problem = ROUTERS.has(file)
    ? count >= ROUTER_LIMIT &&
      `${file}: ${count} characters; folder indexes must stay under ${ROUTER_LIMIT}.`
    : sweepProblem(file, count, ledger);
  if (problem) problems.push(problem);
  if (!file.endsWith("/README.md")) continue;
  if (!names && text.includes("`"))
    names = await codeNames(
      await tracked("src", "web", "tests", "tools", "scripts"),
    );
  const repeated = [...repetitions(file, marked.lexer(text), names)];
  if (repeated.length) remaining[file] = repeated.length;
  const cap = baseline[file] ?? 0;
  if (repeated.length > cap) {
    problems.push(
      `${file}: README repeats code or history (${repeated.length}, baseline ${cap}): ${repeated.map((value) => JSON.stringify(value)).join(", ")}; move this to the code's header or --help, or delete it if the code already says it.`,
    );
  }
}

for (const problem of problems) console.error(problem);
if (problems.length) process.exit(1);
if (
  Object.entries(baseline).some(
    ([file, count]) => (remaining[file] ?? 0) < count,
  )
) {
  await writeFile(BASELINE, `${JSON.stringify(remaining, null, 2)}\n`);
  console.log(`Shrank ${BASELINE}; commit the updated baseline.`);
}
console.log(
  `docs check: ${docs.length} files, ${markdown.length} Markdown files checked; ${Object.keys(remaining).length} READMEs with ${Object.values(remaining).reduce((sum, count) => sum + count, 0)} baselined repetitions`,
);
