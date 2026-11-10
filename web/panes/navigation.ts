// Shared pane navigation: a neutral cursor follows visible DOM items; panes
// without an item action use their focused or largest content scroller.
// Explicit scroll input notifies the scroller before moving, including threads.
import type { PaneNavigation } from "../types.js";

/** Select a visible item, keeping native control focus as the cursor origin. */
export function paneItem(
  root: HTMLElement,
  selector: string,
  command: PaneNavigation,
): HTMLElement | null {
  const items = [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (item) => item.getClientRects().length > 0,
  );
  const focused = document.activeElement?.closest(selector);
  let index = items.findIndex((item) => item === focused);
  if (index < 0)
    index = items.findIndex((item) =>
      item.classList.contains("pane-item-cursor"),
    );
  if (command === "top") index = 0;
  else if (command === "bottom") index = items.length - 1;
  else if (command === "next" || command === "next-section") index++;
  else if (command === "previous" || command === "previous-section")
    index = index < 0 ? items.length - 1 : index - 1;
  const item = items[Math.max(0, Math.min(items.length - 1, index))];
  if (!item) return null;
  for (const previous of root.querySelectorAll(".pane-item-cursor")) {
    previous.classList.remove("pane-item-cursor");
    previous.removeAttribute("aria-current");
  }
  item.classList.add("pane-item-cursor");
  item.setAttribute("aria-current", "true");
  item.tabIndex = -1;
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest" });
  return item;
}

/** Scroll content, including the isolated document inside an Artifact frame. */
export function scrollPane(root: HTMLElement, command: PaneNavigation): void {
  if (
    !["next", "previous", "top", "bottom", "half-down", "half-up"].includes(
      command,
    )
  )
    return;
  root.dispatchEvent(new Event("recurse:reader-scroll"));
  const scrollFrame = () =>
    root
      .querySelector<HTMLIFrameElement>("iframe.artifact-embed")
      ?.contentWindow?.postMessage({ recursePaneScroll: command }, "*");
  const candidates = [root, ...root.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      element.clientHeight > 0 &&
      element.scrollHeight > element.clientHeight &&
      /auto|scroll/.test(getComputedStyle(element).overflowY),
  );
  if (command === "top" || command === "bottom") {
    scrollFrame();
    for (const element of candidates)
      element.scrollTop = command === "top" ? 0 : element.scrollHeight;
    return;
  }
  const focused = candidates
    .filter((element) => element.contains(document.activeElement))
    .at(-1);
  const element =
    focused ??
    candidates.sort(
      (a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth,
    )[0];
  // Invariant: A key moves one scroller, not both the pane and its frame.
  if (element) {
    const before = element.scrollTop;
    element.scrollTop +=
      command === "next"
        ? 40
        : command === "previous"
          ? -40
          : element.clientHeight * (command === "half-down" ? 0.5 : -0.5);
    if (element.scrollTop !== before) return;
  }
  scrollFrame();
}
