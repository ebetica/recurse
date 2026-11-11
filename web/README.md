# Browser app

[app.ts](app.ts) and [sidebar-worker.ts](sidebar-worker.ts) are separate
TypeScript bundles loaded by [index.html](index.html). The server owns durable
conversations; the browser owns view state and unsent drafts.
[conversation/poll.ts](conversation/poll.ts) reads and subscribes to live state.

**Source files:**

- [conversation/](conversation/), [thread-render.ts](thread-render.ts),
  [composer/](composer/) and [attachments.ts](attachments.ts): rendering,
  input and uploads. [conversation/draft-tags.ts](conversation/draft-tags.ts)
  shares the sidebar's tag picker and defaults.
- [sidebar/](sidebar/), [sidebar.ts](sidebar.ts), [deep-link.ts](deep-link.ts)
  and [agent-finder.ts](agent-finder.ts): tree navigation. Sections use the
  instance's [script](sidebar/script.ts) or the [default](sidebar/default_sidebar.js)
  Inbox, Active and Archive sections.
- [dock/](dock/README.md), [panes.ts](panes.ts), [artifacts/](artifacts/), [files.ts](files.ts),
  [explorer.ts](explorer.ts), [diff.ts](diff.ts) and [side-pane.ts](side-pane.ts):
  panels and read-only side conversations. [tips/](tips/README.md) shows hourly tips.
- [models.ts](models.ts), [settings/](settings/) and [keymap.ts](keymap.ts):
  settings and keys. [pane-finder.ts](pane-finder.ts) fuzzy-searches offered panes.
- [api.ts](api.ts), [backends/](backends/) and [connection.ts](connection.ts):
  requests and connections. [prompt.ts](prompt.ts) shows captured model requests.

## Views and connections

Conversation views page server projections. Live polls retain loaded history;
resetting the resident view/session replaces its served range but keeps earlier
settled rows. Navigation preserves reading position and fences departed reads
from the new conversation or draft. Deletes cancel reads. Loading the open
conversation takes priority over background work and caching. Departed work is canceled before registering
new pane probes or warming the parked Side frame.
The composer's `/rename <title>` shares the sidebar's ordered optimistic rename
for local and remote conversations, without sending a message. Bare `/rename`
shows usage; command-menu selection inserts the title prefix.
[composer/file-finder.ts](composer/file-finder.ts) completes `#filename` with
quoted paths. Async finders keep rows until newer responses arrive.

[conversation/operator-send.ts](conversation/operator-send.ts) applies the open
thread's scroll policy before foreground enqueue/delivery. Composer jobs and
persisted comments reuse its transport without scrolling on retry/restoration.
Stops have a separate typed transport without message content.
`tests/checks/operator_send_check.ts` confines delivery and foreground enqueueing
to their owners. Sends to idle agents, including image/Artifact comments, follow
the reply bottom until the sent message reaches the viewport top, then hold until
reader movement. Short replies add no blank space or scrolling. After a reader
scrolls away, repaints hold the visible row even if a live reply shortens the
thread; layout clamps never resume following. Disclosure controls stay fixed
through delayed layout until reader movement. Hidden scrolls retain position
and following until visible. Jump to latest resumes following through repaints.
The live panel above the composer, outside the thread
([conversation/thread.ts](conversation/thread.ts)), retains the turn's latest
thinking title and expandable text through tools, model calls and reloads. Newer
thinking replaces it, even if encrypted/redacted. Its header says Thinking only
while live, then Waiting with the last readable title. Expanded prose omits the
repeated title and bold delimiters. Compacted history uses a plain marker;
earlier messages and the jump-to-first-kept link remain available.
Prompt-cache refresh adds cost/tokens to the turn, not another reply.
The context footer stays blank while Clear rotates history. Tree usage must
match loaded history, or it reads selected usage. Details load on opening.
Usage names the served model; a downgraded latest reply shows a ! button.

Visible main streams report `viewing=true` to suppress agent-finished pushes.
Hidden tabs and the phone list close streams; embedded Side views never report
a viewer or discover panes, even when a tree read finishes after parking.
Every received push shows a notification. Clicking focuses a root app page and
selects the conversation, preferring a page already showing it; other same-origin
documents and embedded views are not app windows. Without a focusable app page,
the worker opens and focuses an absolute same-origin root URL with the conversation
fragment. Authenticated boot restores it without an opener. Clients are discoverable
before worker control; other profiles or discarded tabs may have none to reuse.

