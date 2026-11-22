# Conversation

## Source files

- [index.ts](index.ts) exposes the selected conversation view.
- [fetch.ts](fetch.ts) reads and streams the focused view; [cache](cache/README.md)
  keeps bounded snapshots and [freshness.ts](freshness.ts) tracks their readiness.
- [thread.ts](thread.ts) assembles the thread and saves its reading position;
  [navigation.ts](navigation.ts) handles row and latest-message jumps and requests
  for older pages. [Held row state](../row-thread-state/README.md) owns loaded turns.
- [operator-send.ts](operator-send.ts) applies the foreground send policy and
  owns delivery. [stop-view.ts](stop-view.ts) supplies Stop availability and its
  target, while [stop.ts](stop.ts) dispatches it.
- [chrome.ts](chrome.ts) updates the conversation controls and status;
  [live-panel.ts](live-panel.ts) and [thinking.ts](thinking.ts) show live work.
- [disclosure.ts](disclosure.ts) and [message-disclosure.ts](message-disclosure.ts)
  keep disclosure state; [copy.ts](copy.ts) uses the shared [copy button](copy-button/README.md).

## Reads and navigation

Switching conversations preserves reading position and fences departed reads;
deleting cancels reads. Focused reads come first: cancel departed work before
pane probes or warming a Side frame. App startup supplies the Side pane's
post-action poll.

## Streams

Visible main streams send `viewing=true` to suppress completion pushes. Hidden
threads close streams. Embedded views report no viewers and discover no panes.
Focused reads own stream settlement; [polling](../polling/poll.ts) supplies the
fallback read and speeds up after a changed view.

## Sending and Stop

Foreground enqueueing and delivery use the [thread scroll policy](../thread-scroll/README.md)
before sending. Composer jobs and comments reuse the transport without
scrolling on retry or restore. Stop sends no message; a fresh read gates it.

## Live bar

The live bar joins the composer while running, queued or waiting. It keeps the
latest thought through tool calls and between requests in a running turn.
Long-running tools show their own control beside the thought. After the turn
ends, only ongoing background work keeps a plain Waiting bar.
Only readable prose expands the thinking control. The fixed six-line area
reserves a scrollbar gutter and follows new text unless scrolled up. Reasoning
summaries omit titles and bold markers. The transcript's thinking disclosure
opens the step's full text.

## Rules for changes

Keep the focused read ahead of background work and fence reads before switching
views. Route foreground sends through the shared scroll entry point; keep
retries and restores on the transport path. [operator_send_check.ts](../../tests/checks/operator_send_check.ts)
confines delivery and foreground enqueueing to their owners.
