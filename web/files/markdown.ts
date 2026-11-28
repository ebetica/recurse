// Files Markdown resolves published siblings before local image paths and
// routes previewable links through the existing file-tab lifecycle. The latest
// version of a published file highlights what is new since its reviewed one.
import { html, type TemplateResult } from "lit";
import { renderDocumentMarkdown } from "../document-markdown.js";
import {
  changesHeader,
  reviewedVersion,
  watchReview,
} from "../document-review.js";
import { requestUiStatus } from "../ui-events.js";
import {
  rendersAsMarkdown,
  versionGroups,
  versionLabel,
  type SessionFile,
} from "./model.js";
import type { FilePreviewState } from "./collection.js";

interface FilesMarkdownSource {
  files: SessionFile[];
  previews: Map<string, FilePreviewState>;
  /** Load an idle or evicted preview; a repaint follows when it settles. */
  load: (file: SessionFile) => void;
  /** Repaint after the reviewed version moves. */
  refresh: () => void;
  href: (file: SessionFile, image: boolean) => string | null;
  open: (file: SessionFile, fragment: string) => boolean;
}

const fileDoc = (cid: string, file: SessionFile) => `${cid}\n${file.name}`;

/** Count each published file's latest version reviewed when first seen. */
export function noteReviewed(cid: string, latest: SessionFile[]): void {
  for (const file of latest)
    if (file.storage === "published")
      reviewedVersion(fileDoc(cid, file), file.key);
}

function fileChanges(
  cid: string,
  file: SessionFile,
  source: Pick<FilesMarkdownSource, "files" | "previews">,
) {
  if (file.storage !== "published" || !rendersAsMarkdown(file)) return null;
  const group = versionGroups(source.files).find(
    (candidate) => candidate[0]!.key === file.key,
  );
  if (!group) return null;
  const reviewed = reviewedVersion(fileDoc(cid, file), file.key);
  const since = group.find((item) => item.key === reviewed);
  if (!since || since.key === file.key) return null;
  return { group, since, preview: source.previews.get(since.key) };
}

/** What a repaint must notice: the reviewed version and its text loading. */
export function changesStamp(
  cid: string,
  file: SessionFile,
  source: Pick<FilesMarkdownSource, "files" | "previews">,
) {
  const changes = fileChanges(cid, file, source);
  return changes && [changes.since.key, changes.preview?.status];
}

export function filesMarkdown(
  cid: string,
  file: SessionFile,
  text: string,
  signal: AbortSignal,
  source: FilesMarkdownSource,
): TemplateResult {
  const body = document.createElement("div");
  body.className = "files-markdown artifact-doc report-doc";
  const found = fileChanges(cid, file, source);
  if (found && found.preview?.status !== "ready") source.load(found.since);
  const ready = found?.preview?.status === "ready" ? found : null;
  const changes = ready && {
    doc: fileDoc(cid, file),
    version: file.key,
    since: ready.since.key,
    onReviewed: source.refresh,
    onCompare: source.refresh,
  };
  const sibling = (path: string) => {
    try {
      const name = decodeURIComponent(
        new URL(
          path,
          new URL(file.name, "https://files.invalid/"),
        ).pathname.slice(1),
      );
      return versionGroups(source.files).find(
        (group) => group[0]!.name === name,
      )?.[0];
    } catch {
      return undefined;
    }
  };
  renderDocumentMarkdown(body, text, {
    title: file.name,
    previous: ready && (ready.preview!.text ?? ""),
    signal,
    agentId: cid,
    documentPath: file.source_path,
    doubleClickImages: true,
    resolveRelative: (path, image) => {
      const item = sibling(path);
      return item ? source.href(item, image) : null;
    },
    openRelative: (path, fragment) => {
      const item = sibling(path);
      if (!item || !item.preview || item.preview === "none" || item.unavailable)
        return false;
      if (!source.open(item, fragment))
        requestUiStatus(
          "File not opened. Close a file tab or finish the current comments first.",
        );
      return true;
    },
  });
  watchReview(body, changes);
  if (!changes || !ready) return html`${body}`;
  const versions = ready.group.slice(1).map((item, index, rest) => ({
    value: item.key,
    label: versionLabel(item, rest.length - index, false),
  }));
  return html`${changesHeader(changes, versions)}${body}`;
}
