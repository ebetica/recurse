This page is written for agents running inside Recurse; see the [human docs](../README.md).

# Develop Recurse

Recurse is developed in ebetica/recurse-dev and released to the public
ebetica/recurse; see [How Recurse is developed](../develop.md#how-recurse-is-developed).

## Make a change

1. Work in a managed worktree: `bun $RECURSE_SRC/tools/worktree.ts enter NAME`,
   or `subagent.ts create --worktree NAME` for a child. Each managed checkout of
   Recurse gets its own dependency install ([tools/README.md](../../tools/README.md)).
2. Follow the [repository-reading rule](../../AGENTS.md#repository-map).
3. Change the code and the part's README together. `bun tests/checks/docs_check.ts`
   checks core links and paths; optional deployment checks are documented with the deployment.
   Core code, tests, checks and configuration must not refer to the optional
   playground directory. `tests/check.sh` runs a boundary check in every stage.
4. Run the tests the change can reach first ([tests/README.md](../../tests/README.md));
   `bun tests/dev/affected_tests.ts` lists them. `tests/check.sh` runs the full suite;
   never run two stages at once.
5. Follow the [PR rules](../../AGENTS.md#pr-rules) and the evidence and review
   requirements below. Give commands and results at the exact head commit.

## Evidence and review

Classify the work before starting and state the tier in the PR; get feedback if
the final diff changes it. Exact operator directives override blast radius,
uncertainty, and expected size.

- Focused or doc-only, roughly 50 lines: consistency plus the relevant targeted
  test, build, type or browser check; no independent reviewer.
- Small, roughly up to 250 lines: targeted tests and one review.
- Large, high-risk or cross-cutting (especially auth/security, storage, process
  lifecycle, install/startup, or build): the full local suite, clean cumulative
  integration evidence, and one review. Launch/install changes also need the
  [install smoke test](../develop.md#testing-install-changes).

Implementers commission the review, fix findings, and report verdicts. Re-review
only after substantive changes; escalate reviews still failing after fixes.
Reviewers review only the requested diff. Prompt-only changes (AGENTS.md,
generated prompts, help/JSDoc) need no tests. Prove mechanisms (for example, the
process group is gone), not that cleanup ran.

Justify every new line injected into a model prompt. Prefer one-line command
signatures; put detailed instructions in skills or actionable errors instead of
repeating them on every turn. Review the rendered prompt, not only its source.

## Validation

See the [suite stages and environment](../develop.md#validation). Use targeted
evidence by default; the full suite is reserved for an exact operator request
or large/high-risk work.

`tests/check.sh perf` runs the Linux real-server blocking-call trace and idle-thread
CPU gates. It runs in `all`, not the routine individual PR stages; remove resolved
sites from the shrinking known-offender list rather than accepting new ones.

`tests/check.sh tla` exhaustively checks the [TLA+ lifecycle models](../../specs/tla/README.md)
and their negative controls. It runs in `all`, not `ts` or routine PR stages; the
Linux x64 runner downloads pinned tools into private scratch space.

UI, CSS or server-HTML changes run `tests/check.sh web` at the final head. Run new
or changed tests alone first, then the browser test groups that own the changed
feature (usually 1-3), not the whole suite unless the change is large or
high-risk. Reviewers list the tests and browser groups the change could break
and check that the evidence ran them. Before rerunning a failure you cannot
explain, record the test, error, log, head SHA and time; never retry it away or
call it a flake without that record.

Prettier, TypeScript, `bun tests/checks/browser_import_check.ts`,
`bun tests/checks/operator_send_check.ts` and `bun tests/checks/prompt_budget.ts`
are mandatory quick checks. These scripts also run with the static checks in
`tests/check.sh ts`. The operator-send check confines message delivery and
foreground enqueueing to the shared send-scroll entry point. The prompt check renders
a real fake-provider request with fixed dynamic inputs and prints section sizes;
its [header](../../tests/checks/prompt_budget.ts) defines the measured prompt. Oxlint is advisory. Never commit `web/dist`. tests/check.sh
defines source-size limits and exclusions; simplify large files by deleting dead,
duplicated or parallel code and giving each module one
job, not by mechanically splitting files.
Changes to what the web UI downloads (polling, event streams, images, Artifact
loading, caching, compression) run the bytes-over-the-wire budget:
`bun run build && bun tests/dev/wire_budget.ts`. It starts its own private
server and Chromium, prints bytes and requests per case, and fails when a case
grows past `tests/dev/wire_budget.json`; the [script header](../../tests/dev/wire_budget.ts)
lists the cases and how to update budgets. It is not part of `tests/check.sh`.

Before READY, growing source files ending at 1,500+ lines need an independent
[simplification review](simplify-review.md) by an effort-3 subagent created under
the implementer; a `follow-up #PR` verdict needs an operator-visible PR.

## Writing tests and comments

Tests prove the request on real paths: a real server, Durable store, Chromium
on the built app, git, processes, or data recorded from real runs. Changes to
sending, running or showing a reply need a test that sends a message through
the fake provider. Use a real model only to try a new prompt or a new kind of
model call, to check provider login, or after upgrading Pi.

Prefer fewer tests and extend integration tests. Delete low-value tests or
prove the behaviour through an integration or browser test, rather than adding
`test-check-allow` comments or allowance entries. An exception requires an
independent [test review](test-review.md): a security boundary or real bug's
regression, fail-before evidence, and no possible real-path coverage. After a
PASS at the exact head, the Coordinator adds `Test-review: PASS <full head SHA>`
to the PR body. `tests/checks/test_check.ts --diff BASE --pr-body FILE` checks this
line for added or changed allowances; old operator approval lines and stale
SHAs fail. `tests/checks/test_check.ts --help` describes the checked patterns;
tests/check.sh fails on findings but does not run this PR-aware gate. Reviewers check
real/recorded data, fakes and unexplained values. Fix flakes by waiting for
conditions, not loosening tests.

Bug-fix tests carry `// Regression: #PR reason`; the PR body gives the before-fix
command, base commit and failure line, checked by the reviewer. A feature PR
may add at most one feature test, tagged `// Feature: #PR reason`. Each test
has one adjacent tag. Deleting tagged tests needs `Removes-regression:` or
`Removes-feature:` in the PR body. For the exact deletion declaration and the
PR-aware checks, see `bun tests/checks/test_check.ts --help`; tests/check.sh alone does not
run those PR-aware checks.

A bug fix also proposes how to block its bug class: a fast static check (an
Oxlint rule or a `tests/checks/` script that adds well under a second to a
stage), a slower check in a bulk-only stage such as `tests/check.sh perf`, or,
for classes that code cannot catch, a reviewer rule under
[Evidence and review](#evidence-and-review). The PR body names the proposal;
add the check or rule only after the operator approves it.

JS/TS comments are limited to short declaration docs, one file header, and
`Invariant:`/`Spec:` comments in bodies. Tests have no comments except required
test tags and tool/license comments. Tool and license comments are exempt
throughout. `tests/checks/comment_check.ts --strict` makes JS/TS and Python
findings fail `tests/check.sh ts`. Read its help for precise checks.

## Writing docs

- A file's header and tests describe that file.
- A directory's `README.md` describes how that part works: a **Source files**
  list, short sections in present tense, and **Rules for changes**. Update it in
  the same PR as the behaviour.
- Pages in `docs/` explain ideas that span parts, and tasks. They link to code
  instead of restating constants, flags or file lists, and leave history to
  commits.
- `bun tests/checks/docs_check.ts` (part of `tests/check.sh ts`) fails on a broken link, a
  missing backticked repo path, or a source directory missing from the
  [code map](repository-map.md).

## Testing install changes

Run the [fresh-install smoke test](../develop.md#testing-install-changes).

Several PRs may share one smoke run on their tested combined tip. Repeat any
check that a later change affects, confirm each PR still applies on its own
before merging them in order, and still review each PR.
