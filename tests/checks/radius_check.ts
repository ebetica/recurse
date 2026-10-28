/**
 * Corner radius policy: border radii sit on one theme scale.
 * Usage: bun tests/checks/radius_check.ts; exits 1 on any other length.
 */
import { readFileSync } from "node:fs";
import { trackedFiles } from "./color_check.ts";

export type Finding = { line: number; value: string };

const SCALE = new Set(["0", "6px", "8px", "10px", "14px", "999px", "50%"]);
const ALLOW = "radius-check: allow";
const RADIUS =
  /(?<![\w-])border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius\s*:\s*([^;}"'`]+)|borderRadius\s*[:=]\s*["'`]([^"'`]+)/gi;

const LITERAL =
  String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` +
  "`(?:[^`\\\\$]|\\\\.|\\$(?!\\{))*`)";
const SET_PROPERTY = new RegExp(
  String.raw`\.setProperty\(\s*${LITERAL}\s*,\s*${LITERAL}` +
    String.raw`(?:\s*,\s*${LITERAL})?\s*,?\s*\)`,
  "g",
);

/**
 * Text as the style checks read it: comments blanked, same line breaks.
 */
export function cssView(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<!:)\/\/.*/g, (match) =>
      match.replace(/[^\n]/g, " "),
    )
    .replace(SET_PROPERTY, (match, name: string, value: string) => {
      const at = match.indexOf(value, match.indexOf(name) + name.length);
      const before = match.slice(0, at).split("\n").length - 1;
      const after = match.split("\n").length - 1 - before;
      const css = value
        .slice(1, -1)
        .replace(/\\(.)/g, "$1")
        .replace(/\s+/g, " ");
      return `${"\n".repeat(before)}.${name.slice(1, -1)}: ${css};${"\n".repeat(after)}`;
    });
}

/** Off-scale radius values in one file's text. */
export function findRadii(text: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];
  const view = cssView(text);
  for (const match of view.matchAll(RADIUS)) {
    const line = view.slice(0, match.index).split("\n").length;
    if (lines[line - 1]!.includes(ALLOW)) continue;
    const value = (match[1] ?? match[2]!).replace(/\s+/g, " ").trim();
    let rest = value.replace(/!important|\binherit\b/g, " ");
    while (/var\([^()]*\)/.test(rest))
      rest = rest.replace(/var\([^()]*\)/g, " ");
    const parts = rest.split(/[\s/]+/).filter(Boolean);
    if (parts.every((part) => SCALE.has(part))) continue;
    findings.push({ line, value });
  }
  return findings;
}

/** Error lines for the given files; empty when the policy holds. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
): string[] {
  return files.flatMap(({ file, text }) =>
    findRadii(text).map(
      ({ line, value }) =>
        `${file}:${line}: border radius ${value} is off the 6/8/10/14px, 999px, 50% scale`,
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
