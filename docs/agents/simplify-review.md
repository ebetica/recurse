This page is written for agents running inside Recurse; see the [human docs](../README.md).

# Architecture sweeps

The static gate requires a sweep for a tracked source file at 2,400 lines or a
tracked Markdown file at 15,000 characters. When the check fails, stop and
report the path and size to the Coordinator. Do not trim or delete content to
fit, pad code, or mechanically split a file to pass the check. An oversized
README calls for a sweep of its folder, not just an edit to its prose.

The Coordinator commissions an independent read-only effort-4 reviewer. The
reviewer reads the full file, neighbouring modules and callers; for a README,
read the folder it describes. The reviewer edits nothing and reports:

1. The distinct jobs, state and invariants that the file or folder owns.
2. Which existing or proposed modules should own those jobs, and why each
   boundary simplifies the design. Include the expected net lines across all
   files. Prefer directories named for the work they own over filename prefixes.
3. A sequence of independently reviewable PRs, with validation gates and
   migration risks. If no restructuring helps, explain why instead of proposing
   a cosmetic split.

Save the full proposal in scratch and summarize it for the Coordinator. End
with `VERDICT: architecture-sweep`. This records a completed investigation, not
permission to refactor. The Coordinator confirms any follow-up work separately.

The Coordinator records the completed sweep in the
[ledger](../../tests/checks/architecture-sweeps.json): one record per exact
repo-relative `path`, the full reviewed commit SHA in `head`, and the reviewed
`size` in lines for source or Unicode characters for Markdown. Land the sweep
in a separate PR before feature work resumes. Replace the record only after a
new sweep. A file no larger than its recorded size needs no new sweep;
growth beyond that size at or above the threshold needs another sweep. Do not
use a PR-body declaration or raise a ledger entry without a completed sweep.
The 2,500-line source cap still applies even after a sweep.
