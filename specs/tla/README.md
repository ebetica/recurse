# Lifecycle models

Bounded models, not refinement. Controls restore failures.

## Source files

- [StoreLifecycle.tla](StoreLifecycle.tla), [cfg](StoreLifecycle.cfg): store protocol.
- [ShellHandoff.tla](ShellHandoff.tla), [cfg](ShellHandoff.cfg): shell handoff/eviction.
- [LifecycleAdmission.tla](LifecycleAdmission.tla), [cfg](LifecycleAdmission.cfg): reservation, flock and deadline ordering.
- [ViewportHolds.tla](ViewportHolds.tla), [cfg](ViewportHolds.cfg): target design
  for thread scroll holds; its header lists bounds and controls.
- [Remote relay](relay/README.md): delivery, sleep/wake, revocation.
- [Operator sends](send/README.md): queue, steer, Stop and reload.
- [UnreadSeen.tla](UnreadSeen.tla), [cfg](UnreadSeen.cfg): the unread dot.
- [Idle compaction](idle/README.md).
- [RotationTrace.tla](RotationTrace.tla): replayed rotation safety, not full store refinement.
- [rotation_trace.ts](../../tests/dev/rotation_trace.ts): real-test recording/replay and marker checks.
- [rotation_preload.ts](../../tests/dev/rotation_preload.ts),
  [rotation_record.ts](../../tests/dev/rotation_record.ts): test-only rewriting/ordered NDJSON.
- [rotation_bug.ts](../../tests/dev/rotation_bug.ts): real rename with an open SQLite reader.
- [check.sh](check.sh): pinned tools and all positive/negative checks.

## Run

```sh
tests/check.sh tla                # bulk-only stage, also included in all
specs/tla/check.sh                # standalone: all models and negative controls
specs/tla/check.sh cache          # independent store prepare-cache race
specs/tla/check.sh shell          # fixed shell model only
specs/tla/check.sh shell-pins     # deliberately remove output-retention guard
specs/tla/check.sh admission      # fixed lifecycle-admission model
specs/tla/check.sh viewport       # scroll-hold design and its controls
specs/tla/check.sh unread         # unread-dot design and its controls
specs/tla/check.sh trace          # existing real tests + rotation trace replay
```

Needs Bash, curl, tar, sha256sum, GNU timeout, Linux x64;
trace recording also needs Bun/repo dependencies. [check.sh](check.sh) pins and
hash-checks cached Zulu OpenJDK21/TLC2.19 downloads. Tools, configs, JVM files,
states and logs stay in `RECURSE_AGENT_TMPDIR` or private `TMPDIR`; no system
Java needed. Each case gets 110s/1 GiB. Controls must exit 12 with the expected
invariant; other failures fail.

## Store correspondence

Reviewed against dev `5dbb44511`, including #3055 (`a7f11be57`). Bug flags restore
historical failures, not current dev behavior. The owner is a native connection,
not a Harness or a logical handle. Function names, not line numbers, identify
implementation sites.

- `OpenOwner`, `OpenRead`, `CloseOwner`: [worker]
  `SqliteWorker.openDatabase/start/release`, `WorkerSqliteDatabase.close`;
  [native] `execute/close`.
- `BeginWrite`, `Commit`, `ReadOwner`: [worker]
  `WorkerSqliteDatabase.transaction/serial/direct`, `SqliteWorker.enqueue`;
  [native] `execute`.
- Page `AdmitRead`, `Read`, `ReleaseRead`: [view] `storageView`;
  [host] `DurableHost.waitStorageReads`.
- Search `AdmitRead`, `Sync`, `ReleaseRead`: [search]
  `MessageSearch.request/syncTarget`, `withFiles`; [worker] `syncSearch`;
  [native] `execute`; [sync] `sync`.
- `Prepare`: historical query-time preparation, removed from current queries.
- `BeginRotation`, `Rename`: [host] `maybeRotate/keepStore`; [delete] `retire`;
  [clear] `retireCleared`; [search] `rotate/withStores`; [archive] `keep/moveStore`.
- `Restart`: environmental process-crash assumption, not an application function.

[worker]: ../../src/agents/durable/sqlite_worker.ts
[native]: ../../src/agents/durable/sqlite_thread.worker.ts
[view]: ../../src/agents/durable/host/view.ts
[host]: ../../src/agents/durable/host.ts
[search]: ../../src/search/index.ts
[sync]: ../../src/search/sync.worker.ts
[delete]: ../../src/agents/durable/host/delete.ts
[clear]: ../../src/agents/durable/host/clear.ts
[archive]: ../../src/agents/durable/archive.ts

Path-keyed workers share one native connection; last close and replacement
await exit. Transactions hold the queue. Pages lease before awaits and release after
session close; search synchronizes between transactions and closes in `finally`.
Rotation fences/drains readers and closes the Harness. Final `Sync` collapses its
temporary owner open/sync/close after draining old handles. Queries trust derived
files as-is. `Prepare` is a historical cache control, not query-freshness proof.

### Store bounds and assumptions

