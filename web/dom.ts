// Shared long-lived shell handles; modules query their private nodes locally.
export const $ = <T extends Element = HTMLElement>(s: string): T | null =>
  document.querySelector<T>(s);

// Required shell lookup asserts programming errors once, not at every use.
const req = <T extends Element = HTMLElement>(s: string): T => {
  const el = document.querySelector<T>(s);
  if (!el) throw new Error(`missing required element: ${s}`);
  return el;
};

// One-liner typed element factory: `el("button", "cls", "text")`. Returns the
// precise element type for the tag, so callers get `.value`/`.href`/etc.
// without a cast. Shared so the panes that build DOM by hand don't each
// re-declare it.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export const listEl = req("#agent-list");
export const msgsEl = req("#messages");
export const scrollEl = req("#scroll");
export const inputEl = req<HTMLTextAreaElement>("#input");
export const sendEl = req<HTMLButtonElement>("#send");
export const titleEl = req("#conv-title");
export const scrollBtn = req<HTMLButtonElement>("#scroll-btn");
export const shellOverlayEl = req("#shell-overlay");
