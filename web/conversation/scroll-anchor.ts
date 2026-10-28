// Anchors disclosure toggles by row screen offset; explicit controls stay fixed
// even when pinned, otherwise midpoint/bottom-follow applies. Captures where a
// reader left a thread for restoring on return. Corrections are instant;
// structural inputs avoid import-time DOM access.

export const BOTTOM_FOLLOW_THRESHOLD_PX = 140;

// A fresh thread has no prior viewport to preserve, so it starts at its own
// latest row. A same-conversation repaint follows only when it was already
// near bottom or an opened-thread latch is still holding the bottom.
export function shouldFollowConversationBottom(
  previousConversation: string | null,
  conversation: string,
  nearBottom: boolean,
  latchedConversation: string | null = null,
): boolean {
  return (
    previousConversation === null ||
    previousConversation !== conversation ||
    latchedConversation === conversation ||
    nearBottom
  );
}

// Pure: is this scroll position close enough to the bottom to bottom-follow?
export function isPinnedToBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold: number = BOTTOM_FOLLOW_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

// Upward scrolling (including browser focus/jumps) releases the open-thread
// bottom latch. Height-only growth and bottom-adjacent clamping do not.
export function hasScrolledAwayFromBottom(
  followedScrollTop: number,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return (
    scrollTop < followedScrollTop &&
    !isPinnedToBottom(scrollHeight, scrollTop, clientHeight)
  );
}

// Pure: the corrected scrollTop that keeps the anchor's screen offset.
// beforeTop/afterTop are the anchor's getBoundingClientRect().top readings.
// Clamped like tree_projection's centeredRowScrollTop: collapsing more than
// the current scroll would otherwise go negative before the browser clamps.
export function anchoredScrollTop(
  currentScrollTop: number,
  beforeTop: number,
  afterTop: number,
): number {
  return Math.max(0, currentScrollTop + (afterTop - beforeTop));
}

export interface AnchorRect {
  top: number;
  height: number;
}

// Pure: pick the anchor row as the one holding the viewport's vertical
// midpoint, else the first row intersecting the viewport, else -1 (empty or
// fully out-of-view thread: nothing to anchor against, leave scroll alone).
export function pickAnchorIndex(
  rows: readonly AnchorRect[],
  viewportTop: number,
  viewportHeight: number,
): number {
  const middle = viewportTop + viewportHeight / 2;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (middle >= row.top && middle < row.top + row.height) return index;
  }
  const bottom = viewportTop + viewportHeight;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.top < bottom && row.top + row.height > viewportTop) return index;
  }
  return -1;
}

export interface SavedViewport {
  row: string;
  offset: number;
}

export interface SavedViewportRow {
  readonly dataset: { rowId?: string };
  getBoundingClientRect(): { top: number; bottom: number };
}

// The topmost row still visible at the viewport top, else the last row above
// it; null when the reader is at the bottom or nothing is anchorable.
export function captureViewport(
  viewport: ScrollAnchorViewport,
  rows: readonly SavedViewportRow[],
): SavedViewport | null {
  if (
    isPinnedToBottom(
      viewport.scrollHeight,
      viewport.scrollTop,
      viewport.clientHeight,
    )
  )
    return null;
  const top = viewport.getBoundingClientRect().top;
  let saved: SavedViewport | null = null;
  for (const row of rows) {
    if (!row.dataset.rowId) continue;
    const box = row.getBoundingClientRect();
    saved = { row: row.dataset.rowId, offset: box.top - top };
    if (box.bottom > top) break;
  }
  return saved;
}

export interface ScrollAnchorViewport {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
  getBoundingClientRect(): { top: number };
}

export interface ScrollAnchorRow {
  readonly isConnected: boolean;
  getBoundingClientRect(): { top: number; height: number };
}

// Anchors a synchronous toggle/repaint on a surviving keyed DOM node. Explicit
// controls override bottom pinning; a rAF corrects deferred layout. Reader
// gestures cancel that residual correction.
export function withScrollAnchor(
  viewport: ScrollAnchorViewport,
  rows: readonly ScrollAnchorRow[],
  mutate: () => void,
  explicitAnchor: ScrollAnchorRow | null = null,
): void {
  if (
    !explicitAnchor &&
    isPinnedToBottom(
      viewport.scrollHeight,
      viewport.scrollTop,
      viewport.clientHeight,
    )
  ) {
    mutate();
    return;
  }
  let anchor: ScrollAnchorRow | null = null;
  let beforeTop: number | undefined;
  if (explicitAnchor?.isConnected) {
    anchor = explicitAnchor;
    beforeTop = anchor.getBoundingClientRect().top;
  } else {
    const rects = rows.map((row) => row.getBoundingClientRect());
    const index = pickAnchorIndex(
      rects,
      viewport.getBoundingClientRect().top,
      viewport.clientHeight,
    );
    anchor = index >= 0 ? rows[index] : null;
    beforeTop = anchor ? rects[index].top : undefined;
  }
  mutate();
  if (!anchor || beforeTop === undefined || !anchor.isConnected) return;
  const correct = (): void => {
    if (!anchor.isConnected) return;
    viewport.scrollTop = anchoredScrollTop(
      viewport.scrollTop,
      beforeTop,
      anchor.getBoundingClientRect().top,
    );
  };
  correct();
  const settledScrollTop = viewport.scrollTop;
  requestAnimationFrame(() => {
    // Invariant: The reader steering inside the press-to-frame window wins over
    // the residual async-layout pass.
    if (viewport.scrollTop !== settledScrollTop) return;
    correct();
  });
}
