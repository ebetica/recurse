# Held row state

## Source files

- [index.ts](index.ts) exposes the canonical [held.ts](held.ts) maps and context
  readers without loading fetch, paint or navigation orchestration.
- [row-thread.ts](row-thread.ts) folds immutable view windows into renderer turns.
- [view-blocks.ts](view-blocks.ts) defines browser view-page types. Held tool
  timing comes from the server; the browser does not add a receipt clock.
- [../row-thread-state.ts](../row-thread-state.ts) owns reads, mutations, union
  pruning and presentation, using these same maps. It schedules older reads
  until the viewport can scroll. Navigation keeps the scroll and resize bindings.

## Identity and Clear

Held rows own loaded turns after a successful view read; polls retain chrome.
View resets keep settled rows. Recreated views keep same-session messages and
diagrams mounted until Clear or a new session. Read epochs fence in-flight
pages across drops and eviction. Clear tombstones wait for a new session, not a
rebuilt view instance, and held rows keep context blank through Clear. Context
controls and thread consumers read these canonical maps without importing the
fetch/paint owner. [Row folding](row-thread.ts) treats recognized legacy
notices as plain text, without giving arbitrary custom entries a visible row.

## Rules for changes

Keep the public entry thin and named. Held state has no runtime dependency on
rendering, polling, model controls or navigation. Do not duplicate its maps or
snapshot live presentation bindings. The row owner retains its never-reused drop
serials, union cache bound and Clear guards; moving state does not change them.
