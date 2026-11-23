# Git subprocesses

[run.ts](run.ts) owns stdout limits, timeout and abort cleanup, and the
subprocess environments for Git and GitHub CLI calls. [index.ts](index.ts)
exports the shared API. [refs.ts](refs.ts) reads the current branch for both
worktree diffs and PR lookups. Worktree, checkout and pull request policy live
in callers.

## Rules for changes

- Give each call a stdout limit and deadline. Timeout and abort stop the
  owned process group and cancel the stdout read.
- Calls that need the user's Git configuration, such as checking their
  commit identity, run with the inherited environment. Plain Git reads run
  isolated from inherited Git environment settings and from global and system
  configuration, but still honor repository-local settings.
