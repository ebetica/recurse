This page is written for agents running inside Recurse; see the [human docs](../README.md).

# Test review

A test reviewer is an agent that reads the test changes in one PR and returns a
verdict against the rules below. It edits nothing. `tests/checks/test_check.ts` finds
patterns in code; the reviewer judges what the checker cannot: whether a test
proves behaviour on a real path, and whether its evidence holds.

## How to review

1. Read the PR body and the test diff (`gh pr diff N`, or the diff you were
   given). Judge the code as it was at the PR's base commit: search with
   `git grep -n PATTERN BASE -- tests/` and read files with
   `git show BASE:PATH`, never the working tree or later history.
2. For each added or changed test, test-check allowance, fixture and tag, check
   the Pass list, then check every hunk against R1 to R9. The Pass list says
   which kinds of test are worth having; it does not excuse a line inside one
   that breaks a rule, such as a wall-clock bound in a real-path regression or
   an exact CSS value in a feature test. Before flagging R2 or R9, name the
   browser, provider or integration test that covers the behaviour or could be
   extended.
3. Flag only what the diff adds or changes. A good test in the same PR does not
   excuse a bad hunk next to it; one bad hunk is enough for FLAG.
4. Lean against small unit tests that prove little, not just large matrices:
   a single pure function on invented inputs, tests that restate the
   implementation, trivial getters or formatting, mock-heavy tests, and tests
   that would still pass if the feature were broken on the real path. Their
   default verdict is FLAG: "delete it, or prove it through an integration or
   browser test". A short test, regression tag or plausible allowance reason
   is not evidence of value.

Reply with exactly this format, nothing before it:

```
VERDICT: FLAG
R2 tests/web/turn-usage.test.ts:309 — hand-written usage rows; test_model_response already shows totals through the fake provider — delete it
NOTE R8 tests/mobile_browser/test_header.ts:50 — add the before-fix command and failure line
```

or `VERDICT: PASS` followed by one line on why. One finding per line: rule,
`file:line`, the problem, then the fix. Use `NOTE` only for the missing R8
detail described under Pass; notes never change the verdict.

## Pass: do not flag these

- A regression test on a real path (browser on the built app, real server,
  Durable store, git, processes) whose PR body says it failed at a named
  commit before the fix. That commit is often older than the merge base. If
  the command or failure line is missing, add a `NOTE R8` line and still pass.
- One `// Feature:` test per feature PR, on a real path.
- Security-boundary tests, even as unit tests of a helper, with their
  Regression tags: authentication, owner scoping, traversal and hostile URLs,
  credential redaction, HTML/CSP escaping, safety fail-closed. Judge the test
  as a whole: positive and malformed rows beside the hostile ones are part of
  the boundary. Not a boundary: a test whose inputs are all benign (ordinary
  words that must not count as secrets), or a display selector with "safety"
  in its name.
- Deleting tests (`test_check.ts --diff` checks `Removes-regression:` lines).
- Recorded data: provider responses, logs or files captured from real runs and
  replayed through real code.
- Fault injection that wraps a real implementation (a gate or call-through
  spy on a real Harness, worker or process) is not a mock.
- Strengthening: replacing a size or text check with a behavioural one, for
  example a 44 px `boundingBox()` check replaced by `elementFromPoint` hits at
  the corners of the 44 px tap area. Sampling a pixel inside each edge is
  normal for hit tests, not a loosened bound.

## Rules: flag these

