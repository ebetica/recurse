// Fill inert Markdown math placeholders. KaTeX loads only on first math.
import type katexDefault from "katex";
import {
  escapedHtml,
  MATH_PLACEHOLDER_ATTR,
  MAX_TEX_LENGTH,
} from "../src/markdown_math.js";

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

const MAX_RENDERED_LENGTH = 100_000;

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
