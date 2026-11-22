# Complete non-secret settings-sync inventory and canonical comparison

This module preserves the shared contract without importing its parent's orchestration.
Effort items use the remote's advertised levels. Sync does not send unsupported
levels or a default the remote cannot select.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [inventory.ts](inventory.ts): complete non-secret settings-sync inventory and canonical comparison.

## Rules for changes

Import through the public entry. Preserve existing behavior and keep the entry
limited to named re-exports; do not add orchestration or initialization there.
