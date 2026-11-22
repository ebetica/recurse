# Pane helpers

[The pane shell](../panes.ts) owns registered panes, open state, visit and read
ordering, and the desktop/phone layout. Its helpers do not own conversation
selection or desktop windows.

## Source files

- `index.ts` is the shell's named entry to the helpers.
- `menu.ts` renders pane choices in the phone More menu and handles keyboard
  focus, tap, and press-slide-release. The shell supplies the choices and owns
  the shared header actions and any open pane behind the menu.
- `chrome.ts` reveals sticky phone headers on upward scroll. `powerbar.ts` and
  `powerbar.css` provide shared pane headings and controls. `loading.ts` marks
  content as busy and restores focus after loading.
- `file-tabs.ts` manages bounded tab definitions and registered file sources.
  Restored keys must be canonical JSON string tuples; each source applies its
  own identity checks before it creates a tab. `cache.ts` and `view-state.ts`
  manage retained bodies and saved view state.
- `autoopen.ts` decides when to notify about Artifacts or open Files.
  `navigation.ts` handles pane item navigation and scrolling; `frecency.ts`
  ranks recent pane openings for the finder.

## Rules for changes

Keep the shell's desktop dock, conversation, and comment wiring in
`web/panes.ts`. Use named re-exports in the entry and import directly from the
owning file within this folder. The More menu closes on an action, but its
capture-phase click handler leaves Delete's first tap or slide open to confirm.
Backdrop dismissal closes the menu before asking the shell to close the phone
pane. Pane and menu focus use the shared visible-focusable query in
`web/focus_trap.ts`.
