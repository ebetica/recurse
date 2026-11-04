# Lifecycle models

Bounded TLA+ safety models check store (#3055) and shell protocols, not full
implementation refinement. Guard-removal controls reproduce historical/possible
failures; production behavior is unchanged.

## Source files

- [StoreLifecycle.tla](StoreLifecycle.tla), [cfg](StoreLifecycle.cfg): store protocol.
- [ShellHandoff.tla](ShellHandoff.tla), [cfg](ShellHandoff.cfg): shell handoff/eviction.
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
specs/tla/check.sh trace          # existing real tests + rotation trace replay
```

Bulk-only (`all`, not `ts`): requires Bash, curl, tar, sha256sum, GNU timeout
and Linux x64; trace recording also needs Bun and installed repo dependencies.
Tools, generated configs, JVM files, states and full trace logs
use `RECURSE_AGENT_TMPDIR` or a private `TMPDIR`; no system installation or
preinstalled Java is needed. Downloads are cached and hash-checked before use.
Each TLC case has a 110-second deadline and 1 GiB heap. Negative cases must exit
12 naming the expected invariant; parser errors/timeouts/unexpected results fail.

Pinned tooling, checked on 2026-11-03:

- Azul Zulu JRE Zulu21.40+17-CA, OpenJDK 21.0.6+7-LTS:
  <https://cdn.azul.com/zulu/bin/zulu21.40.17-ca-jre21.0.6-linux_x64.tar.gz>
- TLC reports `2026.11.02.164701 (rev: dc6a944)` from:
  <https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar>

The release label differs from TLC's build; hashes pin the actual bytes:

```text
JRE SHA-256 8524ef3c76ae1e00bb020044557c5ae1a59d985eee0394d71fc9b2414d083d33
JAR SHA-256 c57d4d7bbee3ed2c89c32cb9c60cac728f751e80e2570bc4b7368ae39291fc21
```

## Store correspondence

Reviewed against dev `5dbb44511`, including #3055 (`a7f11be57`). Bug flags restore
historical failures, not current dev behavior. The owner is a native connection,
not a Harness or a logical handle. Function names, not line numbers, identify
implementation sites.

| Actions                                     | Implementation sites                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenOwner`, `OpenRead`, `CloseOwner`       | [worker] `SqliteWorker.openDatabase/start/release`, `WorkerSqliteDatabase.close`; [native] `execute/close`.                           |
| `BeginWrite`, `Commit`, `ReadOwner`         | [worker] `WorkerSqliteDatabase.transaction/serial/direct`, `SqliteWorker.enqueue`; [native] `execute`.                                |
| `AdmitRead`, `Read`, `ReleaseRead` (page)   | [view] `storageView`; [host] `DurableHost.waitStorageReads`.                                                                          |
| `AdmitRead`, `Sync`, `ReleaseRead` (search) | [search] `MessageSearch.request/syncTarget`, `withFiles`; [worker] `syncSearch`; [native] `execute`; [sync] `sync`.                   |
| `Prepare`                                   | Historical query-time preparation; removed from current queries.                                                                    |
| `BeginRotation`, `Rename`                   | [host] `maybeRotate/keepStore`; [delete] `retire`; [clear] `retireCleared`; [search] `rotate/withStores`; [archive] `keep/moveStore`. |
| `Restart`                                   | Environmental process-crash assumption, not an application function.                                                                  |

[worker]: ../../src/agents/durable/sqlite_worker.ts
[native]: ../../src/agents/durable/sqlite_thread.worker.ts
[view]: ../../src/agents/durable/host/view.ts
[host]: ../../src/agents/durable/host.ts
[search]: ../../src/search/index.ts
[sync]: ../../src/search/sync.worker.ts
[delete]: ../../src/agents/durable/host/delete.ts
[clear]: ../../src/agents/durable/host/clear.ts
[archive]: ../../src/agents/durable/archive.ts

Path-keyed workers share one native connection; last-close/replacement await
exit. Transactions hold the queue. Pages lease before awaits and release after
session close; search synchronizes between transactions and closes in `finally`.
Rotation fences/drains readers and closes the Harness. Final `Sync` collapses its
temporary owner open/sync/close after draining old handles. Queries trust derived
files as-is. `Prepare` is a historical cache control, not query-freshness proof.

### Store bounds and assumptions

Bounds: two stores/worker slots/generations, one lease/rotation and **two commits
total**, on either generation of one file or across two files. Larger histories
are excluded. `(store, generation)` denotes an inode; commit counts model
verification/data versions. Retained clear/archive preserve commits; service/
unretained deletion is excluded. `ColdViewBug` permits independent connections
and stale owner reuse.

`AdmitRead` precedes native open, including without an owner or during a
transaction. `OpenRead` may finish behind a fence: rename drains pending leases.
Leases span writes; individual read/sync/close operations wait for transactions.
Thread reservation/exit collapse into native open/close boundaries.

`Sync` atomically publishes projection/verification identity; prepare's cache
is independent. Two stale stores and one catch-up slot structurally reduce the
five-store/production-limit-four race, without proving every five-store behavior.
Only already-synced live stores at prepare's snapshot count; incomplete indexing,
text matching, later commits, archive-path queries and non-atomic publication
are excluded.

Invariants check moved reads, retained commits, single/current owners, synced
store inclusion and closed connections at rename. `Exclusive` changes only the
native-reader crash prerequisite, not SQLite's `walFindFrame` mechanism. Normal
mode is a comparison, not a production setting.

Filesystem power loss, torn multi-file moves, archive expiry/revival, external
processes, SQLite locking/WAL internals, multiple simultaneous readers, native
read-only fallback and IPC/open/close failures are excluded. The launcher lock
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

Reviewed against dev `a250b950d`. Start: detached launch, durable launch memo,
registered Watch, accepted initial snapshot. One registry/shell is modeled, not
competing registries. Cleanup responsibility moves from tool/memo to durable
conversation task, not exclusive possession of the in-memory Shell.

| Actions                            | Implementation sites                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `StoreStep`, `FlushHandoff`        | [persist] `RegistryStore.enqueue/drain/flush`; [registry] `ShellRegistry.flushPersistence`.                                      |
| `Handoff`                          | [shells] `bash.execute`'s `detach`: flush snapshots, then `api.createTask` with conversation ownership.                          |
| `BeginRead`, `EndRead`             | [registry] `retainOutput/trimmedOutput/stillRunningText`; [shells] `bash.execute` output pin.                                    |
| `BeginMonitor`, `EndMonitor`       | [registry] `flushMonitor/readMonitor`: one pending read; completion holds an output pin while draining it.                       |
| `Exit`, `Format`, `Notify`         | [registry] `finishExit/queueCompletion/notify`: mark terminal, pin, drain, format, persist, notify.                              |
| `RequestAck`, `FinishAck`          | [shells] `createShells` notifier transfers `Watch.exit`; [registry] `completionPersistence`; [persist] `acknowledgeCompletions`. |
| `Checkpoint`, `Post`, `FinishTask` | [shells] `ShellTask.watch/notify`, `post`: checkpoint, submit/queue fixed `shell:<id>:exit` request, unwatch, commit terminal.   |
| `Evict`                            | [registry] `ShellRegistry.evict`: completed, over cap, no output readers or pending stored completion.                           |
| `Crash`, `RecoverStop`             | [shells] `recoverInterruptedCommands`, resumed `ShellTask.watch`: stop groups, remove records, report restart/lost.              |

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

Terminal marking/pinning precedes monitor drain; eviction pressure can interleave
with formatting/persistence/notification. Ack is **before submission**: Watch/task
takes responsibility. Before its notify checkpoint, crash may replace exit text
with a restart notice. Checkpoints survive restart; Pi deduplicates stable post
request ids by assumption. Before task creation, the tool memo/recovery scan owns
cleanup. Stop/submission failures stutter; no eventual-delivery claim.

Only notified detached shells and acknowledged terminal record removal are
covered. Numeric caps/TTLs, foreground-only records, abort-successor creation,
text/redaction, monitor batching/cooldowns and identity discovery are excluded.
Retaining every terminal store record until submission is not the real protocol.

### Shell controls

The fixed case is `shell`. Three deliberate mutations remove current guards;
they are sensitivity controls, not claims of unfixed production races:

- `shell-pins`: ignore tool/final/nested read pins; `OutputRetained` fails.
- `shell-flush`: skip the accepted-snapshot drain; `HandoffSettled` fails.
- `shell-completion`: drop Watch transfer; `CompletionResponsibility` fails.

Other invariants retain running shells and tool/task/recovery group ownership.
No current-code race is identified within these bounds.

## Rotation trace pilot

Existing cold-view/clear, retained/service/unkeyed reap and archive-expiry/search
tests produce traces. A Bun preload rewrites `Spec: @tla` comments, including in
Workers; ordinary production has no tracing calls. Marker counts/loaded modules
fail closed, without fingerprints or full semantic drift detection.

Each bounded NDJSON event uses one synchronous O_APPEND write (at most 4 KiB).
Linux atomic append order, not worker timestamps, supplies the replay order.
Main-thread connection admission precedes queued native open; close follows
acknowledgement or proven Worker exit. Standalone search-worker native handles
are recorded too. IPC dispatch/receive/reply carry explicit per-worker request ids;
async context retains correlation across producer synchronization.

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
identity/ownership/rotation boundaries change. Keep controls failing by name and
exhaust under a minute for shells, two per store mode. No fairness/liveness claim;
deadlock checks are disabled because failure/restart/stuttering can defer progress.

Review against owning headers and real-path tests:
[store workers](../../tests/backend/durable_sqlite_worker.test.ts),
[cold view/clear](../../tests/backend/durable_deliver.test.ts),
[archive](../../tests/backend/agent_archive.test.ts),
[search](../../tests/backend/message_search_fuzz.test.ts),
[shell registry](../../tests/extensions/core/shells/registry.test.ts),
[persistence](../../tests/extensions/core/shells/persist.test.ts),
[recovery](../../tests/extensions/core/shells/recovery.test.ts) and
[Durable shell tasks](../../tests/extensions/core/shells/durable.test.ts).
Models do not replace implementation tests or correspondence review.
