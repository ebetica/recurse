// Shared keyboard ownership for the browser and its sandbox key relay. Keep
// these predicates self-contained: the relay embeds their compiled functions.
interface KeyboardElement {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  parentElement?: KeyboardElement | null;
  closest?: (selector: string) => unknown;
}

/** Only text-entry surfaces own ordinary typing, including nested children. */
export function isTextEditorTarget(target: unknown): boolean {
  let element = target as KeyboardElement | null;
  while (element && typeof element === "object") {
    const tag =
      typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (element.isContentEditable) return true;
    if (typeof element.getAttribute === "function") {
      if (element.getAttribute("contenteditable") !== null) return true;
      if (element.getAttribute("role") === "textbox") return true;
    }
    element = element.parentElement ?? null;
  }
  return false;
}

/** Keep Enter/Space activation native on non-text controls. */
export function isNativeActivationKey(key: string, target: unknown): boolean {
  if (key !== "Enter" && key !== " ") return false;
  const element = target as KeyboardElement | null;
  return !!element?.closest?.(
    "button, a[href], summary, [role=button], [role=tab], [role^=menuitem], audio[controls], video[controls]",
  );
}
