# Agent transcripts and search

Search is a CLI operation, not a model tool. `subagent.ts search QUERY [AGENT]`
searches the caller by default. `--tree` includes descendants, `--all` selects
all live agents, and `--deleted` also includes retained deleted agents. Queries
are case-insensitive literal text; `--role user|assistant|agent|tool|tool-result`
and `--limit 1–100` filter results. Each hit prints `path:line: snippet` followed
by its agent, UTC time and role. Read that path with the normal read tool at the
reported 1-based line, or search the file directly with ripgrep. The CLI no longer
has a `messages` command.

## Source files

- [index.ts](index.ts): service, commit scheduling, bounded ripgrep subprocess,
  results and timing events.
- [sync.worker.ts](sync.worker.ts): read-only SQLite catch-up, header cursor and file verification.
- [projection_state.worker.ts](projection_state.worker.ts): shared durable freshness cookies, without SQLite imports.
- [transcript.ts](transcript.ts): readable headers, tool calls/results and bounded bodies.
- [search.worker.ts](search.worker.ts): query decoding, cancellation and lazy standalone projection fallback.
- [query.worker.ts](query.worker.ts): ripgrep process cleanup and off-main-thread output decoding.
- [targets.ts](targets.ts): live, tree and retained-archive scope selection.
- [backfill.ts](backfill.ts): bounded startup catch-up.
- [backfill_process.ts](backfill_process.ts), [backfill.worker.ts](backfill.worker.ts): owned startup process and its cold-store reader.
- [../../tests/dev/search_bench.ts](../../tests/dev/search_bench.ts): separate
  performance benchmark, not test-suite timing assertions.

Isolated entrypoints and helpers use `.worker.ts`; the startup entrypoint runs
in a separate process. Queries never import SQLite into their Worker.

## Storage and crash recovery

SQLite is the source of truth. Each store keeps a plain UTF-8 `transcript.txt`
alongside `session.sqlite`; startup catch-up or live synchronization rebuilds a
missing derived file. Queries read files as-is. Stable paths are:

- Live: `$CHAT_DATA_DIR/conversations/<cid>/durable/transcript.txt`.
- Retained: `$CHAT_DATA_DIR/agent-archive/<archive-id>/transcript.txt`.

Each readable segment starts with a reserved header, followed by real newlines:

```text
--- #42 2026-11-02T19:27:00.000Z tool bash [entry=81 conversation=1 part=1/1 bytes=10]
printf hi
```

The header records commit sequence, time, role/name, SQLite entry id, Durable
conversation id, segment number/count and body byte count. The last complete
entry's final segment is the append cursor; no separate cursor database is used.
A completed append caches its cursor only in the bounded Worker memory cache;
restart recovery reads the header, never a cursor from verification metadata.
Checkpoint headers retain entries without public model text. Body lines beginning
`--- #` gain one leading space, so message text cannot forge a header. CR/CRLF
normalize to newlines, tabs remain, and NUL becomes the literal `\0`.

User and assistant text, agent messages (with sender id), every tool call's
readable arguments and tool-result text are searchable. Bash commands and code
are unescaped; other arguments use indented JSON. Thinking, system prompts,
image/binary payloads and UI-only result details are not copied; omitted content
has a marker. Each segment body is at most **256 KiB**, including an explicit
`[… N bytes omitted]` marker when clipped; clipping never splits UTF-8 characters.
Search returns at most one hit per SQLite entry and role, pointing to its first
matching physical line. A bounded per-query header-range cache makes repeated
matches within one multiline tool output reuse the same header lookup.

Compaction changes the active context, not the transcript: all prior SQLite
entries remain readable. Clear rotates both SQLite and its transcript to
`<cid>.clear-<key>` in the archive; the live path then starts a new store.
`--deleted` includes these cleared stores as well as deleted agents. An explicit
archive id searches or reads that retained store without revival. Archive expiry
removes the transcript with its source store.

