# Shared prompt and summary copy-control templates

This module preserves the shared contract without importing its parent's orchestration.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [copy-button.ts](copy-button.ts): shared prompt and summary copy-control templates.

## Rules for changes

Import through the public entry. Preserve existing behavior and keep the entry
limited to named re-exports; do not add orchestration or initialization there.
