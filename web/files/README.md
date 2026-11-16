# Files

## Source files

- [`../files.ts`](../files.ts): bounded collection, list and per-element viewers.
- [`model.ts`](model.ts): metadata paging, version grouping and text-preview LRU.
- [`markdown.ts`](markdown.ts): sibling links through shared Markdown and file tabs,
  and what is new since the reviewed version.
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
Back control. The desktop metadata row stays below those actions while file
content scrolls, with an opaque background. Its shared row height also reserves
scroll padding so heading and anchor jumps clear it. Phones keep their existing layout.
Each tab stays on its selected published version; automatic offers
leave the active document and saved arrangement unchanged. The first server-read
turn establishes the visit's baseline and is never offered, including when a new
live turn temporarily leaves it as the latest settled turn. Once baselined,
observation follows the latest turn and never falls back to an older file while
that turn is live. Later settled turns remain eligible when their attachment
metadata arrives in a subsequent frame. Phones retain
in-place details, image dialogs and Back navigation. Markdown sibling links open
file views with a Back step on phones; fragments scroll the opened document.
Modified clicks and unsupported types retain browser navigation. Inline image enlargement
retains its dialog on both layouts. Single-key shortcuts close image dialogs
before acting; `i` focuses the composer. Left/Right still step images. The
contextual `c` shortcut keeps its image comment editor open. Text-entry exclusions and native
Enter/Space activation share [../../src/keyboard_target.ts](../../src/keyboard_target.ts)
with the app and Artifact relay. Sealed document previews cannot relay keys;
modal editors keep their local keys.

Desktop image tabs fit the remaining content area below the file header, in
both docked and fullscreen windows. Images preserve their aspect ratio, center
on both axes and upscale small originals, matching the phone dialog. The fitted
frame stays the same size as the image so zoom, drawing and normalized comment
marks share the original image coordinates; phone layout is unchanged. Staged
comments use a bounded scrolling list below the image, keeping Send visible.

## Changes since reviewed

The latest version of a published Markdown file highlights what is new since
the version last reviewed, through the same viewer as Artifacts
([`../document-review.ts`](../document-review.ts) and
[`../document-diff.ts`](../document-diff.ts)). Only additions show: new words
and new blocks; removed text never appears, so comment anchors are unchanged.
Reviewed versions live in page memory, so after a reload every document counts
as reviewed and the first version seen is the starting point. "New since" above
the document picks another earlier version; Reviewed below it, or submitting
comments on that version, clears the highlights. The comparison text is the
earlier version's text preview, loaded (or reloaded after eviction) on demand.
Older versions picked in the version menu show without highlights.

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
byte limits, sanitization and worker-only document/PDF conversion. Plain source
previews and Artifact sibling source files share
[source syntax](../source-preview.ts) with Explorer and reply paths. The
[preview worker](../document-preview.worker.ts) lazily loads Changes' highlighter
and selects a language by filename, without interpreting source as HTML.
Unknown languages stay plain. Above 64K characters or 2,000 lines, syntax stays
off; at most 4,000 token fragments reach the DOM, bounding phone rendering as
well as worker input. A five-second worker deadline keeps pathological parsing
off the main thread. Both viewers use the same syntax theme variables. Text
selection and comment marks survive; Edit mode stays a plain textarea. Existing
preview byte caps are unchanged.

## Rules for changes

Reuse the collection, renderers and shared pane lifecycle. Keep file identity,
comment guards, owner checks and live bounds intact on every view.

Real browser coverage uses accepted files through the fake provider:

- Collection lifecycle: [`test_files.ts`](../../tests/mobile_browser/test_files.ts).
- Navigation: [`test_files_navigation.ts`](../../tests/mobile_browser/test_files_navigation.ts).
- Viewers: [`test_files_viewers.ts`](../../tests/mobile_browser/test_files_viewers.ts)
  and [`test_files_documents.ts`](../../tests/mobile_browser/test_files_documents.ts).
- Comments and touch gestures: [`test_files_comments.ts`](../../tests/mobile_browser/test_files_comments.ts).
- Rail badges: [`test_pane_chrome.ts`](../../tests/mobile_browser/test_pane_chrome.ts).
- Window restoration and shortcuts: [`test_pane_hotkeys.ts`](../../tests/mobile_browser/test_pane_hotkeys.ts).
