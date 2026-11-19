// Row events and template controls repaint through the same synchronous
// thread operations. The entry point binds them before the first read.
import type { Conversation } from "../types.js";
import type { ScrollAnchorRow } from "../thread-scroll/index.js";

export let paint: (conv: Conversation) => void;
export let anchoredPaint: (
  conv: Conversation,
  anchor: ScrollAnchorRow | null,
) => void;

export function configureRowPaint(actions: {
  paint: typeof paint;
  anchoredPaint: typeof anchoredPaint;
}): void {
  ({ paint, anchoredPaint } = actions);
}
