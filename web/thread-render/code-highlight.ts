// Reply code blocks naming a language get Explorer's worker-tokenized colours,
// only once near the viewport and the browser is idle after painting, so
// opening a conversation never waits on them. One shared worker tokenizes.
// A block whose text keeps changing (streaming) is highlighted once it settles.
import { highlightSource } from "../source-preview.js";

const SETTLE_MS = 400;
const near = new WeakSet<Element>();
const observed = new Set<Element>();
const settling = new Map<Element, ReturnType<typeof setTimeout>>();
let observer: IntersectionObserver | undefined;

// The tokenizer picks its grammar from a file extension, so a fence language
// becomes the extension of a stand-in file name.
function highlight(code: Element): void {
  settling.delete(code);
  if (!code.isConnected) return;
  const lang = [...code.classList]
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length);
  if (lang) highlightSource(code, `snippet.${lang}`);
}

function settle(code: Element): void {
  clearTimeout(settling.get(code));
  settling.set(
    code,
    setTimeout(() => highlight(code), SETTLE_MS),
  );
}

/** Highlight reply code blocks in `root` that are, or later come, near view. */
export function highlightCodeIn(root: ParentNode): void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer!.unobserve(entry.target);
        observed.delete(entry.target);
        near.add(entry.target);
        const code = entry.target;
        if ("requestIdleCallback" in window)
          requestIdleCallback(() => highlight(code), { timeout: 2000 });
        else setTimeout(() => highlight(code));
      }
    },
    { rootMargin: "600px 0px" },
  );
  for (const code of observed)
    if (!code.isConnected) {
      observer.unobserve(code);
      observed.delete(code);
    }
  for (const [code, timer] of settling)
    if (!code.isConnected) {
      clearTimeout(timer);
      settling.delete(code);
    }
  for (const code of root.querySelectorAll(
    ".code-wrap > pre > code[class*='language-']:not(.language-mermaid)",
  )) {
    if (near.has(code)) settle(code);
    else if (!observed.has(code)) {
      observed.add(code);
      observer.observe(code);
    }
  }
}
