// Guards staged Changes/Artifact comments on navigation and tab close. They
// exist only in-page until sent; confirm discards, cancel stays put.

export interface CommentSource {
  count(): number;
  discard(): void;
}

const sources = new Set<CommentSource>();

// Register a comment source. Returns an unregister fn.
export function registerCommentSource(src: CommentSource): () => void {
  sources.add(src);
  return () => sources.delete(src);
}

export function pendingCommentCount(): number {
  let n = 0;
  for (const s of sources) {
    try {
      n += s.count() || 0;
    } catch {}
  }
  return n;
}

// The shared "N unsent comments will be discarded" confirm, reused by any
// narrower guard (e.g. switching reports within the pane) that discards its own
// staged comments rather than every pane's. Returns true to proceed (caller
// then discards), false to stay put. n === 0 proceeds without prompting.
export function confirmDiscard(n: number): boolean {
  if (!n) return true;
  return confirm(
    (n === 1
      ? "You have 1 unsent comment."
      : `You have ${n} unsent comments.`) +
      "\n\nComments will be discarded if you leave. Continue?",
  );
}

function discardAll(): void {
  for (const s of sources) {
    try {
      s.discard();
    } catch {}
  }
}

// Call before leaving the current view (opening a different agent). Returns
// true when it's safe to proceed — nothing staged, or the user OK'd discarding
// it (in which case the staged comments are dropped first). Returns false to
// cancel.
export function guardLeaveComments(): boolean {
  const n = pendingCommentCount();
  if (!n) return true;
  const ok = confirmDiscard(n);
  if (ok) discardAll();
  return ok;
}

addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
  if (pendingCommentCount() > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
});
