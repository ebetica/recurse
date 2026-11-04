# Sidebar scripts

The script API is experimental: it is documented but may change without
migration. Recurse updates may require editing a custom script.

## Source files

- `default_sidebar.js` keeps roots in Pinned (only when any are pinned), Inbox,
  Active and Archive;
  `default_sidebar.d.ts` documents every script row field.
- `rows.ts` projects local and connected remote conversations from cached tree snapshots, using
  the same Agent builder as API v1. API v1 fields retain their contract; sidebar
  extras are experimental.
- `sandbox.ts` runs the pure, stateless `sidebar(rows, now)` in a fresh sandbox.
- `arrangement.ts` checks sections and actions.
- `sections.ts` draws sections; `script.ts` manages the worker and saved script.
- `actions.ts` and `hold.ts` handle tag actions and hold menus.

Side conversations are excluded from both script inputs and stay in the Side
pane. Rows require no extra record, transcript or GitHub reads. Usage is not in the
tree snapshot and is omitted. Branch and current directory are optional and only
included if recorded. Remote rows use qualified ids and set `remote` to true.
The same arrangement is shown under each backend label, with independent folds.
Tag actions overlay the local tree immediately, before sending to the owning
backend. The built-in layout renders synchronously; custom layouts render when
the worker answers, discarding superseded results. The overlay survives older
tree reads until a read started after the durable POST answer confirms it.
Home and remote tree changes also arrive over one visible-tab event stream, so
agent changes and actions on other devices do not wait for the fallback poll.
Older remotes without v1 tag fields keep their rows but omit tag actions.
Custom tags appear on rows.
Returning a child renders it as a normal row, without duplicating it
in its root's visible subtree. Omitted roots go to Unsorted; omitted descendants
retain normal tree navigation.

## Rules for changes

Keep browser and server dry-run rows identical. Keep scripts stateless and
preserve the built-in root-only arrangement.
