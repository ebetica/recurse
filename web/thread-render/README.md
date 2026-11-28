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
  [PR references](../pr-references.ts) use explicit repository names when present;
  a bare number cannot select a repository from surrounding prose.
- [code-highlight.ts](code-highlight.ts) colours reply code blocks that name a
  language with the [shared source highlighter](../source-preview.ts), only once
  a block nears the viewport, so opening a conversation never waits on it.

Running tool counts and details belong to the transcript, not the
[status bar](../conversation/README.md#status-bar). [Activity card styles](style.css)
stack collapsed summaries like lines of text on desktop and touch screens.
Each summary is its own tap target; extending it vertically would cover the next
row. Open details keep their separation. Shell completion details stay with the adjacent
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
Only apply legacy notice filtering where the server has not separated the
user's text from delivery framing.
