# Image and PDF box comments

## Source files

- [gesture.ts](gesture.ts): box gestures, normalized highlights and frame lookup.
- [index.ts](index.ts): public entry for Files and Artifacts.

App startup supplies the popover action for a finished box. Inline image
frames record a stable position in the document and the immutable image
source, so comments can find the same image when the view is remounted.

## Rules for changes

Install gestures once per viewer. Keep highlights on the frame they measure,
and let viewers use the shared gesture state to tell a drawn box from a swipe.
