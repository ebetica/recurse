# Composer input

## Source files

[`input-actions.ts`](input-actions.ts) owns resizing and focusing the field,
restoring refused text, and selecting the temporary draft during login
recovery. It keeps the composer fixed while a pointer press is held, so
revealing the controls doesn't move the pressed target. [`view-state.ts`](view-state.ts)
keeps selection and draft text.
Sending and the rest of recovery stay in [`../composer.ts`](../composer.ts).

[`action.ts`](action.ts) owns the Send/Stop button. The conversation's
[Stop view](../conversation/stop-view.ts) supplies its availability and target;
that view doesn't dispatch requests.

[commands.ts](commands.ts) owns slash commands, and [file-finder.ts](file-finder.ts)
completes file paths. [style.css](style.css) styles the editor, its popups,
and the shared card with the live panel.

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

Desktop controls stay visible and wrap in narrow Chat windows. Phones reveal
them on focus or with a draft; taps keep the caret. The gap between the field
and the controls stays compact. On wide touch screens the hit areas extend
farther below the buttons than above, away from the field's bottom corners.
Wrapped control rows keep extra
separation on touch screens. Safety review and errors are in the effort
popup. Active turns show a green border; with reduced motion it stays still.

## Rules for changes

Keep the pressed target and the draft's caret stable when the controls appear.
Use the [shared operator send entry](../conversation/README.md#sending-and-stop)
for foreground sends.
