# Sidebar scripts

The script API is experimental: it is documented but may change without
migration. Recurse updates may require editing a custom script.

## Source files

- `default_sidebar.js` keeps roots in Pinned, Inbox, Active and Archive,
  hiding each section when it is empty;
  `default_sidebar.d.ts` documents every script row field.
- [Shared row and action contracts](../../src/sidebar_script/README.md) project
  cached local/remote Agent metadata and check sections and actions. API v1
  fields retain their contract; sidebar extras remain experimental.
- [The worker engine](../../src/sidebar_script/engine/README.md) runs the pure,
  stateless `sidebar(rows, now)` in a fresh sandbox.
- `index.ts` exposes the shared change signal, tag views, dialogs and tree
  helpers without importing the tree renderer.
- `tag-state.ts` owns optimistic tags until a tree read begun after the answer
  confirms them. `dialogs.ts` shares one tag, snooze or confirmation popover
  between sidebar actions and the optional draft control.
- `sections.ts` draws sections; `script.ts` manages the worker and saved script.
- [style.css](style.css) keeps the agent list, shared agent rows, section
  actions, and tag and hold menus together. It ships in `app.css` so the
  list and the active-agent dialog use the same row styles on first paint.
- `actions.ts` and `hold.ts` handle tag actions and hold menus. App startup
  supplies `action-handlers.ts` with the tree refresh shared by link lookup
  and sidebar mutations, the draft action for sections and remote headers, and
  the row and selection actions used by the active-agent dialog.
- `drag.ts` owns desktop agent drop targets and feedback. `row-touch.ts` owns
  phone row and section holds and left-swipe deletion. The renderer supplies
  actions and pauses repaint during an active swipe.
- Sidebar history completes boot links by correcting the URL before opening the
  linked artifact or reporting an unavailable agent.
- `focus.ts` refreshes the list before focusing its cursor, with the phone menu
  fallback. App startup supplies rendering; pane exits import only this helper.
- `agent-folds.ts` remembers, on this device, which agents list their
  subagents (opened with l/Right, folded with h/Left), so the agent list keeps
  its shape across reloads and server restarts. A one-time reset discards saved
  opens from the old format, which included automatic reveals, while preserving
  the saved h/Left fold. Storage holds at most 500
  agent ids, discarding the oldest opens first and deleted home agents after
  an authoritative tree read. Selection reveals the agent's children and
  ancestors only while selected; opening another row with l/Right does not save
  that reveal. The ancestors of taken-over agents stay open unless manually
  folded or limited by the tree's size caps. Pressing l/Right on the selected
  agent keeps its children open after leaving. A selected agent's h/Left fold
  lasts until selection changes.
  `sections.ts` remembers section folds separately.

Side conversations are excluded from both script inputs and stay in the Side
pane. Rows require no extra record, transcript or GitHub reads. Usage is not in the
tree snapshot and is omitted. Branch and current directory are optional and only
included if recorded. Remote rows use qualified ids and set `remote` to true.
Rows expose `unread: true` after a notification-eligible finish, independently of
notification subscriptions. The shared row renderer centers an accent dot in place
of the activity time, preserving its space and tooltip on desktop, phones and the
active-agent dialog. Row action overlays cover the dot. Section headers have no
unread indicator. Opening the main conversation clears it on the owning server and all
devices over tree events; watching it finish keeps it cleared. This applies to
custom layouts and remote rows whose backend supplies `unread`, without extra
polling. Older remotes default to false.
The same arrangement is shown under each backend label, with independent folds.
Section labels sit close above their first row. Hovered or focused section
headers show compact actions without moving rows. Actions scroll sideways if
their labels do not fit. Phones use the hold menu; fold targets extend upward
to keep 44px tap targets without adding space below the label.
Sections may set the optional boolean `hideWhenEmpty` to hide their header,
actions and empty text when no checked rows remain for that backend. It defaults
to false. Hidden sections leave no space and keep their fold preference when rows
return; section order and action targets are unchanged.
Tag actions overlay the local tree immediately, before sending to the owning
backend. The built-in layout renders synchronously; custom layouts render when
the worker answers, discarding superseded results. New rows wait for their checked
layout rather than flashing in Unsorted. The overlay survives older
tree reads until a read started after the durable POST answer confirms it.
Home and remote tree changes also arrive over one visible-tab event stream, so
agent changes and actions on other devices do not wait for the fallback poll.
Older remotes without v1 tag fields keep their rows but omit tag actions.
Tagging UI is opt-in through a custom sidebar script; the built-in layout has no
tag actions, tag sections or draft tag control. The project-group example enables
Tag…, Untag, nested Active, Inbox and Archive sections, and the optional draft
control.