A bounded Worker cache and private `message-search-state.json` record file size,
modification/change timestamps, permissions, database/WAL identity and a
source-entry verification anchor, never an append cursor. Persisted identities
exclude remount-sensitive device/inode aliases; inode checks remain process-local.
Atomic metadata restores verified state after restart and moves with the store.
An owner's checkpoint/close updates an already-current projection's source cookie
after the native connection closes, without rescanning history. A fresh service
still verifies the full projection when its main-database cookie differs, including
replacement databases with identical final entries but different earlier history.
Synchronization reloads owner-written identities when cached source/projection
identities differ. Changed live files verify byte-for-byte against SQLite;
matching identities skip SQLite and metadata writes. Queries can restore an
unvisited live store's readiness from these cookies without reading source rows
or transcript payloads; they never repair files. Missing, different or incorrectly
permissioned projections rebuild privately and replace atomically. Torn tails
repair from SQLite, never from an arbitrary footer. An empty read-only-open WAL
does not invalidate verification. Changed databases check the cursor entry, so
cleared/replaced stores discard old projections.

After listen on every startup, one owned child catches up missing/stale
projections; it never pre-reads current transcript data. It traverses live records
and retained archives in pages of 16, with one file in flight. It yields to focused
opens and waits at file boundaries while queries are queued, running or reaping
their child. Existing final archive transcripts are projection done-markers:
archives are immutable, so they need no SQLite recheck. Missing files rebuild from
their closed source. Searches read transcripts on demand, next to their databases;
there is no warming pass, local mirror, pack, separate index or persistent job
checkpoint. A restart resumes from final projection files. Legacy TSV is removed
only after its replacement transcript succeeds.

Pi's `entries.id` is an `INTEGER PRIMARY KEY` (rowid). Entries are immutable;
clears rotate stores. Catch-up reads bounded primary-key pages of 256 rows inside
a read-only SQLite snapshot. Live synchronization runs in the store's owning SQLite
worker between transactions. Startup delegates already-owned stores to that
actor without sending their transcript to the child. Cold stores synchronize
in the child, without a second connection to an EXCLUSIVE-owned store. Cold
actor opens and startup readers share the existing rotation fence. Rotation fences search admission through final
sync, owner close and rename. Archived readers use native read-only connections
only without an EXCLUSIVE owner. Expiry, revival and rollback wait for admitted
readers to close and fence later readers until their file moves finish; revival
fences both source and destination paths. Pi's entry schema has no kind column. The projection
uses exact canonical root-kind prefixes to skip JSON decoding for common metadata
entries. Other records decode once in JavaScript; only user, assistant and
tool-result models become readable segments. SQLite does not reserialize model
JSON before JavaScript decodes it. SQLite still reads
record overflow pages because the source schema has no separately indexed kind.
No indexes or schema changes are required. Writes are batched, without per-line fsync.

Commit publications are queued with `setImmediate` and batched across four
stores. SQLite determines every new entry, including commits whose publication
was lost before a later append or startup catch-up. Publications schedule a
store without copying model payloads across the server event loop; duplicate
publications do not duplicate lines. The startup child sends only counters and
file metadata back to the server and is stopped with verified process cleanup
when the job completes or is cancelled.

## Limits and observability

Queries select canonical transcript paths and never wait for startup catch-up.
An existing final archive transcript is already a durable readiness marker:
restart does not make it unindexed, and queries inspect neither its source nor
its state file. Ripgrep reports genuinely missing files as `not_indexed`.
During incomplete catch-up, only unvisited live stores need a bounded metadata
check in the query Worker. Matching saved database/WAL and transcript cookies
establish currentness without SQLite or transcript verification; missing or stale
state remains incomplete until synchronization. Aborted catch-up retains those
warnings, not a blanket warning for every unvisited archive. Queries never repair
files. A bounded per-hit header lookup decodes matches.

Search has no service, ripgrep, HTTP or CLI deadline. A streamed live-only
ripgrep pass finishes before a retained-archive pass starts. Archives are supplied
newest-first; parallel completion order within a pass is not stable. A Worker
checks the pass's filesystem type with `statfs`: recognized NFS, 9p, FUSE,
SMB/CIFS, Ceph, AFS and Coda filesystems use 8 threads. This is the conservative
network default: larger fan-out has not demonstrated a cold-scan improvement.
Local disks and unknown types retain ripgrep's default. Missing paths probe their
nearest existing ancestor. Exhaustive, cache-controlled cold comparisons must
accompany future tuning. Either child is killed as soon as the combined requested
hit limit or shared 8 MiB output bound is reached.
Disconnecting or interrupting the CLI cancels either pass. Cancelled queries release
their admission slot only after their child has exited; descriptors are always
closed. Plain-text read ranges retain their separate fifteen-second deadline.
Ripgrep output and header lookups are decoded in an independent Worker, not on
the server event loop. A process-wide, abortable queue runs at most four
searches/ripgrep children and retains at most six waiting requests, including
searches from different service instances. Excess requests fail immediately with
`Search busy; retry after current searches finish` (HTTP 429), rather than waiting
behind a large scan. Ten concurrent readers remain admitted.
Unicode matching uses case-insensitive literal Unicode simple folding. Output is bounded to 8 MiB and 200 hits; a limit
returns `truncated`. Search does not log queries or message text.

