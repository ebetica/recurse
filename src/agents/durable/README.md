# Turns, prompts and compaction (Pi Durable)

Pi Durable runs agent turns inside the Recurse server. This directory connects
the agent tree to a Harness for each conversation: it opens storage, admits
input, builds and captures requests, and reports finished work.

**Source files:** [host.ts](host.ts) and [host/](host/) own Harness lifecycles;
[sqlite_worker.ts](sqlite_worker.ts) owns storage execution;
[prompt_resources.ts](prompt_resources.ts), [prompt_sections.ts](prompt_sections.ts),
[../runtime/prompts.ts](../runtime/prompts.ts) and [request_capture.ts](request_capture.ts) and its
[serialization worker](request_capture_worker.ts) build and capture requests; [report.ts](report.ts) and
[report_holds.ts](report_holds.ts) report runs; [side_conversations.ts](side_conversations.ts)
and [promotion.ts](promotion.ts) manage forks; the
[compaction extension](../../extensions/core/context/durable-compaction.ts)
manages context summaries.

## Harness and turns

[host/open.ts](host/open.ts) opens a Harness on demand or for recovery. Startup
[recovery](host/recovery.ts) reads live task indexes, root/side inboxes and the
report cursor without constructing a Harness. Only unfinished tasks, queued
input, undelivered reports, pending clears, revivals or promotions reopen;
idle conversations remain lazy. Unknown or older storage opens normally so
inspection failures never suppress recovery. Pi owns the turn, tool calls and
request boundaries; Recurse admits input and projects live state. Runs outlive HTTP requests. [host/clear.ts](host/clear.ts),
[host/close.ts](host/close.ts) and [archive.ts](archive.ts) handle storage
rotation, closing and retained history. SQLite work is off the event loop, in
one lazy worker per database, so a busy database does not delay another.
Connections to the same database share its worker; the last close stops it.
Shutdown fences new page calls, drains admitted reads and waits for worker exit.
Dead-worker replacement and failed open/close cleanup also wait for exit.
A failed native close poisons the owner rather than releasing a live connection.
Stores use WAL with exclusive locking: one native connection and transaction
queue serve the store's logical handles, keeping the WAL index in heap instead
of a shared-memory file. Search projections use that same worker connection.
Store rotation waits for admitted, bounded storage-page calls to close their
connections, logging each holder and the elapsed wait; it never leases an idle
view or waits for a client to consume output. Search admission stays fenced
through final sync, owner-handle close and archive rename, so later searches
cannot retain the old database across rotation. Archive expiry, revival and
revival rollback share that fence; moves fence both source and destination.
The final retirement rename stays fenced even for service conversations and
stores without an archive key; skipping archival never skips reader draining.
Retirement runs in the descriptor-pinned trash Worker, and its completion stays
inside the storage fence. Import staging and promotion cleanup await it too.
Read-only handles reject writes. Cold live views and search use a writable
exclusive owner with a logical read-only guard, so page reads avoid lock RPCs
before a Harness opens. Every logical reader shares an existing owner. Cold
archived stores, explicit native-read-only requests and unwritable live stores
may use native read-only connections only without an open EXCLUSIVE owner.
External direct SQLite readers and backup tools must wait for every connection
to close before opening or moving a store. WAL/NORMAL retains process-crash durability; power loss can lose the latest
commit. Checkpoint/close refreshes an already-current search projection's source
cookie after the connection closes; unknown database replacements still require
verification. Native read-only connections do not change journal settings or
checkpoint on close.
History for an unopened idle conversation uses a page-scoped, read-only Pi
storage and document reader, without creating tools, loading the agent
environment or recovering tasks. A ready Harness serves live history as before.
Missing stores, unfinished runs, queued input, pending clears and older schemas
use the normal open; sends still open and
recover the Harness before admitting work. File collections resolve without
loading the tool environment. The `durable_view_storage` log records cold
history reads; `durable_open` records full runtime initialization.
Focus-admission waits have their own `focus_wait_ms` field instead of inflating
the yielding phase. The same `durable_open` line splits root wall time into
`root_conversation_ms`, `root_snapshot_ms`, `root_mcp_ms`, `root_import_ms` and
`root_report_ms`. These include async waits, not just main-thread execution;
there is no additional polling or log line. Slow opens also report storage connection-queue, worker
dispatch/startup, execution and reply-delivery durations; these contain no SQL.
The native SQLite and migration timings overlap those transport measurements.
SQLite remains at schema version 2 in Pi 1.5; opening a 1.4 store alone does
not change its schema. Reading `pi.live` migrates its value from version 1 to
version 3, and its next write stores version 3. New generation tasks use version
2 and tool tasks version 3. Older Pi cannot resume these newer document/task
versions; revive imports migrate only their staged copy.
When crashes cut a task off Pi's restart limit times in a row, Pi ends it.
An interrupted model request consumes its retry budget and can end earlier.
Recurse adds a visible error row for interrupted or restart-limited replies and
compactions, without aborting or retrying the tasks.
The focused view follows bounded conversation watches for immediate progress and
stored commits for history; listeners are removed on disconnect and do not read the
session in observer callbacks. Root-store commit publications also enqueue derived
message-search appends outside the reply path. Retained stores move their search
sidecar with SQLite files after final sync; search service cleanup finishes before
the archive index closes.