## Moving agents

Desktop drags onto a row nest under that agent; drags at its top or bottom edge
choose its parent, including top level. The indented line shows the destination
level, not a saved position: the script and activity order still sort siblings.
Section headers are not move targets. Moves keep the subtree together, refuse
cycles and remain local-only. Phones and keyboard navigation are unchanged.

## Nested sections

A section has either `rows` or `sections`, never both. For example:

```js
{ title: "recurse", sections: [
  { title: "Active", rows: active, hideWhenEmpty: true },
  { title: "Inbox", rows: inbox, hideWhenEmpty: true },
  { title: "Archive", rows: archive, collapsed: true, hideWhenEmpty: true },
] }
```

There are at most 12 top-level sections and 12 children per group, with no
further nesting. Groups show the combined row count and fold their children;
children retain independent folds, actions, rowActions, empty text and
`hideWhenEmpty`. A group's `hideWhenEmpty` hides it when all children have no
checked rows on that backend. Group actions target all child rows by default;
New agent actions also work on a group. Fold preferences use the full title path
and backend, so children with the same title in different groups are independent.
As with flat sections, the selected conversation stays visible when folded.

## Actions that ask for a tag

Row and section actions may use `{ label: "Tag…", icon: "tag", ask: "tag" }`.
The name box suggests live custom tags across the operator's rows, with fuzzy
filtering and arrow-key selection. Typing normalizes names to at most 24
lowercase letters, digits and hyphens (for example, `Recurse Dev` becomes
`recurse-dev`). Enter sets the typed name or selected suggestion; tapping a
suggestion picks it. Escape or clicking outside cancels. The reserved tags
`archived`, `snoozed` and `pinned` cannot be chosen here.

`{ label: "Remove tag…", ask: "tag", clear: "ask" }` removes a chosen tag
instead; it suggests only custom tags currently on the targeted rows and refuses
other names. Fixed `set` names still apply. For setting a typed tag, fixed `set`
and `clear` names apply in the same change. Changes are operator-authored.
Section tag actions default to their section's rows, or may specify `rows` explicitly;
they confirm the target count before applying.
Returning a child renders it as a normal row, without duplicating it
in its root's visible subtree. Omitted roots go to Unsorted; omitted descendants
retain normal tree navigation.

## Starting agents

New agent opens its draft immediately. Export `export const newAgent = { ask: "tag" };`
to show an optional tag control below its model picker, including on phones and
connected backends. The control opens the same tag box; No tag clears the choice.
Without this export, the draft has no tag control.

Section actions may use `{ label: "New agent", icon: "new", start: true, set: "recurse" }`
to open a top-level draft with those custom tags preselected, still changeable
or clearable in the tag control.
`set` may also be a list. Start actions cannot use row targets, conditions, `clear`,
`ask` or `until`, and cannot appear in `rowActions`. The example's project
sections use this action (hold the header on phones).

Optional per-tag defaults use `newAgent.defaults = { recurse: { effort: 3 } }`
in the exported object. Effort is 1–6 and remains editable in the draft; choosing
a tag applies its default. For preselected tags, the first match in `set` order supplies it. Working directory is not a New agent
input, so scripts cannot default it.

As before, the server creates the agent on its first message, not when its draft
opens. Tags are operator-authored and saved in that initial transaction, so the
agent appears directly in its tag section. Connected backends use the same
creation request; older backends must be updated to support initial tags.

## Rules for changes

Keep browser and server dry-run rows identical. Keep scripts stateless and
preserve the built-in root-only arrangement. Keep imports from `web/conversation/`,
`web/artifacts/`, `web/panes.ts`, `web/dock/` and `web/comments.ts` in the root
`web/sidebar.ts`, not in this folder. The module entry uses only named exports;
in this folder, import directly from the file that owns the code.
