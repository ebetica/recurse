# Cross-tab send coordination shared by comment and composer outboxes

This module preserves the shared contract without importing its parent's orchestration.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [send-lock.ts](send-lock.ts): cross-tab send coordination shared by comment and composer outboxes.

## Rules for changes

Import through the public entry. Preserve existing behavior and keep the entry
limited to named re-exports; do not add orchestration or initialization there.
