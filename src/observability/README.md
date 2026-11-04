# Wall-time diagnostics

[loop_lag.ts](loop_lag.ts) measures delayed timer samples without native CPU or
memory reads. Stall details are assembled only when a warning is emitted.

[slow_span.ts](slow_span.ts) records bounded synchronous wall spans and open-phase
intervals. `spans` describes completed synchronous sections; `phases` lists up to
three `cid:phase:812ms` intervals overlapping the delayed sample window. Phase
durations include awaits and admission waits: overlaps are context, not CPU
causes or exclusive execution time.

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
and guard-admission waits. No paths, keys or file contents are retained. They do
not cover SDK document decoding/materialization after its internal awaits.
