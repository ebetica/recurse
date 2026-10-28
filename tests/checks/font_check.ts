/**
 * Type policy: sizes on the 10.5-20px scale, weights 400/600/700, families
 * as var(--font-sans|mono). Usage: bun tests/checks/font_check.ts; exits 1.
 */
import { readFileSync } from "node:fs";
import { trackedFiles } from "./color_check.ts";
import { cssView } from "./radius_check.ts";

export type Finding = { line: number; value: string; problem: string };

const SCALE = new Set([10.5, 11.5, 12.5, 13.5, 15, 16, 17, 20]);
const WEIGHTS = new Set([400, 600, 700]);
const ALLOW = "font-check: allow";
const FONT =
  /(?<![\w-])(font-size|font-family|font-weight|font)\s*:\s*((?:(?![\w-]+\s*:)[^;}"'`]|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)+)|\b(fontSize|fontFamily|fontWeight|font)\s*[:=]\s*(?:["'`]([^"'`]+)|(\d*\.?\d+))/gi;
const WEIGHT = /^(\d*\.?\d+|bolder|lighter)$/i;
const PX = /(?<![\w.$-])(\d*\.?\d+)px\b/;

/** Drop a font shorthand's /line-height, including calc() values. */
function dropLineHeight(value: string): string {
  const slash = value.indexOf("/");
  if (slash === -1) return value;
  let end = slash + 1;
  while (value[end] === " ") end++;
  let depth = 0;
  for (; end < value.length; end++) {
    const ch = value[end]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === " " || ch === ",")) break;
  }
  return `${value.slice(0, slash)} ${value.slice(end)}`;
}

/** Replace every var(...) call, nested parentheses included, with a space. */
function stripVars(value: string): string {
  let out = value;
  for (let at = out.indexOf("var("); at !== -1; at = out.indexOf("var(")) {
    let depth = 0;
    let end = at + 3;
    for (; end < out.length; end++) {
      if (out[end] === "(") depth++;
      else if (out[end] === ")" && --depth === 0) break;
    }
    out = `${out.slice(0, at)} ${out.slice(end + 1)}`;
  }
  return out;
}

/** The weight in a font-weight value or before a font shorthand's size. */
function weightOf(property: string, value: string): string | null {
  const tokens = value
    .replace(/!important|["'`]/gi, " ")
    .trim()
    .split(/\s+/);
  if (property.includes("weight"))
    return tokens.length === 1 && WEIGHT.test(tokens[0]!) ? tokens[0]! : null;
  for (const token of tokens) {
    if (WEIGHT.test(token)) return token;
    if (/\d|^(?:x*-?small|medium|x*-?large|larger|smaller)$/i.test(token))
      return null;
  }
  return null;
}

/** Off-policy font sizes, weights and written-out families in one file. */
export function findFonts(text: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];
  const view = cssView(text);
  for (const match of view.matchAll(FONT)) {
    const line = view.slice(0, match.index).split("\n").length;
    if (lines[line - 1]!.includes(ALLOW)) continue;
    const property = (match[1] ?? match[3]!).toLowerCase();
    const value = (match[2] ?? match[4] ?? match[5]!)
      .replace(/\s+/g, " ")
      .trim();
    const rest = stripVars(value);
    const sized = property === "font" ? dropLineHeight(rest) : rest;
    const size = /family|weight/.test(property) ? null : PX.exec(sized);
    const weight = /weight|^font$/.test(property)
      ? weightOf(property, sized)
      : null;
    if (weight && !WEIGHTS.has(Number(weight)))
      findings.push({ line, value, problem: "weight" });
    if (size && !SCALE.has(parseFloat(size[1]!)))
      findings.push({ line, value, problem: "size" });
    else if (property.includes("weight")) continue;
    else if (!property.includes("size") && /\bmonospace\b/.test(rest))
      findings.push({ line, value, problem: "mono" });
    else if (
      !property.includes("size") &&
      /\bsans-serif\b|\bsystem-ui\b|-apple-system/.test(rest)
    )
      findings.push({ line, value, problem: "sans" });
  }
  return findings;
}

/** Error lines for the given files; empty when the policy holds. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
): string[] {
  return files.flatMap(({ file, text }) =>
    findFonts(text).map(({ line, value, problem }) =>
      problem === "size"
        ? `${file}:${line}: font size ${value} is off the 10.5/11.5/12.5/13.5/15/16/17/20px scale`
        : problem === "weight"
          ? `${file}:${line}: font weight ${value} is off the 400/600/700 scale`
          : `${file}:${line}: ${problem === "mono" ? "monospace" : "sans-serif"} font ${value} should use var(--font-${problem})`,
    ),
  );
}

if (import.meta.main) {
  const errors = checkFiles(
    trackedFiles(true).map((file) => ({
      file,
      text: readFileSync(file, "utf8"),
    })),
  );
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (errors.length) process.exitCode = 1;
}
