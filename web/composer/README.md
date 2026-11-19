# Composer input

[`input-actions.ts`](input-actions.ts) owns resizing and focusing the field,
restoring refused text, and selecting the temporary draft during login
recovery. [`view-state.ts`](view-state.ts) keeps selection and draft text.
Sending and the rest of recovery stay in [`../composer.ts`](../composer.ts).

[`action.ts`](action.ts) owns the Send/Stop button. The conversation's
[Stop view](../conversation/stop-view.ts) supplies its availability and target;
that view doesn't dispatch requests.
