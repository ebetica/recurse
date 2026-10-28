import type { KeyTarget } from "./keymap.js";

/** Prefer a selection offer, then the focused pane, other panes, and thread. */
export function visibleCommentControl():
  | HTMLButtonElement
  | HTMLTextAreaElement
  | null {
  const visible = (element: HTMLElement): boolean => {
    if (
      !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    )
      return false;
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return !!top && element.contains(top);
  };
  const modal = Array.from(
    document.querySelectorAll<HTMLElement>('dialog:modal, [aria-modal="true"]'),
  )
    .filter(visible)
    .at(-1);
  const controls = Array.from(
    document.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
      ".selection-comment-offer, .report-comment-popover textarea, .diff-add-comment",
    ),
  ).filter(
    (control) =>
      !control.disabled &&
      visible(control) &&
      (!modal ||
        modal.contains(control) ||
        (modal.matches(".pane-col") &&
          control.closest(".report-comment-popover"))),
  );
  const focusedPane = document.activeElement?.closest(".pane-col");
  const rank = (control: HTMLElement): number =>
    control.matches(".selection-comment-offer")
      ? 0
      : control.matches("textarea")
        ? 1
        : focusedPane?.contains(control)
          ? 2
          : control.closest(".pane-col")
            ? 3
            : 4;
  return controls.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export interface FocusLayers {
  composer: boolean;
  rename: boolean;
  finder: boolean;
  insidePane: boolean;
  textEditor: boolean;
  interactiveControl: boolean;
  modalLayer: boolean;
}

// Keep this ordering pure and tested: an ordinary desktop pane is not globally
// modal. Its chrome gets Pane mode while editors within it retain native keys.
export function classifyKeyTarget(layers: FocusLayers): KeyTarget {
  if (layers.finder) return "finder";
  if (layers.modalLayer) return "dialog";
  if (layers.insidePane) return layers.textEditor ? "editor" : "pane";
  if (layers.composer) return "composer";
  if (layers.rename) return "rename";
  if (layers.textEditor) return "editor";
  if (layers.interactiveControl) return "control";
  return "chrome";
}
