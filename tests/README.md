# Tests

| Directory                                         | What it covers                                                              | Run with                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `tests/backend/`                                  | Server, agents, storage, launcher and tools; recorded inputs in `fixtures/` | `bun test tests/backend/NAME.test.ts` or `bun run test:backend` |
| `tests/extensions/`                               | Extensions, mirroring `src/extensions/`                                     | `bun test tests/extensions/...` or `bun run test:backend`       |
| `tests/web/`                                      | Pure browser-app helpers                                                    | `bun test tests/web/NAME.test.ts` or `bun run test`             |
| [tests/mobile_browser/](mobile_browser/README.md) | Chromium against the built app, in named groups                             | `bun tests/mobile_browser/index.ts GROUP...`                    |
| [tests/live/](live/)                              | Real-provider checks and fixture recorders                                  | Run by hand; see each tool's usage                              |
| [tests/checks/](checks/)                          | Static checks and PR test policy                                            | `bun tests/checks/static.ts`                                    |
| [tests/dev/](dev/)                                | Test selection and developer tools                                          | See each tool's header or `--help`                              |

## Run the suites

Run [tests/check.sh](check.sh) from the repository root. Each invocation starts
with the static gate. Do not run stages concurrently.

```bash
tests/check.sh web       # web formatting, tests and build
tests/check.sh ts        # backend formatting, types, server composition and tests
tests/check.sh browser   # rebuild the app, install Chromium, run browser groups
tests/check.sh provider  # recorded-provider reply tests; install Chromium first
tests/check.sh perf      # Linux blocking-call trace, search CPU and server idle CPU
tests/check.sh tla       # TLA+ lifecycle models
tests/check.sh macos     # macOS backend coverage
tests/check.sh           # all: web, ts, browser, perf and tla, in order
```

For a focused run, `bun tests/dev/affected_tests.ts` prints the test commands a
change can reach. To run named browser groups directly, first run `bun run build`
and install Chromium as in the `browser` stage. Then run
`bun tests/mobile_browser/index.ts [--workers N] [GROUP ...]`; with no group names
it runs all groups. The [runner](mobile_browser/index.ts) lists the names.

## Rules for changes

Follow the [validation workflow](../docs/agents/develop.md#validation) and the standing
[test constraints](../AGENTS.md#development-and-tests). PRs that change tests
get a [test review](../docs/agents/test-review.md).
