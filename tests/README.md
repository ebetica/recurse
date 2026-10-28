# Tests

Tests run on real paths: a real server, Durable store, Git, processes, Chromium
on the built app, or data recorded from real runs. Read the
[test-writing workflow](../docs/agents/develop.md#writing-tests-and-comments);
`tests/checks/test_check.ts` enforces what it can.

| Directory               | What it tests                                                                   | Run with                                                         |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `tests/backend/`        | The server, agents, storage, launcher and tools; recorded inputs in `fixtures/` | `bun test tests/backend/NAME.test.ts`, or `bun run test:backend` |
| `tests/extensions/`     | Extensions, mirroring `src/extensions/`                                             | `bun test tests/extensions/...`                                  |
| `tests/web/`            | Pure browser-app helpers                                                        | `bun test tests/web/NAME.test.ts`, or `bun run test`             |
| `tests/mobile_browser/` | Chromium against the built app, in named groups                                 | `bun tests/mobile_browser/index.ts GROUP...`                     |
| `tests/live/`           | Real-provider checks and fixture recorders, run by hand                         | see each file's header                                           |

`tests/checks/` holds the documentation, comment, test-policy and web style
checks run by `tests/check.sh`. `tests/dev/` holds the affected-test/browser mapper,
test-review evaluator, performance load driver, provider recorder and worker
count helper. Read each script's header or `--help` before running it.

Deployment lifecycle tests use the real pinned Python SDK. Install it once with
`python3 -m pip install modal==1.5.1` (CI does this before the backend stage).
Their local process/filesystem transport makes no Modal API calls. SDK upgrades
must pass the task-identity and native image-version checks.

`tests/check.sh web`, `tests/check.sh ts` and `tests/check.sh browser` run these suites, and
`tests/check.sh provider` runs the reply-path tests against recorded providers.
`bun tests/dev/affected_tests.ts` prints the tests a change can reach. Real-model
evidence comes from `bun tests/live_e2e.ts`, which needs real credentials and
never runs in tests/check.sh.

## Rules for changes

Follow the [validation workflow](../docs/agents/develop.md#validation) and the standing
[test constraints](../AGENTS.md#development-and-tests). PRs that change tests
get a [test review](../docs/agents/test-review.md).
