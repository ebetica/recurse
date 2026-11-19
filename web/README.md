# Browser app

[index.html](index.html) loads [app.ts](app.ts)/[sidebar-worker.ts](sidebar-worker.ts).
[Polling](polling/) coordinates tree and focused reads across features.

**Source files:**

- [Chat](conversation/index.ts), [thread actions](thread-render.ts),
  [composer](composer/), [uploads](attachments.ts),
  [tags](conversation/draft-tags.ts), [bubbles](thread-render/user-bubble.ts),
  [disclosure state](conversation/disclosure.ts),
  [live-tail reveal](row-thread-state/live-reveal.ts),
  [reply HTML](thread-render/reply-html.ts), [view cache](conversation/cache/).
- [Sidebar](sidebar.ts), [links](deep-link.ts), [agent finder](agent-finder.ts):
  tree navigation. [Shared script contracts](../src/sidebar_script/README.md)
  validate [custom](sidebar/script.ts) and [built-in](sidebar/default_sidebar.js)
  sections.
- [dock/](dock/README.md), [panes.ts](panes.ts), [artifacts/](artifacts/), [files.ts](files.ts),
  [explorer.ts](explorer.ts), [diff.ts](diff.ts) and [side-pane.ts](side-pane.ts):
  panels and read-only side conversations. [tips/](tips/README.md) shows hourly tips.
- [Models](models.ts), [Settings](settings/), [keys](keymap.ts),
  [defaults](settings/draft-defaults/) and [safety](conversation/chrome.ts).
  [Pane search](pane-finder.ts).
- [Requests](api.ts), [backends](backends/index.ts), [connections](connection.ts),
  [ids](backends/conversation-id/), [prompts](prompt.ts), [banner](prompt/banner.ts),
  [copy](conversation/copy-button/).

## Views and connections

View resets keep settled rows. Recreated views keep same-session messages and
diagrams mounted until Clear or a new session. Navigation preserves reading
position and fences departed reads; deletes cancel reads. Focused reads come
first; cancel departed work before pane probes or Side frame warming.
Startup supplies the Side pane's post-action poll.
The composer's `/rename <title>` shares the sidebar's ordered optimistic rename
for local and remote conversations, without sending a message. Bare `/rename`
shows usage; command-menu selection inserts the title prefix.
[composer/file-finder.ts](composer/file-finder.ts) completes `#filename` with
quoted paths. Async finders keep rows until newer responses arrive.

[Operator sends](conversation/operator-send.ts) use the app's thread scroll
policy before foreground enqueue/delivery. Composer jobs and comments reuse
its transport without scrolling on retry or restore.
Stops send no message; [reads](conversation/freshness.ts) gate them.
`tests/checks/operator_send_check.ts` confines delivery and foreground enqueueing
to their owners. Sends to idle agents follow the reply bottom until the sent
message reaches the viewport top, then hold. Short replies never add scrolling. Repaints keep the reader's row as replies shrink; layout clamps never
resume following. Disclosure controls stay fixed through delayed layout. Hidden
threads retain position and following until visible. Following spans paints
before a scroll frame. [Thread scroll](thread-scroll/index.ts) owns anchoring,
scrolling and edge controls; other offsets (scrollbar, find-in-page,
scripts) release holds.
The [live panel](conversation/live-panel.ts) keeps the latest
[thought](conversation/thinking.ts) through tools, replies and reloads, even
if open in the thread. Only newer readable thinking replaces it; explicit
waiting or idle clears it. Both disclosures can stay open as work continues.
Expanded panel prose omits the title and bold markers. A command button says
“Command details” when its running count appears elsewhere.
Compacted history uses a plain marker; earlier messages and the
jump-to-first-kept link remain available.
`publish` counts files. Prompt-cache refresh adds turn usage, not replies.
[Held rows](row-thread-state/) keep context blank through Clear.
Tree usage matches loaded history or reads selected usage. Details load on opening.
Usage names the served model; a downgraded latest reply shows a ! button.

Visible main streams send `viewing=true` to suppress completion pushes. Hidden
threads close streams; embedded views report no viewers and discover no panes.
[Focused reads](conversation/fetch.ts) own stream settlement and fallbacks.
Polling supplies the fallback read and faster cadence after a changed view.
Every received push shows a notification. Clicking focuses a root app page and
selects the conversation, preferring a page already showing it; other same-origin
documents and embedded views are not app windows. Without a focusable app page,
the worker opens and focuses an absolute same-origin root URL with the conversation
fragment. Authenticated boot restores it without an opener. Clients are discoverable
before worker control; other profiles or discarded tabs may have none to reuse.

Remotes isolate health and enforce their own key policy. Cancellation stays
active through body reads, so abandoned streams and stalled discovery close.
[Tree and tag notices](backends/discovery/events.ts) share one visible-tab stream,
superseding older reads without waiting for a poll. Remote subscriptions pause
with the backend and never wake it. [Home tree reads](backends/tree.ts) patch
only the exact in-memory ETag behind the same generation fence; remotes keep
array reads. [Shared trees](shared-trees.ts) filter display, not access.

