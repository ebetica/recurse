# Wall-time diagnostics

[loop_lag.ts](loop_lag.ts) measures delayed timer samples without native CPU or
memory reads. Stall details are assembled only when a warning is emitted.

[slow_span.ts](slow_span.ts) records bounded synchronous wall spans and open-phase
intervals. `spans` describes the three longest completed synchronous sections
in the delayed sample window, rather than the last three sections to finish.
`phases` lists up to three `cid:phase:812ms` intervals overlapping that window.
Phase durations include awaits and admission waits: overlaps are context, not
CPU causes or exclusive execution time. Names beginning with `awaited_` identify
individual Pi storage calls, snapshots, recovery inspection, projection tracking,
and the lazy runtime import. These include I/O and Pi's main-thread continuations
(JSON parsing, document replay and migration); they do not assert which part
blocked. Storage methods retain their original receiver and return values.
Awaited calls that receive SQLite rows append `:1048576B`, the sum of their
reply string bytes. Async-local scope is captured when dispatching each SQL
request, so another conversation's reply cannot charge that call.

[OpenTiming](../agents/durable/host/open.ts) updates one scope per live open and
removes it in `finally`, including failed opens. Three completed phase intervals
are retained so a phase ending just before the delayed timer still appears.
Intervals outside the sample window are excluded. Phase queries run only while
assembling a stall warning; no extra timers or per-tick scans are added. Neither
collector retains prompts, payloads or results.

Process launches, Worker construction and large record/transcript/remote JSON
conversions use named synchronous spans. A Promise-returning launch records only
its synchronous prefix, not startup readiness or process lifetime. Codemode's
paired Pi hooks bracket Worker construction on the same synchronous stack after
Wasm loading; the finish callback is idempotent when Worker exit releases it.

Environment setup also names clear-state parsing, filesystem invocation prefixes
(`*_call`), and individual native file-lock attempts/releases. These spans finish
before a returned Promise settles; they exclude I/O completion, lock retry sleeps
and guard-admission waits. No paths, keys or file contents are retained. Awaited
Pi call intervals narrow the SDK continuation gap without modifying Pi.

Startup also names synchronous environment setup, record lookup, hook/handle
construction, resume, message-search target collection/sorting, Settings update
and JSON decoding, GitHub identity decoding, Pi response decoding, and detached
job invocation prefixes. Existing remote-response decoding spans cover relay
polls; relay response validation has its own spans. Search synchronization names
per-conversation result/state handling and `search_sync` logging, Worker/child
reply handling, outbound message handoffs, and SQLite Worker termination. Its
`awaited_search_sync` interval includes off-thread marker/cookie verification;
those filesystem reads remain in Workers or the startup child, not the main
thread. Log formatting/bounding and each persistence filesystem invocation
prefix are named too, including queued writes after the `search_sync` callback
returns. These spans do not establish that the backfill or relay causes a stall.
Process-identity filesystem reads and trash open/retirement operations
are named without adding any filesystem probes. Runtime imports have awaited
wall intervals, not purported synchronous module-evaluation or JIT measurements.

`worker_replies` contains up to three `sqlite_all:1048576B:84ms` observations,
ranked by size, for replies with at least 1 MiB of string fields or 50 ms of
delivery delay. SQLite counts flat result-row string bytes off-thread without
serializing another copy; this excludes object/array overhead and non-string
fields. Delivery starts immediately before posting and includes scheduling and
runtime structured-clone work before the handler. `sqlite_reply_decode` brackets
access to `event.data` and `sqlite_request_clone` brackets posting; eager runtime
decoding before the handler cannot be measured as a synchronous JavaScript span.
Counters and spans are consumed each sample, with no per-row logs or payload
retention. A stall with no named synchronous span remains unattributed, not proof
that an overlapping await or worker caused it.