Backend-bound requests use the same UI for home and remote conversations.
Remote health is isolated from home health, and the remote's key policy remains
the authority. Request cancellation remains active after response headers, so
abandoned streams close and stalled discovery bodies cannot strand boot restore. [backends/events.ts](backends/events.ts) receives tree-change
tag-change notices for home and connected remotes over one visible-tab SSE connection.
Notices fence older reads and start fresh tree reads without waiting for the
fallback poll. The server multiplexes remote notices to preserve browser
connection slots. Remote subscriptions pause with the backend's existing sleep
state and do not themselves count as activity or wake a sleeping backend. [shared-trees.ts](shared-trees.ts) filters the displayed tree
but does not grant access.

Artifact and image comments persist for background sending and retry; crop
storage preserves the original pixels. Comment send controls stay outside native
text selections, including when they appear after a paragraph is selected.
Scroll events queued before a selection gesture do not cancel its comment offer.
Adding a selection comment focuses its card immediately, without overriding a
later reader focus change. The send bar updates when a selection draft opens or closes, without waiting for
a pane refresh. Cmd/Ctrl+Enter in a comment popover stages the draft without
opening the comment list and returns focus to the viewer; the next shortcut
submits the staged batch. Submitting comments closes the pane; reopening preserves the
reading position on desktop and phones without reloading unchanged documents. See
[artifacts/comment-outbox.ts](artifacts/comment-outbox.ts) and
[artifacts/crop-store.ts](artifacts/crop-store.ts).
[image-preview/README.md](image-preview/README.md) describes preview gestures.
Thread images keep compact filename footers, full-name tooltips and reserved space
for lazy loading. Diagrams stage outside the flex row.
Inline captions read the filename from cached metadata, never Markdown alt text.
Artifact raster previews live in the Artifacts pane, not inline in the thread.
Closed Artifact list reads update availability on completion for the visible conversation.
[Files](files/README.md) opens desktop file tabs beside Chat; phones keep in-place previews.

Phones use the full-screen agent list as root, with New agent and Settings.
Opening adds one conversation history entry; switching replaces it. Back/title
arrow return to the list, including after direct links/reloads; root Back belongs
to the browser. Headers keep New agent/More. More opens at Delete above the fade,
with counts and Artifacts attention. The composer is full width. Artifact links
open above the conversation; Files from an image closes the viewer's history step.
Pane drafts consume its history step once; replay preserves text. Tablet/embedded
navigation is unchanged. Vertical thread touch drags dismiss the keyboard without
changing draft/caret; composer, mouse and automatic movement retain focus.

Desktop Settings is a gear beside Delete; the icon rail is on the right.
Shift+H toggles the list. No Dialog badge.

## Changes

By default Changes shows the folder's changes, uncommitted edits included. A
typed branch, tag or commit shows that committed work: a merged commit's own
change, or unmerged work since main or the nearest ancestor branch. HEAD means
uncommitted changes; pull requests keep their GitHub diff.

## Working-folder Explorer

[explorer.ts](explorer.ts) adds rail/menu browsing locally or by proxy. Older
remotes show update guidance. [explorer.css](explorer.css) shares tokens and
buttons. Opening or
refreshing follows the agent's latest folder unless staged comments retain the
loaded file snapshot. Folders load one page; Show more pages and collapsing drops
children. About 1,000 rows are retained; replacement notices offer Refresh folder.
There is no recursive download or probe of closed files. Desktop files open in
tabs beside Chat; Explorer keeps its tree and search. Reopening selects the same
folder/path's existing tab. [panes/file-tabs.ts](panes/file-tabs.ts) bounds tabs and
definitions; descriptors use the existing window-layout store. Restoration reads
named tabs after the conversation paints. Unavailable files are skipped for the
visit without changing the saved layout. Phones keep in-place previews.

Read-only UTF-8 previews offer Download and chunked Load more, capped at 256K
characters; remaining or non-text content is download-only. Readable files,
including dotfiles, can open. Symlinks and special files stay unavailable.
HTML Preview uses the [offline viewer](document-preview.ts).

Selecting text stages the same quote-and-line comments as Files and Artifacts.
Comments include the opened file's absolute path and go through the shared
submission outbox. Loading more text preserves existing marks and line offsets.
File tabs show the path and Download; their Files button stays on phones only.
On desktop, `h` focuses Explorer without discarding a file tab's notes;
closing its tab uses the shared discard guard. Phones ask before replacing an
annotated preview. Escape preserves the annotated body in the bounded pane cache.
Reopening resolves the current working folder but reuses that body and its notes.
Conversation changes use the shared unsent-comment guard.

