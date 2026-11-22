// Register the Explorer pane and handle working-folder links in replies.
import { DRAFT } from "../state.js";
import { openFileTab, registerPane } from "../panes.js";
import { guardLeaveComments } from "../comments.js";
import { EXPLORER_ICON } from "../icons.js";
import { requestUiStatus } from "../ui-events.js";
import type { ExplorerPreview } from "../../src/web/explorer_io.js";
import {
  browserCache,
  leaveBrowser,
  navigateBrowser,
  renderBrowser,
} from "./browser.js";
import { read } from "./io.js";
import { guardViewerClose } from "./viewer.js";
import "./tab.js";

export { explorerSearchOwnsKey } from "./browser.js";

registerPane({
  id: "explorer",
  title: "Explorer",
  icon: EXPLORER_ICON,
  available: (ctx) => ctx.agentId !== DRAFT && !!ctx.node,
  navigate: navigateBrowser,
  cache: browserCache,
  leave: leaveBrowser,
  guardClose(element, preserveComments) {
    return guardViewerClose(element, preserveComments, guardLeaveComments);
  },
  render: renderBrowser,
});

/** Open a file path from a reply in the shared viewer, at any location. */
async function openFilePath(cid: string, path: string): Promise<void> {
  try {
    const preview = await read<ExplorerPreview>(
      cid,
      `/api/conversations/${encodeURIComponent(cid)}/tree/file?${new URLSearchParams({ path })}`,
      AbortSignal.timeout(30_000),
    );
    if (!preview.path) throw new Error("This path is a folder.");
    if (
      !openFileTab("explorer", JSON.stringify([preview.root, preview.path]), {
        cid,
        preview,
        paths: [preview.path],
      })
    )
      requestUiStatus(
        "File not opened. Close a file tab or finish the current comments first.",
      );
  } catch (error) {
    requestUiStatus(
      error instanceof Error ? error.message : "Could not open the file.",
    );
  }
}

document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>(
    "a[data-file-path]",
  );
  const cid = link?.dataset.fileOwner;
  if (
    !link ||
    !cid ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  void openFilePath(cid, link.dataset.filePath!);
});
