# Browser app

[index.html](index.html) loads [app.ts](app.ts) and [sidebar-worker.ts](sidebar-worker.ts).
[conversation/poll.ts](conversation/poll.ts) subscribes to conversations;
drafts and view state live in the browser.

**Source files:**

- [Chat](conversation/), [thread](thread-render.ts),
  [composer](composer/), [uploads](attachments.ts),
  [tags](conversation/draft-tags.ts), [bubbles](thread-render/user-bubble.ts),
  [disclosures](conversation/message-disclosure.ts),
  [reply HTML](thread-render/reply-html.ts).
- [sidebar/](sidebar/), [sidebar.ts](sidebar.ts), [deep-link.ts](deep-link.ts)
  and [agent-finder.ts](agent-finder.ts): tree navigation. Sections use the
  instance's [script](sidebar/script.ts) or the [default](sidebar/default_sidebar.js)
  Inbox, Active and Archive sections.
- [dock/](dock/README.md), [panes.ts](panes.ts), [artifacts/](artifacts/), [files.ts](files.ts),
  [explorer.ts](explorer.ts), [diff.ts](diff.ts) and [side-pane.ts](side-pane.ts):
  panels and read-only side conversations. [tips/](tips/README.md) shows hourly tips.
- [models.ts](models.ts), [settings/](settings/) and [keymap.ts](keymap.ts):
  settings and safety. [pane-finder.ts](pane-finder.ts) fuzzy-searches offered panes.
- [api.ts](api.ts), [backends/](backends/) and [connection.ts](connection.ts):
  requests. [prompt.ts](prompt.ts), [prompt/banner.ts](prompt/banner.ts): prompts.

## Views and connections

Conversation views page server projections. Live polls retain loaded history;
resetting the resident view/session replaces its served range but keeps earlier
settled rows. Navigation preserves reading position and fences departed reads
from the new conversation or draft. Deletes cancel reads. Loading the open conversation takes priority over background work. Departed work is canceled before registering
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
to their owners. Sends to idle agents follow the reply bottom until the sent
message reaches the viewport top, then hold. Short replies never add scrolling. Repaints keep the reader's row as replies shrink; layout clamps never
resume following. Disclosure controls stay fixed through delayed layout. Hidden
threads retain position and following until visible. Following spans paints
before a scroll frame. [conversation/scroll-ledger.ts](conversation/scroll-ledger.ts)
alone moves the thread; offsets it did not record (scrollbar, find-in-page,
scripts) release every hold.
The [live panel](conversation/live-panel.ts) above the composer, outside the thread,
retains the turn's latest
[thinking](conversation/thinking.ts) title and expandable text through tools, model calls and reloads. Newer
thinking replaces it, even encrypted/redacted. Its header says Thinking only
while live, then Waiting with the last readable title. Expanded prose omits the
repeated title and bold markers. Compacted history uses a plain marker;
earlier messages and the jump-to-first-kept link remain available.
`publish` counts files. Prompt-cache refresh adds turn usage, not replies.
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
Earlier queued scrolls do not cancel selection comment offers.
Adding a selection comment focuses its card immediately, without overriding a
later reader focus change. The send bar updates when a selection draft opens or closes, without waiting for
a pane refresh. Cmd/Ctrl+Enter in a comment popover stages the draft without
opening the comment list and returns focus to the viewer; the next shortcut
submits the batch. Artifact submission keeps its pane/tab open; other viewers close.
Reopening retains position without reloading unchanged documents. See
[artifacts/comment-outbox.ts](artifacts/comment-outbox.ts) and
[artifacts/crop-store.ts](artifacts/crop-store.ts).
[image-preview/README.md](image-preview/README.md) describes preview gestures.
Thread images keep compact filename footers, full-name tooltips and reserved space
for lazy loading. Diagrams stage outside the flex row.
Inline captions read the filename from cached metadata, never Markdown alt text.
Artifact raster previews live in the Artifacts pane, not inline in the thread.
Artifact discovery never opens its pane; clicks and saved layouts do.
[Sibling links](artifacts/file-links.ts) reuse viewers and phone Back at the
selected version; Files shares link handling.
[Files](files/README.md) opens desktop file tabs beside Chat; phones keep in-place previews.

