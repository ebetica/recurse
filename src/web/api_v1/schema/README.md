# Shared versioned API wire schema and TypeScript types

This module preserves the shared contract without importing its parent's orchestration.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [schema.ts](schema.ts): shared versioned api wire schema and typescript types.

## Rules for changes

Import through the public entry. Preserve existing behavior and keep the entry
limited to named re-exports; do not add orchestration or initialization there.
