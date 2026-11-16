/**
 * JS/TS comment policy. CLI: --help lists modes; tests/check.sh enforces it.
 */
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { resolveConfig } from "prettier";
import { leadingModuleHelp } from "../../src/skill_context";

const TEST_FUNCTION =
  /(?:async function test_\w+\s*\(|(?:export )?const \w+\s*:\s*BrowserTest\s*=\s*async\s*\()/y;

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
  const scanned = new Set<number>();
  const scan = (pos: number) => {
    if (scanned.has(pos)) return;
    scanned.add(pos);
    for (const range of ts.getLeadingCommentRanges(text, pos) ?? [])
      ranges.set(range.pos, range);
    for (const range of ts.getTrailingCommentRanges(text, pos) ?? [])
      ranges.set(range.pos, range);
  };
  const collect = (node: ts.Node) => {
    nodes.push(node);
    scan(node.pos);
    scan(node.end);
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
  let testStarts: number[] | undefined;
  const testFollows = (c: ts.CommentRange) => {
    testStarts ??= nodes
      .filter(
        (node) =>
          (ts.isCallExpression(node) &&
            /^(?:test|it)(?:\.|$)/.test(node.expression.getText(source))) ||
          ((TEST_FUNCTION.lastIndex = node.getStart(source)),
          TEST_FUNCTION.test(text) && TEST_FUNCTION.lastIndex <= node.end),
      )
      .map((node) => node.getStart(source))
      .sort((a, b) => a - b);
    const start = testStarts.find((start) => start > c.end);
    return (
      start !== undefined &&
      /^\r?\n(?:[ \t]*\/\/ test-check-allow: [^\r\n]*\r?\n)*[ \t]*$/.test(
        text.slice(c.end, start),
      )
    );
  };
  const testExemption = (c: ts.CommentRange) =>
    file.split("/").includes("tests") &&
    c.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
    (/^\/\/ test-check-allow: (?:T[1-46-9]|T10) \S[^\r\n]*$/.test(raw(c)) ||
      (/^\/\/ (?:Regression|Feature): #\d+ \S[^\r\n]*$/.test(raw(c)) &&
        testFollows(c)));
  const exemptions = new Map<string, boolean>();
  const exempt = (c: ts.CommentRange) => {
    const key = `${c.pos}:${c.end}`;
    let result = exemptions.get(key);
    if (result === undefined) exemptions.set(key, (result = computeExempt(c)));
    return result;
  };
  const computeExempt = (c: ts.CommentRange) =>
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
  const bodyRanges = bodies.map((body) => [body.getStart(source), body.end]);
  const inBody = (c: ts.CommentRange) =>
    bodyRanges.some(([start, end]) => c.pos >= start! && c.end <= end!);
  const kept = comments.filter((c) => !exempt(c));
  const endsSorted = kept.every(
    (c, index) => index === 0 || kept[index - 1]!.end <= c.end,
  );
  const firstAtLeast = (
    list: ts.CommentRange[],
    value: number,
    key: (c: ts.CommentRange) => number,
  ) => {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (key(list[mid]!) < value) low = mid + 1;
      else high = mid;
    }
    return low;
  };
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
    const c = endsSorted
      ? kept[firstAtLeast(kept, start + 1, (c) => c.end) - 1]
      : kept.filter((c) => c.end <= start).at(-1);
    const gap = c ? text.slice(c.end, start) : "";
    const direct = c && /^\s*$/.test(gap) && line(start) === line(c.end) + 1;
    const leading = direct && c && ownLine(c);
    if (leading) attached.set(c.pos, limit);
    if (!singleLineDocTarget(node)) continue;
    const next = comments[firstAtLeast(comments, node.end, (c) => c.pos)];
    const trailing =
      next &&
      next.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      line(next.pos) === line(node.end) &&
      /^[ \t]*,?[ \t]*$/.test(text.slice(node.end, next.pos)) &&
      !exempt(next) &&
      !inBody(next)
        ? next
        : undefined;
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
    console.log(`Usage: bun tests/checks/comment_check.ts [--strict] [--summary]
Check tracked JS/TS files outside fixtures.
Comment lines use the file's Prettier print width (default 80), including indent.
--strict         Fail on any finding (tests/check.sh ts).
--summary        Print at most 50 findings, retaining full counts.
Without --strict, findings only warn.
JS/TS results are cached in the checkout's git directory, keyed by this
checker's source and each file's path, width and content.`);
    process.exit(0);
  }
  const tracked = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--",
    ".",
    ":(glob,exclude)" + ["play", "ground"].join("") + "/**",
    ":(glob,exclude)web/vendor/**",
    ":(glob,exclude)web/dist/**",
    ":(glob,exclude)scripts/patches/**",
    ":(glob,exclude)**/*.lock",
  ]);
  if (tracked.exitCode !== 0) throw new Error(tracked.stderr.toString());
  const files = tracked.stdout
    .toString()
    .split("\0")
    .filter(
      (file) =>
        file &&
        !lstatSync(file).isSymbolicLink() &&
        /\.[cm]?[jt]sx?$/i.test(file) &&
        !file.split("/").includes("fixtures"),
    );
  const widths = await Promise.all(
    files.map(async (file) => (await resolveConfig(file))?.printWidth ?? 80),
  );
  const cachePath = Bun.spawnSync([
    "git",
    "rev-parse",
    "--git-path",
    "recurse-comment-check.json",
  ])
    .stdout.toString()
    .trim();
  const version = Bun.hash(
    [
      readFileSync(import.meta.path, "utf8"),
      readFileSync(
        new URL("../../src/skill_context.ts", import.meta.url),
        "utf8",
      ),
      ts.version,
    ].join("\0"),
  ).toString(36);
  let cached: Record<string, Violation[]> = {};
  try {
    cached = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {}
  const results: Record<string, Violation[]> = {};
  const violations: Violation[] = [];
  for (const [index, file] of files.entries()) {
    const width = widths[index]!;
    const text = readFileSync(file, "utf8");
    const key = `${version}:${width}:${Bun.hash(`${file}\0${text}`).toString(36)}`;
    const hit = cached[key];
    results[key] =
      Array.isArray(hit) &&
      hit.every(
        (v) =>
          v?.file === file &&
          Number.isInteger(v.line) &&
          typeof v.rule === "string" &&
          typeof v.reason === "string",
      )
        ? hit
        : checkComments(file, text, width);
    violations.push(...results[key]);
  }
  try {
    writeFileSync(`${cachePath}.${process.pid}`, JSON.stringify(results));
    renameSync(`${cachePath}.${process.pid}`, cachePath);
  } catch {}
  console.log(report(violations, process.argv.includes("--summary")));
  if (process.argv.includes("--strict") && violations.length)
    process.exitCode = 1;
}
