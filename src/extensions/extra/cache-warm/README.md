# Prompt cache warming and idle compaction

**Source file:** [cache-warm.ts](cache-warm.ts) installs the Durable extension.
The [host registry](../../../agents/durable/host/registry.ts) supplies exact
post-hook request captures, instance settings and live conversation state.
Replay retains provider payload wrappers and shared side-session cache keys,
but drops the generation's payload callback and abort signal, bypasses
generation hooks and never replaces the captured real request.

## Behaviour

Only the latest main-model request is replayed, with one output token and no
retries. Busy includes turns, queued input, background shells and working
descendants, using the same live rows as API v1's idle check. Idle, abort,
compaction, model changes and closing cancel warming. Successful replay usage
is committed to Durable's usage ledger and a `cache_warm` usage entry, without
adding a model-visible message. The thread adds that spend without counting
another assistant reply.

Optional idle compaction uses the same captured main-model request, cache-tier
TTL, refresh margin, late-dispatch cutoff and single timer. Once the whole
conversation tree is idle, a context of at least the configured minimum (120,000
input/cache tokens by default) is compacted shortly before that cache expires.
When warming is disabled, compaction also covers conversations waiting on
background shells or working descendants, provided their own turn is finished
and no input is queued. Short contexts are left to expire without compaction.
With warming enabled, waiting conversations continue warming as before and
compaction still waits for the whole tree to become idle.
Warming's unchanged delay is the earlier of 90% of the TTL and 10 seconds before
expiry; dispatch skips after half the remaining margin has elapsed. A successful busy refresh moves
that deadline. Short contexts and unknown TTLs do not qualify. A new turn,
queued input or model-visible note, abort, model change, compaction, close,
deletion or shutdown cancels
pending compaction. Each captured request gets at most one idle attempt; an
already compacted conversation needs another main-model request to qualify.

The host admits Pi's normal threshold CompactionTask through the existing
compaction adapter, including summary hooks, usage and thread notices. Pi selects
an immutable context prefix and admits the summary as an ordered write, retaining
shell notices and descendant reports arriving during a summary. Background
compaction tasks do not create activity markers; they never create a run, change
reply activity, notify completion, or postpone instance sleep. Timers are
unreferenced and live only in open Harnesses, so they cannot wake sleeping
instances. Closing for sleep cancels them instead of waiting for their deadline.

Pi 1.4.0 does not export its shipped cache warmer. This extension ports only
its streaming path: cache-tier TTL, replay safety, refresh margin, economics,
late-dispatch protection and fixed one-hour horizon. There is no idle warming,
extension decision override or separate warming status UI. Pi's model registry,
streaming and cost calculation are reused directly. Models without known TTL
or sufficient savings are not warmed.

Settings > Models registers **Keep context cached while agents work**,
enabled by default. Disabling it cancels scheduled and in-flight warming.
**Compact long idle conversations before their cache expires** is off by default
in the same section. Enabling it shows **Minimum conversation length for idle
compaction (tokens)**, persisted with the switch. The minimum is a positive safe
integer of at least 32,000 tokens, defaulting to 120,000. It summarizes older
model context without deleting thread history. Provider cache hits are not
guaranteed: each idle summary response reporting zero cache-read tokens logs
`durable_idle_compaction_cache_miss` with its conversation id, never a UI warning.
The task-owned idle marker commits with admission and retires with the task, so
recovery retains that diagnostic without a historical scan. Clocks can be injected for real Durable/faux-provider tests without TTL
waits. The [timer policy model](../../../../specs/tla/idle/README.md) checks independent
switches, busy/idle eligibility, minimum size, invalidation, clock jumps and the
admission recheck. It assumes timely scheduling for before-expiry progress;
real request replay, usage, compaction and recovery stay covered by Durable tests.

## Rules for changes

- Keep the replay context detached from later turns and use Models-owned auth.
- Do not pass a serialized telemetry handle or a finished task's AbortSignal.
- Cancel in-flight replays at model changes and before shutdown cleanup waits.
- Never warm safety reviews, titles, summaries, or idle conversations.
- Keep at most one warming/compaction timer per conversation; dispose it before Harness close.
- Recheck turn/input eligibility and deadlines on the Session line before admitting compaction; include shells and descendants when warming is enabled.
- Prefer Pi's exported implementation when it becomes available.
