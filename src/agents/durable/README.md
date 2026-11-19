# Turns, prompts and compaction (Pi Durable)

Pi Durable gives each conversation one Harness for storage, input, request
capture and run reports.

**Source files:** [host.ts](host.ts) and [host/](host/) own Harness lifecycles;
[run-state clock](run_state_clock.ts) stamps snapshots;
[shared refusal](stopping_error/) fences admission;
[sqlite_worker.ts](sqlite_worker.ts) owns storage execution;
[prompt_resources.ts](prompt_resources.ts), [prompt_sections.ts](prompt_sections.ts),
[../runtime/prompts.ts](../runtime/prompts.ts) and [request_capture.ts](request_capture.ts) and its
[serialization worker](request_capture_worker.ts) build and capture requests; [report.ts](report.ts) and
[report_holds.ts](report_holds.ts) report runs; [side_conversations.ts](side_conversations.ts)
and [promotion.ts](promotion.ts) manage forks; the
[compaction extension](../../extensions/core/context/durable-compaction.ts)
manages context summaries.

## Harness and turns

[host/open.ts](host/open.ts) opens a Harness on demand or for recovery. Side
forks share its registry. Startup
[recovery](host/recovery.ts) reads live task indexes, root/side inboxes and the
report cursor without constructing a Harness. Only unfinished tasks, queued
input, undelivered reports, pending clears, revivals or promotions reopen;
idle conversations remain lazy. Unknown or older storage opens normally so
inspection failures never suppress recovery. Send and clear share
[submission.ts](host/submission.ts). Pi owns the turn, tool calls and
request boundaries; Recurse admits input and projects live state. Runs outlive HTTP requests. Explicit interrupt sends check the committed request
ledger inside serialized admission before stopping a run; retrying an accepted
request cannot abort its replacement. Input held by a clear is appended and
persisted before Stop can let rotation proceed; that Stop is fenced to the
original opened storage and run, since fresh storage may reuse task ids. The
admission callback reports whether a run was stopped, false for a replay. [host/clear.ts](host/clear.ts),
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
A conversation already marked for deletion returns an unavailable history window
without opening storage; focused event reads return 503 until its record is gone.
Shutdown still refuses reads with the server-stopping response.
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
session in observer callbacks. Entry catch-up fences captured live generations by
successful task id, so a concurrently committed thought/tool step appears once
and keeps its disclosure state. Failed attempts do not fence their task's retries. Root-store commit publications also enqueue derived
message-search appends outside the reply path. Retained stores move their search
sidecar with SQLite files after final sync; search service cleanup finishes before
the archive index closes.

[activity.ts](activity.ts) maintains a per-root `durable/activity` marker only
while live tasks, queued input or undelivered reports remain, refreshing it each
minute and removing it when idle or closed. Open storage, WAL files and background compaction tasks are not
activity signals. Deployment adapters may use the fresh marker as a keepalive
hint; recovery always reads authoritative storage, never the marker.

A settled subagent run is reported to its parent. A report is held while the
child or a local descendant works or owes a report; when holders stop, held
reports are rechecked. The report cursor advances only after delivery or drop.
Its tiny latest-only document stores a complete snapshot on each advance, so
opening it does not replay all earlier cursor updates. Generation and delivery
position are unchanged. An existing delta chain is discarded on its next advance;
there is no per-open migration or historical scan.

[reply_times.ts](reply_times.ts) keeps at most 500 reply finish times and writes a
full checkpoint for each change, rather than retaining every earlier delta.
The first access to an existing chain still replays it. The next reply replaces
that chain through Pi's normal checkpoint transaction, so later opens read the
latest base without replaying earlier updates.

## Prompts and context

