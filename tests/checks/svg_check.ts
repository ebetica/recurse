/**
 * Icon policy: SVG markup lives only in web/icons.ts.
 * Usage: bun tests/checks/svg_check.ts; exits 1 on SVG tags outside it.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { trackedFiles, tsCode } from "./color_check.ts";

export type Finding = { line: number; markup: string };

const ALLOW = "svg-check: allow";
const ICONS = "web/icons.ts";
const SLOT = /<svg data-icon="\w+"><\/svg>/g;
const TAG =
  /<(?:svg|path|circle|ellipse|rect|line|polyline|polygon|g|use|symbol|defs|text)(?=[\s/>])[^>]*>?/gi;
const CODE =
  /createElementNS\s*\(\s*["'`]http:\/\/www\.w3\.org\/2000\/svg|\bsvg\s*`|import\s*\{[^}]*\bsvg\b[^}]*\}\s*from\s*["']lit/gi;
const DATA_URL = /data:image\/svg\+xml/gi;

/** The text with non-kept characters blanked, keeping offsets and lines. */
function keep(text: string, kept: (index: number) => boolean): string {
  return text.replace(/[^\n]/g, (c, index: number) => (kept(index) ? c : " "));
}

/** TypeScript text inside string and template literals, all else blanked. */
function literalText(source: ts.SourceFile, text: string): string {
  const inside = new Uint8Array(text.length);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node))
      inside.fill(1, node.getStart(source), node.end);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keep(text, (i) => inside[i] === 1);
}

/** Inline SVG markup in one file's text, empty icon slots excepted. */
export function findSvg(text: string, file: string): Finding[] {
  let code: string, markup: string;
  if (file.endsWith(".ts")) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    code = tsCode(source, text);
    markup = literalText(source, text);
  } else {
    code = markup = text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (m) =>
      m.replace(/[^\n]/g, " "),
    );
  }
  markup = markup.replace(SLOT, (slot) => " ".repeat(slot.length));
  const lines = text.split("\n");
  const matches = [
    ...markup.matchAll(TAG),
    ...markup.matchAll(DATA_URL),
    ...code.matchAll(CODE),
  ].sort((a, b) => a.index - b.index);
  const findings: Finding[] = [];
  for (const match of matches) {
    const line = text.slice(0, match.index).split("\n").length;
    if (lines[line - 1]!.includes(ALLOW)) continue;
    if (findings.at(-1)?.line === line) continue;
    findings.push({ line, markup: match[0].slice(0, 60) });
  }
  return findings;
}

/** Error lines for the given files; empty when the policy holds. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
): string[] {
  return files
    .filter(({ file }) => file !== ICONS)
    .flatMap(({ file, text }) =>
      findSvg(text, file).map(
        ({ line, markup }) =>
          `${file}:${line}: inline SVG ${markup} belongs in ${ICONS}`,
      ),
    );
}

if (import.meta.main) {
  const errors = checkFiles(
    trackedFiles().map((file) => ({ file, text: readFileSync(file, "utf8") })),
  );
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (errors.length) process.exitCode = 1;
}
