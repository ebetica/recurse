// Version-pinned Artifact siblings share the image, PDF and offline document
// viewers. Saved layouts can still reopen old Markdown tabs. Descriptors contain identity, never URLs;
// comments are scoped to the repository file rather than the entry document.
// Escaping paths render an error without issuing file requests.
import { html, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor } from "../backends/backend.js";
import { parseConversationId } from "../backends/conversation-id/index.js";
import { openFileTab } from "../panes.js";
import { decodeFileTabKey, registerFileTabSource } from "../panes/index.js";
import { ATTACHMENT_FILE_ICON, FILE_DOWNLOAD_ICON } from "../icons.js";
import {
  renderDocumentMarkdown,
  scrollDocumentFragment,
  imagePlaceholder,
  revealArtifactImage,
} from "../document-markdown.js";
import {
  artifactFileUrl,
  artifactRelativePath,
  isMarkdownPath,
} from "./model.js";
import { artifactWorkingPath } from "../../src/artifacts/working_path.js";
import {
  commentRendering,
  discardCurrent,
  renderComments,
} from "./comment-bar.js";
import { claimComments, reanchor } from "./selection-comments.js";
import { createCommentState, type CommentPane } from "./artifact-state.js";
import { commentMount } from "../comments/selection-draft/index.js";
import { installImageZoom } from "../image-preview/zoom.js";
import {
  registerInlineBoxFrame,
  installBoxComments,
} from "../comments/box/index.js";
import { requestUiStatus } from "../ui-events.js";
import { highlightSource } from "../source-preview.js";

interface Target {
  agent: string;
  artifact: string;
  version: string;
  path: string;
  owner?: string;
}

function kind(path: string): string | null {
  if (isMarkdownPath(path)) return "markdown";
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.(docx|xlsx|xls|ods|csv|pptx|ipynb|html?)$/i.test(path))
    return "document";
  if (
    /\.(txt|json|ya?ml|toml|xml|[cm]?[jt]sx?|py|css|sh|rs|go|c|h|cpp)$/i.test(
      path,
    )
  )
    return "text";
  return null;
}

export function openArtifactFile(target: Target, fragment = ""): boolean {
  const opened = openFileTab(
    "artifact",
    JSON.stringify([
      target.agent,
      target.artifact,
      target.version,
      target.path,
      target.owner || parseConversationId(target.agent).cid,
    ]),
    fragment,
  );
  if (!opened)
    requestUiStatus(
      "File not opened. Close a file tab or finish the current comments first.",
    );
  return true;
}

