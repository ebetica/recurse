# Thread rendering

## Source files

- [../thread-render.ts](../thread-render.ts) assembles thread templates.
- [index.ts](index.ts) exposes [row painting](row-paint.ts) and [user bubbles](user-bubble.ts).
- [thread-markers.ts](thread-markers.ts), [activity-boundary.ts](activity-boundary.ts)
  and [turn-view.ts](turn-view.ts) model history markers, response groups and turns.
- [turn-usage.ts](turn-usage.ts) and [activity-usage.ts](activity-usage.ts) attribute usage;
  [tool_activity.ts](tool_activity.ts) describes tool work.
- [reply-html.ts](reply-html.ts) sanitizes reply Markdown and applies the image
  policy; [inline image captions](../image-preview/inline.ts) use cached filenames.

Running tool counts and details belong to the transcript, not the
[status bar](../conversation/README.md#status-bar). The opened activity card
keeps summaries compact on desktop and preserves tap targets on phones and touch
screens. Shell completion details stay with the adjacent
[command series](turn-groups.ts), so output stays available without a duplicate row.
A completion without an adjacent series keeps its own disclosure.

[Thread styles](style.css) load with the app so transcript layout and image
controls do not depend on the Files stylesheet. The transcript and message
inspector share preformatted text defaults.

## History and usage

Compacted history uses a plain marker; earlier messages and the
jump-to-first-kept link remain available. History details load on opening.
Pending actions come from metadata; in-progress and completed compaction
rows come from the thread history, not a separate compaction flag.
`publish` counts files. Prompt-cache refresh adds turn usage, not replies.
Tree usage matches loaded history. Usage names the served model. The turn usage total adds the recorded conversation and safety review costs; `+` marks a subtotal when some costs are unknown.

## Thread images

Thread images keep compact filename footers, full-name tooltips and reserved
space for lazy loading. Inline captions use cached filenames, never Markdown alt
text. Diagrams stage outside the flex row. Artifact raster previews live in the
Artifacts pane, not inline in the thread. See [image previews](../image-preview/README.md)
for gestures.

## Rules for changes

Keep full history details lazy and preserve recorded usage rather than inferring
it from visible replies. Apply the shared image policy to inline previews.
