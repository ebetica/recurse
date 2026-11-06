# Tips

The Tips pane shows short tips about Recurse, one at a time.

## Source files

- [list.ts](list.ts) is the fixed list of tips, in display order. Each tip says
  first what to ask an agent, then where the same thing is in the app. A tip
  may carry a request (typed into a new agent's or this agent's message box,
  never sent) and one app control its second button opens.
- [pane.ts](pane.ts) registers the pane and keeps its state in this browser's
  storage: the switch, the tips seen, the tip showing, and time used.

## Behaviour

Tips is the last pane in the rail and the phone More actions menu, because
`web/app.ts` imports it after every other pane. It is offered whenever an agent
is open.

Time counts only while a Recurse tab is visible and Tips is closed. After each
hour of it, if the switch is on and a tip is unseen, the pane gets the shared
attention dot (`PaneDef.attention` in `web/panes.ts`). Opening the pane after
the dot shows the next unseen tip and clears the dot; opening it otherwise
keeps the current tip, so a pane restored on navigation does not move on.
Opening also restarts the hour. Phones skip desktop-only tips and desktops skip
phone-only ones. A button is hidden when its control is not available for the
open agent. On phones, asking a new agent closes Tips and keeps the new draft
and its suggested prompt while the pane's Back step is removed. The prompt is
never sent automatically.

## Rules for changes

- Check each tip against the code it describes, and keep its text in plain
  language without internal names.
- Keep tip ids stable; a new id counts as unseen.
