// Total, Unicode-safe output trimming: bound head/tail by line/byte budgets,
// drop whole middle lines and truncate oversized individual lines. Bad input
// degrades without throwing.

export interface TrimOptions {
  /** Max lines kept (split between head and tail). Capped at 2000. */
  maxLines?: number;
  /** Approximate total byte budget for the returned text. */
  byteBudget?: number;
  /** Any single line longer than this many characters is truncated. */
  maxLineLen?: number;
  /** Path to the full log, referenced in the omission marker. */
  logPath?: string;
}

export interface TrimResult {
  /** The trimmed text. */
  text: string;
  /** Whether any content was removed (middle omission or line truncation). */
  trimmed: boolean;
  /** Number of whole lines dropped from the middle, if any. */
  omittedLines: number;
}

export const DEFAULT_BYTE_BUDGET = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_LINE_LEN = 500;

/** UTF-8 byte length of a string, guarding against non-string input. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// Clamp lines to 1..2000; nonfinite input uses the fallback.
export function clampLineLimit(
  value: number | undefined,
  fallback = DEFAULT_MAX_LINES,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(DEFAULT_MAX_LINES, Math.max(1, Math.floor(value)));
}

// Numbers-only omission marker plus registry-owned log path and Read hint;
// never log content.
export function truncationMarker(
  omittedLines: number,
  omittedBytes: number,
  logPath: string | undefined,
  headLines: number,
): string {
  const loc = logPath ? ` — full log: ${logPath}` : "";
  return `... ${omittedLines} lines + ${omittedBytes} bytes truncated${loc} — Read offset=${headLines + 1} limit=${omittedLines} to continue`;
}

// Byte omission marker when the total line count is unknown.
export function byteTruncationMarker(
  omittedBytes: number,
  logPath: string | undefined,
  headLines: number,
  limit = 200,
): string {
  const loc = logPath ? ` — full log: ${logPath}` : "";
  return `... ~${omittedBytes} bytes truncated${loc} — Read offset=${headLines + 1} limit=${limit} to continue`;
}

// Truncate by Unicode code point, adding the dropped-character count.
function truncateLine(
  line: string,
  maxLineLen: number,
): { line: string; truncated: boolean } {
  if (line.length <= maxLineLen && byteLen(line) <= maxLineLen) {
    return { line, truncated: false };
  }
  const chars = Array.from(line);
  if (chars.length <= maxLineLen) {
    return { line, truncated: false };
  }
  const dropped = chars.length - maxLineLen;
  const kept = chars.slice(0, maxLineLen).join("");
  return {
    line: `${kept} … line truncated (${dropped} chars)`,
    truncated: true,
  };
}

// Take whole head lines within count/byte budgets, always one unless input is
// empty.
function takeHead(
  lines: string[],
  budgetBytes: number,
  maxCount: number,
): { taken: string[]; count: number } {
  const taken: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (taken.length >= maxCount) break;
    const cost = byteLen(line) + 1;
    if (taken.length > 0 && used + cost > budgetBytes) break;
    taken.push(line);
    used += cost;
  }
  return { taken, count: taken.length };
}

/** Symmetric to `takeHead`, taking whole lines from the end. */
function takeTail(
  lines: string[],
  budgetBytes: number,
  maxCount: number,
): { taken: string[]; count: number } {
  const taken: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (taken.length >= maxCount) break;
    const line = lines[i];
    const cost = byteLen(line) + 1;
    if (taken.length > 0 && used + cost > budgetBytes) break;
    taken.unshift(line);
    used += cost;
  }
  return { taken, count: taken.length };
}

// Total string trimming by lines/approximate bytes with head/tail and omission
// marker. Truncate oversized lines; bad input never throws.
export function trimOutput(
  text: string,
  options: TrimOptions = {},
): TrimResult {
  const byteBudget = Math.max(64, options.byteBudget ?? DEFAULT_BYTE_BUDGET);
  const maxLines = clampLineLimit(options.maxLines);
  const maxLineLen = Math.max(16, options.maxLineLen ?? DEFAULT_MAX_LINE_LEN);
  const logPath = options.logPath;

  if (typeof text !== "string") {
    text = text == null ? "" : String(text);
  }
  if (text.length === 0) {
    return { text: "", trimmed: false, omittedLines: 0 };
  }

  const rawLines = text.split("\n");
  let anyLineTruncated = false;
  const lines = rawLines.map((l) => {
    const r = truncateLine(l, maxLineLen);
    if (r.truncated) anyLineTruncated = true;
    return r.line;
  });

  const joined = lines.join("\n");
  if (lines.length <= maxLines && byteLen(joined) <= byteBudget) {
    return { text: joined, trimmed: anyLineTruncated, omittedLines: 0 };
  }

  const headTarget = Math.ceil(maxLines / 2);
  const tailTarget = maxLines - headTarget;
  const half = Math.floor(byteBudget / 2);
  const head = takeHead(lines, half, headTarget);
  const tail = takeTail(lines, byteBudget - half, tailTarget);

  if (head.count + tail.count >= lines.length) {
    return { text: joined, trimmed: anyLineTruncated, omittedLines: 0 };
  }

  const omitted = lines.length - head.count - tail.count;
  const headText = head.taken.join("\n");
  const tailText = tail.taken.join("\n");
  const totalBytes = byteLen(joined);
  const keptBytes = byteLen(headText) + byteLen(tailText) + 2;
  const omittedBytes = Math.max(0, totalBytes - keptBytes);
  const marker = truncationMarker(omitted, omittedBytes, logPath, head.count);
  return {
    text: `${headText}\n${marker}\n${tailText}`,
    trimmed: true,
    omittedLines: omitted,
  };
}
