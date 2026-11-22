# Browser backends

## Source files

- [index.ts](index.ts) exposes the backend registry and tree reads.
- [backend.ts](backend.ts) resolves backend identity, proxy URLs and request health.
- [tree.ts](tree.ts) reads trees independently per backend.
- [discovery](discovery/) registers remotes and [streams tree and tag notices](discovery/events.ts).
- [conversation-id](conversation-id/README.md) encodes backend-qualified IDs.

## Remotes and tree updates

Remotes isolate health and enforce their own key policy. Cancellation stays
active through body reads, so abandoned streams and stalled discovery close.
Tree and tag notices share one visible-tab stream and supersede older reads
without waiting for a poll. Remote subscriptions pause with the backend and
never wake it. Home reads patch only the exact in-memory ETag behind the same
generation fence; remotes keep array reads.

## Rules for changes

Do not let slow remotes hold the home or add a second browser-side allowlist.
[Shared trees](../shared-trees.ts) filter display, not access.
