# Composer input

## Source files

[`input-actions.ts`](input-actions.ts) owns resizing and focusing the field,
restoring refused text, and selecting the temporary draft during login
recovery. It keeps the phone caret on composer control taps.
[`view-state.ts`](view-state.ts) keeps selection and draft text.
Sending and the rest of recovery stay in [`../composer.ts`](../composer.ts).

[`action.ts`](action.ts) owns the Send/Stop button. Its [touch menu](send-menu.ts)
keeps the caret in the draft; it and the desktop shortcut use the same command
path as `/btw`. The conversation's
[Stop view](../conversation/stop-view.ts) supplies its availability and target;
that view doesn't dispatch requests.

[commands.ts](commands.ts) owns slash commands, and [file-finder.ts](file-finder.ts)
completes file paths. [style.css](style.css) styles the editor, its popups,
and the shared card with the status bar.

## Commands and finders

`/rename <title>` uses the sidebar's ordered optimistic rename for local and
remote conversations without sending a message. Bare `/rename` shows usage;
selecting it in the command menu inserts the title prefix. The `#filename`
finder inserts quoted paths. Async finders keep rows until newer responses arrive.

## Controls

The chat composer bottom-aligns Attach and Send as the field grows. Their end
margin uses the inherited line height, shared field padding and button size
so they stay centred on the last text line, including the one-line placeholder.
On touch screens, the hit areas extend past the visible buttons without
changing the row height. Phones at least 360 px wide show larger Attach and Send
buttons, Send the largest, with extra space between Send and the model picker.

The control row stays visible below the editor before, during, and after
focus, so opening the phone keyboard doesn't add a row or cover the thread.
Desktop controls wrap in narrow Chat windows. On wide touch screens the hit
areas extend farther below the buttons than above, away from the field's
bottom corners. Wrapped rows keep extra separation on touch screens.
New agent and existing conversations use the same [effort picker](../models.ts)
in the control row; only the way the selected level applies differs. Safety review
and errors are in the effort popup. Active turns show a green border; with
reduced motion it stays still.

## Rules for changes

Keep the control row's geometry and the draft's caret stable on focus changes.
Use the [shared operator send entry](../conversation/README.md#sending-and-stop)
for foreground sends.
