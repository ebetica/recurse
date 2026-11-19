/**
 * Stacking policy: web UI z-index is a layer token, calc(token + 1-4), 0,
 * auto or inherit. tests/checks/static.ts runs it.
 */
import { cssView } from "./radius_check.ts";

type Finding = { line: number; value: string };

const LAYERS = "raised|chrome|drawer|menu|dialog|toast";
const OK = new RegExp(
  `^(?:0|auto|inherit|var\\(--z-(?:${LAYERS})\\)|calc\\(\\s*var\\(--z-(?:${LAYERS})\\) \\+ [1-4]\\s*\\))$`,
);
const ALLOW = "z-check: allow";
const Z =
  /(?<![\w-])z-index\s*:\s*((?:[^;}"'`()]|\((?:[^()]|\([^()]*\))*\))+)|\bzIndex\s*[:=]\s*(?:["'`]([^"'`]+)|(-?[\d.][\w.]*))/gi;

/** Off-policy z-index values in one file's text. */
export function findLayers(text: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];
  const view = cssView(text);
  for (const match of view.matchAll(Z)) {
    const line = view.slice(0, match.index).split("\n").length;
    if (lines[line - 1]!.includes(ALLOW)) continue;
    const value = (match[1] ?? match[2] ?? match[3]!)
      .replace(/\s+/g, " ")
      .trim();
    const bare = value.replace(/\s*!important$/i, "");
    if (!OK.test(bare)) findings.push({ line, value });
  }
  return findings;
}

/** Error lines for the given files; empty when the policy holds. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
): string[] {
  return files.flatMap(({ file, text }) =>
    findLayers(text).map(
      ({ line, value }) =>
        `${file}:${line}: z-index ${value} is not a --z- layer token (or a token + 1 to 4)`,
    ),
  );
}
