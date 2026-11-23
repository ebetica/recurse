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
  [status-bar.ts](status-bar.ts) and [thinking.ts](thinking.ts) show live work.
- [disclosure.ts](disclosure.ts) and [message-disclosure.ts](message-disclosure.ts)
  keep disclosure state; [copy.ts](copy.ts) uses the shared [copy button](copy-button/README.md).

[Conversation styles](style.css) follow the header, status and overlay
renderers. [Composer styles](../composer/style.css) still own the border
where the status bar and editor join.

## Reads and navigation

Switching conversations preserves reading position and fences departed reads;
deleting cancels reads. Focused reads come first: cancel departed work before
pane probes or warming a Side frame. App startup supplies the Side pane's
post-action poll. The thread renders pending actions from conversation metadata
and history markers from the separately loaded rows. A compaction notice can
jump to its recorded retained message even without a summary row.

## Streams

Visible main streams send `viewing=true` to suppress completion pushes. Hidden
threads close streams. Embedded views report no viewers and discover no panes.
Focused reads own stream settlement; [polling](../polling/poll.ts) supplies the
fallback read and speeds up after a changed view.

## Sending and Stop

Foreground enqueueing and delivery use the [thread scroll policy](../thread-scroll/README.md)
before sending. Composer jobs and comments reuse the transport without
scrolling on retry or restore. Stop sends no message; a fresh read gates it.

## Take over

The control sends the same operator-only [take-over request](../../src/web/conversations.ts)
to the local or selected backend. Connected backends must support this action
for the control to change who runs the conversation.

## Status bar

The status bar joins the composer while running, queued or waiting. It keeps the
latest thought through tool calls and between requests in a running turn.
Tool counts and details stay in the transcript. Background shell and agent
chips stay in the status bar; after the turn ends, only ongoing background
work keeps it visible with a Waiting label.
Only readable prose expands the thinking control. The fixed six-line area
reserves a scrollbar gutter and follows new text unless scrolled up. Reasoning
summaries omit titles and bold markers. Unlike the status bar, the transcript's
[thinking disclosure](thinking.ts) keeps finished steps' text out of the
heading; open the step to read it.

## Rules for changes

Keep the focused read ahead of background work and fence reads before switching
views. Route foreground sends through the shared scroll entry point; keep
retries and restores on the transport path. [operator_send_check.ts](../../tests/checks/operator_send_check.ts)
confines delivery and foreground enqueueing to their owners.
