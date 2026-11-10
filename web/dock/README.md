# Desktop windows

The desktop workspace puts the chat and registered panes in draggable, tabbed
windows. Phones keep the pane overlay and do not request dockview or its CSS.

## Source files

- [desktop.ts](desktop.ts) bridges the pane lifecycle to the lazy host, parks a
  closed chat without discarding its draft, and restores the phone layout.
- [host.ts](host.ts) adapts dockview's tabs, splits and resizing to existing DOM
  content. [commands.ts](commands.ts) owns window navigation, arrangement and
  transient split hints. [layout.ts](layout.ts) validates saved native grids without
  importing the window library. [style.css](style.css) applies the shared card
  tokens, tab styling and keyboard hints.
- [../panes/file-tabs.ts](../panes/file-tabs.ts) keeps bounded file definitions
  and positively validated source descriptors inside native layouts.

Asset publication combines the vendor stylesheet and adapter styles. Optional
vendor variables have local defaults derived from the shared palette, keeping
generated themes complete without adding library-specific global theme tokens.

## Opening and focus

Opening an existing pane shows its tab. A new pane joins the last-used window
that contains neither Chat nor Explorer, otherwise the right-most eligible
window. With no eligible window it opens to the right of Chat. Automatic opens
preserve DOM focus; a hidden new tab keeps the accent until first shown.
Explorer and Files items instead join Chat as tabs, unless a one-shot split was requested.
Their tree and list stay separate. A repeated folder/path selects the existing file tab
and keeps its content and notes. Phones retain the in-place preview. At most eight
file tabs open together; 32 definitions and the existing pane-body cache bound
inactive state. Closing a file with staged notes uses the shared discard guard.
Dragging a tab to an edge splits a window; dropping it in the middle joins tabs.
Tabs show their full titles while they fit. On overflow, inactive tabs show only
their icons, keeping full-name tooltips and accessible labels; the active title
stays complete. Native horizontal scrolling keeps every tab reachable at narrow
widths.

The active pane's fullscreen button lives at the right of its window's tabstrip;
close stays on each tab. Pane-specific pickers and actions remain below the tabs,
and panes without those controls have no empty extra row. The same native
fullscreen button returns to its pane before fullscreen or phone layout, keeping
its handler, focus and keyboard ownership. Desktop fullscreen is a layout,
not a modal dialog; phone overlays remain modal. Tab stays within the visible
fullscreen pane. Window keys (`g`/`w` and `z`) also work from focused non-editor
controls; native button activation keeps its keys. Chat activity controls retain
thread shortcuts while Enter and Space activate the focused control. Window controls retain their
pane's keyboard and staged-comment ownership; conversation or availability
cleanup restores the usual tree/menu focus.

Dockview activation is not keyboard focus. Its tabs and wrappers are not Tab
stops. Clicking Chat returns to Normal mode without adding a focusable chat
wrapper; clicking a pane tab focuses that pane's content. Real controls retain
native focus. Only the focused window flashes briefly; changing focus cancels
the previous window's flash. Its active tab keeps an accent line. Initial layout
runs after pane sizing is refreshed, so the first windows use the host's actual
bounds before input resumes. Initial mounting waits for visible content before
moving Chat, preserving the active composer's draft and selection. Every content move restores
native editing selection even when the browser retains focus, so typing immediately
after mounting still advances the caret and opens command suggestions. Dragging
preserves the composer's focus, draft and selection. Moving an already-focused pane
updates its window ownership without requiring a new focus event. Content temporarily
parked during layout changes keeps its keyboard focus targets.
Pane focus waits for a visible window and enabled controls. New keyboard,
pointer or input actions cancel an unfinished focus request. Closing a pane
restores its opener only if focus has not moved elsewhere. Submitting comments
keeps that pane closed through refreshes and later visits until reopened;
other panes retain their staged comments.
Closing Chat keeps its content parked; composing reopens it.
Narrowing to phone keeps the focused pane or the pane owning a floating comment
draft, including its editor focus and selection. Cleaning up another pane must
not cancel that draft. Global pane and agent finders are mounted outside Chat
while open so hidden or closed Chat tabs cannot hide them. Their inputs stay near
the viewport's vertical middle as results change; lists scroll within the available
height. Mentions remain beside the composer, and phone placement is unchanged.

## Conversation layouts

Each conversation remembers its native window splits, sizes, tabs, active tabs and
closed Chat in this browser, including after reload. The existing conversation
UI-state store owns retention, draft promotion, cross-tab field merging and owner
cleanup. Its versioned `window-layout` field permits at most 32,000 JSON characters;
other pane fields retain their 3,000-character limit. Record and owner bounds stay
unchanged. Unknown panels/renderers, unsupported native options, duplicate
membership, invalid dimensions or orientation, excessive nesting and oversized
layouts fall back to the usual view. File panels alone may carry validated
source/key parameters; static panes still reject native parameters. File keys
identify the working folder and relative path, never a URL. Opening resolves the
server's current folder rather than trusting an older tree listing. File reads on
restoration must match the saved folder; unavailable file tabs are omitted only
from the live grid, retaining other windows and the original saved snapshot.

