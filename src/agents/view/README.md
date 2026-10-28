# Conversation views

A **view** is the list of rows the browser shows for one conversation: messages,
tool calls and status lines. This directory builds views from stored history and
live updates, one bounded page at a time.

**Source files:** [reader.ts](reader.ts) (reads pages) ·
[conversation.ts](conversation.ts) (turns entries into rows) ·
[session_entries.ts](session_entries.ts) (legacy Pi JSONL pages) ·
[failure_sentences.ts](failure_sentences.ts) (failure text for the operator) ·
[../durable/durable_rows.ts](../durable/durable_rows.ts) (Durable entries to rows) ·
[../../web/conversations.ts](../../web/conversations.ts) (serves rows at `/view`)

## How it works

Pi Durable's SQLite store is the history. The view merges live Harness updates
with stored pages by entry identity, so each entry shows once whether it arrived
live, from storage, or both. Old Pi JSONL sessions can still be read, but there
is no second live transcript.

The supervisor keeps one collection of resident views. Each entry owns its rows,
history position, revision and the lock that synchronizes them together; evicting it drops the entry, and the
next read rebuilds it from storage. Deleting the agent drops its entries.

Reads run off the event loop, one page at a time. After every await the reader
checks the agent and session are still the same, so a stale read never updates
a view that was deleted or rebound. Compaction summaries keep their history
positions, so scrolling back past a compaction works. A retained user message
sits after its summary marker, keeping it out of the compacted activity group;
tool-only assistant cuts still seat the marker before their tool rows.

## Rules for changes

- Readers and projections never import live owners, the supervisor, HTTP or file
  retention; callers supply complete entries.
- History reads serve loading, reconnecting and paging only: never deciding
  whether a sender may send, and never proving that a message was delivered.
- Keep every read bounded and every scan proportional to live state, not history.
  Usage totals never count a merged entry twice.