[activity.ts](activity.ts) maintains a per-root `durable/activity` marker only
while live tasks, queued input or undelivered reports remain, refreshing it each
minute and removing it when idle or closed. Open storage and WAL files are not
activity signals. Deployment adapters may use the fresh marker as a keepalive
hint; recovery always reads authoritative storage, never the marker.

A settled subagent run is reported to its parent. A report is held while the
child or a local descendant works or owes a report; when holders stop, held
reports are rechecked. The report cursor advances only after delivery or drop.
Its tiny latest-only document stores a complete snapshot on each advance, so
opening it does not replay all earlier cursor updates. Generation and delivery
position are unchanged. An existing delta chain is discarded on its next advance;
there is no per-open migration or historical scan.

## Prompts and context

Prompt resources and Recurse sections form the model's system context.
Tool instructions resolve asynchronously before the detached snapshot is rendered.
Changes are applied at request boundaries, and
[request_capture.ts](request_capture.ts) records the exact request for the
inspector. One lazy host-owned Worker serializes captured requests, including
images, off the main thread. Posting a request detaches its snapshot before the
provider can mutate it; inspection and idle persistence await its exact JSON.
Only options are JSON-normalized on the main thread to omit callbacks, including
nested telemetry callbacks; AbortSignal stays excluded. Credential overrides are
refused before posting. Worker failures surface as errors, never stale captures;
shutdown drains captures before terminating the thread. The
`request_capture_snapshot` span measures the main-thread handoff, not encoding.
Registry tool wrappers shorten Pi-owned model-facing descriptions;
Pi's parameter schemas and execution stay unchanged. Pi wrappers put native
codemode usage in the tool description and list script-only tool names in the
codemode section, without schemas, including deferred tools the model may call
(`artifact`, `recurse_settings`); on-demand MCP tools appear only by server in
`mcp_servers`. Discovery is unchanged. Message provenance is separate from user text
([../runtime/prompt_stamp.ts](../runtime/prompt_stamp.ts)).
[models.ts](models.ts) and [model_selection.ts](model_selection.ts) resolve
models; Settings owns credentials. Pi's credential store defers its first read
until an asynchronous auth operation. Credential and stored-catalog revision
checks, locked reads and writes use asynchronous filesystem calls, preserving
Pi's cross-process locking and external Settings-update visibility. The
[cache-warming extension](../../extensions/extra/cache-warm/README.md) replays
the last captured main-model request only while live work remains. Replay
usage is persisted without changing model context.
`follow.ts` keeps the latest committed assistant usage in its live row for API
status, clearing it on compaction or close. Status uses the UI's shared occupancy
projection without opening storage; cold or reopened-but-unsampled agents report
unknown usage.

Compaction summarizes older context without deleting stored history. Signed-in
ChatGPT (Codex) models always use encrypted server compaction. Model/account
changes and rejected items trigger a lazy readable summary from retained history;
failed compaction calls use the normal readable-summary path. Other providers
continue to use readable summaries.
[refusals.ts](refusals.ts) excludes refused runs from later model requests
while retaining them in history. If a crash interrupts the refusal commit,
the next request restores the uncommitted omission before request transforms. Codemode and MCP tools use the same safety
policy as direct tool calls.

## Side conversations

A side conversation is a read-only fork in its parent's Harness, with its own
agent record and live projection. Its tools are guarded even for nested calls;
only an explicit, reviewed return can send instructions to the parent.
Promotion copies an idle fork into a child conversation, preserving model content
except for remapped internal server-compaction history boundaries. Promoted
server-only markers use the lazy readable-summary fallback because encrypted
checkpoint documents are not copied. See [side_conversations.ts](side_conversations.ts),
[follow.ts](follow.ts) and [promotion.ts](promotion.ts).

## Open diagnostics

[host/open.ts](host/open.ts) keeps the existing `durable_open` wall costs and
tracks phases for [stall diagnostics](../../observability/README.md).
`event_loop_stall` reports `phases=cid:phase:812ms` for phases overlapping its
sample window, including phases that just finished. These are wall intervals,
including awaits and admission waits, not CPU causes. Successful and failed
opens release their live phase scope in `finally`.

## Rules for changes

- Everything sent to a model stays inspectable through request capture.
- Prompt rendering takes supplied context and returns exact text; it does no
  I/O or owner lookup. Provenance is rendered in one place.
- Model and prompt changes apply at request boundaries. Platform notes are
  best effort and never block fresh input.
- Summary requests never replace the captured turn request. Persisted entry
  kinds keep their names across upgrades.
