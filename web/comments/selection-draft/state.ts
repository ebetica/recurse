// Holds the draft and its viewer without importing pane rendering or actions.
import type {
  Comment,
  CommentBox,
  CommentPane,
} from "../../artifacts/artifact-state.js";
import type { PreparedCrop } from "../../artifacts/comment-crops.js";

export interface SelectionSource {
  doc: Document;
  agentId: string | null;
  artifactId: string | null;
  version: string | null;
  generation: number;
  active: boolean;
  pointerIds: Set<number>;
  interactionStarted: number;
  touch: boolean;
  changed: boolean;
  rangeAtStart: Range | null;
  blocked: boolean;
  blockedRange: Range | null;
  offerToken: number;
}

export interface SelectionDraft {
  pane: CommentPane;
  key: string;
  version: string;
  root: Element;
  source: SelectionSource;
  range: Range;
  quote: string;
  box?: CommentBox;
  crop?: PreparedCrop;
  mark?: HTMLElement;
  edit?: { comment: Comment; anchor: HTMLElement };
}
export let selectionDraft: SelectionDraft | null = null;
export function setSelectionDraft(draft: SelectionDraft | null): void {
  selectionDraft = draft;
}

/** A DOM move can collapse the draft's live range even when its text survives. */
export function captureSelectionDraftRange(
  subtree: HTMLElement,
): (() => void) | undefined {
  const draft = selectionDraft;
  if (!draft || draft.edit || draft.box || !subtree.contains(draft.root))
    return;
  const { range, root } = draft;
  const { startContainer, startOffset, endContainer, endOffset } = range;
  if (!root.contains(startContainer) || !root.contains(endContainer)) return;
  return () => {
    if (
      selectionDraft !== draft ||
      !root.contains(startContainer) ||
      !root.contains(endContainer)
    )
      return;
    range.setStart(startContainer, startOffset);
    range.setEnd(endContainer, endOffset);
  };
}

/** The pane whose shown document takes the next selection comment. */
export const commentMount: { current: CommentPane | null } = {
  current: null,
};

/** The viewer owning the floating selection-comment draft. */
export function selectionCommentOwner(): CommentPane | null {
  return selectionDraft?.pane ?? null;
}
