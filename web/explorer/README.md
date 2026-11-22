# Explorer

Explorer browses the selected agent’s working folder. On phones, a file opens in
place. On desktop, a file opens in a file tab. File paths in replies open through
the same viewer.

## Source files

- [browser.ts](browser.ts) owns the folder tree, search, and row navigation. Its
  `Browser` keeps the working root, loaded pages, search results and active row.
- [viewer.ts](viewer.ts) owns file previews, the editor, comments, and the close
  guard. Its `Viewer` keeps the selected path, preview and save state. The inline
  viewer reads the browser’s root; a tab uses the root from its key.
- [tab.ts](tab.ts) owns the Explorer file-tab source, saved keys, and availability
  probes. Tabs have a `Viewer` but no `Browser`.
- [pane.ts](pane.ts) registers the pane and handles reply links. [index.ts](index.ts)
  is the public entry. [io.ts](io.ts) shares path and read helpers.

## Rules for changes

- Keep folder reads paged and the tree bounded. Cancel reads on leave; an aborted
  request must not replace newer results. Tabs validate the working root before
  extending a preview.
- Keep editor drafts in memory. Saves use the opened version unless the operator
  chooses Overwrite, and tell the agent the path, not the draft. Both the pane and
  tab use the viewer’s discard guard; their existing comment and cache policies
  stay separate.
- Keep the viewer independent of the browser. The inline viewer gets its root,
  the visible file order and a repaint callback from the browser. Tab navigation
  can return focus to the browser without moving its tree state into the tab.