Only operator window arrangements save: opening, closing, moving, resizing,
splitting, selecting tabs, balancing and Only mode. Automatic pane opens, content
controls and viewport changes leave the last operator snapshot unchanged. Pending
operator changes are captured before pane teardown or page hiding. A fresh
default grid is not saved. An existing visible, unmaximized Chat-only grid is
reused for the default view. Incoming restoration waits for that conversation's
rendered view and offered panes without delaying
its thread. Chat stays usable during discovery. A settled unavailable pane uses
the usual view for this visit but retains the saved snapshot for a later visit;
a corrupt or incompatible snapshot is replaced by the default, including the
existing explicit pane preference. Operator arrangements cancel a pending
restore. Restoration preserves connected content, keyboard focus and editing
selection across the whole replacement, including temporary parking; a pane
comment draft is never displaced.
Window focus history, merge directions and one-shot opening hints do not cross
conversation visits.
Phones retain their own overlay choice and never overwrite the desktop arrangement;
returning to desktop restores it while preserving the composer's draft and caret.

## Pane keys

`o` opens the pane finder from the agent list, thread or a pane, including Chat.
Picking Chat focuses the thread, reopens its closed tab with the draft intact,
and leaves another window's fullscreen/Only view. On phones it returns to the
conversation. Initial order uses bounded device-local opening history, decayed
over time; Chat openings from the finder count too. Typing filters by title.
Arrow keys select, Enter opens, and Escape returns focus.
Already-open panes, including Chat, are labelled Open. `g1`–`g9` open panes in rail order;
rail tooltips show the keys. `q` closes the focused pane, `i` focuses the
composer, and other printable keys never start a draft from a pane. `wQ` closes
all panes and leaves Chat open, preserving its draft and caret. Plain `p` no
longer changes focus.
In a pane, `j`/`k` move through items or scroll, `d`/`u` scroll half a page,
and `gg`/`G` go to the top/bottom. Normal-mode `G` still jumps to the latest
message. [../panes/navigation.ts](../panes/navigation.ts) shares the neutral item
cursor and scroll fallback; each pane's `navigate` adapter owns item actions.
Changes uses [../diff/navigation.ts](../diff/navigation.ts): `l`/Enter expands a
file, `h` collapses, `[`/`]` select files, `/` focuses its filename filter, and
`y` copies the selected path. [Files](../files.ts) uses the same cursor:
`l`/Enter opens, `h` returns to its filtered list, `[`/`]` select list items or
step through detail files, `/` filters filenames, and `y` copies the download
link (or unavailable file's name). Its arrow keys, image viewer and unfiltered
touch list remain unchanged. Native controls retain Enter activation and editors
keep typing. Artifacts keeps its detail view until `h` (All artifacts) or `/`
opens its local title-filtered list; `l`/Enter opens the cursor item. Back asks
before discarding staged comments. In detail, `[`/`]` step older/newer versions,
`j`/`k` scroll rather than switch Artifacts, and `y` copies the displayed Artifact's
download link. Touch keeps the native picker. Side conversations uses the same
list/filter/open keys, `[`/`]` for neighbouring conversations and `y` for the
conversation link. Detail navigation scrolls the embedded thread, releasing its send and bottom
following before moving so later repaints and resizing keep the reader's position.
Browsing keeps its frame and draft mounted. Desktop reader keys inside the
focused frame use the owning pane's shared key dispatcher, including window
commands after layout changes. Editors and native control activation retain
their keys; Escape cancels window commands without entering agent-list shortcuts.
Parked frames cannot relay keys. Phones retain their touch controls.
[../keymap.ts](../keymap.ts) owns
bindings; [../pane-finder.ts](../pane-finder.ts) owns the finder.

## Window keys

`gh`/`gj`/`gk`/`gl` focus the window left/below/above/right, including Chat.
Horizontal navigation walks tabs first without wrapping; entering a window from
its right selects its last tab. `gp` returns to the previous focused window;
repeating it toggles between two windows. The `g` and `w` prefixes show a small
key list, also listed under Keyboard shortcuts. Editors, native modified keys,
finders and dialogs keep their own input.

`wh`/`wj`/`wk`/`wl` move the active tab left/below/above/right beside the neighbouring
window, or split it from its current tabs at an empty edge. Capitals remain aliases. `wv`/`ws` place the next newly opened
window to the right/below the focused window. The tabstrip shows that one-shot
choice until a new pane consumes it or Escape cancels it; showing an existing tab
does not consume it. Automatic opens still preserve focus.

`wt` joins sibling windows as tabs in layout order. `we` separates tabs, retaining
the joined direction, or changes a split's direction. `wo` shows only this window;
repeating it restores the same layout. `wf` and `z` toggle fullscreen, including
Chat; `wq` closes the active tab. Window navigation and arrangement leave
fullscreen/only views before moving to another window. `w=` equalizes split
sizes. `wr` enters Resize mode: `h`/`l` narrow/widen, `k`/`j` decrease/increase height, and
Escape or Enter finishes. Dockview applies its size constraints.

Only uses native maximization. Direction changes and equal sizing apply a
transient serialization of the live grid, never a parallel layout model. The host
parks existing content in connected DOM while rebuilding wrappers, preserving
frames, drafts and caret positions. Redundant split wrappers are collapsed, so
repeated direction changes cannot grow a history-shaped tree. Phones retain the
existing layout and do not load window commands.

## Rules for changes

- Keep dockview and its styles behind the desktop-only import.
- Preserve existing pane ownership, comment guards and bounded caches.
- Exercise focus and layout through Chromium on the built app, including phones.
