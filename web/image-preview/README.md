# Image previews

`zoom.ts` transforms the image frame and its comment marks together. Comment
boxes use normalized image coordinates, independent of zoom or translation.
When zoomed, dragging with one finger, a pen or a mouse pans. At fit, touch
swipes navigate the gallery; a mouse or pen drag does nothing. Touch and pen
hold, then drag to comment. Mouse comments use Command-drag on macOS and
Ctrl-drag elsewhere. Double-tap and double-click toggle zoom; pinch zooms and
pans. Browser wheel events cannot reliably distinguish a mouse from a trackpad,
so desktop wheel controls use one rule for both: Ctrl/Command-wheel (including
trackpad pinch reported as Ctrl-wheel) zooms around the pointer. Plain vertical
wheel zooms at fit; once zoomed, plain scrolling pans on both axes, clamped to
the image edges. Use Ctrl/Command-wheel or Fit image to zoom back out.
At fit only, a predominantly horizontal scroll steps to the next/previous image
after 60 pixels. It steps once until wheel events pause for 250 ms, including
momentum across image and desktop file-tab changes. At a zoomed pan edge,
scrolling stays a pan and
never changes images. Line/page wheel deltas are normalized to pixels. These
controls are shared by chat images, Files image tabs and Markdown images;
phone and touch gestures are unchanged. A tap and the compact comment bar
explain commenting, updating for the pointer being used, including
pen input. Arrow keys navigate and Escape closes the viewer;
the Fit image button, filled so it stays legible over any image, resets zoom. Download saves the original file with its
filename. On touch devices that support sharing files, it opens the system
share sheet so images can be saved to Photos; otherwise it downloads directly.
Long-press commenting is unchanged.

In chat and Markdown documents, [Open diagram](../mermaid.ts) fits the Mermaid
SVG in a full-screen viewer with the same zoom and pan gestures. The zoom bar
and arrow keys on the canvas also work without a pointer. Escape, Close diagram
or Back on phones returns to the diagram. In chat, Copy copies the Mermaid source from
above the diagram.

The image viewer starts with a compact bottom comment bar at every width. The fitted
image reserves space above that bar, measured once at opening or a width
change when collapsed. Zooming and panning may move the image
under that bar. The bar opens a bounded, independently scrolling comment list,
and expands into a bounded editor only for a draft; both overlay the image
without changing its fit. Text scrolls inside the
editor. The draft uses the conversation composer’s field and auto-growing sizing,
starting at one line and scrolling after five. Its Cancel and Comment are the
shared text buttons, spaced apart, with 44px touch targets on phones. The viewer shares the conversation
top bar and icon buttons, with 44px touch targets; single images have no pager.
The canvas height
is held from opening or a width change, so keyboard height changes cannot
re-fit it. `comments-layout.ts` follows the visual viewport to keep the controls
above the keyboard without resizing the canvas. Closing removes its viewport
listeners.

[The Files image viewer](../files/image-viewer.ts) owns the dialog and its close
path. The swipe/button/keyboard image gallery skips operator uploads, including
comment crops and drawing exports. Published images remain in the gallery.
Opening an operator image directly still works, as a standalone preview with no
image navigation. The separate Files list continues to show operator uploads.
There is no setting or toggle for this default.

Markdown in replies, Files and Artifacts also displays absolute, `~/` and
relative image paths through an operator-authenticated, byte-validated route.
Relative paths use the conversation's working directory, or the document's
source directory when recorded; published sibling images take precedence.
Clicking or tapping a loaded Markdown picture opens the existing viewer with
its original. Links around pictures keep their authored destination; selecting
text across a picture does not open the viewer or discard comments. Files and
Artifacts register through `../document-markdown.ts` and share the handler in
`references.ts`. In Artifact Markdown, Command/Ctrl-drag or hold then drag
on a loaded local or inline image to comment on an area without opening the
viewer. The pending card keeps the original crop. On remount, the box returns
for images pinned to the same revision, but not for mutable local paths.
Sealed previews and web images are excluded.
Missing or non-image paths show “Image not found” with the reference.
Web images do not load automatically: “Show image from host” loads just that
image directly on click, without a referrer. This avoids a server-side fetch
proxy and keeps external network access an explicit operator decision. Small
raster data URLs render without a request. Other Markdown resource surfaces
remain stripped before insertion into the document.

The thread, the composer and the Files list (and images inside rendered
Markdown files) show `/thumbnail`: PNG, JPEG and WebP images from 128 KB to
25 MB arrive as WebP with the long side at most 1024 px
(`src/web/thumbnails.ts`); GIFs and animated PNGs arrive unchanged. The Files
detail view, the full-screen viewer, drawing and downloads load the original
bytes. A thumbnail that fails to load, as from a connected backend without the
route, retries once as the original.

The [drawing editor](editor.ts) loads [its stylesheet](style.css) together
with Excalidraw's on first use. A cancellable progress dialog stays visible
until the canvas code and stylesheet are ready.

Submitting comments closes the dialog immediately. The conversation shows sending progress and keeps failed comments for retry. Command-Enter on macOS and Ctrl-Enter elsewhere submit comments, including from a comment field. Escape closes the floating comment editor first and keeps its comment; another Escape closes the viewer. Drawing Done also closes the dialog; drawing Cancel leaves it open.