Filename search debounces and aborts superseded reads through the agent's fff
service, preserving names/order, including unavailable entries. Matches are
highlighted; field arrows choose, Enter opens and Escape clears. Leaving aborts
reads. Desktop vim keys (j/k, gg/G, l/h, /, y, [ ]) move, open, search, copy paths
and step through loaded files; phones keep native controls.

## HTTP and browser capabilities

The app supports plain HTTP origins as well as HTTPS. Copy actions share
[tool_details.ts](tool_details.ts)'s clipboard helper: when the Clipboard API is
unavailable, a temporary textarea copies synchronously during the click, without
losing the browser's user gesture. Failed copies remain visible to the operator.
[settings/auth.ts](settings/auth.ts) uses the same helper for device sign-in codes.
[files.ts](files.ts) falls back from unavailable Web Share to ordinary downloads.
Image shares retain admitted file media types; local-path images use the
byte-checked response type.
Push notifications require a secure context;
[settings/notifications.ts](settings/notifications.ts) disables the setting on HTTP
and explains that HTTPS is required. Loopback origins that browsers consider
trustworthy retain secure-context capabilities. [index.html](index.html) links
the authenticated web manifest served by [../src/web/notifications.ts](../src/web/notifications.ts);
there is no app-owned install button or install-prompt hook. The browser controls
whether installation is available on the current origin.

Browser UUID callers fall back when `crypto.randomUUID` is unavailable:
[conversation-ui-state/store.ts](conversation-ui-state/store.ts) uses random bytes
or a local UI-only identifier, [show-timing.ts](show-timing.ts) uses a timestamp
and sequence, and [stop-control/id.ts](stop-control/id.ts) uses random bytes before a
non-secret local fallback. `crypto.getRandomValues` works on HTTP; browser code
does not require `crypto.subtle`, `navigator.storage` or media-device access. Local/session storage
and IndexedDB also work on HTTP, independently of HTTPS storage for the same host.
Unavailable or full storage is still a persistence failure, not permission to
silently discard pending comments.

When Web Locks are unavailable, [artifacts/comment-lock.ts](artifacts/comment-lock.ts)
serializes comment upload, send and discard across tabs with an IndexedDB
readwrite transaction kept alive by pending requests. Its separate database does
not block crop storage. This is transaction ownership, not an expiring lease;
[artifacts/comment-outbox.ts](artifacts/comment-outbox.ts) rechecks ownership after
awaits, and server idempotency handles crash recovery.

## Settings

Settings uses a desktop category sidebar and phone category list, with rounded
value/switch rows. Editors, provider sign-in, usage and model pickers stay inline
on desktop; phones use labelled sheets with Escape/Done returning to the row.
Resizing preserves edits and closes desktop sheets. Nested model pickers retain
unsaved effort edits until the ladder is saved. Safe preferences autosave;
credentials, passwords and model policy require confirmation. Prompt-cache
warming saves directly in Models. Unsent work blocking an update marks the gear
with an upper-right dot and accessible label. Its message and Retry action sit
below categories, not the composer, with a 44px phone target.

## Document previews

[document-preview.ts](document-preview.ts) lazily mounts Files views.
[Its worker](document-preview.worker.ts) loads Mammoth, SheetJS, pptxtojson,
notebookjs and inert LinkeDOM. Conversion is capped, cancellable and worker-only.
Signature-based ZIP bounds and DOMPurify protect an opaque CSP frame:
raster data images only; no scripts, network, links, embeds, CSS or same-origin
access. Failures retain Download.

## Styles and assets

[theme.css](theme.css) defines design tokens and [icons.ts](icons.ts) provides
inline icons. Sidebar action overlays fade into the current row surface, sharing
its background token and leaving selection outlines visible. Installed Android
apps use fullscreen display; mobile chrome and Settings keep controls clear of
display cutouts using safe-area insets.
[brand/](brand/) holds the default ouroboros mark; its SVGs and PNG icons come
from one outline traced from [logo.png](brand/logo.png).
[../src/branding.ts](../src/branding.ts) owns instance branding: a custom icon
replaces the mark, favicons and manifest icons.

## Rules for changes

- Never commit `web/dist`; it is build output.
- Pure helpers get unit tests in `tests/web/`; user-visible behaviour gets a
  browser test in `tests/mobile_browser/` ([tests/README.md](../tests/README.md)).
- Keep diagnostics free of DOM text and input values
  ([main-thread-timing.ts](main-thread-timing.ts)).
