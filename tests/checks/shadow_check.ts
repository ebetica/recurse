/**
 * Shadow policy: drop shadows come from theme tokens (one elevation scale).
 * Usage: bun tests/checks/shadow_check.ts; exits 1 on non-token offsets.
 */
import { readFileSync } from "node:fs";
import { trackedFiles } from "./color_check.ts";
import { cssView } from "./radius_check.ts";

export type Finding = { line: number; value: string };

const ALLOW = "shadow-check: allow";
const SHADOW =
  /(?<![\w-])(?:box|text)-shadow\s*:\s*([^;}"'`]+)|(?:box|text)Shadow\s*[:=]\s*["'`]([^"'`]+)|(?<![\w-])drop-shadow\(((?:[^()]|\([^()]*\))*)\)/gi;
const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)[a-z]*$/i;
const LENGTH_FN = /^(?:calc|min|max|clamp)\(/i;
const ZERO_FN =
  /^(?:calc|min|max|clamp)\(\s*[+-]?(?:0+\.?0*|\.0+)[a-z]*\s*\)$/i;

/** Split a value at separator characters outside parentheses. */
function splitTop(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && separator.test(ch)) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Whether one shadow layer is offset from its element. */
function isDropShadow(layer: string): boolean {
  const offsets = splitTop(layer.replace(/!\s*important/gi, " "), /\s/)
    .filter((part) => LENGTH.test(part) || LENGTH_FN.test(part))
    .slice(0, 2);
  return offsets.some((part) =>
    LENGTH_FN.test(part) ? !ZERO_FN.test(part) : parseFloat(part) !== 0,
  );
}

/** Hand-written drop shadows in one file's text. */
export function findShadows(text: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];
  const view = cssView(text);
  for (const match of view.matchAll(SHADOW)) {
    const line = view.slice(0, match.index).split("\n").length;
    if (lines[line - 1]!.includes(ALLOW)) continue;
    const value = (match[1] ?? match[2] ?? match[3]!)
      .replace(/\s+/g, " ")
      .trim();
    if (splitTop(value, /,/).some(isDropShadow)) findings.push({ line, value });
  }
  return findings;
}

/** Error lines for the given files; empty when the policy holds. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
): string[] {
  return files.flatMap(({ file, text }) =>
    findShadows(text).map(
      ({ line, value }) =>
        `${file}:${line}: drop shadow ${value} should use --expanded-lift, --menu-shadow or --dialog-shadow`,
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
