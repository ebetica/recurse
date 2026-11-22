# Changes viewer

The [Changes pane](../diff.ts) owns the selected comparison target, cached
summaries and its shell. The viewer owns the comparison chooser, individual
file bodies and their line comments.

## Source files

- [index.ts](index.ts) is the viewer entry for Changes and published Files previews.
- [file-view.ts](file-view.ts) loads patches and full contents and draws file bodies.
- [render.ts](render.ts) derives bounded rows and loads the diff library on demand.
- [comments.ts](comments.ts) maintains line and range editors and formats staged
  notes for submission.
- [expand.ts](expand.ts) draws context-gap controls; [navigation.ts](navigation.ts)
  handles file filtering and navigation.
- [model.ts](model.ts) defines the summary, file and comparison target types.
- [target-chooser.ts](target-chooser.ts) owns the comparison controls, candidate
  search and base changes. The pane handles refreshing the diff on success.

## Rules for changes

- Keep file bodies by reference across shell repaints. A late patch or contents
  response must not rebuild a body with an open editor.
- Keep file bodies per comparison view and path. Cache patches and contents for
  their summary version; stage comments by the owning conversation. Pull request
  file bodies show patch hunks only.
