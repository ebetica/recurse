// Files previews use the shared selection drafts, marks and comment cards.
import {
  claimComments,
  commentKey,
  commentRendering,
  createCommentState,
  reanchor,
  syncSelectionDraft,
  type CommentPane,
} from "../artifacts/index.js";
import { commentMount } from "../comments/selection-draft/index.js";
import { highlightSource } from "../source-preview.js";
import { cachedEntry } from "./collection.js";
import { diffPending } from "./diff-preview.js";
import type { SessionFile } from "./model.js";

export interface FileCommentElement extends HTMLElement {
  _rs?: CommentPane["_rs"];
}

let diffReady: (element: FileCommentElement, cid: string) => void;

export function configureFileComments(
  fileViews: ReadonlyMap<
    FileCommentElement,
    { cid: string; file: SessionFile }
  >,
  onDiffReady: typeof diffReady,
): void {
  diffReady = onDiffReady;
  document.addEventListener("recurse:comments-changed", (event) => {
    const key = (event as CustomEvent<string>).detail;
    for (const [element, { cid, file }] of fileViews) {
      if (
        element === event.target ||
        !element.isConnected ||
        !file.id ||
        key !== commentKey(cid, file.id)
      )
        continue;
      reanchor(element as CommentPane, file.id, { pruneStale: true });
      commentRendering.renderComments(element as CommentPane);
    }
  });
}

// Spec: A shown text preview takes selection comments exactly like an Artifact
// version: staged in the comment bar, submitted to this conversation.
export function syncComments(
  element: FileCommentElement,
  cid: string,
  file: SessionFile | null,
) {
  syncSelectionDraft();
  const pending = file && diffPending(cachedEntry(cid)?.previews.get(file.key));
  if (pending) void pending.then(() => diffReady(element, cid));
  const doc = file?.id && element.querySelector(".report-doc") ? file : null;
  // Invariant: Mutated in place: an in-flight send clears the flags on the
  // object it started with.
  element._rs ??= createCommentState(cid);
  Object.assign(element._rs, {
    agentId: cid,
    selId: doc?.id ?? null,
    contentInfo: doc
      ? { noun: "file", id: doc.id!, title: doc.name, version: doc.key }
      : null,
  });
  const pane = element as CommentPane;
  if (!doc) {
    if (commentMount.current === pane) commentMount.current = null;
    return;
  }
  const source = element.querySelector(".files-source");
  if (source) highlightSource(source, doc.name);
  claimComments(pane, commentRendering);
  reanchor(pane, doc.id!);
  commentRendering.renderComments(pane);
}
