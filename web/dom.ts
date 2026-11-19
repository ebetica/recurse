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
  if (tag === "button") n.dataset.theme = "button";
  if (tag === "input" || tag === "textarea" || tag === "select")
    n.dataset.theme = "input";
  if (tag === "dialog") n.dataset.theme = "dialog";
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export const listEl = req("#agent-list");
export const msgsEl = req("#messages");
// Read-only: only thread-scroll/scroll-ledger.ts moves the thread.
export const scrollEl: Omit<HTMLElement, "scrollTop"> & {
  readonly scrollTop: number;
  scroll: never;
  scrollBy: never;
  scrollTo: never;
  scrollIntoView: never;
} = req("#scroll");
export const liveBarEl = req("#live-bar");
export const inputEl = req<HTMLTextAreaElement>("#input");
export const sendEl = req<HTMLButtonElement>("#send");
export const titleEl = req("#conv-title");
export const scrollBtn = req<HTMLButtonElement>("#scroll-btn");
export const shellOverlayEl = req("#shell-overlay");

document.body.dataset.theme = "background";
req("#sidebar").dataset.theme = "sidebar";
req("#topbar").dataset.theme = "chat-header";
scrollEl.dataset.theme = "thread";
req("#composer").dataset.theme = "composer";
inputEl.dataset.theme = "input";
sendEl.dataset.theme = "button";
