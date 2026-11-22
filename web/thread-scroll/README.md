# Thread scrolling

## Source files

- [index.ts](index.ts) exposes scrolling, anchoring and edge controls.
- [scroll-anchor.ts](scroll-anchor.ts) captures and corrects row offsets.
- [scroll-ledger.ts](scroll-ledger.ts) writes offsets and tracks app scrolls.
- [../conversation/thread.ts](../conversation/thread.ts) owns the thread's holds
  and saved reading positions.

## Following and holds

Sends to idle agents follow the reply bottom until the sent message reaches the
viewport top, then hold. Short replies never add scrolling. Repaints keep the
reader's row as replies shrink; layout clamps never resume following. Disclosure
controls stay fixed through delayed layout. Hidden threads retain position and
following until visible. Following spans paints before a scroll frame.
Scrollbar, find-in-page and script offsets not written by the ledger release holds.

## Rules for changes

Write thread offsets through this module so it can distinguish app movement
from the reader's. Preserve holds when repainting or revealing hidden content.
