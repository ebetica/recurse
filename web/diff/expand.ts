// Owns context-gap controls, not fetching or diff state. diff.ts owns
// requests/state; lazy render.ts owns library row models, so the main
// bundle does not load the diff library.
import { el } from "../dom.js";
import { CHEVRON_DOWN_ICON, CHEVRON_UP_ICON } from "../icons.js";
import type { ExpandDir, HunkExpand } from "./render.js";

// Small gaps offer one complete reveal to avoid crossing hunk boundaries.
// Larger gaps offer directions/all; step is the library reveal count.
export function gapBar(
  expand: HunkExpand,
  step: number,
  onExpand: (dir: ExpandDir) => void,
): HTMLElement {
  const bar = el("div", "diff-gap");
  bar.setAttribute("role", "group");
  bar.setAttribute(
    "aria-label",
    expand.last
      ? "Hidden lines at the end of the file"
      : "Hidden lines above this section",
  );
  const hidden = expand.hidden;
  const count = hidden > 0 ? ` (${hidden})` : "";
  const mk = (label: string, title: string, dir: ExpandDir): void => {
    const b = el("button", "diff-gap-btn", label);
    if (label === "Expand up")
      b.insertAdjacentHTML("afterbegin", CHEVRON_UP_ICON);
    if (label === "Expand down")
      b.insertAdjacentHTML(
        dir === "down" && !expand.last ? "beforeend" : "afterbegin",
        CHEVRON_DOWN_ICON,
      );
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.onclick = () => onExpand(dir);
    bar.append(b);
  };
  const lines = (n: number): string => (n === 1 ? "1 line" : n + " lines");
  if (expand.last) {
    if (hidden > step) {
      mk("Expand down", `Show the next ${step} lines at the end`, "down");
      mk("Expand all" + count, "Show the rest of the file", "all");
    } else {
      mk(
        "Expand down",
        hidden > 0
          ? `Show the final ${lines(hidden)}`
          : "Show the rest of the file",
        "down",
      );
    }
  } else if (expand.first) {
    if (hidden > step) {
      mk("Expand up", `Show ${step} more lines above`, "up");
      mk("Expand all" + count, "Show every hidden line above", "all");
    } else {
      mk(
        "Expand up",
        hidden > 0 ? `Show the ${lines(hidden)} above` : "Show lines above",
        "all",
      );
    }
  } else if (hidden > step) {
    mk("Expand up", `Show ${step} more lines above`, "up");
    mk("Expand all" + count, "Show every hidden line in this gap", "all");
    mk("Expand down", `Show ${step} more lines below`, "down");
  } else {
    mk(
      "Expand",
      hidden > 0 ? `Show ${lines(hidden)}` : "Show hidden lines",
      "all",
    );
  }
  return bar;
}
