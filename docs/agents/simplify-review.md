This page is written for agents running inside Recurse; see the [human docs](../README.md).

# Simplification review and architecture sweep

When a PR grows a tracked source file to 1,500+ lines, commission an independent
read-only effort-3 simplification subagent before READY. Within 100 lines of the
hard cap (or above it), commission an effort-4 **architecture-sweep** subagent
instead. Both use this procedure; one architecture sweep satisfies both gates.
The PR-validation check names files needing a sweep; it does not launch agents.

An independent simplification reviewer reads the named files in full, plus the
modules they call. It edits nothing. Follow [AGENTS.md](../../AGENTS.md): simplify
the design, do not mechanically split files to get under a size limit. When a
simplification splits a module, prefer a clear directory structure over name
prefixes or suffixes: for example, **src/agents/durable/host/open.ts**, not
`host_open.ts`. Name
the directory after the concept, with one job per file. Removing lines merely
to fit under the limit is not acceptable.

For an architecture sweep, also read neighbouring modules and callers. Report:

1. The file's distinct jobs and the state/invariants each owns.
2. Which existing or proposed module should own each job, and why that boundary
   simplifies the design (including expected net lines across all files).
3. An ordered sequence of independently reviewable PRs, with validation gates
   and migration risks. Propose only; get the Coordinator's confirmation before
   beginning any refactor. If no re-architecture helps, explain why.

Save the full proposal in the implementer's scratch directory and summarize it
in the PR. End the sweep with `VERDICT: architecture-sweep`; this records a
completed investigation, not permission to exceed the hard cap or an approved
refactor plan. The normal simplification verdicts below remain for smaller files.

Look for dead, duplicated or parallel code, a module doing several jobs, long
functions that hide separate steps, and state that could be derived. Report only
concrete simplifications: name the location, describe the change and give its
expected line change (including any lines added elsewhere). If none are useful,
say why; do not manufacture a refactor to satisfy the check.

After the implementer applies useful findings, review the final head. Use
`simplified` when the findings were addressed, `none-found` when no useful
simplification remains, or `follow-up #PR` for deferred work with an
operator-visible PR. Report findings first and end with exactly one verdict line:

```
VERDICT: <simplified|none-found|follow-up #PR>
```

The implementer records one standalone PR-body line per growing source file
ending at 1,500 lines or more (use `architecture-sweep` inside the cap margin):

```
Simplify-review: <path> <simplified|none-found|follow-up #PR|architecture-sweep> <full head SHA>
```

Before READY, run the PR-validation command with the PR base ref
(normally `origin/dev`) and a local PR-body file:

```
bun tests/checks/test_check.ts --diff REF --pr-body BODY --strict
```

It compares tracked working-tree line counts to `git merge-base REF HEAD` and
prints that base SHA; `--diff-exact BASE` uses an exact base instead. Declarations
are checked against the current head. Both growth thresholds require a diff
flag and `--pr-body`; without them, growth reviews are skipped.
Growing files without the required record fail with subagent instructions.
Shrinking, unchanged or same-size files need no declaration, so existing large
files do not block unrelated PRs. New tracked files count as growth; stage them
first. Renames count as additions.

The unconditional source-size cap in the [static gate](../../tests/checks/static.ts)
still runs in every suite stage and cannot be waived by a review record.
