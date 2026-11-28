# Files

## Source files

- [`../files.ts`](../files.ts): list, selection and viewer navigation.
- [`collection.ts`](collection.ts): metadata paging, file routes and text-preview LRU.
- [`preview.ts`](preview.ts): file-kind rendering, lazy previews and shared viewer controls.
- [`image-viewer.ts`](image-viewer.ts): image dialog, history, gallery and sharing.
- [`swipe.ts`](swipe.ts): shared touch and wheel stepping.
- [`comments.ts`](comments.ts): comment marks and drafts across Files viewers.
- [`model.ts`](model.ts): file identity, version grouping and the settled-turn observer.
- [`markdown.ts`](markdown.ts): sibling links through shared Markdown and file tabs,
  and what is new since the reviewed version.
- [`diff-preview.ts`](diff-preview.ts): inert diff rendering and comment anchors.
- [`style.css`](style.css): collection and viewer layout.

The server's owner-scoped accepted-file routes supply metadata and bytes.
App startup connects row reads, turn observations, and published-file changes to
the Files pane. Row commits notify it synchronously before the next thread paint.

## Views

On desktop, opening a listed file or a reply's file button opens a file tab
beside Chat through [`../panes/file-tabs.ts`](../panes/file-tabs.ts). The Files
list stays separate. Reopening selects the current conversation's existing tab
and retains its viewer and notes. The version menu still opens a separate file
tab. Previous and Next (including keyboard and gestures) step between available
files in the current tab, even if another tab already shows the destination.
Staged notes stay with their file when stepping. Headers retain actions but no
Back control. The desktop metadata row stays below those actions while file
content scrolls, with an opaque background. Its shared row height also reserves
scroll padding so heading and anchor jumps clear it.
Each tab stays on its selected published version; automatic offers
leave the active document and saved arrangement unchanged. The first server-read
turn establishes the visit's baseline and is never offered, including when a new
live turn temporarily leaves it as the latest settled turn. Once baselined,
observation follows the latest turn and never falls back to an older file while
that turn is live. Later settled turns remain eligible when their attachment
metadata arrives in a subsequent frame. Phones retain
in-place details, image dialogs and Back navigation. Markdown sibling links open
file views with a Back step on phones; fragments scroll the opened document.
Markdown siblings opened from Artifacts use the same reading padding as published
Markdown files. Figures use the [shared image viewer](../image-preview/README.md),
independent of tab navigation. [Markdown tables](../util.ts) share layout with Artifacts and
chat: long cells wrap, and tables scroll only when their columns cannot fit.

Uploaded and published HTML and Explorer HTML use the Artifact app isolation.
Source shows highlighted markup; Preview runs inline scripts and styles and
loads embedded data images, fonts and media. Separate files do not load as
subresources, even when adjacent to the HTML. Its document URL does not inherit
the enclosing Recurse URL. Preview cannot read the Recurse page, cookies or API,
open popups, submit forms or navigate the Recurse page.
Resource hints in the original HTML are removed before rendering. Because the
filter's parser can interpret markup differently from Chromium, a second check
scans the remaining text for hint-like `rel` attributes. If it finds one, the
file opens as Source, even if the match was only in a comment. Scripts can still
deliberately add hints at runtime, and a link or script can navigate the preview
frame itself. Either can contact another host and disclose the file's own
content or that it was opened.
Files larger than 256 KiB open as source with the first 256 KiB and a Download
action for the rest. If HTML is too complex to prepare safely, Preview is
unavailable and the file opens as Source.

Modified clicks and unsupported types retain browser navigation. Inline image enlargement
retains its dialog on both layouts. Single-key shortcuts close image dialogs
before acting; `i` focuses the composer. Left/Right still step images. The
contextual `c` shortcut keeps its image comment editor open. Text-entry exclusions and native
Enter/Space activation share [../../src/keyboard_target.ts](../../src/keyboard_target.ts)
with the app and Artifact relay. Document and HTML file previews do not relay
keys; modal editors keep their local keys.

Desktop image tabs fit the remaining content area below the file header, in
both docked and fullscreen windows. Images preserve their aspect ratio, center
on both axes and upscale small originals, matching the phone dialog. The fitted
frame stays the same size as the image so zoom, drawing and normalized comment
marks share the original image coordinates. Staged comments use a bounded
scrolling list below the image, keeping Send visible.
[Image sharing](../image-preview/README.md) falls back to an ordinary download
when Web Share is unavailable. Shares retain the admitted file media type;
local-path images use the byte-checked response type.

## Documents

[document-preview.ts](../document-preview.ts) lazily mounts document views.
[Its worker](../document-preview.worker.ts) loads Mammoth, SheetJS, pptxtojson,
notebookjs and inert LinkeDOM. Conversion is capped, cancellable and worker-only.
Signature-based ZIP bounds limit archive expansion; DOMPurify sanitizes markup
before it enters the opaque [CSP frame](../document-media/). Converted content
can show raster data images but cannot run scripts, use the network, open links,
embed content, add CSS or access the parent origin. Failures retain Download.

## Changes since reviewed

The latest version of a published Markdown file highlights what is new since
the version last reviewed, through the same viewer as Artifacts
([`../document-review.ts`](../document-review.ts) and
[`../document-diff.ts`](../document-diff.ts)). Only additions show: new words
and new blocks; removed text never appears, so comment anchors are unchanged.
Reviewed versions live in page memory, so after a reload every document counts
as reviewed and the first version seen is the starting point. "New since" above
the document picks another earlier version; Reviewed at the bottom right, or submitting
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
12-conversation and 24-preview limits. Tabs reuse the Files store, routes and quotas.

The list remains newest-first and groups published versions by name. Metadata
refresh remains bounded and throttled during a running turn. An open collection
stays available until its pending metadata read settles. List loading state
does not repaint the open document, so an active selection and draft stay
anchored during an unchanged refresh. Failed deletions remain
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
selection and comment marks survive; Edit mode stays a plain textarea.

## Rules for changes

Reuse the collection, renderers and shared pane lifecycle. Keep file identity,
comment guards, owner checks and live bounds intact on every view. Files and
Artifacts share [image and PDF box comments](../comments/box/README.md).

Real browser coverage uses accepted files through the fake provider:

- Collection lifecycle: [`test_files.ts`](../../tests/mobile_browser/test_files.ts).
- Navigation: [`test_files_navigation.ts`](../../tests/mobile_browser/test_files_navigation.ts).
- Viewers: [`test_files_viewers.ts`](../../tests/mobile_browser/test_files_viewers.ts)
  and [`test_files_documents.ts`](../../tests/mobile_browser/test_files_documents.ts).
- Comments and touch gestures: [`test_files_comments.ts`](../../tests/mobile_browser/test_files_comments.ts).
- Rail badges: [`test_pane_chrome.ts`](../../tests/mobile_browser/test_pane_chrome.ts).
- Window restoration: [`test_dock_layout.ts`](../../tests/mobile_browser/test_dock_layout.ts).
- Window shortcuts: [`test_pane_hotkeys.ts`](../../tests/mobile_browser/test_pane_hotkeys.ts).