Phones use the full-screen agent list as root, with New agent and Settings.
Opening adds one conversation history entry; switching replaces it. Back/title
arrow return to the list, including after direct links/reloads; root Back belongs
to the browser. Headers keep New agent/More. More opens at Delete above the fade,
with counts and Artifacts attention. Composer is full width. Artifact links
open above the conversation; Files from an image closes the viewer's history step.
Pane drafts use its history step once; replay preserves text. Tablet/embedded
navigation is unchanged. Vertical thread touch drags dismiss the keyboard,
keeping draft/caret; composer, mouse and automatic movement keep focus.

Desktop Settings is a gear by Delete; the icon rail is right.
Shift+H toggles the list. No Dialog badge. Body blur keeps `g`/`w`.

## Changes

Default compares the working tree to the merge-base; HEAD shows local edits.
Both cap untracked names at 500 (folded above 20) and report that cap.
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
send only paths, not contents (tools can still read them). HTML can show a
sandboxed [live page](html-page.ts).

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

When Web Locks are unavailable, [artifacts/comment-lock.ts](artifacts/comment-lock.ts)
serializes comment upload, send and discard across tabs with an IndexedDB
readwrite transaction kept alive by pending requests. Its separate database does
not block crop storage. This is transaction ownership, not an expiring lease;
[artifacts/comment-outbox.ts](artifacts/comment-outbox.ts) rechecks ownership after
awaits, and server idempotency handles crash recovery.

## Settings

Only the open Settings category is mounted; closing removes its controls.
Desktop uses a sidebar and inline editors; phones use a category list and
labelled sheets (Escape/Done returns to the row). Resizing preserves open edits.
Nested model pickers retain unsaved effort edits until Save. Safe preferences
autosave; credentials, passwords, two-factor and model policy need confirmation.
Prompt-cache warming saves directly in Models. Updates cover empty/draft pages;
unsent work marks the gear with a dot and accessible label. Its message and Retry sit below
categories, not the composer, with a 44px phone target.

## Document previews

[document-preview.ts](document-preview.ts) lazily mounts Files views.
[Its worker](document-preview.worker.ts) loads Mammoth, SheetJS, pptxtojson,
notebookjs and inert LinkeDOM. Conversion is capped, cancellable and worker-only.
Signature-based ZIP bounds and DOMPurify protect an opaque CSP frame:
raster data images only; no scripts, network, links, embeds, CSS or same-origin
access. Failures retain Download.

## Styles and assets

[settings/theme-css.ts](settings/theme-css.ts) rejects network URLs and pauses for
protected UI/Side chats. Safety-off needs confirmation; parked frames are inert.
`?customCss=off` follows Side URLs. See [CSS hooks](../docs/examples.md#theme-css).

[theme.css](theme.css) defines tokens; [icons.ts](icons.ts) supplies inline icons.
Sidebar overlays fade into their row surface, preserving selection outlines.
Installed Android apps use fullscreen; mobile controls respect safe-area insets.
[brand/](brand/) holds ouroboros SVGs/PNGs traced from [logo.png](brand/logo.png).
[../src/branding.ts](../src/branding.ts) replaces marks, favicons and manifest
icons with the custom icon.

## Rules for changes

- Never commit `web/dist`; it is build output.
- Pure helpers get unit tests in `tests/web/`; user-visible behaviour gets a
  browser test in `tests/mobile_browser/` ([tests/README.md](../tests/README.md)).
- Keep diagnostics free of DOM text and input values
  ([main-thread-timing.ts](main-thread-timing.ts)).
