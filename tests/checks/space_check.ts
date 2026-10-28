/**
 * Spacing policy: padding, margin and gap use the --space-N tokens.
 * Usage: bun tests/checks/space_check.ts; exits 1 on off-scale px lengths.
 */
import { readFileSync } from "node:fs";
import { trackedFiles } from "./color_check.ts";
import { cssView } from "./radius_check.ts";

export type Finding = { line: number; value: string };

/** Files still carrying raw spacing lengths, with their exact counts. */
export const PENDING: Readonly<Record<string, number>> = {};

const ALLOW = "space-check: allow";
const SPACING =
  /(?<![\w-])(?:(?:padding|margin)(?:-?(?:top|right|bottom|left|inline|block)(?:-?(?:start|end))?)?|(?:row-?|column-?)?gap)["'`]?\s*(?::\s*(?:["'`]([^"'`]*)|([^\s;}"'`](?:(?![\w-]+\s*:)[^;}"'`])*))|=\s*["'`]([^"'`]*))/gi;
const PX = /(?<![\w.])-?(\d*\.?\d+)px\b/gi;

/** The value with every var() call, nested fallbacks included, blanked. */
function withoutVars(value: string): string {
  let rest = value;
  for (let at = rest.search(/var\(/i); at >= 0; at = rest.search(/var\(/i)) {
    let end = at + 3;
    for (let depth = 0; end < rest.length; end++) {
      if (rest[end] === "(") depth++;
      else if (rest[end] === ")" && --depth === 0) break;
    }
    rest = rest.slice(0, at) + " " + rest.slice(end + 1);
  }
  return rest;
}

/** Spacing declarations with a raw length in one file's text. */
export function findSpacing(text: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];
  const view = cssView(text);
  for (const match of view.matchAll(SPACING)) {
    const line = view.slice(0, match.index).split("\n").length;
    if (lines[line - 1]!.includes(ALLOW)) continue;
    const value = (match[1] ?? match[2] ?? match[3]!).replace(/\s+/g, " ");
    const raw = [...withoutVars(value).matchAll(PX)].filter(
      ([, n]) => parseFloat(n!) !== 0 && parseFloat(n!) !== 1,
    );
    if (raw.length) findings.push({ line, value: value.trim() });
  }
  return findings;
}

/** Error lines for the given files; empty when the policy holds. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
  pending: Readonly<Record<string, number>> = PENDING,
): string[] {
  return files.flatMap(({ file, text }) => {
    const found = findSpacing(text);
    const expected = pending[file];
    if (expected === undefined)
      return found.map(
        ({ line, value }) =>
          `${file}:${line}: spacing ${value} should use --space-1 to --space-6`,
      );
    if (found.length === expected) return [];
    return [
      `${file}: ${found.length} raw spacing lengths, PENDING expects ${expected}; ${found.length > expected ? "use --space-1 to --space-6" : "lower its PENDING count"}`,
    ];
  });
}

if (import.meta.main) {
  const errors = checkFiles(
    trackedFiles().map((file) => ({ file, text: readFileSync(file, "utf8") })),
  );
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (errors.length) process.exitCode = 1;
}
