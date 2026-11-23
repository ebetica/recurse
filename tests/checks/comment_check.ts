/**
 * Check JS/TS comment policy and ratchet missing source headers.
 * CLI: --help lists modes; tests/check.sh enforces both rules.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import ts from "typescript";
import { leadingModuleHelp } from "../../src/skill_context";
import {
  HEADER_BYTES,
  isHeaderSource,
  isLicenseComment,
  sourceHeader,
} from "../../tools/code_map_headers.ts";
import { hasCommentOpener, scanTsComments } from "./ts_comments.ts";

const HEADER_BASELINE = "tests/checks/source_header_baseline.json";
const HEADER_ROOT = /^(?:src|web|tools|scripts)\//;
const checksHeader = (file: string) =>
  HEADER_ROOT.test(file) && isHeaderSource(file);
const checksComments = (file: string) =>
  /\.[cm]?[jt]sx?$/i.test(file) && !file.split("/").includes("fixtures");
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

export function checkComments(file: string, text: string): Violation[] {
  if (!hasCommentOpener(text)) return [];
  const source = ts.createSourceFile(
    file,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
    },
    true,
  );
  const nodes: ts.Node[] = [];
  const { top, ranges } = scanTsComments(source, (node) => {
    nodes.push(node);
  });
  if (ranges.length === 0) return [];
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
    ? ranges.find((c) => raw(c).startsWith("/**"))
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
    (c.pos < firstCode && isLicenseComment(content(c)));
  const ownLine = (c: ts.CommentRange) =>
    text.slice(text.lastIndexOf("\n", c.pos - 1) + 1, c.pos).trim() === "";
  const groups: ts.CommentRange[] = [];
  for (const c of ranges) {
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
  const comments = groups;
  const isTest =
    file.split("/").includes("tests") && !/^tests\/(?:checks|dev)\//.test(file);
  const kept = comments.filter((c) => !exempt(c));
  if (kept.length === 0) return [];
  const attached = new Map<number, number>();
  const bodyRanges: { start: number; end: number }[] = [];
  for (const node of nodes) {
    if (node.end <= (bodyRanges.at(-1)?.end ?? 0)) continue;
    if (
      ts.isBlock(node) ||
      (node.parent &&
        ts.isFunctionLike(node.parent) &&
        "body" in node.parent &&
        node.parent.body === node)
    )
      bodyRanges.push({ start: node.getStart(source), end: node.end });
  }
  const inBody = (c: ts.CommentRange) =>
    bodyRanges.some(({ start, end }) => c.pos >= start && c.end <= end);
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
    const c = kept[firstAtLeast(kept, start + 1, (c) => c.end) - 1];
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
      const allowed = doc || isHeader || body;
      if (!allowed)
        add(
          c.pos,
          "unexpected-comment",
          "comment is not a doc, header or body comment",
        );
      const limit = doc ?? 4;
      if (allowed && line(c.end) - line(c.pos) + 1 > limit)
        add(
          c.pos,
          "comment-lines",
          `comment exceeds ${limit} line${limit === 1 ? "" : "s"}`,
        );
    }
  }
  return violations.sort(
    (a, b) => a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

function report(violations: Violation[], summary = false): string {
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
Check tracked JS/TS files outside fixtures. Ordinary body comments need no
label. Body comments, file headers and declaration docs may span up to four
lines; data declaration docs must fit on one line. In tests only tags, tool
directives and licenses are allowed.
Source files in src/, web/, tools/ and scripts/ need a leading module comment.
On a clean run, commit any shrink to the missing-header baseline.
--strict         Fail on any finding (used by the static gate).
--summary        Print at most 50 findings, retaining full counts.
Without --strict, findings only warn.
JS/TS results are cached in the checkout's git directory, keyed by this
checker's source and each file's path and content.`);
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
        (checksComments(file) || checksHeader(file)) &&
        !lstatSync(file).isSymbolicLink(),
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
      readFileSync(new URL("./ts_comments.ts", import.meta.url), "utf8"),
      readFileSync(
        new URL("../../tools/code_map_headers.ts", import.meta.url),
        "utf8",
      ),
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
  const baselined = new Set<string>(
    existsSync(HEADER_BASELINE)
      ? JSON.parse(readFileSync(HEADER_BASELINE, "utf8"))
      : [],
  );
  const missing: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    if (
      checksHeader(file) &&
      !sourceHeader(file, bytes.toString("utf8", 0, HEADER_BYTES))
    ) {
      missing.push(file);
      if (!baselined.has(file))
        violations.push({
          file,
          line: 1,
          rule: "missing-header",
          reason: "add a leading comment describing this file's job",
        });
    }
    if (!checksComments(file)) continue;
    const text = bytes.toString("utf8");
    const key = `${version}:${Bun.hash(`${file}\0${text}`).toString(36)}`;
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
        : checkComments(file, text);
    violations.push(...results[key]);
  }
  try {
    writeFileSync(`${cachePath}.${process.pid}`, JSON.stringify(results));
    renameSync(`${cachePath}.${process.pid}`, cachePath);
  } catch {}
  if (!violations.length && missing.length < baselined.size) {
    writeFileSync(HEADER_BASELINE, `${JSON.stringify(missing, null, 2)}\n`);
    console.log(`Shrank ${HEADER_BASELINE}; commit the updated baseline.`);
  }
  console.log(report(violations, process.argv.includes("--summary")));
  if (process.argv.includes("--strict") && violations.length)
    process.exitCode = 1;
}