Bounds: two stores/worker slots/generations, one lease/rotation, **two commits
total** across either generation/file. `(store, generation)` is an inode;
commits are verification/data versions. Retained clear/archive preserve commits;
service/unretained deletion is excluded. `ColdViewBug`: independent connections,
stale owner reuse.

`AdmitRead` precedes native open without owners or during transactions too.
`OpenRead` may finish behind a fence; rename drains pending leases. Leases span
writes; read/sync/close wait for transactions. Reservation/exit collapse into
native open/close.

`Sync` atomically publishes projection/verification identity, independent of
prepare's cache. Two stale stores plus one catch-up slot reduce the five-store,
limit-four race, not every five-store behavior. Only already-synced live stores
at prepare's snapshot count; incomplete indexing, text matching, later commits,
archive-path queries and non-atomic publication are excluded.

Invariants check moved reads, retained commits, single/current owners, synced
store inclusion and closed connections at rename. `Exclusive` changes only the
native-reader crash prerequisite, not SQLite's `walFindFrame` mechanism. Normal
mode is a comparison, not a production setting.

Power loss, torn multi-file moves, archive expiry/revival, external processes,
SQLite locking/WAL internals, simultaneous readers, native read-only fallback
and IPC/open/close failures are excluded. The launcher lock
excludes a second server. Commits are atomic and survive process restart by
assumption, matching WAL/NORMAL's process-crash contract, not power-loss durability.

### Store controls

The runner prints counts and durations (one worker, seed 1, fingerprint polynomial
0). Both fixed modes must exhaust; diagnostics must fail their named invariant:

- `fixed-exclusive`, `fixed-normal`: exhaust with all invariants.
- `cold` (`ColdViewBug`), `search` (`SearchFenceBug`): `RotationClosed`.
- `cache` (`PrepareCacheBug`): `SearchCacheCoherent` despite bounded catch-up.
- `cold-read`, `search-read`: respective reader flag, `NoReadMoved`.
- `cold-reopen`: `ColdViewBug`, `OwnerConnectionCurrent`.
- `native`: `ColdViewBug` in exclusive mode, `NoNativeRenameCrash`.

## Shell correspondence

Reviewed against dev `a250b950d`. Start: detached launch, durable memo, registered
Watch, accepted snapshot. One registry/shell. Cleanup responsibility, not
exclusive Shell possession, transfers from tool/memo to durable task.

- `StoreStep`, `FlushHandoff`: [persist] `RegistryStore.enqueue/drain/flush`;
  [registry] `ShellRegistry.flushPersistence`.
- `Handoff`: [shells] `bash.execute`'s `detach` flushes snapshots, then
  `api.createTask` with conversation ownership.
- `BeginRead`, `EndRead`: [registry] `retainOutput/trimmedOutput/stillRunningText`;
  [shells] `bash.execute` output pin.
- `BeginMonitor`, `EndMonitor`: [registry] `flushMonitor/readMonitor` has one
  pending read; completion holds an output pin while draining it.
- `Exit`, `Format`, `Notify`: [registry] `finishExit/queueCompletion/notify`
  marks terminal, pins, drains, formats, persists and notifies.
- `RequestAck`, `FinishAck`: [shells] `createShells` transfers `Watch.exit`;
  [registry] `completionPersistence`; [persist] `acknowledgeCompletions`.
- `Checkpoint`, `Post`, `FinishTask`: [shells] `ShellTask.watch/notify`, `post`
  checkpoints, submits/queues `shell:<id>:exit`, unwatches and commits terminal.
- `Evict`: [registry] `ShellRegistry.evict` requires completed, over cap,
  no output readers or pending stored completion.
- `Crash`, `RecoverStop`: [shells] `recoverInterruptedCommands`, resumed
  `ShellTask.watch` stops groups, removes records and reports restart/lost.

[persist]: ../../src/extensions/core/shells/persist.ts
[registry]: ../../src/extensions/core/shells/registry.ts
[shells]: ../../src/extensions/core/shells/shells.ts

### Shell bounds and assumptions

Bounds: one monitor read, two nested output readers. `Exit` means the entire
group is proven gone; responsibility cannot become `done` while live. Identity
verification/signal escalation are trusted; escaped descendants are excluded.

Snapshots/notices/removal use a successful atomic FIFO queue. Heartbeats and
coalescing are omitted; writes cannot overtake removal. `FlushHandoff` is distinct
from task creation: later completion writes do not invalidate the barrier.
Disk failures, directory replacement, corruption and power loss are excluded.

Terminal marking/pinning precedes monitor drain; eviction may interleave with
formatting/persistence/notification. Ack is **before submission**: Watch/task owns
cleanup. Crash before notify checkpoint may replace exit text with a restart
notice. Checkpoints survive restart; Pi deduplicates stable post ids by assumption.
Until task creation, memo/recovery owns cleanup. Stop/submission failures stutter;
no eventual-delivery claim.

Only notified detached shells and acknowledged terminal record removal are
covered; caps/TTLs, foreground-only records, abort successors, text/redaction,
monitor batching/cooldowns and identity discovery are excluded.
Retaining every terminal store record until submission is not the real protocol.

### Shell controls