Prompt resources and Recurse sections form the model's system context.
[Skill discovery](../../coding_backend/skills.ts) supplies Pi's default and
Agent Skills locations to both autocomplete and each fresh request, including
subagents. Names, full descriptions and file paths are advertised; skill bodies
are read on demand. Resource reads do not reuse the tree's skill-context cache.
Tool instructions resolve asynchronously before the detached snapshot is rendered.
[request_capture.ts](request_capture.ts) snapshots before provider mutation. One
lazy host Worker encodes context and images off-loop. Captures exclude callbacks,
AbortSignal, credential overrides, transport headers and credential-bearing model
metadata. Inspection and idle files await exact JSON; failures reject inspection
instead of serving stale data. Shutdown drains the worker.
`request_capture_snapshot` measures the handoff, not encoding.
Safety reviews keep separate latest request/reply snapshots for operator inspection
using the same worker and idle files. They never feed cache warming; failures log
only the conversation id and never change verdicts. Side deletion drops captures.
Registry tool wrappers shorten Pi-owned model-facing descriptions;
Pi's parameter schemas and execution stay unchanged. Pi wrappers put native
codemode usage in the tool description and list script-only tool names in the
codemode section, without schemas. `artifact` and `recurse_settings` are native
model tools and remain callable from scripts; on-demand MCP tools appear only
by server in `mcp_servers`. Discovery is unchanged. Message provenance is separate from user text
([../runtime/prompt_stamp.ts](../runtime/prompt_stamp.ts)).
[models.ts](models.ts) resolves models; [choices](model_selection/)
never fall back;
Settings owns credentials. The [loader](../../pi_model_config.worker.ts) shares
Pi's built-ins/store across listing, turns and internal requests. Regular files
(1 MiB/128 entries) load off-thread within 2s, or keep built-ins. Only new IDs
accept metadata/non-auth headers (32/8 KiB); catalog IDs/omissions and
`modelOverrides` stay untouched. Existing/Settings providers keep endpoint/auth
and selection rules; ignored fields log counts. File-only providers require
literal keys, HTTP(S), Anthropic messages or OpenAI completions/responses and
explicit selection. Fetch strips ambient headers; skips log IDs/reasons.
Codex uses SSE. Safety uses shipped/Settings models, never file-backed catalogs
or cached lists. Settings keeps pins. Policy follows stored identity each run.
Invalid reviewer configuration tries trusted fallbacks, then allows with a warning
and failure log. Provider failures also allow; invalid optional rules still block. File models remain available for non-security requests. Fable's UA
fallback is unchanged. Anthropic disables message threads: captures and replays
are self-contained. Pi's credential store reads lazily during async auth. Credential/catalog checks
and locked I/O are asynchronous, retaining cross-process locking and Settings
update visibility. The
[cache-warming extension](../../extensions/extra/cache-warm/README.md) replays
the last captured main-model request only while live work remains. Replay
usage is persisted without changing model context. Its optional idle mode
compacts long contexts just before cache expiry through the normal Pi compaction
path, without creating a run or keeping the instance awake. Durable does not construct
Pi's AgentSession cache warmer, so Pi's idle-warming default does not apply.
`follow.ts` keeps the latest committed assistant usage and its storage-session
identity in its live row for API status, clearing it on compaction or close.
Pi's first-entry boundary scopes search and the live panel across generations.
The identity matches `/view` across projection rebuilds and changes on Clear;
clients must not reuse usage from another session. Status uses the UI's shared
occupancy projection without opening storage; cold or reopened-but-unsampled
agents report unknown usage.

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
opens release their live phase scope in `finally`. `observer_late_ms` measures an
independent timer in the same window: both timers late suggests a shared pause;
only main late suggests main-thread blocking. The field is omitted when the
observer is unavailable; neither observation identifies a root cause.

## Rules for changes

- Everything sent to a model stays inspectable through request capture.
- Prompt rendering takes supplied context and returns exact text; it does no
  I/O or owner lookup. Provenance is rendered in one place.
- Model and prompt changes apply at request boundaries. Platform notes are
  best effort and never block fresh input.
- Summary requests never replace the captured turn request. Persisted entry
  kinds keep their names across upgrades.
