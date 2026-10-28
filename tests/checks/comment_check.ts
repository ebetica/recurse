/**
 * Python: module docs <=8 lines; declaration docs <=2; # Invariant:/Spec:.
 * CLI: --help lists modes. tests/check.sh enforces all languages.
 */
import { lstatSync, readFileSync } from "node:fs";
import ts from "typescript";
import { resolveConfig } from "prettier";
import { leadingModuleHelp } from "../../src/skill_context";

export type Violation = {
  /** Repository-relative source path. */
  file: string;
  /** One-based source line. */
  line: number;
  /** Stable policy rule name. */
  rule: string;
  /** Short explanation. */
  reason: string;
};

export function checkComments(
  file: string,
  text: string,
  width = 80,
): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, ts.CommentRange>();
  const nodes: ts.Node[] = [];
  const collect = (node: ts.Node) => {
    nodes.push(node);
    for (const pos of [node.pos, node.end]) {
      for (const range of [
        ...(ts.getLeadingCommentRanges(text, pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, pos) ?? []),
      ])
        ranges.set(range.pos, range);
    }
    for (const child of node.getChildren(source)) collect(child);
  };
  collect(source);
  const literals = nodes.filter((node) => ts.isJsxText(node));
  let comments = [...ranges.values()]
    .filter(
      (c) => !literals.some((node) => c.pos >= node.pos && c.pos < node.end),
    )
    .sort((a, b) => a.pos - b.pos);
  const violations: Violation[] = [];
  const line = (pos: number) =>
    source.getLineAndCharacterOfPosition(pos).line + 1;
  const add = (pos: number, rule: string, reason: string) =>
    violations.push({ file, line: line(pos), rule, reason });
  const raw = (c: ts.CommentRange) => text.slice(c.pos, c.end);
  const content = (c: ts.CommentRange) =>
    raw(c)
      .replace(/^\/\/[ /]?|^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .replace(/^\s*(?:\*|\/\/) ?/gm, "")
      .trim();
  const top = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0;
  const firstCode = source.statements[0]?.getStart(source) ?? text.length;
  const directive = (c: ts.CommentRange) =>
    /^(?:@ts-(?:expect-error|ignore|nocheck)\b|prettier-ignore\b|(?:color|font|svg)-check: allow\b|(?:oxlint|eslint)-disable(?:-next-line|-line)?\b)/.test(
      content(c),
    ) || /^\/\/\/\s*<reference\b/.test(raw(c));
  const toolHelpSource =
    /^(?:tools|tests\/dev)\//.test(file) &&
    source.statements.some(
      (node) =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /(?:^|\/)\_help\.ts$/.test(node.moduleSpecifier.text) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          (name) => name.name.text === "toolHelp" && !name.propertyName,
        ),
    ) &&
    nodes.some(
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "toolHelp" &&
        node.arguments.length === 1 &&
        node.arguments[0]?.getText(source) === "import.meta.url",
    ) &&
    leadingModuleHelp(text) !== null;
  const helpComment = toolHelpSource
    ? comments.find((c) => raw(c).startsWith("/**"))
    : undefined;
  const testExemption = (c: ts.CommentRange) =>
    file.split("/").includes("tests") &&
    c.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
    (/^\/\/ test-check-allow: (?:T[1-46-9]|T10) \S[^\r\n]*$/.test(raw(c)) ||
      (/^\/\/ (?:Regression|Feature): #\d+ \S[^\r\n]*$/.test(raw(c)) &&
        nodes.some(
          (node) =>
            ((ts.isCallExpression(node) &&
              /^(?:test|it)(?:\.|$)/.test(node.expression.getText(source))) ||
              /^(?:async function test_\w+\s*\(|(?:export )?const \w+\s*:\s*BrowserTest\s*=\s*async\s*\()/.test(
                node.getText(source),
              )) &&
            /^\r?\n(?:[ \t]*\/\/ test-check-allow: [^\r\n]*\r?\n)*[ \t]*$/.test(
              text.slice(c.end, node.getStart(source)),
            ),
        )));
  const exempt = (c: ts.CommentRange) =>
    testExemption(c) ||
    c.pos === helpComment?.pos ||
    directive(c) ||
    (c.pos < firstCode &&
      /(?:@license\b|SPDX-License-Identifier:|(?:^|\n)\s*Copyright\b|^(?:MIT License|Apache License|GNU (?:General|Lesser) Public License|Licensed under\b|Permission is hereby granted\b))/i.test(
        content(c),
      ));
  const ownLine = (c: ts.CommentRange) =>
    text.slice(text.lastIndexOf("\n", c.pos - 1) + 1, c.pos).trim() === "";
  const groups: ts.CommentRange[] = [];
  for (const c of comments) {
    const last = groups.at(-1);
    if (
      last &&
      last.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      c.kind === last.kind &&
      ownLine(last) &&
      ownLine(c) &&
      !exempt(last) &&
      !exempt(c) &&
      line(c.pos) === line(last.end) + 1 &&
      /^\s*$/.test(text.slice(last.end, c.pos))
    )
      last.end = c.end;
    else groups.push({ ...c });
  }
  comments = groups;
  const isTest =
    file.split("/").includes("tests") && !/^tests\/(?:checks|dev)\//.test(file);
  const attached = new Map<number, number>();
  const bodies = nodes.flatMap((node) =>
    ts.isBlock(node)
      ? [node]
      : ts.isFunctionLike(node) && "body" in node && node.body
        ? [node.body as ts.Node]
        : [],
  );
  const inBody = (c: ts.CommentRange) =>
    bodies.some((body) => c.pos >= body.getStart(source) && c.end <= body.end);
  const singleLineDocTarget = (node: ts.Node) =>
    (ts.isVariableStatement(node) &&
      (ts.isSourceFile(node.parent) || ts.isModuleBlock(node.parent))) ||
    ts.isPropertyDeclaration(node) ||
    ts.isEnumMember(node) ||
    (node.parent &&
      (ts.isInterfaceDeclaration(node.parent) ||
        ts.isTypeLiteralNode(node.parent)) &&
      node.parent.members.includes(node as ts.TypeElement));
  const multilineDocTarget = (node: ts.Node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node);
  for (const node of nodes) {
    const limit = singleLineDocTarget(node)
      ? 1
      : multilineDocTarget(node)
        ? 4
        : undefined;
    if (limit === undefined) continue;
    const start = node.getStart(source);
    const preceding = comments.filter((c) => c.end <= start && !exempt(c));
    const c = preceding.at(-1);
    const gap = c ? text.slice(c.end, start) : "";
    const direct = c && /^\s*$/.test(gap) && line(start) === line(c.end) + 1;
    const leading = direct && c && ownLine(c);
    if (leading) attached.set(c.pos, limit);
    if (!singleLineDocTarget(node)) continue;
    const trailing = comments.find(
      (comment) =>
        comment.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
        comment.pos >= node.end &&
        line(comment.pos) === line(node.end) &&
        /^[ \t]*,?[ \t]*$/.test(text.slice(node.end, comment.pos)) &&
        !exempt(comment) &&
        !inBody(comment),
    );
    if (trailing) {
      attached.set(trailing.pos, 1);
      if (leading)
        add(trailing.pos, "duplicate-doc", "declaration has more than one doc");
    }
  }
  let header = false;
  let headerStart = top;
  for (const c of comments) {
    if (exempt(c)) {
      if (text.slice(headerStart, c.pos).trim() === "") headerStart = c.end;
      continue;
    }
    if (isTest) {
      add(c.pos, "test-comment", "tests must contain no comments");
    } else {
      const doc = attached.get(c.pos);
      const body = inBody(c);
      const isHeader =
        !doc && !header && text.slice(headerStart, c.pos).trim() === "";
      if (isHeader) header = true;
      const allowed =
        doc || isHeader || (body && /^(?:Invariant:|Spec:)/.test(content(c)));
      if (!allowed)
        add(
          c.pos,
          "unexpected-comment",
          "comment is not an allowed doc, header, invariant or spec",
        );
      const limit = doc ?? 4;
      if (allowed && line(c.end) - line(c.pos) + 1 > limit)
        add(
          c.pos,
          "comment-lines",
          `comment exceeds ${limit} line${limit === 1 ? "" : "s"}`,
        );
    }
    let pos = c.pos;
    for (const part of raw(c).replace(/\r$/, "").split(/\r?\n/)) {
      const column = source.getLineAndCharacterOfPosition(pos).character;
      if (column + part.length > width)
        add(pos, "comment-width", `comment line exceeds print width ${width}`);
      pos += part.length + (text[pos + part.length] === "\r" ? 2 : 1);
    }
  }
  return violations.sort(
    (a, b) => a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

export function report(violations: Violation[], summary = false): string {
  const lines = violations
    .slice(0, summary ? 50 : undefined)
    .map((v) => `${v.file}:${v.line} ${v.rule} ${v.reason}`);
  const counts = (key: (v: Violation) => string) => {
    const result = new Map<string, number>();
    for (const v of violations)
      result.set(key(v), (result.get(key(v)) ?? 0) + 1);
    return [...result]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name}=${count}`)
      .join(" ");
  };
  lines.push(
    `Comment warnings: ${violations.length}`,
    `By rule: ${counts((v) => v.rule)}`,
    `By directory: ${counts((v) => (v.file.includes("/") ? v.file.split("/")[0] : "(root)"))}`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    console.log(`Usage: bun tests/checks/comment_check.ts [--strict | --strict-python] [--summary]
Check tracked JS/TS and Python files; Python fixtures are included.
Python permits one module docstring of at most 8 physical lines and function/class
docstrings of at most 2. Eight lines allow a purpose and a few safety rules.
Python # comments must state Invariant: or Spec:; tool/license pragmas are exempt.
Comment lines use the file's Prettier print width (default 80), including indent.
--strict         Fail on any JS/TS or Python finding (tests/check.sh ts).
--strict-python  Fail only on Python findings.
--summary        Print at most 50 findings, retaining full counts.
Without strict flags, findings only warn. Requires python3 for Python files.`);
    process.exit(0);
  }
  const tracked = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--",
    ".",
    ":(glob,exclude)web/vendor/**",
    ":(glob,exclude)web/dist/**",
    ":(glob,exclude)scripts/patches/**",
    ":(glob,exclude)**/*.lock",
  ]);
  if (tracked.exitCode !== 0) throw new Error(tracked.stderr.toString());
  const violations: Violation[] = [];
  const python = [];
  for (const file of tracked.stdout.toString().split("\0").filter(Boolean)) {
    if (lstatSync(file).isSymbolicLink()) continue;
    const isPython = file.endsWith(".py");
    if (
      !isPython &&
      (!/\.[cm]?[jt]sx?$/i.test(file) || file.split("/").includes("fixtures"))
    )
      continue;
    const width = (await resolveConfig(file))?.printWidth ?? 80;
    const text = readFileSync(file, "utf8");
    if (isPython) python.push({ file, text, width });
    else violations.push(...checkComments(file, text, width));
  }
  if (python.length) {
    const result = Bun.spawnSync(
      [
        "python3",
        new URL("./python_comment_check.py", import.meta.url).pathname,
      ],
      { stdin: Buffer.from(JSON.stringify(python)) },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    violations.push(...(JSON.parse(result.stdout.toString()) as Violation[]));
  }
  console.log(report(violations, process.argv.includes("--summary")));
  if (
    (process.argv.includes("--strict") && violations.length) ||
    (process.argv.includes("--strict-python") &&
      violations.some((violation) => violation.file.endsWith(".py")))
  )
    process.exitCode = 1;
}
