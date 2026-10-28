// Tokenizes TeX before Markdown escaping; macros remain per render. Tokenizers
// emit inert payloads; consumers finalize after content policies. KaTeX loads
// only on first math, never with the shell.
import type katexDefault from "katex";
import type { MarkedExtension, Tokens } from "marked";

type Katex = typeof katexDefault;

let library: Promise<Katex> | null = null;
let loaded: Katex | null = null;

function loadKatex(): Promise<Katex> {
  library ??= import("katex").then((mod) => {
    loaded = mod.default as unknown as Katex;
    return loaded;
  });
  return library;
}

function peekKatex(): Katex | null {
  return loaded;
}

const MAX_TEX_LENGTH = 8_192;
const MAX_RENDERED_LENGTH = 100_000;
const CLOSE_SCAN_LIMIT = MAX_TEX_LENGTH + 2;
const MATH_PLACEHOLDER_ATTR = "data-math-placeholder";

type MathToken = Tokens.Generic & {
  type: "math-block" | "math-inline";
  text: string;
  displayMode: boolean;
  literal?: boolean;
};

function escapedHtml(text: string): string {
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

type MathPlaceholder = {
  tex: string;
  displayMode: boolean;
  raw: string;
};

function parseMathPlaceholder(value: string): MathPlaceholder | undefined {
  try {
    const payload = JSON.parse(value) as Partial<MathPlaceholder>;
    return typeof payload.tex === "string" &&
      typeof payload.displayMode === "boolean" &&
      typeof payload.raw === "string"
      ? (payload as MathPlaceholder)
      : undefined;
  } catch {
    return undefined;
  }
}

export function renderMathPlaceholders(root: ParentNode): void {
  const katex = peekKatex();
  if (katex === null) return;
  fillPlaceholders(root, katex);
}

// Live-DOM pass, mirroring renderMermaidIn: paint() runs it on every render,
// so placeholders left by the synchronous pass fill as soon as KaTeX loads.
// Idempotent (filled placeholders lose their attribute); safe to re-run.
export function renderMathIn(root: ParentNode): void {
  if (peekKatex() !== null) {
    renderMathPlaceholders(root);
    return;
  }
  if (root.querySelector(`[${MATH_PLACEHOLDER_ATTR}]`) === null) return;
  void loadKatex()
    .then((katex) => {
      fillPlaceholders(root, katex);
    })
    .catch(() => {
      // Invariant: A failed chunk fetch must not pin math dead: drop the
      // rejected promise so the next paint retries instead of re-rejecting
      // forever.
      library = null;
    });
}

function fillPlaceholders(root: ParentNode, katex: Katex): void {
  for (const element of root.querySelectorAll<HTMLElement>(
    `[${MATH_PLACEHOLDER_ATTR}]`,
  )) {
    if (element.closest("code, pre")) continue;
    const encoded = element.getAttribute(MATH_PLACEHOLDER_ATTR) || "";
    const payload = parseMathPlaceholder(encoded);
    if (!payload) {
      element.replaceWith(document.createTextNode(encoded));
      continue;
    }
    const rendered = renderMath(
      katex,
      payload.tex,
      payload.displayMode,
      payload.raw,
    );
    const template = document.createElement("template");
    template.innerHTML = rendered;
    element.replaceWith(template.content.cloneNode(true));
  }
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

export function renderMath(
  katex: Katex,
  tex: string,
  displayMode: boolean,
  raw: string,
): string {
  if (tex.length > MAX_TEX_LENGTH) return escapedHtml(raw);
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      output: "html",
      throwOnError: true,
      trust: false,
      globalGroup: false,
      maxExpand: 1_000,
      maxSize: 500,
      strict: "ignore",
    });
    return html.length <= MAX_RENDERED_LENGTH ? html : escapedHtml(raw);
  } catch {
    return escapedHtml(raw);
  }
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
