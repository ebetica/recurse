// File-tab keys, availability probes and prepared previews for Explorer.
import { html, render } from "lit";
import { DRAFT } from "../state.js";
import { syncPanes } from "../panes.js";
import { decodeFileTabKey, registerFileTabSource } from "../panes/index.js";
import { ATTACHMENT_FILE_ICON } from "../icons.js";
import { commentKey, comments } from "../artifacts/index.js";
import type { PaneContext, PaneNavigation } from "../types.js";
import type { ExplorerPreview } from "../../src/web/explorer_io.js";
import { focusBrowser, inlineFileIsOpen, MAX_ROWS } from "./browser.js";
import { absolutePath, read } from "./io.js";
import {
  backToFiles,
  guardViewerClose,
  hasUnsaved,
  leaveViewer,
  navigateFile,
  phone,
  seedTab,
  viewerAt,
  viewerCache,
  viewerFor,
  visiblePath,
} from "./viewer.js";

function navigate(element: HTMLElement, command: PaneNavigation): boolean {
  const view = viewerAt(element);
  if (!view || view.disposed || phone.matches) return false;
  if (command === "filter" || command === "back") {
    backToFiles(view);
    focusBrowser(command, view.file);
    return true;
  }
  return navigateFile(view, command);
}

registerFileTabSource("explorer", (key, id) => {
  const parts = decodeFileTabKey(key, 2);
  if (!parts) return null;
  const [root, path] = parts as [string, string];
  if (
    !/^(\/|[A-Za-z]:[\\/])/.test(root) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.includes("\\")
  )
    return null;
  type Prepared = {
    cid: string;
    controller: AbortController;
    preview?: ExplorerPreview;
    exists?: boolean;
  };
  let prepared: Prepared | undefined;
  let paths = [path];
  const showingStatus = new WeakSet<HTMLElement>();
  const release = (): void => {
    prepared?.controller.abort();
    prepared = undefined;
  };
  const paintTab = (element: HTMLElement, ctx: PaneContext): void => {
    const current = prepared?.cid === ctx.agentId ? prepared : undefined;
    if (!current?.exists || !current.preview) {
      showingStatus.add(element);
      render(
        html`<p class="explorer-status" role="status">
          ${current?.exists === false ? "File unavailable." : "Loading file…"}
        </p>`,
        element,
      );
      return;
    }
    showingStatus.delete(element);
    const preview = current.preview;
    const view = viewerFor(element, ctx.agentId, {
      root: () => root,
      tabId: id,
    });
    seedTab(view, path, paths, preview);
  };
  return {
    id,
    title: visiblePath(path.split("/").at(-1)!),
    icon: ATTACHMENT_FILE_ICON,
    navigate,
    cache: {
      ...viewerCache,
      key({ agentId }) {
        const key = commentKey(agentId, `explorer:${absolutePath(root, path)}`);
        return (key && comments.get(key)?.size) ||
          hasUnsaved(agentId, absolutePath(root, path))
          ? agentId
          : null;
      },
    },
    leave: leaveViewer,
    release,
    guardClose: guardViewerClose,
    visit(agentId) {
      if (prepared && prepared.cid !== agentId) release();
    },
    prepare(value) {
      const seed = value as {
        cid: string;
        preview: ExplorerPreview;
        paths: string[];
      };
      if (
        !seed?.cid ||
        seed.preview?.root !== root ||
        seed.preview.path !== path
      )
        return;
      release();
      paths = seed.paths.slice(0, MAX_ROWS);
      prepared = {
        cid: seed.cid,
        controller: new AbortController(),
        preview: seed.preview,
        exists: true,
      };
    },
    available(ctx: PaneContext) {
      if (ctx.agentId === DRAFT || !ctx.node) return false;
      if (inlineFileIsOpen(ctx.agentId, path, root)) return false;
      if (!prepared || prepared.cid !== ctx.agentId) {
        release();
        const attempt: Prepared = {
          cid: ctx.agentId,
          controller: new AbortController(),
        };
        prepared = attempt;
        const url = `/api/conversations/${encodeURIComponent(ctx.agentId)}/tree/file?${new URLSearchParams({ path: absolutePath(root, path) })}`;
        void read<ExplorerPreview>(ctx.agentId, url, attempt.controller.signal)
          .then((preview) => {
            if (prepared !== attempt || attempt.controller.signal.aborted)
              return;
            attempt.preview = preview;
            attempt.exists =
              preview.root === root &&
              preview.path === path &&
              preview.kind !== "missing";
          })
          .catch(() => {
            if (prepared === attempt) attempt.exists = false;
          })
          .finally(() => {
            if (prepared === attempt && !attempt.controller.signal.aborted)
              syncPanes();
          });
      }
      return prepared.exists;
    },
    render: paintTab,
    refresh(element, ctx) {
      // Keep a retained viewer's source, comments and preview mode on reopen.
      if (
        showingStatus.has(element) ||
        (prepared?.cid === ctx.agentId && prepared.exists === false)
      )
        paintTab(element, ctx);
    },
  };
});
