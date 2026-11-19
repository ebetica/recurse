# Conversation model parsing and no-fallback validation

This module preserves the shared contract without importing its parent's orchestration.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [model_selection.ts](model_selection.ts): conversation model parsing and no-fallback validation.

## Rules for changes

Import through the public entry. Preserve existing behavior and keep the entry
limited to named re-exports; do not add orchestration or initialization there.
