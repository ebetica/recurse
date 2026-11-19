# Held row state

## Source files

- [index.ts](index.ts) exposes the canonical [held.ts](held.ts) maps and context
  readers without loading fetch, paint or navigation orchestration.
- [row-thread.ts](row-thread.ts) folds immutable view windows into renderer turns.
- [view-blocks.ts](view-blocks.ts) defines browser view-page types.
- [../row-thread-state.ts](../row-thread-state.ts) owns reads, mutations, union
  pruning and presentation, using these same maps. It schedules older reads
  until the viewport can scroll. Navigation keeps the scroll and resize bindings.

## Identity and Clear

Held rows own loaded turns after a successful view read; polls retain chrome.
Read epochs fence in-flight pages across drops and eviction. Clear tombstones
wait for a new session, not a rebuilt view instance. Context controls and thread
consumers read these canonical maps without importing the fetch/paint owner.

## Rules for changes

Keep the public entry thin and named. Held state has no runtime dependency on
rendering, polling, model controls or navigation. Do not duplicate its maps or
snapshot live presentation bindings. The row owner retains its never-reused drop
serials, union cache bound and Clear guards; moving state does not change them.
