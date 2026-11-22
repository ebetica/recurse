# Git subprocesses

[run.ts](run.ts) owns stdout limits, timeout and abort cleanup, and the
subprocess environments for Git and GitHub CLI calls. [index.ts](index.ts)
exports the shared API. Worktree, checkout and pull request policy live in
callers.

## Rules for changes

- Give each call a stdout limit and deadline. Timeout and abort stop the
  owned process group and cancel the stdout read.
- Use `gitEnv` for calls that need inherited Git configuration. `gitText`
  uses `safeGitEnv` to isolate Git reads from inherited `GIT_*` settings and
  global and system configuration. It still honors repo-local settings.
