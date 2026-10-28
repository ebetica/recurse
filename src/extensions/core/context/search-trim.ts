// Search head/tail trimming shares its bounds with core/shells/trim.ts; keep
// both algorithms in sync.

export const DEFAULT_BYTE_BUDGET = 50 * 1024;
const DEFAULT_MAX_LINES = 2_000;
const DEFAULT_MAX_LINE_LEN = 500;

export interface TrimOptions {
  byteBudget?: number;
  maxLines?: number;
  maxLineLen?: number;
}

export interface TrimResult {
  text: string;
  trimmed: boolean;
  omittedLines: number;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function shortenLine(
  line: string,
  limit: number,
): { text: string; trimmed: boolean } {
  const chars = Array.from(line);
  if (chars.length <= limit) return { text: line, trimmed: false };
  const dropped = chars.length - limit;
  return {
    text: `${chars.slice(0, limit).join("")} … line truncated (${dropped} chars)`,
    trimmed: true,
  };
}

function takeHead(lines: string[], budget: number, limit: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = bytes(line) + 1;
    if (kept.length >= limit || (kept.length > 0 && used + cost > budget))
      break;
    kept.push(line);
    used += cost;
  }
  return kept;
}

function takeTail(lines: string[], budget: number, limit: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const cost = bytes(line) + 1;
    if (kept.length >= limit || (kept.length > 0 && used + cost > budget))
      break;
    kept.unshift(line);
    used += cost;
  }
  return kept;
}

// Keep readable head/tail text and a search-specific omission marker.
export function trimOutput(
  text: string,
  options: TrimOptions = {},
): TrimResult {
  if (typeof text !== "string") text = text == null ? "" : String(text);
  if (!text) return { text: "", trimmed: false, omittedLines: 0 };
  const budget = Math.max(
    64,
    Number.isFinite(options.byteBudget)
      ? options.byteBudget!
      : DEFAULT_BYTE_BUDGET,
  );
  const maxLines = Math.min(
    DEFAULT_MAX_LINES,
    Math.max(
      1,
      Math.floor(
        Number.isFinite(options.maxLines)
          ? options.maxLines!
          : DEFAULT_MAX_LINES,
      ),
    ),
  );
  const maxLineLen = Math.max(
    16,
    Number.isFinite(options.maxLineLen)
      ? options.maxLineLen!
      : DEFAULT_MAX_LINE_LEN,
  );
  let lineTrimmed = false;
  const lines = text.split("\n").map((line) => {
    const result = shortenLine(line, maxLineLen);
    lineTrimmed ||= result.trimmed;
    return result.text;
  });
  const joined = lines.join("\n");
  if (lines.length <= maxLines && bytes(joined) <= budget) {
    return { text: joined, trimmed: lineTrimmed, omittedLines: 0 };
  }

  const head = takeHead(lines, Math.floor(budget / 2), Math.ceil(maxLines / 2));
  const tail = takeTail(
    lines,
    budget - Math.floor(budget / 2),
    Math.floor(maxLines / 2),
  );
  if (head.length + tail.length >= lines.length) {
    return { text: joined, trimmed: lineTrimmed, omittedLines: 0 };
  }
  const omittedLines = lines.length - head.length - tail.length;
  const keptBytes = bytes(head.join("\n")) + bytes(tail.join("\n")) + 2;
  const omittedBytes = Math.max(0, bytes(joined) - keptBytes);
  const marker = `... ${omittedLines} lines + ${omittedBytes} bytes truncated — narrow the pattern, add path constraints, or use the cursor to continue`;
  return {
    text: `${head.join("\n")}\n${marker}\n${tail.join("\n")}`,
    trimmed: true,
    omittedLines,
  };
}
