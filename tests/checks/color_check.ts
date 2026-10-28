/**
 * Colour policy: web UI colours come from theme tokens (var(--...)).
 * Usage: bun tests/checks/color_check.ts; exits 1 on literal colours.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

export type Finding = { line: number; literal: string };

/** Files still carrying colour literals, with their exact counts. */
export const PENDING: Readonly<Record<string, number>> = {};

const TOKEN_FILE = "web/theme.css";
const ALLOW = "color-check: allow";
const NAMES =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen";
const NAMED = new RegExp(
  `(?<![\\w-])(?:${NAMES.replaceAll(" ", "|")})(?![\\w-])`,
  "gi",
);
const LITERAL =
  /(?<![&\w#]|url\(\s*["']?)#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const COLOR_PROPERTY =
  /^(?:--|color$|background|border|outline|box-shadow|text-shadow|text-decoration|column-rule|caret-color|accent-color|fill$|stroke$|stop-color|flood-color|lighting-color|scrollbar-color)/i;
const DECLARATION = /(?<=(?:^|[{;])\s*)(--[\w-]+|-?[a-z][\w-]*)\s*:([^;{}]*)/gi;
const STYLE_BLOCK = /(<style[^>]*>)([\s\S]*?)<\/style>/gi;
const STYLE_ATTRIBUTE = /(\bstyle\s*=\s*(["']))([\s\S]*?)\2/gi;
const COLOR_ATTRIBUTE =
  /(\b(?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*(["']))([^"']*)\2/gi;

type Hit = { index: number; literal: string };

/** Replace matched text with spaces, keeping offsets and line breaks. */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => match.replace(/[^\n]/g, " "));
}

function scan(text: string, pattern: RegExp, offset: number, hits: Hit[]) {
  for (const match of text.matchAll(pattern))
    hits.push({ index: offset + match.index, literal: match[0] });
}

/** Colours in CSS declaration values (not selectors, comments, strings). */
function scanCss(css: string, at: number, hits: Hit[]) {
  const code = blank(css, /\/\*[\s\S]*?\*\/|"[^"\n]*"|'[^'\n]*'/g);
  for (const match of code.matchAll(DECLARATION)) {
    const [whole, property, value] = match as unknown as string[];
    const start = at + match.index + whole!.length - value!.length;
    scan(value!, LITERAL, start, hits);
    if (COLOR_PROPERTY.test(property!)) scan(value!, NAMED, start, hits);
  }
}

/** Colours in <style>, style="..." and colour attributes; blanks the CSS. */
function scanMarkup(text: string, hits: Hit[]) {
  for (const region of [STYLE_BLOCK, STYLE_ATTRIBUTE])
    for (const match of text.matchAll(region)) {
      const body = match.at(-1)!;
      const start = match.index + match[1]!.length;
      scanCss(body, start, hits);
      text =
        text.slice(0, start) +
        " ".repeat(body.length) +
        text.slice(start + body.length);
    }
  for (const match of text.matchAll(COLOR_ATTRIBUTE))
    scan(match[3]!, NAMED, match.index + match[1]!.length, hits);
  return text;
}

/** TypeScript source with its comments blanked. */
export function tsCode(source: ts.SourceFile, text: string): string {
  const chars = text.split("");
  const visit = (node: ts.Node) => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ])
      for (let i = range.pos; i < range.end; i++)
        if (chars[i] !== "\n") chars[i] = " ";
    node.getChildren(source).forEach(visit);
  };
  visit(source);
  return chars.join("");
}

const UNIT =
  /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(\r?\n)|([\s\S]))|[\s\S]/gi;
const NAMED_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

/** A literal's raw text decoded, with each decoded character's source index. */
function decode(raw: string, at: number) {
  let text = "";
  const where: number[] = [];
  for (const m of raw.matchAll(UNIT)) {
    const hex = m[1] ?? m[2] ?? m[3];
    const char = hex
      ? String.fromCodePoint(parseInt(hex, 16))
      : m[4] !== undefined
        ? ""
        : m[5] !== undefined
          ? (NAMED_ESCAPES[m[5]] ?? m[5])
          : m[0];
    text += char;
    for (let i = 0; i < char.length; i++) where.push(at + m.index);
  }
  return { text, where };
}

/**
 * Named colours in plain TypeScript string style values (color: "red").
 */
function scanStyleValues(source: ts.SourceFile, hits: Hit[]) {
  const check = (name?: ts.Node, value?: ts.Node) => {
    if (!name || !value || !ts.isStringLiteralLike(value)) return;
    if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return;
    const css = ts.isIdentifier(name)
      ? name.text.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      : name.text;
    if (!COLOR_PROPERTY.test(css)) return;
    const at = value.getStart(source) + 1;
    const { text, where } = decode(source.text.slice(at, value.end - 1), at);
    for (const match of text.matchAll(NAMED))
      hits.push({ index: where[match.index]!, literal: match[0] });
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) check(node.name, node.initializer);
    else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    )
      check(node.left.name, node.right);
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setProperty"
    )
      check(node.arguments[0], node.arguments[1]);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** Colour literals in one file's text. */
export function findColors(file: string, text: string): Finding[] {
  const hits: Hit[] = [];
  if (file.endsWith(".css")) scanCss(text, 0, hits);
  else if (file.endsWith(".ts")) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    scan(tsCode(source, text), LITERAL, 0, hits);
    scanStyleValues(source, hits);
  } else {
    const markup = blank(text, /<!--[\s\S]*?-->/g);
    scan(scanMarkup(markup, hits), LITERAL, 0, hits);
  }
  const lines = text.split("\n");
  return hits
    .map(({ index, literal }) => ({
      line: text.slice(0, index).split("\n").length,
      literal,
    }))
    .filter((finding) => !lines[finding.line - 1]!.includes(ALLOW))
    .sort((a, b) => a.line - b.line);
}

/** Error lines for the given files; empty when the policy holds. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
  pending: Readonly<Record<string, number>> = PENDING,
): string[] {
  const errors: string[] = [];
  for (const { file, text } of files) {
    if (file === TOKEN_FILE) continue;
    const findings = findColors(file, text);
    const allowed = pending[file];
    if (allowed === undefined)
      for (const { line, literal } of findings)
        errors.push(
          `${file}:${line}: colour literal ${literal}; use a token from ${TOKEN_FILE}`,
        );
    else if (findings.length !== allowed)
      errors.push(
        `${file}: ${findings.length} colour literals but PENDING lists ${allowed}; use tokens from ${TOKEN_FILE} and keep the entry equal to the count`,
      );
  }
  return errors;
}

/** Tracked web UI files; withServer adds src/ TypeScript but not themes. */
export function trackedFiles(withServer = false): string[] {
  const roots = withServer
    ? ["web/index.html", "web", "src"]
    : ["web/index.html", "web"];
  const listed = Bun.spawnSync(["git", "ls-files", "-z", ...roots]);
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  return listed.stdout
    .toString()
    .split("\0")
    .filter((file) => /\.(?:css|html|ts)$/.test(file))
    .filter((file) => !/^web\/(?:dist|vendor)\//.test(file))
    .filter((file) => file !== "src/themes.ts");
}

if (import.meta.main) {
  const files = trackedFiles(true);
  const texts = files.map((file) => ({
    file,
    text: readFileSync(file, "utf8"),
  }));
  const errors = checkFiles(texts);
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (errors.length) process.exitCode = 1;
}
