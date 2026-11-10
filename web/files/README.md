# Files

## Source files

- [`../files.ts`](../files.ts): bounded collection, list and per-element viewers.
- [`model.ts`](model.ts): metadata paging, version grouping and text-preview LRU.
- [`box-comments.ts`](box-comments.ts): image and PDF selection gestures.
- [`diff-preview.ts`](diff-preview.ts): inert diff rendering and comment anchors.
- [`style.css`](style.css): collection and viewer layout.

The server's owner-scoped accepted-file routes supply metadata and bytes.

## Views

On desktop, opening a listed file or a reply's file button opens a file tab
beside Chat through [`../panes/file-tabs.ts`](../panes/file-tabs.ts). The Files
list stays separate. Reopening selects the current conversation's existing tab
and retains its viewer and notes. Versions and neighboring files open their own
tabs rather than replacing an annotated viewer. Headers retain actions but no
Back control. Each tab stays on its selected published version; automatic offers
leave the active document and saved arrangement unchanged. Phones retain
in-place details, image dialogs and Back navigation. Inline image enlargement
retains its dialog on both layouts.

## Ownership and lifetime

Descriptors contain only the conversation ID and the server's upload/published
key, never a URL. Restoration pages the existing metadata collection only for
wanted/open tabs and omits missing or inaccessible items for that visit. The
original saved window layout remains available to the next visit. Conversation
changes cancel pending discovery; browser window placement and persistence stay
owned by the shared pane and dock lifecycle.

Live file views use per-element rendering, comments, Markdown cancellation,
preview observation and drawing targets. The list and image dialog reuse those
same rendering functions. Closing a file checks only that document's pending
comments; its detached annotated body uses the existing pane cache. Resuming
restores preview observers and document/PDF resources even when the content needs
no repaint. File tabs
share the eight-open/32-definition bounds with Explorer and the existing
12-body retention limit. Collection and text caches retain their existing
12-conversation and 24-preview limits. No new store, endpoint or quota is added.

The list remains newest-first and groups published versions by name. Metadata
refresh remains bounded and throttled during a running turn. An open collection
stays available until its pending metadata read settles. Failed deletions remain
visible and Retry retries the deletion. Media keep their admitted preview routes,
byte limits, sanitization and worker-only document/PDF conversion.

## Rules for changes

Reuse the collection, renderers and shared pane lifecycle. Keep file identity,
comment guards, owner checks and live bounds intact on every view.

Real browser coverage lives in
[`test_panes_files.ts`](../../tests/mobile_browser/test_panes_files.ts) and
[`test_pane_hotkeys.ts`](../../tests/mobile_browser/test_pane_hotkeys.ts), alongside
image, document and comment browser groups. It exercises real accepted files,
window restoration, viewer navigation and comments through the fake provider.
