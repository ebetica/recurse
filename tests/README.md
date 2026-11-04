# Tests

Tests run on real paths: a real server, Durable store, Git, processes, Chromium
on the built app, or data recorded from real runs. Read the
[test-writing workflow](../docs/agents/develop.md#writing-tests-and-comments);
`tests/checks/test_check.ts` enforces what it can.

| Directory               | What it tests                                                                   | Run with                                                         |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `tests/backend/`        | The server, agents, storage, launcher and tools; recorded inputs in `fixtures/` | `bun test tests/backend/NAME.test.ts`, or `bun run test:backend` |
| `tests/extensions/`     | Extensions, mirroring `src/extensions/`                                         | `bun test tests/extensions/...`                                  |
| `tests/web/`            | Pure browser-app helpers                                                        | `bun test tests/web/NAME.test.ts`, or `bun run test`             |
| `tests/mobile_browser/` | Chromium against the built app, in named groups                                 | `bun tests/mobile_browser/index.ts GROUP...`                     |
| `tests/live/`           | Real-provider checks and fixture recorders, run by hand                         | see each file's header                                           |

`tests/checks/` holds the documentation, comment, test-policy and web style
checks run by `tests/check.sh`. `browser_import_check.ts` bundles the browser
entries from `package.json` in memory and checks Bun's resolved import graph,
including literal dynamic imports and dependencies, without writing `web/dist`.
It rejects Node builtins (including browser-shimmed builtins), Bun imports and
known server packages listed in the check, and prints each entry-to-import chain.
Type-only imports are erased by Bun and do not cross this boundary. Splitting is
disabled only for this in-memory build so dynamic edges retain their source paths
in the graph. Forbidden imports stay external so their transitive dependencies
cannot hide the chain behind a bundler error.

`bun tests/checks/operator_send_check.ts` checks browser source syntax for direct
message delivery outside the shared send module, low-level transport and
optimistic enqueue calls outside their owning functions, and foreground outbox
insertion outside `startOperatorSend`. It prints file:line diagnostics and runs
in quick checks and `tests/check.sh ts`. Existing-job retries, restoration and
stop requests do not initiate send scrolling.

`bun tests/checks/prompt_budget.ts` captures a fresh fake-provider request in the
Recurse checkout with the recorded effort ladder/model names and empty memory/tree
inputs. It prints rendered section sizes, rejects system prompts of 15,000 or more
characters and rejects codemode descriptions pointing at the removed native-tool
system section. The existing `agent_tools` integration test uses the same capture
and compares the CLI help with its recorded fixture. The check also runs in the
static portion of `tests/check.sh ts`.

Every stage also runs the blocking Oxlint rules in
[.oxlintrc.blocking.jsonc](../.oxlintrc.blocking.jsonc) over `src/`: synchronous
filesystem imports/properties, native process counters, synchronous subprocesses
and SQLite imports are errors. General Oxlint remains advisory.
Worker entrypoints and worker-only helpers end in `.worker.ts` (or `.worker.mjs`);
launcher-only modules end in `.cli.ts`. The public `src/local.ts` and
`src/launch_cli.ts` entrypoints retain their installed names. These paths may use
blocking APIs. Server-thread modules cannot import off-thread modules except as
types; Worker URLs and child-process paths are not imports. Mixed-use helpers
stay checked. Module initialization uses asynchronous I/O too.
Remaining violations have per-call `oxlint-disable-next-line` directives with a
`known:` reason. Unused directives are errors: remove them with fixes, never add
new violations to this baseline. Legacy filesystem calls use default imports so
each property access is checked, rather than suppressing an entire named import.
The rules are syntactic, not alias/data-flow analysis; they cannot distinguish a
Bun file's `.size` from an ordinary object's `.size`. The unchanged dynamic trace
below covers these accesses, dependency internals and runtime reachability.
`tests/dev/` holds the affected-test/browser mapper,
test-review evaluator, performance load driver, bytes-over-the-wire budget,
their shared private-server helper, provider recorder and worker count helper. Read each script's header or `--help` before running it.

`tests/check.sh web`, `tests/check.sh ts` and `tests/check.sh browser` run these suites, and
`tests/check.sh provider` runs the reply-path tests against recorded providers.
`tests/check.sh perf` drives a private fake-provider server, traces synchronous
main-thread calls after startup (including a real operator Settings write that
must persist before its response), and checks search CPU in isolated real
process trees, counting native and JavaScript threads in the driver and its
search child. Each process is counted once, including exited threads and reaped
child CPU. `tests/dev/hotpath_allowed.json` holds
justified permanent exceptions; `tests/dev/hotpath_known.json` is a shrinking
baseline that rejects missing entries as well as new sites. The trace retains
both application and dependency frames; logs and reports remain in temporary
scratch space. The search CPU gate runs the real search service from a fresh
driver process over the isolated local fixture, before starting the server. It
waits for the whole process tree to quiesce and includes post-search work
until quiescence in both samples. Thirty alternating find/grep calls, spaced
1.1 seconds apart, allow eight times the cold find's CPU plus 50 ticks, counting
every driver and search-child thread. The server still runs the fake-provider search
burst for the blocking trace; its CPU is diagnostic, not the search budget.
The idle gate warms one real index, waits for bounded all-thread quiescence,
then allows 120 ticks while another process churns indexed files for 15 seconds.
Post-churn work is counted until quiescence too. The measured process tree
contains the search driver and service, not server startup tails, maintenance
timers or full-turn GC/JIT; no thread is filtered from its CPU total. Independently, the full server must
quiesce before three consecutive 15-second request-free churn windows. Their
median must also stay within 120 ticks across server and search-child threads; raw windows,
startup quiet samples and thread breakdowns remain in the report. The unchanged
120-tick limit has 50% headroom above the highest three-window calibration median
(80); the median prevents one GC/JIT/maintenance burst from deciding the result.
`tests/dev/hotpath_idle_cpu.ts REPO REPORT [SOURCE_CHECKOUT]` runs this gate
standalone; a historical checkout selects real old source/dependencies for defect
sensitivity checks. `tests/dev/hotpath_search_cpu.ts REPO REPORT [REFRESH_MS]`
runs the search burst gate; its optional interval exercises real repeated refreshes.
The gates need Linux `/proc` and run in the full `all` stage.
`bun tests/dev/affected_tests.ts` prints the tests a change can reach. Real-model
evidence comes from `bun tests/live_e2e.ts`, which needs real credentials and
never runs in tests/check.sh.

## Rules for changes

Follow the [validation workflow](../docs/agents/develop.md#validation) and the standing
[test constraints](../AGENTS.md#development-and-tests). PRs that change tests
get a [test review](../docs/agents/test-review.md).
