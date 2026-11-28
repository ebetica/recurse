// Tokenize TeX before Markdown escaping and emit inert render placeholders.
import type { MarkedExtension, Tokens } from "marked";

export const MAX_TEX_LENGTH = 8_192;
const CLOSE_SCAN_LIMIT = MAX_TEX_LENGTH + 2;
export const MATH_PLACEHOLDER_ATTR = "data-math-placeholder";

type MathToken = Tokens.Generic & {
  type: "math-block" | "math-inline";
  text: string;
  displayMode: boolean;
  literal?: boolean;
};

export function escapedHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

function mathPlaceholder(math: MathToken): string {
  return `<span ${MATH_PLACEHOLDER_ATTR}="${escapedHtml(
    JSON.stringify({
      tex: math.text,
      displayMode: math.displayMode,
      raw: math.raw,
    }),
  )}"></span>`;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function closingDelimiter(
  source: string,
  start: number,
  close: string,
): number {
  const limit = Math.min(
    source.length - close.length,
    start + CLOSE_SCAN_LIMIT,
  );
  for (let i = start; i <= limit; i++) {
    if (source.startsWith(close, i) && !isEscaped(source, i)) return i;
  }
  return -1;
}

function literal(opener: string): MathToken {
  return {
    type: "math-inline",
    raw: opener,
    text: opener,
    displayMode: false,
    literal: true,
  };
}

function inlineMath(src: string): MathToken | undefined {
  const opener = src.startsWith("\\(")
    ? "\\("
    : src.startsWith("\\[")
      ? "\\["
      : undefined;
  if (!opener) return undefined;
  const close = opener === "\\(" ? "\\)" : "\\]";
  const end = closingDelimiter(src, opener.length, close);
  if (end < 0) return literal(opener);
  const raw = src.slice(0, end + close.length);
  const text = src.slice(opener.length, end);
  if (text.length > MAX_TEX_LENGTH) return literal(opener);
  return {
    type: "math-inline",
    raw,
    text,
    displayMode: opener === "\\[",
  };
}

function blockMath(src: string): MathToken | undefined {
  const opener = /^ {0,3}\\\[/.exec(src);
  if (!opener) return undefined;
  const start = opener[0].length;
  const end = closingDelimiter(src, start, "\\]");
  if (end < 0) return undefined;
  const text = src.slice(start, end);
  if (text.length > MAX_TEX_LENGTH) return undefined;
  let rawEnd = end + 2;
  while (rawEnd < src.length && src[rawEnd] === "\n") rawEnd++;
  return {
    type: "math-block",
    raw: src.slice(0, rawEnd),
    text,
    displayMode: true,
  };
}

function findInlineStart(src: string): number | undefined {
  for (let i = 0; i < src.length - 1; i++) {
    if (
      src[i] === "\\" &&
      (src[i + 1] === "(" || src[i + 1] === "[") &&
      !isEscaped(src, i)
    )
      return i;
  }
  return undefined;
}

function findBlockStart(src: string): number | undefined {
  return /^ {0,3}\\\[/m.exec(src)?.index;
}

const render = (token: Tokens.Generic): string => {
  const math = token as MathToken;
  return math.literal ? escapedHtml(math.text) : mathPlaceholder(math);
};

export const mathExtension: MarkedExtension = {
  extensions: [
    {
      name: "math-block",
      level: "block",
      start(src) {
        return findBlockStart(src);
      },
      tokenizer(src) {
        return blockMath(src);
      },
      renderer: render,
    },
    {
      name: "math-inline",
      level: "inline",
      start(src) {
        return findInlineStart(src);
      },
      tokenizer(src) {
        return inlineMath(src);
      },
      renderer: render,
    },
  ],
};
