# Artifacts

## Source files

- [index.ts](index.ts) exposes the comment outbox.
- [pane.ts](pane.ts) owns the list and selection; [artifact-detail.ts](artifact-detail.ts)
  and [content-view.ts](content-view.ts) display the selected version.
- [selection-comments.ts](selection-comments.ts) and [comment-bar.ts](comment-bar.ts)
  manage comment drafts and cards. [comment-outbox.ts](comment-outbox.ts) persists
  sends, [crop-store.ts](crop-store.ts) stores crop bytes, and [send-lock](send-lock/README.md)
  coordinates sends across tabs.
- [file-links.ts](file-links.ts) previews version-pinned non-Markdown siblings.

## Comments

Artifact and image comments persist original crops for background send and
retry. App startup supplies rendering and connects the comment outbox to the
thread; panes own actions. [Quote text](../comments/selection-text/README.md)
limits quote length. Source highlighting waits while a selection draft owns the
viewer. Send controls stay outside native selections, including ones added
later. Earlier queued scrolls do not cancel selection comment offers.

New comments focus their cards. Click an Artifact highlight or press Enter or
Space on it to edit. Links still navigate; use cards for overlapping or
link-only highlights. Save updates the comment; Cancel or Escape keeps its text.
Finish editing before sending. Cmd/Ctrl+Enter stages a draft without opening the
list and focuses the viewer; press again to send.

## Submission and navigation

Submission keeps the Artifact pane or tab open; other viewers close. Reopening
retains position without reloading unchanged documents. See [image previews](../image-preview/README.md)
for preview gestures.

Without Web Locks, the send lock serializes composer and comment uploads, sends
and discards in a separate IndexedDB readwrite transaction that does not block
crop storage. Pending requests keep transaction ownership, not an expiring lease.
The outbox rechecks ownership after awaits; server idempotency handles crash
recovery.

Discovery never opens the Artifacts pane; clicks and saved layouts do. Markdown
pages share the Artifact pane and its browser history, so a page link does not
change the selected Artifact. A historical page link identifies its published
version so it opens the same revision in another tab. Other files use the shared
[Files](../files/README.md) viewers.

## Rules for changes

Keep pending comments, crop bytes and recipient identity intact until send or
discard settles. Keep pane actions separate from background discovery and
submission.