Artifact/image comments persist original crops for background send/retry.
Startup supplies rendering and connects the comment outbox to the thread.
Panes own actions. [Quote text](comments/selection-text/)
bounds quotes. Source highlighting waits while a selection draft owns the viewer.
Send controls, even later ones, stay outside native selections.
Earlier queued scrolls do not cancel selection comment offers.
Adding a comment focuses its card. In Artifacts, the highlight, adjacent edit
button, and card reopen the editor. Save updates the same comment; Cancel or
Escape keeps its text. Finish editing before submitting. Cmd/Ctrl+Enter in
a comment popover stages the draft without opening the list and returns focus
to the viewer; the next press submits. Startup routes pane keys to this handler.
Artifact submission keeps its pane/tab open; other viewers close.
Reopening retains position without reloading unchanged documents. See
[artifacts/comment-outbox.ts](artifacts/comment-outbox.ts) and
[artifacts/crop-store.ts](artifacts/crop-store.ts).
[image-preview/README.md](image-preview/README.md) describes preview gestures.
Thread images keep compact filename footers, full-name tooltips and reserved space
for lazy loading. Diagrams stage outside the flex row.
Inline captions use cached filenames, never Markdown alt text.
Artifact raster previews live in the Artifacts pane, not inline in the thread.
Artifact discovery never opens its pane; clicks and saved layouts do.
[Sibling links](artifacts/file-links.ts) reuse viewers and phone Back at the
selected version; Files shares link handling.
[Files](files/README.md) opens desktop file tabs beside Chat; phones keep in-place previews.

Phones start at the agent list (New agent, Settings). Opening adds
a conversation history step; switching replaces it. Back/title arrow return to
the list after deep links/reloads; root Back belongs to the browser. Headers
keep New agent/More (above the fade): panes, actions, then Delete agent after
a line. Composer is full width. Effort shows the model and announces the level.
Artifact links open above chat; linked Artifacts retain revisions/scroll for browser Back.
Other selections reset it. Files from an image closes its viewer
step. Pane drafts reuse that step and retain text. Tablet/embedded navigation
is unchanged. Thread drags hide the keyboard, keeping draft/caret; composer,
mouse and automatic movement keep focus.

Desktop Settings is a gear; Delete agent ends the right rail.
Shift+H toggles the list. Normal/Insert badges are screen-reader only;
no Dialog badge. Body blur keeps `g`/`w`.

## Changes

Default compares the working tree to the merge-base; HEAD shows local edits.
Both cap untracked names at 500 (folded above 20), noting the cap.
Typed refs show committed work; PRs add tracked local edits to GitHub's diff. Neither lists untracked names. See [ref rules](../src/workdir_git_work.ts).

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

[Reply paths](file-path-links.ts) share [syntax](source-preview.ts) and a 256 KB UTF-8 editor with full, escaped
canonical paths. Changed destinations refuse saves; Markdown files warn. Saves
send only paths, not contents (tools can still read them). HTML uses the
[offline viewer](document-preview.ts).

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
the web manifest served by [../src/web/notifications.ts](../src/web/notifications.ts);
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

When Web Locks are unavailable, [artifacts/send-lock/](artifacts/send-lock/)
serializes composer and comment upload, send and discard across tabs with an IndexedDB
readwrite transaction kept alive by pending requests. Its separate database does
not block crop storage. This is transaction ownership, not an expiring lease;
[artifacts/comment-outbox.ts](artifacts/comment-outbox.ts) rechecks ownership after
awaits, and server idempotency handles crash recovery.

## Settings

Only the open Settings category is mounted; closing removes its controls.
Desktop rows open sub-pages with a back link; phones use a category list and
labelled sheets. Escape, Back or Done returns to the row; resizing keeps edits.
Effort edits wait for Save. Safety review always opens a sheet. Safe preferences
autosave; credentials, passwords, two-factor and model policy need confirmation.
Prompt-cache warming saves directly in Models. Updates cover empty/draft pages;
unsent work marks the gear with a dot and accessible label. Its message and Retry sit below
categories, not the composer, with a 44px phone target.

## Document previews

[document-preview.ts](document-preview.ts) lazily mounts Files views.
[Its worker](document-preview.worker.ts) loads Mammoth, SheetJS, pptxtojson,
notebookjs and inert LinkeDOM. Conversion is capped, cancellable and worker-only.
Signature-based ZIP bounds and DOMPurify protect the opaque [CSP frame](document-media/):
raster data images only; no scripts, network, links, embeds, CSS or same-origin
access. Failures retain Download.

## Styles and assets

[settings/theme-css.ts](settings/theme-css.ts) rejects network URLs and pauses for
protected UI/Side chats. Safety-off needs confirmation; parked frames are inert.
`?customCss=off` follows Side URLs. See [CSS hooks](../docs/examples.md#theme-css).

[theme.css](theme.css) defines tokens; [icons.ts](icons.ts) supplies inline icons.
Sidebar overlays fade into their row surface, preserving selection outlines.
Android installs use standalone to avoid cutout jumps; controls use safe insets.
[brand/](brand/) holds ouroboros SVGs/PNGs traced from [logo.png](brand/logo.png).
[../src/branding.ts](../src/branding.ts) replaces marks, favicons and manifest
icons with the custom icon.

## Rules for changes

- Never commit `web/dist`; it is build output.
- Pure helpers get unit tests in `tests/web/`; user-visible behaviour gets a
  browser test in `tests/mobile_browser/` ([tests/README.md](../tests/README.md)).
- Keep diagnostics free of DOM text and input values
  ([main-thread-timing.ts](main-thread-timing.ts)).
