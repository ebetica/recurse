// On-the-fly mermaid rendering. `mermaid` is a large dependency, so it loads
// through a dynamic import — the main bundle never pays for it, and the
// diagram module is only fetched when a ```mermaid fence first appears.

// Recognizes bare and MIME-style Mermaid fence language names.
const LANG_RE =
  /^(?:mermaid|text-mermaid|application-mermaid|text\/mermaid|application\/mermaid)$/i;

export const isMermaidLang = (className: string | undefined): boolean => {
  const lang = (className || "")
    .split(/\s+/)
    .find((c) => c.startsWith("language-"))
    ?.slice("language-".length);
  return LANG_RE.test(lang || "");
};

type Mermaid = (typeof import("mermaid"))["default"];

let library: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  library ??= import("mermaid").then((mod) => mod.default);
  return library;
}

// Serializes Mermaid renders to protect shared IDs and DOM measurements.
let queue: Promise<unknown> = Promise.resolve();

// Short one-line summary of a mermaid render failure for the error note.
export function mermaidErrorMessage(err: unknown): string {
  const first = String((err as Error)?.message || err)
    .split("\n", 1)[0]
    .trim();
  return first.length > 160 ? first.slice(0, 157) + "\u2026" : first;
}

// Mermaid appends its error diagram to document.body (the `d<id>` element)
// unless suppressErrorRendering is set; sweep any stray node for this
// render id so a failed render can never leave layout-breaking SVG behind.
function removeStrayMermaidErrorNodes(id: string): void {
  for (const strayId of ["d" + id, id]) {
    document.getElementById(strayId)?.remove();
  }
}

function renderOne(host: HTMLElement, code: string): Promise<void> {
  const id = "mmd-" + Math.random().toString(36).slice(2);
  host.dataset.renderId = id;
  const chain = queue
    .then(() => loadMermaid())
    .then((m) => {
      const style = getComputedStyle(document.documentElement);
      const token = (name: string) =>
        style.getPropertyValue(`--${name}`).trim();
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // Invariant: Parse failures must not append broken SVGs to body.
        suppressErrorRendering: true,
        theme: "base",
        themeVariables: {
          darkMode: style.colorScheme === "dark",
          background: token("bg"),
          primaryColor: token("panel-2"),
          primaryTextColor: token("text"),
          primaryBorderColor: token("border-strong"),
          secondaryColor: token("user-bubble"),
          tertiaryColor: token("panel"),
          lineColor: token("muted"),
          textColor: token("text"),
        },
      });
      return m.render(id, code);
    });
  queue = chain.catch(() => {});
  return chain
    .then(({ svg }) => {
      if (host.dataset.renderId !== id) return;
      host.innerHTML = svg;
      host.classList.add("mermaid-done");
    })
    .catch((err) => {
      removeStrayMermaidErrorNodes(id);
      if (host.dataset.renderId !== id) return;
      host.classList.add("mermaid-error");
      const note = document.createElement("code");
      note.textContent = mermaidErrorMessage(err);
      // Invariant: Keep the diagram source readable inside the host so the
      // content survives a syntax error (textContent keeps it injection-safe).
      const pre = document.createElement("pre");
      const src = document.createElement("code");
      src.textContent = code;
      pre.appendChild(src);
      host.replaceChildren(note, pre);
    });
}

function repaintDiagrams(): void {
  for (const host of document.querySelectorAll<HTMLElement>(
    ".mermaid-host[data-mermaid-source]",
  ))
    void renderOne(host, host.dataset.mermaidSource!);
}

if (typeof window !== "undefined") {
  window.addEventListener("recurse:theme-changed", repaintDiagrams);
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", repaintDiagrams);
}

/** Replace every `language-mermaid` code block under `root` with a diagram. */
export function renderMermaidIn(root: ParentNode): void {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code")].filter(
    (el) =>
      isMermaidLang([...el.classList].find((c) => c.startsWith("language-"))),
  );
  for (const el of blocks) {
    const pre = el.parentElement!;
    const code = (el.textContent || "").trim();
    if (!code) continue;
    const host = document.createElement("div");
    host.className = "mermaid-host";
    host.dataset.mermaidSource = code;
    host.textContent = "Diagram…";
    pre.replaceWith(host);
    void renderOne(host, code);
  }
}