registerFileTabSource("artifact", (key, id) => {
  const parts = decodeFileTabKey(key, 5, 2048);
  if (!parts) return null;
  const [agent, artifact, version, path, owner] = parts;
  if (!/^[0-9a-f]{40}$/.test(version!) || path!.startsWith("/")) return null;
  const target = {
    agent: agent!,
    artifact: artifact!,
    version: version!,
    path: path!,
    owner: owner!,
  };
  let fragment = "";
  let controller: AbortController | undefined;
  let shown: HTMLElement | undefined;
  let releaseView: (() => void) | undefined;
  const url = artifactFileUrl(
    target.agent,
    target.artifact,
    target.path,
    target.version,
  );
  const commentId = `${target.artifact}/${target.version}/${target.path}`;
  const comments = (element: CommentPane) => {
    claimComments(element, commentRendering);
    reanchor(element, commentId);
    renderComments(element);
  };
  return {
    id,
    title: target.path.split("/").at(-1)!,
    icon: ATTACHMENT_FILE_ICON,
    prepare(value) {
      fragment = typeof value === "string" ? value : "";
      if (shown?.isConnected) scrollDocumentFragment(shown, fragment);
    },
    guardClose: (element, preserveComments) =>
      preserveComments ||
      !(element as CommentPane)._rs ||
      discardCurrent(element as CommentPane),
    available: (ctx) => ctx.agentId === target.agent,
    render(element, ctx) {
      if (ctx.agentId !== target.agent) {
        element.textContent = "File unavailable.";
        return;
      }
      if (shown === element) {
        comments(element as CommentPane);
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      shown = element;
      const pane = element as CommentPane;
      element.classList.add("files-view");
      installBoxComments(element);
      pane._rs = {
        ...createCommentState(target.agent),
        selId: commentId,
        contentInfo: {
          id: commentId,
          title: target.path,
          version: target.version,
          noun: "file",
          path: `${artifactWorkingPath(target.owner, target.artifact)}/${target.path}`,
        },
      };
      if (target.path.split("/").includes("..")) {
        pane._rs.contentInfo = null;
        render(
          html`<div class="report-doc">
              File not found. Choose a file inside this Artifact.
            </div>
            <div class="report-comments"></div>
            <div class="report-bar"></div>`,
          element,
        );
        return;
      }
      render(
        html`<div class="files-detail">
            <div class="files-detail-bar">
              <span class="files-name">${target.path}</span>
              <a
                class="icon-btn lg"
                href=${url}
                target="_blank"
                rel="noopener noreferrer"
                download
                aria-label="Download"
                title="Download"
                >${unsafeHTML(FILE_DOWNLOAD_ICON)}</a
              >
            </div>
            <div class="report-doc artifact-doc"></div>
          </div>
          <div class="report-comments"></div>
          <div class="report-bar"></div>`,
        element,
      );
      const body = element.querySelector<HTMLElement>(".report-doc")!;
      element.addEventListener("recurse:pdf-pages", () => comments(pane), {
        signal,
      });
      body.textContent = "Loading…";
      void (async () => {
        const type = kind(target.path);
        if (type === "markdown") body.classList.add("files-markdown");
        if (type === "document") {
          body.textContent = "";
          const module = await import("../document-preview.js");
          if (!signal.aborted) {
            module.mountDocument(body, url, target.path, 0);
            releaseView = () => module.releaseDocuments(body);
          }
        } else if (type === "pdf") {
          body.textContent = "";
          const module = await import("../pdf-view.js");
          if (!signal.aborted) {
            module.mountPdf(body, url);
            releaseView = () => module.releasePdfs(body);
          }
        } else if (type === "image") {
          body.textContent = "";
          const image = document.createElement("img");
          image.alt = target.path;
          image.className = "files-image";
          body.classList.add("image-zoom-viewport");
          const frame = imagePlaceholder(image, true);
          frame.classList.add("files-image-frame", "report-box-frame");
          frame.append(image);
          body.append(frame);
          if (await revealArtifactImage(frame, image, url, signal)) {
            frame.style.removeProperty("width");
            frame.style.setProperty(
              "--image-aspect",
              String(image.naturalWidth / image.naturalHeight),
            );
            installImageZoom(image);
          } else if (!signal.aborted) {
            const response = await backendFor(target.agent).api(url, {
              signal,
            });
            await response.body?.cancel();
            body.textContent =
              response.status === 404
                ? "File not found. Check the link or choose another file."
                : "Couldn’t display the image. Download it to view it.";
          }
        } else {
          const response = await backendFor(target.agent).api(url, { signal });
          if (!response.ok)
            throw Error(
              response.status === 404
                ? "File not found. Check the link or choose another file."
                : "Couldn’t display this file. Download it to view it.",
            );
          if (!type) {
            await response.body?.cancel();
            body.textContent =
              "Preview is unavailable for this file type. Download it to open it.";
            return;
          }
          const text = await response.text();
          if (signal.aborted) return;
          body.textContent = "";
          if (type === "markdown")
            renderDocumentMarkdown(body, text, {
              title: target.path,
              agentId: target.agent,
              artifactId: target.artifact,
              documentPath: target.path,
              onImageFrame: registerInlineBoxFrame,
              signal,
              resolveRelative: (path) => {
                const sibling = artifactRelativePath(target.path, path);
                return sibling
                  ? artifactFileUrl(
                      target.agent,
                      target.artifact,
                      sibling,
                      target.version,
                    )
                  : null;
              },
              openRelative: (path, hash) => {
                const sibling = artifactRelativePath(target.path, path);
                return (
                  !!sibling &&
                  openArtifactFile({ ...target, path: sibling }, hash)
                );
              },
            });
          else {
            const pre = document.createElement("pre");
            pre.textContent = text;
            body.append(pre);
            highlightSource(pre, target.path);
          }
        }
        if (!signal.aborted) {
          comments(pane);
          scrollDocumentFragment(body, fragment);
        }
      })().catch((error) => {
        if (!signal.aborted)
          body.textContent = error.message || "Couldn’t display this file.";
      });
      comments(pane);
    },
    leave(element) {
      releaseView?.();
      releaseView = undefined;
      controller?.abort();
      shown = undefined;
      if (commentMount.current === element) commentMount.current = null;
    },
    release() {
      releaseView?.();
      releaseView = undefined;
      controller?.abort();
      shown = undefined;
    },
  };
});
