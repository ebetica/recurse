// Artifacts-pane content preview. This module owns turning a fetched artifact
// revision into inert DOM: the URL-stripping static policy, Markdown with
// math/mermaid/images, sandboxed HTML embeds, and image reveal.
import {
  artifactFileUrl,
  artifactImagePreviewTarget,
  artifactPageUrl,
} from "./model.js";
import { nextArtifactFrameDescriptionId } from "./embed.js";
import {
  imagePlaceholder,
  revealArtifactImage,
  renderDocumentMarkdown,
} from "../document-markdown.js";
import { setNotice } from "./artifact-detail.js";
import { watchPageErrors } from "./page-errors.js";
import { cancelSelectionComment } from "./selection-comments.js";
import type { ArtifactInfo } from "./model.js";
import type { ArtifactEl } from "./artifact-state.js";

window.addEventListener("recurse:theme-changed", () => {
  // Spec: Theme changes reload pages, resetting app input/scroll/counters.
  for (const frame of document.querySelectorAll<HTMLIFrameElement>(
    "iframe.artifact-embed-page[src]",
  ))
    frame.src = frame.src;
});

function refreshUrl(pane: ArtifactEl, url: string): string {
  return pane._rs.refreshKey ? `${url}&refresh=${pane._rs.refreshKey}` : url;
}

const sizedFrames = new Set<HTMLIFrameElement>();
function watchArtifactHeight(frame: HTMLIFrameElement): void {
  for (const old of sizedFrames) if (!old.isConnected) sizedFrames.delete(old);
  sizedFrames.add(frame);
  window.addEventListener("message", receiveArtifactHeight);
}
function receiveArtifactHeight(event: MessageEvent): void {
  for (const frame of sizedFrames) {
    if (!frame.isConnected) {
      sizedFrames.delete(frame);
      continue;
    }
    if (event.source !== frame.contentWindow) continue;
    const height: unknown = event.data?.recurseArtifactHeight;
    // Invariant: Opaque-origin artifact code is untrusted, including its size
    // reports.
    if (
      typeof height !== "number" ||
      !Number.isFinite(height) ||
      height < 1 ||
      height > 30000
    )
      return;
    frame.style.height = `${Math.ceil(height)}px`;
    return;
  }
}

function appendLiveEmbed(
  body: HTMLElement,
  info: ArtifactInfo,
  pane: ArtifactEl,
): void {
  // Invariant: The live preview is the app page the server built at publish:
  // its sandboxing CSP plus this iframe's sandbox give scripts an opaque origin
  // and no session reach, so the page runs as built.
  const frame = document.createElement("iframe");
  const description = document.createElement("p");
  description.className = "sr-only";
  description.id = nextArtifactFrameDescriptionId();
  description.textContent = `Live offline preview for ${info.title}. Download original is available above.`;
  frame.className = "report-embed artifact-embed artifact-embed-page";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = `${info.title} live preview`;
  frame.setAttribute("aria-describedby", description.id);
  frame.src = refreshUrl(
    pane,
    artifactPageUrl(pane._rs.agentId || "", info.id, pane._rs.selectedVersion),
  );
  const errors = document.createElement("div");
  errors.className = "artifact-errors";
  errors.setAttribute("aria-live", "polite");
  body.append(description, errors, frame);
  watchPageErrors(pane, info, frame, errors);
  watchArtifactHeight(frame);
}

function renderFallback(
  body: HTMLElement,
  info: ArtifactInfo,
  message: string,
): void {
  const card = document.createElement("div");
  card.className = "artifact-file-card";
  const name = document.createElement("strong");
  name.textContent = info.filename;
  const note = document.createElement("p");
  note.textContent = message;
  card.append(name, note);
  body.appendChild(card);
}

export async function renderContent(
  pane: ArtifactEl,
  info: ArtifactInfo,
  content: string | null,
): Promise<boolean> {
  cancelSelectionComment();
  pane._rs.imageAbort?.abort();
  const controller = new AbortController();
  pane._rs.imageAbort = controller;
  const body = pane.querySelector<HTMLElement>(".report-doc")!;
  body.innerHTML = "";
  if (info.format === "markdown") {
    renderDocumentMarkdown(body, content || "", {
      title: info.title,
      signal: controller.signal,
      resolveRelative: (path, image) => {
        const url = artifactFileUrl(
          pane._rs.agentId!,
          info.id,
          path,
          pane._rs.selectedVersion,
        );
        return image ? refreshUrl(pane, url) : url;
      },
    });
  } else if (info.format === "html") {
    appendLiveEmbed(body, info, pane);
  } else if (info.format === "text" || info.format === "code") {
    const pre = document.createElement("pre");
    pre.className = "artifact-plain";
    const code = document.createElement("code");
    code.textContent = content || "";
    pre.appendChild(code);
    body.appendChild(pre);
  } else if (info.format === "image" && pane._rs.agentId) {
    const preview = artifactImagePreviewTarget(
      pane._rs.agentId,
      pane._rs.selId,
      info,
      pane._rs.selectedVersion,
    );
    if (!preview) {
      renderFallback(
        body,
        info,
        "Preview is unavailable for this file type. Download the original to open it.",
      );
      return true;
    }
    const image = document.createElement("img");
    image.className = "artifact-image";
    image.alt = preview.alt;
    const frame = imagePlaceholder(image, true);
    frame.appendChild(image);
    body.appendChild(frame);
    const loaded = await revealArtifactImage(
      frame,
      image,
      refreshUrl(pane, preview.url),
      controller.signal,
    );
    if (!loaded && !controller.signal.aborted && body.contains(frame)) {
      body.innerHTML = "";
      renderFallback(
        body,
        info,
        "Image preview is unavailable. Download the original to view it.",
      );
      setNotice(pane, "Couldn’t display the image preview", true);
    }
    return loaded;
  } else if (info.format === "pdf") {
    renderFallback(
      body,
      info,
      "PDF preview is unavailable. Download the original to view it.",
    );
  } else {
    renderFallback(
      body,
      info,
      "Preview is unavailable for this file type. Download the original to open it.",
    );
  }
  return true;
}