INFO events define the performance metrics:

- `search_query`: `scope`, `agents`, `not_indexed`, `queue_ms`, `rg_ms`,
  `total_ms`, `files`, `bytes_scanned`, `hits`, `truncated`.
- `search_sync`: `cid`, `entries`, `bytes`, `ms` and `profile` phase timings for
  open, SQLite reads, JSON/text decode, verification (`verify_ms`) and batched
  text writes. `bytes` counts text actually written, not verified bytes.
- `search_rg`: `active` child count at process start and exit.
- `search_backfill`: `done`, `remaining`, `bytes`, `page_ms` per startup page.

`bytes_scanned` is ripgrep's completed-pass byte count and is omitted when an
early limit prevents that footer. Query timings include admission and Worker IPC,
not HTTP transport or agent-selection lookups. Append `ms` measures
Worker file work; the benchmark separately reports dispatch-to-completion time.

## Copied-corpus benchmark

Copied files are already cacheable. A fresh service in this benchmark is not a
post-restart cold volume, and these timings do not establish cold-read throughput.
Measure that separately on immutable archive files immediately after restart,
recording per-file open/stat/read/close costs and ripgrep flags without printing
matches. File-local cache advice may leave host-side caches warm.

Run `bun tests/dev/search_bench.ts --manifest COPY_MANIFEST --out NEW_REPORT`.
The manifest contains `items` with `cid`, copied `session.sqlite` `path`, and
`archived: true` for archived stores. The benchmark clones these closed copies
into private scratch space before rebuilding; no original store is modified.
Use `--rebuild-only --rebuild-concurrency 4` for a short profiling pass.

The report includes rebuild MB/s and agents/s, open/SQLite/decode/write timings,
cold and warm query p50/p95/max, and 10/50/100-reader waves over the same full
corpus or different small target sets. Busy rejections and their latency are
separate from completed-query latency and unexpected failures. `--scoped-only`
measures rebuild, scoped queries and appends without reader stress waves.
The retained-corpus p95 budget is **1,000 ms**: tool-output transcripts contain
about 3.4 times the previous searchable text on the measured corpus. Own/tree/live
query budgets remain 50/100/300 ms; append/catch-up budgets remain 2/50 ms. A separate SQLite Worker generates
commits across 20 stores at a target 1,000 commits/s. Actual production and
query-window rates, queue/drain latency, ripgrep child counts, loop-lag events
and memory are reported separately. Streams stop after 30 seconds; capped waves
are not evidence of sustained writes for their full duration. Test-suite cases
check deterministic correctness, not elapsed-time thresholds.

Mounted-filesystem and host-cache variability remain material. Keep measured
results with their PR and cache conditions rather than treating a warm rerun as
evidence that a cold failure did not happen.

## Scope and rules for changes

- The HTTP route and CLI only select targets and render results; storage,
  synchronization, searching and metrics belong here.
- Keep SQLite reads and filesystem projection work off the reply/event-loop path.
  Retain bounded pages, output, process cleanup and file-based startup progress.
- Side conversations share a parent store and are excluded from tree/all search;
  a side-only request returns 422. Cold fork-id lookup is a follow-up.
- `id@label` uses the existing authenticated backend proxy and qualifies result
  agents with that label. Paths in remote hits live on that backend, not locally.
  Use `subagent.ts read id@label --offset LINE --limit N` for a bounded plain-text
  range (at most 2,000 lines and 256 KiB); archive ids work too. The route resolves
  agent/archive ids only, never caller-supplied file paths. There is no local fallback.
- Verify the monotonic entry-id invariant when upgrading Pi. Preserve read-only
  access and rebuildability rather than adding a separate cursor database.
