# Browser app

[index.html](index.html) loads `/static/app.js`. The [browser build](../src/launcher/build.cli.ts)
bundles [app.ts](app.ts), [sidebar-worker.ts](sidebar-worker.ts) and
[document-preview.worker.ts](document-preview.worker.ts). [sidebar/script.ts](sidebar/script.ts)
starts `/static/sidebar-worker.js`; [the server](../src/web/notifications.ts)
serves [push-worker.ts](push-worker.ts) at `/push-worker.js`.

## Source files

- Chat: [conversation](conversation/README.md), [composer](composer/README.md),
  [thread rendering](thread-render/README.md), [thread scrolling](thread-scroll/README.md),
  [held rows](row-thread-state/README.md), [pending queue](pending-queue/README.md),
  [conversation UI state](conversation-ui-state/), [context](context/),
  [stop control](stop-control/) and [uploads](attachments.ts).
- Navigation: [sidebar](sidebar/README.md), [agent finder](agent-finder/),
  [deep links](deep-link.ts), [pane finder](pane-finder.ts) and [keys](keymap.ts).
  The [shared script contracts](../src/sidebar_script/README.md) validate
  [custom](sidebar/script.ts) and [built-in](sidebar/default_sidebar.js) sections.
- Panes: [lifecycle](panes.ts) and [helpers](panes/README.md), [desktop windows](dock/README.md),
  [Artifacts](artifacts/README.md), [Files](files/README.md), [Explorer](explorer/README.md),
  [Changes](diff.ts) and its [diff viewer](diff/README.md), [Side chats](side-pane.ts),
  [hourly tips](tips/README.md), and [image previews](image-preview/README.md).
