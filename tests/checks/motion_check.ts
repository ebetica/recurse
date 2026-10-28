/**
 * Motion policy: transition and animation durations use --motion-* tokens.
 * Usage: bun tests/checks/motion_check.ts; exits 1 on non-zero time literals.
 */
import { readFileSync } from "node:fs";
import { trackedFiles } from "./color_check.ts";
import { cssView } from "./radius_check.ts";

export type Finding = { line: number; value: string };

const ALLOW = "motion-check: allow";
const TOKENS = new Set(["fast", "move", "enter"]);
const MOTION =
  /(?<![\w-])(?:(["'`]?)((?:transition|animation)(?:Duration)?)\1\s*[:=]\s*["'`]([^"'`]*)|((?:transition|animation)(?:-duration)?)\s*:\s*([^;}"'`]+))/gi;
const TIME = /(?<![\w.-])(\d+\.?\d*|\.\d+)m?s\b/g;
const TOKEN = /var\(\s*--motion-([\w-]+)/g;

function items(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, value.slice(start)];
}

function offPolicy(name: string, value: string): boolean {
  return items(value).some((item) => {
    if (name === "animation" && /\binfinite\b/.test(item)) return false;
    for (const [, n] of item.matchAll(TIME)) if (Number(n) !== 0) return true;
    for (const [, token] of item.matchAll(TOKEN))
      if (!TOKENS.has(token!)) return true;
    return false;
  });
}

/** Off-policy motion durations in one file's text. */
export function findMotion(text: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];
  const view = cssView(text);
  for (const match of view.matchAll(MOTION)) {
    const first = view.slice(0, match.index).split("\n").length;
    const span = match[0].split("\n").length;
    const marked = lines
      .slice(first - 1, first - 1 + span)
      .some((line) => line.includes(ALLOW));
    const name = (match[2] ?? match[4]!).toLowerCase();
    const value = (match[3] ?? match[5]!).replace(/\s+/g, " ").trim();
    if (!marked && offPolicy(name, value))
      findings.push({ line: first, value });
  }
  return findings;
}

/** Error lines for the given files; empty when the policy holds. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
): string[] {
  return files.flatMap(({ file, text }) =>
    findMotion(text).map(
      ({ line, value }) =>
        `${file}:${line}: motion ${value} must use --motion-fast, --motion-move or --motion-enter`,
    ),
  );
}

if (import.meta.main) {
  const errors = checkFiles(
    trackedFiles().map((file) => ({
      file,
      text: readFileSync(file, "utf8"),
    })),
  );
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (errors.length) process.exitCode = 1;
}
