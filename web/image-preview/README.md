# Image previews

`zoom.ts` transforms the image frame and its comment marks together. Comment
boxes use normalized image coordinates, independent of zoom or translation.
When zoomed, one-finger drag draws a comment box; two fingers pan and pinch
simultaneously. At fit, swipe navigates and hold-drag draws. Double-tap toggles
zoom; a tap explains the commenting gesture. Mouse drag draws a box, Shift-drag
pans, and Ctrl/Command-wheel zooms. The zoomed viewport tooltip names panning.

The viewer starts with a compact bottom comment bar at every width. The fitted
image reserves space above that bar, measured once at opening or a width
change when collapsed. Zooming and panning may move the image
under that bar. The bar opens a bounded, independently scrolling comment list,
and expands into a bounded editor only for a draft; both overlay the image
without changing its fit. Text scrolls inside the
editor; all viewer buttons have at least 44px touch targets. The canvas height
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

Successful comment sends close that dialog and return to the conversation at its latest messages; failed
sends leave it open. Drawing Done also closes it; drawing Cancel leaves it open.
