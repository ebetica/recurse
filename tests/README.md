# Tests

Tests run on real paths: a real server, Durable store, Git, processes, Chromium
on the built app, or data recorded from real runs. Browser tests use
`tsconfig.browser-tests.json` for DOM types; the backend does not. Read the
[test-writing workflow](../docs/agents/develop.md#writing-tests-and-comments);
`tests/checks/test_check.ts` enforces what it can.

| Directory               | What it tests                                                                   | Run with                                                         |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `tests/backend/`        | The server, agents, storage, launcher and tools; recorded inputs in `fixtures/` | `bun test tests/backend/NAME.test.ts`, or `bun run test:backend` |
| `tests/extensions/`     | Extensions, mirroring `src/extensions/`                                         | `bun test tests/extensions/...`                                  |
| `tests/web/`            | Pure browser-app helpers                                                        | `bun test tests/web/NAME.test.ts`, or `bun run test`             |
| `tests/mobile_browser/` | Chromium against the built app, in named groups                                 | `bun tests/mobile_browser/index.ts GROUP...`                     |
| `tests/live/`           | Real-provider checks and fixture recorders, run by hand                         | see each file's header                                           |

`bun tests/live/reviewer_cache.ts [provider/model]` checks reviewer cache reads
on a private server using existing sign-ins read-only, without OAuth refresh.
It sends one real message for seven reviewed scratch writes and requires cache
reads on at least four of the six follow-up reviews: the provider misses its
cache on a small share of identical-prefix requests, so one miss is not a
regression. It stops the whole private instance after seven reviews, ten
completed acting requests, or 90,000 uncached input tokens, then
checks final recorded usage across its conversations. Crossing a cap during
shutdown is FAIL. Signals clean up its private server and state; an independent
three-minute lifetime also bounds the server. A failed review line names
which check failed, such as `command-other-target` when the acting model's
command lacks the expected target path; it never prints the model's command or
the target's contents.
SKIPPED (exit 2) is not a promotion pass.

`bun tests/live/safety_decisions.ts --output DIRECTORY` compares the default
reviewer with signed-in OpenRouter Jev 1.14 and Clef on the 20 PR #3388 cases and 56 accident
fixtures. Commands are evidence only and never execute. Sign-ins use a literal,
read-only memory snapshot; stored variable references and credential commands
are rejected before authentication. Optional `--openai-key-file FILE` loads a
bare API key into memory only for Luna measurement. The caller owns deleting that input file. Full fixture requests,
probabilities, usage and timings stay in the output directory. `--resume` skips
recorded calls only with unchanged evaluator, fixture and policy hashes. A $1
per-model cap bounds spend. The ship gate fails if Jev makes any mistake the
default does not, either model returns no decision, or coverage is incomplete.
`--case GROUP/ID` reruns one fixture while preserving its earlier evidence and
reports a selected-case gate, not a full-corpus ship pass. This manual live
evaluation is not part of CI; use `--help` for details.

The Artifact reopen check polls the tree API for deletion before reusing its
source conversation. Its asynchronous API condition runs in Playwright's
assertion poll, not the synchronous page-function wait. The Files collection
check consumes held requests in arrival order, including requests that arrive
before a waiter, and aborts held routes when its scope exits.

The Linux-only `notifications` browser group uses full Chromium with a persistent
profile, an isolated X display and a private desktop notification session.
Install `xvfb`, `dbus` and `dunst` alongside Chromium's dependencies; CI installs
these packages before the browser stage. It activates
real desktop notifications with `dunstctl`, so Chromium dispatches trusted
service-worker click events, including permission to focus or open windows.
Synthetic `NotificationEvent` dispatches do not grant that permission.

Browser fixtures give each scripted agent its own provider response queue.
Named gates release one waiter at a time for a specific agent and gate name;
releasing an empty gate does nothing. Published-file fixtures run the native
`publish` tool through each agent's provider; returned file ids come from that
call's metadata in the conversation view. Static history fixtures commit native
Durable messages in one transaction; replacement prevents concurrent reads from
reopening the old storage while it retires, then opens an empty history. Seeded
tool results retain their calling assistant's entry mapping for lazy details.
One imported-history counterpart uses the product import function on the
checked-in `tests/mobile_browser/fixtures/imported-pi.jsonl`; no fixture writes
Pi session files at runtime.

That six-line Pi v3 snapshot contains unchanged messages from entries 7, 12, 15,
16 and 18 of `tests/backend/fixtures/durable_rows/recorded.json`, recorded from a
real model by `tests/live/durable_rows_record.ts`. Its envelopes follow
`tests/backend/pi_import.test.ts`: ids are `e<entry id>` with a linear parent
chain; ISO entry timestamps equal the message timestamp, plus 8,068 ms for
assistants. The header supplies the fixture session id and `/recorded` cwd.
The browser test checks the timestamp-derived model durations and expanded
read/bash details and output. Imported results have no output artifact id;
the native reveal-backfill test separately exercises the details endpoint.

The `themes` browser group saves custom CSS through Settings and a native tool
turn, probes rendered targets, and checks resource blocking and protected file
editor destinations at desktop and phone widths.

Browser geometry baselines use settled layout: `waitForLayout` also waits for
desktop Chat to sit in its window.
Scroll-to-latest measurements also wait for smooth scrolling to settle before
sampling a viewport-preservation baseline.

`tests/checks/` holds the documentation, comment, test-policy and web style
checks. [static.ts](checks/static.ts) runs them all, as the quick check and
before every `tests/check.sh` stage. Web style checks share each TypeScript
file's parse and reuse the comment check's scanner to blank comment trivia.
The [comment check](checks/comment_check.ts) allows short body comments without
labels and checks declaration docs and test comment exemptions. The static gate
checks the [architecture sweep ledger](../docs/agents/simplify-review.md).
PR test policy runs separately with
`bun tests/checks/test_check.ts --diff REF --pr-body BODY --strict`.
`--diff` uses the merge base (normally with `origin/dev`); `--diff-exact BASE`
uses an exact base instead.
T6 rejects positive `expect(await locator.isVisible())` snapshots in browser tests;
use `await locator.waitFor()` or `await browserExpect(locator).toBeVisible()`.
Existing snapshots have shrinking per-file caps; removing one requires lowering
its cap. Negative snapshots and visibility checks used in branches are unchanged.
The PR gate also preserves every PR id in each base Feature/Regression tag in a
tag directly above the same named test. Missing ids, including rewritten or
removed tags on surviving tests, need `Removes-feature:` or `Removes-regression:`
for the original tag kind (see `test_check.ts --help` for the exact line).
Changing tag kind while keeping the ids does not remove their protection.
`import_graph.ts` checks file and folder-module cycles, entry bypasses and thin
named-export-only entries against shrinking baselines. Nested folders are separate
modules; root `src/` and `web/` files stand alone. `--modules` dumps module debt;
`--height` reports a longest condensed module chain without enforcing a cap.
TypeScript unused-export check: `dead_export_check.ts`.
`browser_import_check.ts` bundles the browser
entries from `package.json` in memory and checks Bun's resolved import graph,
including literal dynamic imports and dependencies, without writing `web/dist`.
It rejects Node builtins (including browser-shimmed builtins), Bun imports and
known server packages listed in the check, and prints each entry-to-import chain.
Type-only imports are erased by Bun and do not cross this boundary. Splitting is
disabled only for this in-memory build so dynamic edges retain their source paths
in the graph. Forbidden imports stay external so their transitive dependencies
cannot hide the chain behind a bundler error.
[standalone_import_check.ts](checks/standalone_import_check.ts) keeps release,
setup, build and agent CLIs independent of the server. It follows runtime imports
transitively, allowing Node built-ins and an exact allowlist for each entrypoint.
It does not check the post-setup server launcher or server-owned workers.

`bun tests/checks/operator_send_check.ts` checks browser source syntax for direct
message delivery outside the shared send module, low-level transport and
optimistic enqueue calls outside their owning functions, and foreground outbox
insertion outside `startOperatorSend`. It prints file:line diagnostics and runs
in the static gate. Existing-job retries, restoration and
stop requests do not initiate send scrolling.

`bun tests/checks/prompt_budget.ts` captures a fresh fake-provider request in the
Recurse checkout with the recorded effort ladder/model names and empty memory/tree
inputs. Known checkout/runtime roots become fixed fixture paths after capture;
prompt content is retained. It prints canonical section sizes, rejects totals of
15,000 or more characters and obsolete codemode native-tool pointers. The
`agent_tools` integration test compares recorded CLI help and captures the same
resources at a longer checkout path to verify equal budgets. The check also runs
in the static gate.

Every stage runs two blocking Oxlint checks. `bun run lint` covers `web/`,
`tests/web/`, and extensions. [Server rules](../.oxlintrc.blocking.jsonc) cover
`src/` and ban synchronous filesystem APIs and subprocesses, native process
counters, and SQLite imports.
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
