This page is written for agents running inside Recurse; see the [human docs](../README.md).

# Simplification review

An independent simplification reviewer reads the named files in full, plus the
modules they call. It edits nothing. Follow [AGENTS.md](../../AGENTS.md): simplify
the design, do not mechanically split files to get under a size limit. When a
simplification splits a module, prefer a clear directory structure over name
prefixes or suffixes: for example, **src/agents/durable/host/open.ts**, not
`host_open.ts`. Name
the directory after the concept, with one job per file.

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
ending at 1,500 lines or more:

```
Simplify-review: <path> <simplified|none-found|follow-up #PR> <full head SHA>
```

`bun tests/checks/test_check.ts --diff BASE --pr-body FILE` checks these declarations
against the current head. Shrinking or unchanged files need no declaration.
