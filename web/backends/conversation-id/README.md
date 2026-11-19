# Qualified conversation identity without backend discovery

This module preserves the shared contract without importing its parent's orchestration.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [conversation-id.ts](conversation-id.ts): qualified conversation identity without backend discovery.

## Rules for changes

Import through the public entry. Preserve existing behavior and keep the entry
limited to named re-exports; do not add orchestration or initialization there.
