# Conversation views

A **view** is the list of rows the browser shows for one conversation: messages,
tool calls and status lines. This directory builds views from stored history and
live updates, one bounded page at a time.

**Source files:** [index.ts](index.ts) (shared display helpers) ·
[reader.ts](reader.ts) (reads pages and owns the resident view cache) ·
[entry_rows.ts](entry_rows.ts) (projects one entry without changing the view) ·
[conversation.ts](conversation.ts) (reconciles stored and live entries) ·
[session_entries.ts](session_entries.ts) (legacy Pi JSONL pages) ·
[failure_sentences.ts](failure_sentences.ts) (failure text for the operator) ·
[../durable/durable_rows.ts](../durable/durable_rows.ts) (Durable entries to rows) ·
[../../web/conversations.ts](../../web/conversations.ts) (serves rows at `/view`)

## How it works

Pi Durable's SQLite store is the history. The view merges live Harness updates
with stored pages by entry identity, so each entry shows once whether it arrived
live, from storage, or both. Old Pi JSONL sessions can still be read, but there
is no second live transcript. [Legacy notices](entry_rows.ts) keep their text
without changing earlier rows or recreating live actions. Thinking rows retain a
presence flag even when the provider supplies only encrypted or redacted thinking.
Readable thinking shows a bounded heading or opening line in the thread. The
latest readable tool thought stays visible when command details are folded, even
if a later tool has an unreadable thought. The status bar shows the latest
readable thought in the run; an empty, redacted or encrypted block cannot displace it.

The view withholds credential-shaped shell commands from transcript rows and
their inline details. Script calls beyond the display cap retain grouped names
and statistics without their arguments. Full argument JSON shows printable
Unicode without changing the argument values; control characters and line
separators remain escaped.

Authentication and model-availability failures retain the recorded agent's
level-reselection guidance in both the visible sentence and raw detail.

The supervisor keeps one collection of resident views. Each entry owns its rows,
history position, revision and the lock that synchronizes them together; evicting it drops the entry, and the
next read rebuilds it from storage. Deleting the agent drops its entries.

Reads run off the event loop, one page at a time. After every await the reader
checks the agent and session are still the same, so a stale read never updates
a view that was deleted or rebound. Compaction summaries are included in view
rows and keep their history positions, so scrolling back past a compaction works. A retained user message
sits after its summary marker, keeping it out of the compacted activity group;
tool-only assistant cuts still seat the marker before their tool rows.

Legacy message-detail scans reuse the asynchronous JSONL reader and pin the
session's descriptor identity between bounded pages. Parsed view batches and
page inputs stay as objects inside the server; the view projects display rows
without re-encoding that data between the reader and the projection.

The [row feed](row_feed.ts) tracks browser revisions independently of entry
reconciliation. A change page (`since` a revision) lists only rows that changed
after it.
Paging older history does not advance the revision for newly backfilled rows;
reconciliation that changes an already-held row remains a live change. When
the caller asks for text deltas (`text_deltas=true` on `/view` and `/events`),
an assistant row whose earlier text is still its prefix carries only the
appended text, `text_from` (the length it follows) and `text_hash` (the
`textHash` of that prefix), so a streaming reply is not resent whole on every
poll. The browser appends only when its held prefix has that hash, so reads
that land out of order cannot splice onto rewritten text; otherwise it rereads
in full.

## Rules for changes

- Readers and projections never import live owners, the supervisor, HTTP or file
  retention; callers supply complete entries.
- History reads serve loading, reconnecting and paging only: never deciding
  whether a sender may send, and never proving that a message was delivered.
- Keep every read bounded and every scan proportional to live state, not history.
  Usage totals never count a merged entry twice.