**R1 Allowance to get past the checker.** A new or reworded
`test-check-allow` comment, or a new or changed
`tests/test-check-allowances.json` entry, defaults to FLAG: "delete it, or prove
it through an integration or browser test". PASS an allowance only when the
test guards a security boundary or a real bug's regression, has fail-before
evidence (named commit, command and failure line), and no real-path test could
cover it. All three conditions are required, even for tests on the Pass list;
the missing-evidence NOTE exception does not apply to allowances. A reason that describes the inputs
("boundary cases", "near misses", "pure state selector", "direct inputs
distinguish…", "constructed inputs") instead of a real path is this rule.
Example: `// test-check-allow: T9 Operator-reported approximation patterns and
Markdown boundary cases.` over invented Markdown strings, when the same PR's
browser test sends them through the fake provider.

**R2 Pure function on invented inputs.** Hand-written rows, truth tables,
formatter strings or fixture loops fed to a helper, when a browser, provider
or integration test covers (or could cover) the behaviour. Even one trivial getter or formatting assertion that restates the
implementation is enough: size is not a reason to pass. Size makes it worse,
not better: 381 constructed rows asserted against "independently derived"
values are still invented. Example: `summaryWithoutRunningCommands("Ran 1
command, running 1 command")` → `"Ran 1 command"`.

**R3 Restating constants or copy.** Asserting an exact CSS value (`fontSize`
`"10.5px"`, `borderTopWidth` `"1px"`, a box height of 44) or a literal UI
string, when nothing behavioural follows from it. Changing such an expectation
to match a new design value is the same problem. Test what the value does:
hit testing, clipping, overlap, order, or that a state's label changes.

**R4 Raising a timeout.** A larger per-test timeout, `setDefaultTimeout`,
`waitFor({ timeout })` or `--timeout` added to make a slow or flaky test pass.
Make the test cheaper (fewer processes, scenarios or fixtures) or wait on a
condition.

**R5 Loosening an assertion.** Replacing an exact check with a weaker one
(`toBe` → `toContain`, `toEqual` → `toMatchObject`, a wider tolerance,
dropping a case or viewport) so a change passes. When the PR changes a fixture
or copy that an exact check reads, the fix is the new exact value, not a
weaker matcher. Not this rule: a stronger behavioural check (see Pass), or
deleting a whole test. Replacing a disruptive machine-wide resource sweep
with a real conflicting listener or another bounded, deterministic resource
conflict is strengthening, not a loosened assertion.

**R6 One-shot read that races the page.** A single `textContent()`,
`innerText()`, `count()` or `isVisible()` read of content that arrives
asynchronously (a server response, a new conversation's view, a stream),
guarded only by a wait that is already true. Wait on the expected condition
instead (`locator(…, { hasText })`.waitFor(), `waitForFunction`). Not this
rule: reading layout or the DOM right after a local input such as `fill()`,
or a click that re-renders from data already on the page, which the page
applies before the call returns; nor a read the PR body shows failing before
the fix.

**R7 Fakes, timing and machine facts.** `mock()`/`mock.module`, a
`spyOn(...).mockImplementation` that replaces the code under test, a fake
DOM, wall-clock assertions (`elapsed < 1000`, `timing.ms`), hard-coded
machine paths (`/tmp/recurse/`, `/home/…`) or real-provider model ids
(`claude-…`, `gpt-…`; fake-provider ids are fine). A timing allowance
does not excuse a wall-clock bound: prove the mechanism instead, for example
by holding the slow path so only the fast one can deliver.

**R8 Regression tag without evidence.** A new `// Regression: #N` tag with no
fail-before claim for that test in the PR body. Tagging existing helper tests
in bulk is this rule, and so is a tag on an invented-input unit test whose
claimed failure was in a different test.

**R9 A new test where an integration test could be extended.** A new unit or
wiring test (often reading source text) added for coverage in a PR that
already adds or has a browser or integration test of the same behaviour.

## Using it at premerge

- The Coordinator, not the implementer, creates a fresh reviewer for every PR
  whose diff touches `tests/`:

  ```bash
  subagent.ts create --title "Test review #N" --effort 3 \
    "Read docs/agents/test-review.md and review PR #N at HEAD_SHA."
  ```

  A FLAG goes back to the implementer; a fixed head gets a new reviewer.

- After an independent reviewer returns `VERDICT: PASS`, the Coordinator
  records the reviewer id and verdict in the PR evidence and adds this exact
  standalone line to the PR body: `Test-review: PASS <full head SHA>`.
  `tests/checks/test_check.ts --diff BASE --pr-body FILE` requires that line for new
  or changed allowance comments and JSON entries, including moved or renamed
  comments. It compares the full SHA with `git HEAD`; stale or abbreviated
  SHAs and old `Operator-approved-test-allowance:` lines do not qualify.
  Uncommitted changes under `tests/` also invalidate the review declaration.
- Implementers never write the line or create their own test reviewers; only
  the Coordinator adds it after checking the independent review transcript
  and exact head, then reruns `test_check.ts --diff`. The checker verifies the
  declaration and SHA, not reviewer identity or transcript contents. A changed
  head requires a fresh test review and replacement line.
- `tests/dev/test_review_eval.ts CASES_DIR` measures these rules on labelled real
  PR hunks; rerun it after editing this page.
