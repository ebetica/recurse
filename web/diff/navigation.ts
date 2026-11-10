// Changes adapts shared pane navigation to file headings and their existing
// expand controls. Filtering is local and reapplied after keyed row updates.
import { html } from "lit";
import { paneItem } from "../panes/navigation.js";
import { copyText } from "../tool_details.js";
import type { PaneNavigation } from "../types.js";

export function filterChanges(root: HTMLElement): void {
  const query =
    root
      .querySelector<HTMLInputElement>(".diff-filter")
      ?.value.trim()
      .toLowerCase() ?? "";
  let matches = false;
  for (const row of root.querySelectorAll<HTMLElement>(".diff-file")) {
    row.hidden = !row
      .querySelector(".diff-path")
      ?.textContent?.toLowerCase()
      .includes(query);
    matches ||= !row.hidden;
  }
  const status = root.querySelector(".diff-navigation-status");
  if (status)
    status.textContent = query && !matches ? "No matching files." : "";
}

export function changesFilter() {
  return html`<div class="diff-filter-bar">
    <input
      class="diff-filter"
      type="search"
      aria-label="Filter files"
      placeholder="Filter files"
      @input=${(event: Event) =>
        filterChanges(
          (event.currentTarget as HTMLElement).closest<HTMLElement>(
            ".pane-body",
          )!,
        )}
    />
    <span class="diff-navigation-status" role="status"></span>
  </div>`;
}

export function navigateChanges(
  root: HTMLElement,
  command: PaneNavigation,
): boolean {
  if (command === "filter") {
    root.querySelector<HTMLInputElement>(".diff-filter")?.focus();
    return true;
  }
  if (command === "half-down" || command === "half-up") return false;
  const item = paneItem(root, ".diff-file-head", command);
  if (!item) return false;
  const toggle = item.querySelector<HTMLButtonElement>(".diff-file-toggle");
  if (
    (command === "open" && toggle?.getAttribute("aria-expanded") === "false") ||
    (command === "back" && toggle?.getAttribute("aria-expanded") === "true")
  )
    toggle.click();
  if (command === "copy") {
    const path = item.querySelector(".diff-path")?.textContent ?? "";
    void copyText(path).then((copied) => {
      const status = root.querySelector(".diff-navigation-status");
      if (status)
        status.textContent = copied
          ? "Path copied."
          : "Could not copy. Select and copy the path.";
      if (item.isConnected && document.activeElement === document.body)
        item.focus({ preventScroll: true });
    });
  }
  return command !== "top" && command !== "bottom";
}