- Shared pane content: [comments](comments/), [selection text](comments/selection-text/README.md)
  and [document media](document-media/). See [document previews in Files](files/README.md#documents).
- Settings and input choices: [Settings](settings/README.md), [models](models.ts)
  and [model finders](models/), [prompt](prompt.ts) and its [banner](prompt/banner.ts),
  and [skills](skills/).
- Requests: [API](api.ts), [backends](backends/README.md),
  [connections](connection.ts) and [transport helpers](connection/).
  [Polling](polling/) coordinates tree and focused reads across features.
- Shared assets and helpers: [brand](brand/), [theme](theme.css),
  [icons](icons.ts), and [utilities](util/).

For [Changes](diff.ts), Default compares the working tree to the merge base and
HEAD shows local edits (both report the 500-name cap and fold the untracked list
above 20); [typed refs](../src/workdir_git_work.ts) show committed work and PRs
add tracked local edits to GitHub's diff, without untracked names in either view.

## Navigation and keys

[Phone navigation](phone-nav.ts) starts at the agent list (New agent, Settings).
Opening adds a conversation history step; switching replaces it. Back/title
arrow return to the list after deep links or reloads; root Back belongs to the
browser. Headers keep New agent and More above the fade: panes, actions, then
Delete agent after a line. The composer is full width.

Artifact links open above chat. Linked Artifacts retain revisions and scroll
position for browser Back; other selections reset that history. Files from an
image closes its viewer step. Pane drafts reuse that step and retain text. The
phone history rules apply only at widths of 700 px or less and outside embeds.
On phones, Side chats is a bordered card in the lower four fifths of the
visible area below the header, so the parent stays visible above it; tapping
the parent closes the card. Desktop shows it as an ordinary window.
Thread drags hide the keyboard, keeping draft and caret; composer, mouse and
automatic movement keep focus.

Desktop Settings is a gear; Delete agent ends the right rail. Shift+H toggles
the agent list. Normal and Insert badges are screen-reader only; there is no
Dialog badge. Losing focus to the body keeps `g`/`w` prefixes.

## Working-folder Explorer

[Explorer](explorer/README.md) adds rail and menu browsing locally or by proxy.
Older remotes show update guidance. [explorer.css](explorer.css) shares tokens
and buttons. Opening or refreshing follows the agent's latest folder unless
staged comments retain the loaded file snapshot. Folders load one page; Show
more loads another and collapsing drops children. About 1,000 rows are
retained; replacement notices offer Refresh folder. There is no recursive
download or probe of closed files.

[Desktop windows](dock/README.md#opening-and-focus) describes shared tab opening,
reuse and bounds. Descriptors are saved with the window layout. Tabs paint on
agent switch and load separately. Missing files stay open with an error. On
phones, Back and Close ask before discarding edits in Explorer.

[Reply paths](file-path-links.ts) share a 256 KiB UTF-8 editor with full,
escaped canonical paths. [Files](files/README.md#ownership-and-lifetime)
describes shared source syntax. Changed destinations refuse saves. The server's
[prompt-resource check](../src/web/explorer.worker.ts) warns for `.md`,
`.markdown` and `.mdx` files and for prompt context files: “This file’s
contents are sent to the model. Don’t save secrets here.” Saves notify the
agent with the path, not the contents (tools can still read them). HTML uses
the [offline viewer](files/README.md#views).

Selecting text stages the same quote-and-line comments as Files and Artifacts.
Comments include the opened file's absolute path and go through the shared
submission outbox. Loading more text preserves existing marks and line offsets.
File tabs show the path and Download; their Files button is phone-only. On
desktop, `h` focuses Explorer without discarding a file tab's notes. Phones ask
before replacing an annotated preview. Escape preserves the annotated body in
the bounded pane cache. Reopening resolves the current working folder but
reuses that body and its notes. Conversation changes use the shared
unsent-comment guard.

Filename search debounces and aborts superseded reads through the agent's fff
service, preserving names and order, including unavailable entries. Matches are
highlighted; field arrows choose, Enter opens and Escape clears. Leaving aborts
reads. Desktop Vim keys (j/k, gg/G, l/h, /, y, [ ]) move, open, search, copy paths
and step through loaded files; phones keep native controls.

## Notifications and installation

Every received push shows a notification. Clicking focuses a root app page and
selects the conversation, preferring a page already showing it; other same-origin
documents and embedded views are not app windows. Without a focusable app page,
the worker opens and focuses an absolute same-origin root URL with the conversation
fragment. Authenticated boot restores it without an opener. Clients are discoverable
before worker control; other profiles or discarded tabs may have none to reuse.

[index.html](index.html) links the [server's web manifest](../src/web/notifications.ts).
The browser controls installation for the current origin; the app has no
install button or install-prompt hook.

## Styles and assets

Keep the shell in [index.html](index.html) as markup. Put always-loaded CSS
in `style.css` beside its feature, and add it to the ordered
[app.css source list](../src/launcher/frontend_assets.ts). [app.css](app.css)
comes last so shared buttons, badges, menus, dialogs, fields and panes keep
winning ties. Optional views can link separate stylesheets on demand. Run
`bun run build:assets` to see CSS edits in live mode.

[theme.css](theme.css) defines tokens; [icons.ts](icons.ts) supplies inline icons.
Sidebar overlays fade into their row surface, preserving selection outlines.
Controls use safe insets. [brand](brand/) holds ouroboros SVGs and PNGs traced
from [logo.png](brand/logo.png). [branding.ts](../src/branding.ts) replaces
marks, favicons and manifest icons with the custom icon.

## Rules for changes

- A subfolder README owns its folder's behaviour. This README owns how the
  parts fit together, root features without a folder and web-wide rules.
- Browser code must work on plain HTTP. Don't require `crypto.subtle`,
  `navigator.storage` or media devices. `crypto.randomUUID`, Web Locks, the
  Clipboard API, Web Share and push may be missing; trustworthy loopback
  origins retain secure-context features. Use the existing fallbacks for
  [UUIDs](conversation-ui-state/store.ts), [timing IDs](show-timing.ts),
  [Stop IDs](stop-control/id.ts), [send locks](artifacts/send-lock/README.md),
  [copying](tool_details.ts), [sharing](files/README.md#views) and
  [notifications](settings/notifications.ts). HTTP and HTTPS have separate
  local/session storage and IndexedDB; a missing or full store is a persistence
  failure, never permission to drop pending comments.
  - `crypto.getRandomValues` works on HTTP. Draft UI and Stop IDs fall back to
    random bytes, then non-secret local IDs; timing IDs use a timestamp and sequence.
  - When the Clipboard API is unavailable, the shared helper copies from a
    temporary textarea synchronously during the click. Keep failures visible;
    [device sign-in codes](settings/auth.ts) use the same helper.
- Never commit `web/dist`; it is build output.
- Pure helpers get unit tests in `tests/web/`; user-visible behaviour gets a
  browser test in `tests/mobile_browser/` ([tests/README.md](../tests/README.md)).
- Keep diagnostics free of DOM text and input values
  ([main-thread-timing.ts](main-thread-timing.ts)).
