// Ordinary HTML previews are separate documents, never mounted in the app DOM.
import { Parser, type DefaultTreeAdapterMap, type Token } from "parse5";
import { ARTIFACT_APP_FRAME_CSP } from "../src/artifacts/index.js";

const hints = new Set([
  "dns-prefetch",
  "preconnect",
  "prefetch",
  "prerender",
  "preload",
  "modulepreload",
]);

const MAX_OPEN_ELEMENTS = 128;

class HintFilter extends Parser<DefaultTreeAdapterMap> {
  private readonly parts: string[] = [];
  private end = 0;

  constructor(private readonly markup: string) {
    super({ sourceCodeLocationInfo: true, scriptingEnabled: true });
  }

  private checkBudget(): void {
    if (this.openElements.stackTop >= MAX_OPEN_ELEMENTS)
      throw new Error("HTML preview parse budget exceeded");
  }

  override onEndTag(token: Token.TagToken): void {
    this.checkBudget();
    super.onEndTag(token);
  }

  override onStartTag(token: Token.TagToken): void {
    this.checkBudget();
    const rel =
      token.tagName === "link" && token.attrs.find((a) => a.name === "rel");
    if (
      rel &&
      rel.value
        .toLowerCase()
        .split(/[\t\n\f\r ]+/)
        .some((value) => hints.has(value))
    ) {
      const { startOffset, endOffset } = token.location!;
      this.parts.push(this.markup.slice(this.end, startOffset), "<!---->");
      this.end = endOffset;
      return;
    }
    super.onStartTag(token);
  }

  filtered(): string {
    this.tokenizer.write(this.markup, true);
    return this.parts.length
      ? this.parts.join("") + this.markup.slice(this.end)
      : this.markup;
  }
}

/** Embed an ordinary HTML file in a frame sandboxed with only allow-scripts. */
export function htmlAppPreviewUrl(source: string): string {
  const markup =
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_APP_FRAME_CSP}">` +
    `<meta name="referrer" content="no-referrer">` +
    source.replace(/^\uFEFF?\s*<!doctype\s+html\s*>/i, "");
  // Invariant: Drop static hints before Chromium's speculative loader can see
  // them. A non-DOM parser preserves author markup and cannot fetch resources.
  const filtered = /<link(?=[\t\n\f\r />])/i.test(markup)
    ? new HintFilter(markup).filtered()
    : markup;
  // Invariant: The browser may tokenize differently; a remaining hint-like
  // attribute falls back to Source even when the parser treated it as text.
  if (
    /\brel[\t\n\f\r ]*=[\t\n\f\r ]*["']?[^"'<>]*\b(preconnect|dns-prefetch|prefetch|prerender|preload|modulepreload)\b/i.test(
      filtered,
    )
  )
    throw new Error("HTML preview contains a remaining resource hint");
  return `data:text/html;charset=utf-8,${encodeURIComponent(filtered)}`;
}
