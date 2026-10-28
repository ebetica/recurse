// Desktop "type to compose" policy. Keep the keyboard classification and text
// insertion pure so the exclusions can be regression-tested without a browser
// DOM; app.ts supplies the live focus/dialog/composer state.
export interface TypeToComposeKey {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface TypeToComposeContext {
  desktop: boolean;
  composerFocused: boolean;
  composerAvailable: boolean;
  textEditorFocused: boolean;
  textSelected: boolean;
  dialogOpen: boolean;
}

// One visible Unicode code point. Shift is intentionally allowed (uppercase
// letters and punctuation); Space stays with focused buttons for native
// keyboard activation, while shortcut modifiers, dead/named keys, controls, and
// IME composition are rejected by shouldTypeToCompose.
function isVisibleTextKey(key: string): boolean {
  return (
    key !== " " && [...key].length === 1 && !/[\u0000-\u001f\u007f]/u.test(key)
  );
}

export function shouldTypeToCompose(
  event: TypeToComposeKey,
  context: TypeToComposeContext,
): boolean {
  return (
    context.desktop &&
    !context.composerFocused &&
    context.composerAvailable &&
    !context.textEditorFocused &&
    !context.textSelected &&
    !context.dialogOpen &&
    !event.defaultPrevented &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    isVisibleTextKey(event.key)
  );
}

// Inputs, textareas, selects, contenteditable regions (including an explicitly
// contenteditable="false" island), and ARIA textboxes own their keystrokes.
// Walk ancestors because key events can originate from a child of an editable
// host.
export function isTextEditorTarget(target: EventTarget | null): boolean {
  let element = target as HTMLElement | null;
  while (element && typeof element === "object") {
    const tag =
      typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (element.isContentEditable) return true;
    if (typeof element.getAttribute === "function") {
      if (element.getAttribute("contenteditable") !== null) return true;
      if (element.getAttribute("role") === "textbox") return true;
    }
    element = element.parentElement;
  }
  return false;
}

// A dialog owns even non-editing key presses made inside it. App.ts separately
// reports globally-open native/settings/inspector dialogs whose backdrop has
// focus, so typing can never jump behind a modal.
export function isDialogTarget(target: EventTarget | null): boolean {
  let element = target as HTMLElement | null;
  while (element && typeof element === "object") {
    const tag =
      typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
    if (tag === "dialog") return true;
    if (
      typeof element.getAttribute === "function" &&
      (element.getAttribute("role") === "dialog" ||
        element.getAttribute("aria-modal") === "true")
    )
      return true;
    element = element.parentElement;
  }
  return false;
}

export interface TextInsertion {
  value: string;
  caret: number;
}

// Textarea selection offsets use UTF-16 code units, so text.length is the right
// caret increment even when the initiating key is an astral Unicode character.
export function insertTextAtSelection(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  text: string,
): TextInsertion {
  const rawStart = selectionStart ?? value.length;
  const start = Math.max(0, Math.min(value.length, rawStart));
  const rawEnd = selectionEnd ?? start;
  const end = Math.max(start, Math.min(value.length, rawEnd));
  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret: start + text.length,
  };
}
