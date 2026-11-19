# Shared sidebar script contracts

Browser rendering and server dry runs share row projection, section/action
validation and timeout retry policy. This module has no browser state or server
lifecycle ownership. The built-in script remains in `web/sidebar/default_sidebar.js`.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [rows.ts](rows.ts): cached Agent metadata plus sidebar-only fields.
- [arrangement.ts](arrangement.ts): script output and action checks.
- [retry.ts](retry.ts): the bounded timeout retry policy and `LatestRun`,
  which runs only the newest input; newer input ends a retry pause.
- [engine/](engine/README.md): the separate QuickJS worker engine module.

## Rules for changes

Import through `index.ts`. Keep engine exports type-only here so importing row
contracts never loads QuickJS into the main browser bundle. Preserve the shared
row fields, operator tag restrictions, unsorted fallback and retry semantics.
The browser groups `sidebar` and `remote-sidebar`, and
`tests/backend/sidebar_script.test.ts`, cover the real script paths.
