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

## History and usage

Compacted history uses a plain marker; earlier messages and the
jump-to-first-kept link remain available. History details load on opening.
`publish` counts files. Prompt-cache refresh adds turn usage, not replies.
Tree usage matches loaded history. Usage names the served model.

## Thread images

Thread images keep compact filename footers, full-name tooltips and reserved
space for lazy loading. Inline captions use cached filenames, never Markdown alt
text. Diagrams stage outside the flex row. Artifact raster previews live in the
Artifacts pane, not inline in the thread. See [image previews](../image-preview/README.md)
for gestures.

## Rules for changes

Keep full history details lazy and preserve recorded usage rather than inferring
it from visible replies. Apply the shared image policy to inline previews.