The fixed case is `shell`. Three deliberate mutations remove current guards;
they are sensitivity controls, not claims of unfixed production races:

- `shell-pins`: ignore tool/final/nested read pins; `OutputRetained` fails.
- `shell-flush`: skip the accepted-snapshot drain; `HandoffSettled` fails.
- `shell-completion`: drop Watch transfer; `CompletionResponsibility` fails.

Other invariants retain running shells and tool/task/recovery group ownership.
No current-code race is identified within these bounds.

## Admission correspondence

[TreeLifecycle](../../src/agents/mutation_guard.ts) maps `Reserve`, `Wake` and
`Expire` to `awaitReservation/reserve/nextRelease`; `Prepare`, `Flock` and `Poll`
to `openLease` and [flockExclusive](../../src/utils/flock.ts). Nested entry/exit
and spent-token refusal map to `reserve/release/checkToken`; body completion,
unlock, descriptor close and final release map to `body/closeLease/release`.

Bounds: two fresh callers in one process, nested depth two, one external holder
and one data-root inode. Wakes are unordered. Expiry crosses awaits; bodies and
nested calls are untimed. Refusals snapshot that layer's blocker; kernel poll
expiry uses its last failed attempt. Stable inodes and successful close/unlock
are assumed; filesystem failures/replacement, crashes and cancellation excluded.

`MutualExclusion`, `BusyOnlyIfHeld`, `CloseBeforeRelease` and `TokenOwnership`
check exclusive bodies, justified refusal, close-before-release and token
ownership. They replace injected-clock cases; a real-flock check remains.
The bulk stage runs:

- `admission`: exhaust all invariants.
- `admission-reservation`: restore deadline-before-reservation; the released
  holder's expired waiter must violate `BusyOnlyIfHeld`.
- `admission-preparation`: restore the pre-#3259 deadline-before-flock check;
  uncontended expiry must violate `BusyOnlyIfHeld`.

## Viewport correspondence

[Thread](../../web/conversation/thread.ts): `paint` → `Repaint`, `anchoredPaint`
→ `Press`, `releaseBottomFollow` → `Release`. [Scroller](../../web/conversation/scroll-ledger.ts):
`ToBottom`/`OnFrame`. `Repaint` latches natural bottom. `NaturalFollow` checks
settled bottom; `PendingBottom` excludes viewport holds during a batch.
`Press` paints/relatches, then releases before anchoring.

`viewport-` controls: `natural-follow`/`natural-bottom` omit the latch
(`PendingBottom`/`NaturalFollow`); `disclosure-follow` keeps the partial clear
(`OneHold`). Run `check.sh viewport`.

## Rotation trace pilot

Cold-view/clear, retained/service/unkeyed reap and archive-expiry/search tests
record traces. A Bun preload rewrites `Spec: @tla` comments, including Workers;
production has no tracing calls. Marker counts/loaded modules fail closed, without
fingerprints/full semantic drift detection.

NDJSON events are synchronous O_APPEND writes of at most 4 KiB; Linux append
order, not worker timestamps, orders replay. Main-thread admission precedes native
open; close follows acknowledgement or proven Worker exit. Search-worker native
handles are recorded too. IPC dispatch/receive/reply carry per-worker request ids;
async context preserves correlation across producer synchronization.

The replay asserts **no rename with any connection or page/search lease held**,
**no new external lease after its page/search fence**, and balanced/correlated
operations. Connections may materialize already-admitted leases or internal final
rotation sync behind a fence; they are not new external admissions. Page admission
linearizes before its first await; search admission when its file gate is acquired.
Native `open`/module events stutter. Rename events precede filesystem attempts,
including failed attempts and both endpoints. All store-file moves use the SQLite
path as their key. Worker exit releases that worker's remaining handles.

The real buggy fixture renames with an open native reader: its trace must fail
`RenameClosed` (exit 12). Positive traces exhaust; malformed/unknown events,
absent coverage and unexpected TLC results fail. Only recorded rotations count,
not full StoreLifecycle refinement, query/cache correctness, arbitrary processes,
unmarked direct SQLite users, crashes/power loss or all schedules. Logs/witnesses
stay private; keep added warm execution below 30 seconds.

## Rules for changes

Update actions, assumptions and correspondence when await/queue/pin/lease/
identity/ownership/rotation boundaries change. Controls must fail by name.
Exhaust shells under a minute, each store mode under two. Relay and operator sends assume
fairness for liveness. Deadlock checks are off: failure/restart/stuttering
can defer progress.

Review against owning headers and real-path tests:
[store workers](../../tests/backend/durable_sqlite_worker.test.ts),
[cold view/clear](../../tests/backend/durable_deliver.test.ts),
[archive](../../tests/backend/agent_archive.test.ts),
[search](../../tests/backend/message_search_fuzz.test.ts),
[shell registry](../../tests/extensions/core/shells/registry.test.ts),
[persistence](../../tests/extensions/core/shells/persist.test.ts),
[recovery](../../tests/extensions/core/shells/recovery.test.ts) and
[Durable shell tasks](../../tests/extensions/core/shells/durable.test.ts).
