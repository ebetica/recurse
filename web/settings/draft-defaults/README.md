# DOM-free preferences and new-subagent default snapshots

This module preserves the shared contract without importing its parent's orchestration.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [draft-defaults.ts](draft-defaults.ts): dom-free preferences and new-subagent default snapshots.

## Rules for changes

Import through the public entry. Preserve existing behavior and keep the entry
limited to named re-exports; do not add orchestration or initialization there.
