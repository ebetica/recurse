# Idle compaction timer policy

## Source files

- [IdleCompaction.tla](../IdleCompaction.tla) and [configuration](../IdleCompaction.cfg).
- [cache-warm.ts](../../../src/extensions/extra/cache-warm/cache-warm.ts): captured
  request, reconciliation, shared timer, replay and admission callback.
- [Durable host](../../../src/agents/durable/host/host.ts): `cacheWarmBusy` distinguishes own
  turn/input from shells and descendants. [registry.ts](../../../src/agents/durable/host/registry.ts)
  supplies independent settings and repeats `allowed()` before compaction.

Run `bash specs/tla/check.sh idle-compaction` for the design and all controls.
The bulk TLA stage includes them; each case has the existing 110-second limit.

## Properties and correspondence

`Plan`/`Change` model `reconcile` and `schedule`; `DispatchCompact` models the
single timer callback; `Admit` models the adapter's later eligibility recheck.
`Replay` abstracts successful warm replay and its `cachedAt` renewal.
Reconciliation retires a pending compact capture when its busy guard becomes
true, or a no-mode capture when fully idle or compaction is disabled. Later
settings/work changes cannot revive it; a new capture is outside this model.

- **BeforeExpiry:** eligible captures cannot be discarded prematurely; with
  unchanged eligibility from due time, warming off and
  compaction on admit at/above-minimum waiting or idle context before expiry.
  With warming on, only whole-tree idle context qualifies.
- **WaitingWarms:** retained eligible busy context with warming on replays
  rather than compacting, and cannot be discarded prematurely. This excludes
  the deliberate retirement of a previously scheduled compact when work starts.
  Warming does not depend on the compaction switch or minimum.
- **CancellationFinal:** retired/invalidated captures stay retired. Progress
  witnesses record erroneous cancellation independently of the actual live flag,
  so a mutation cannot erase the obligation by dropping its own capture.
- **MinimumRequired**, **OwnTurnFinished**, **InputQueueEmpty**,
  **WarmingWaitsForTree:** admission checks size, own work and, when warming is
  on, shells/descendants. Below-minimum context never compacts; economical
  warming of busy short context remains independent.
- **SwitchesIndependent:** neither operation runs with its own switch off.
  `BeforeExpiry` and `WaitingWarms` also cover each independently enabled route.
- **DeadlineRespected**, **CurrentCapture:** admission rejects clock jumps past
  the cutoff and invalidated captures, including changes after dispatch.
- **NoDoubleExpiry:** a successful warm and compaction cannot consume the same
  cache window. Successful replay renews that window; this is not a prohibition
  on compacting after a failed or aborted warm attempt.

Bounds: one responded/current main-model capture, one environment change or
invalidation, two cache windows, running/queued/quiet own work, one Boolean
for shells or working descendants, and below/at/above-minimum context.
Switches, size and work can change between timer dispatch and admission.
Known TTL, economical/supported successful atomic replay and available
compaction admission are assumptions. Normal clock steps give dispatch and
admission CPU by the cutoff; explicit jumps have no progress obligation.
Thus `BeforeExpiry` is bounded scheduling-policy evidence, not an unconditional
wall-clock or eventual-summary guarantee. Real replay I/O, errors/aborts,
request bytes, billing, one-hour warming age, provider cache hits, tree traversal,
Pi task execution and immutable-prefix summary ordering are not proved.

## Negative controls

Each must exit 12 naming its property, not time out or fail parsing.

| `idle-compaction-` suffix | Mutation                                              | Property            |
| ------------------------- | ----------------------------------------------------- | ------------------- |
| `waiting`                 | Restore pre-#3292 whole-tree gate when warming is off | BeforeExpiry        |
| `minimum`                 | Ignore minimum size                                   | MinimumRequired     |
| `strict-min`              | Exclude equality at the minimum                       | BeforeExpiry        |
| `no-warm`                 | Suppress warming of busy context                      | WaitingWarms        |
| `turn`                    | Ignore own running turn                               | OwnTurnFinished     |
| `queue`                   | Ignore own queued input                               | InputQueueEmpty     |
| `tree`                    | Ignore background in reconciliation/admission guards  | WarmingWaitsForTree |
| `coupled`                 | Require warming for compaction                        | BeforeExpiry        |
| `compact-switch`          | Ignore compaction switch                              | SwitchesIndependent |
| `warm-switch`             | Ignore warming switch                                 | SwitchesIndependent |
| `deadline`                | Admit past cutoff                                     | DeadlineRespected   |
| `recheck`                 | Skip post-dispatch eligibility check                  | CurrentCapture      |
| `renewal`                 | Successful replay does not renew the cache window     | NoDoubleExpiry      |
| `cancel`                  | Keep a capture reconciliation must retire             | CancellationFinal   |

## Real-path coverage

[durable_cache_warm.test.ts](../../../tests/backend/durable_cache_warm.test.ts)
uses an injected clock, not slow TTL waits. Both existing tests stay intact:
exact captured replay/options/session keys, Durable usage and view projection,
real shells/descendants, model/shutdown cancellation, actual CompactionTask
admission, summary, restart recovery, cache-miss logging and absence of activity
markers or row changes are not model properties. No timer-only test qualifies
for replacement without losing this real-path evidence.

## Rules for changes

Update correspondence when timer ownership, eligibility, renewal or admission
boundaries change. Keep both switch combinations, equality at the minimum,
post-dispatch changes and late clocks reachable. Add a named negative control
for each removed guard; do not present bounded policy as provider or Pi proof.
