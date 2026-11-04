# Image previews

`zoom.ts` transforms the image frame and its comment marks together. Comment
boxes use normalized image coordinates, independent of zoom or translation.
When zoomed, dragging with one finger, a pen or a mouse pans. At fit, touch
swipes navigate the gallery; a mouse or pen drag does nothing. Touch and pen
hold, then drag to comment. Mouse comments use Command-drag on macOS and
Ctrl-drag elsewhere. Double-tap and double-click toggle zoom; pinch zooms and
pans. All wheel events zoom around the cursor, including trackpad scrolling:
browser wheel events do not reliably identify the device. A tap and the compact
comment bar explain commenting, updating for the pointer being used, including
pen input. Arrow keys navigate and Escape closes the viewer;
the Fit image button resets zoom. Download saves the original file with its
filename. On touch devices that support sharing files, it opens the system
share sheet so images can be saved to Photos; otherwise it downloads directly.
Long-press commenting is unchanged.

The viewer starts with a compact bottom comment bar at every width. The fitted
image reserves space above that bar, measured once at opening or a width
change when collapsed. Zooming and panning may move the image
under that bar. The bar opens a bounded, independently scrolling comment list,
and expands into a bounded editor only for a draft; both overlay the image
without changing its fit. Text scrolls inside the
editor. The draft uses the conversation composer’s field and auto-growing sizing,
starting at one line and scrolling after five. The viewer shares the conversation
top bar and icon buttons, with 44px touch targets; single images have no pager.
The canvas height
is held from opening or a width change, so keyboard height changes cannot
re-fit it. `comments-layout.ts` follows the visual viewport to keep the controls
above the keyboard without resizing the canvas. Closing removes its viewport
listeners.

`files.ts` owns the preview dialog and its close path. The swipe/button/keyboard
image gallery skips operator uploads, including comment crops and drawing
exports. Published images remain in the gallery. Opening an operator image
directly still works, as a standalone preview with no image navigation. The
Files pane is a separate all-files list and continues to show operator uploads.
There is no setting or toggle for this default.

The thread, the composer and the Files list (and images inside rendered
Markdown files) show `/thumbnail`: PNG, JPEG and WebP images from 128 KB to
25 MB arrive as WebP with the long side at most 1024 px
(`src/web/thumbnails.ts`); GIFs and animated PNGs arrive unchanged. The Files
detail view, the full-screen viewer, drawing and downloads load the original
bytes. A thumbnail that fails to load, as from a connected backend without the
route, retries once as the original.

Submitting comments closes the dialog immediately. The conversation shows sending progress and keeps failed comments for retry. Command-Enter on macOS and Ctrl-Enter elsewhere submit comments, including from a comment field. Escape closes the floating comment editor first and keeps its comment; another Escape closes the viewer. Drawing Done also closes the dialog; drawing Cancel leaves it open.
